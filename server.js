// Driftchat — random stranger text + video chat server
// Express serves the site, Socket.IO handles matching, chat relay and WebRTC signaling.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

// ---------- config ----------
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';           // set when behind nginx/Cloudflare/Render etc.
const INTEREST_TIMEOUT_MS = 10_000;                             // after this, users with interests match with anyone
const AUTO_BAN_REPORTS = Number(process.env.AUTO_BAN_REPORTS) || 5; // distinct reporters in 24h -> 24h auto-ban
const MAX_MSG_LEN = 1000;
const DATA_DIR = path.join(__dirname, 'data');
// Sites allowed to connect when the frontend is hosted elsewhere (e.g. GitHub Pages).
// Comma-separated, e.g. "https://hallowthorn.github.io". "*" allows any site.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const originOk = origin => !origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);

if (ADMIN_PASSWORD === 'changeme') {
  console.warn('[!] ADMIN_PASSWORD not set — admin panel password is "changeme". Set it before going public.');
}

// ---------- tiny JSON persistence ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const load = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return fallback; }
};
const save = (file, obj) => fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(obj, null, 2));

let bans = load('bans.json', {});        // { ip: { reason, at, until|null } }
let reports = load('reports.json', []);  // [{ id, at, reason, details, mode, reporterIp, reportedIp, log }]

function activeBan(ip) {
  const b = bans[ip];
  if (!b) return null;
  if (b.until && b.until < Date.now()) { delete bans[ip]; save('bans.json', bans); return null; }
  return b;
}

// ---------- http ----------
const app = express();
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && originOk(origin)) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'content-type, x-admin-key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      Vary: 'Origin',
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/healthz', (_req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/ice', (_req, res) => {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map(s => s.trim()),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  }
  res.json(servers);
});

function adminAuth(req, res, next) {
  const a = Buffer.from(req.get('x-admin-key') || '');
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/admin/state', adminAuth, (_req, res) => {
  Object.keys(bans).forEach(activeBan); // prune expired
  res.json({
    reports: [...reports].reverse(),
    bans,
    online: io.engine.clientsCount,
    queued: { text: queues.text.length, video: queues.video.length },
  });
});

app.post('/api/admin/ban', adminAuth, (req, res) => {
  const { ip, reason = 'Violation of rules', hours = 0, reportId } = req.body || {};
  if (!ip || typeof ip !== 'string') return res.status(400).json({ error: 'ip required' });
  banIp(ip, String(reason).slice(0, 200), Number(hours) || 0);
  if (reportId) {
    reports = reports.filter(r => r.id !== reportId);
    save('reports.json', reports);
  }
  res.json({ ok: true });
});

app.post('/api/admin/unban', adminAuth, (req, res) => {
  delete bans[req.body?.ip];
  save('bans.json', bans);
  res.json({ ok: true });
});

app.post('/api/admin/dismiss', adminAuth, (req, res) => {
  reports = reports.filter(r => r.id !== req.body?.id);
  save('reports.json', reports);
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  cors: { origin: (origin, cb) => cb(null, originOk(origin)) },
});

// ---------- matching ----------
const queues = { text: [], video: [] };

function getIp(socket) {
  if (TRUST_PROXY) {
    const fwd = socket.handshake.headers['cf-connecting-ip'] || socket.handshake.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return socket.handshake.address;
}

function removeFromQueues(socket) {
  for (const mode of Object.keys(queues)) {
    const i = queues[mode].indexOf(socket);
    if (i !== -1) queues[mode].splice(i, 1);
  }
}

const waitedLong = s => Date.now() - s.data.queuedAt > INTEREST_TIMEOUT_MS;
const canGoRandom = s => s.data.interests.length === 0 || waitedLong(s);

function compatible(a, b) {
  if (a === b || !b.connected || b.data.partner) return false;
  // don't instantly re-pair the two people who just skipped each other, unless both have waited a while
  const justMet = a.data.lastPartnerId === b.id || b.data.lastPartnerId === a.id;
  if (justMet && !(Date.now() - a.data.queuedAt > 5000 && Date.now() - b.data.queuedAt > 5000)) return false;
  return true;
}

// Try to pair `socket` with someone in its queue. Returns true if paired.
function attemptMatch(socket) {
  const q = queues[socket.data.mode];
  let best = null, bestCommon = [];
  for (const other of q) {
    if (!compatible(socket, other)) continue;
    const common = socket.data.interests.filter(i => other.data.interests.includes(i));
    if (common.length > bestCommon.length) { best = other; bestCommon = common; }
    else if (!best && canGoRandom(socket) && canGoRandom(other)) best = other;
  }
  if (!best) return false;
  pair(best, socket, bestCommon); // the one who waited longer sends the WebRTC offer
  return true;
}

function pair(a, b, common) {
  removeFromQueues(a);
  removeFromQueues(b);
  const room = { id: crypto.randomUUID(), mode: a.data.mode, startedAt: Date.now(), log: [] };
  a.data.partner = b; b.data.partner = a;
  a.data.room = room; b.data.room = room;
  a.emit('matched', { common, initiator: true });
  b.emit('matched', { common, initiator: false });
}

// Ends a chat for both sides. The partner is told; the caller already knows.
function endChat(socket) {
  const p = socket.data.partner;
  if (!p) return;
  const room = socket.data.room;
  socket.data.partner = null; p.data.partner = null;
  socket.data.room = null; p.data.room = null;
  socket.data.lastPartnerId = p.id; p.data.lastPartnerId = socket.id;
  // keep the last chat around so either side can still report after it ends
  socket.data.lastChat = { room, ip: p.data.ip };
  p.data.lastChat = { room, ip: socket.data.ip };
  p.emit('partner-left');
}

// Sweep queues so people with interests fall back to random matches after the timeout.
setInterval(() => {
  for (const mode of Object.keys(queues)) {
    for (const s of [...queues[mode]]) {
      if (queues[mode].includes(s)) attemptMatch(s);
    }
  }
}, 2000);

// Online count broadcast (throttled)
let lastOnline = -1;
setInterval(() => {
  const n = io.engine.clientsCount;
  if (n !== lastOnline) { lastOnline = n; io.emit('online', n); }
}, 3000);

function banIp(ip, reason, hours) {
  bans[ip] = { reason, at: Date.now(), until: hours > 0 ? Date.now() + hours * 3600_000 : null };
  save('bans.json', bans);
  for (const s of io.sockets.sockets.values()) {
    if (s.data.ip === ip) {
      endChat(s);
      removeFromQueues(s);
      s.emit('banned', bans[ip]);
      setTimeout(() => s.disconnect(true), 250);
    }
  }
}

function sanitizeInterests(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

// ---------- sockets ----------
io.on('connection', socket => {
  const ip = getIp(socket);
  socket.data = {
    ip, mode: null, interests: [], partner: null, room: null,
    queuedAt: 0, lastPartnerId: null, lastChat: null,
    msgTimes: [], lastReportAt: 0,
  };

  const ban = activeBan(ip);
  if (ban) {
    socket.emit('banned', ban);
    setTimeout(() => socket.disconnect(true), 250);
    return;
  }
  socket.emit('online', io.engine.clientsCount);

  socket.on('find', (opts = {}) => {
    if (activeBan(ip)) return socket.emit('banned', bans[ip]);
    endChat(socket);
    removeFromQueues(socket);
    socket.data.mode = opts.mode === 'video' ? 'video' : 'text';
    socket.data.interests = sanitizeInterests(opts.interests);
    socket.data.queuedAt = Date.now();
    socket.emit('searching');
    if (!attemptMatch(socket)) queues[socket.data.mode].push(socket);
  });

  socket.on('message', text => {
    const p = socket.data.partner;
    if (!p || typeof text !== 'string') return;
    text = text.slice(0, MAX_MSG_LEN).trim();
    if (!text) return;
    // rate limit: 6 messages per 3 seconds
    const now = Date.now();
    socket.data.msgTimes = socket.data.msgTimes.filter(t => now - t < 3000);
    if (socket.data.msgTimes.length >= 6) return socket.emit('notice', 'Slow down a little.');
    socket.data.msgTimes.push(now);
    const log = socket.data.room.log;
    log.push({ from: socket.id, text, t: now });
    if (log.length > 200) log.shift();
    p.emit('message', text);
  });

  socket.on('typing', isTyping => {
    socket.data.partner?.emit('typing', !!isTyping);
  });

  socket.on('signal', data => {
    const p = socket.data.partner;
    if (!p || socket.data.mode !== 'video' || !data || typeof data !== 'object') return;
    if (JSON.stringify(data).length > 20_000) return;
    p.emit('signal', data);
  });

  socket.on('leave', () => {
    endChat(socket);
    removeFromQueues(socket);
  });

  socket.on('report', (payload = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const now = Date.now();
    if (now - socket.data.lastReportAt < 20_000) return reply({ ok: false, error: 'Please wait before reporting again.' });

    let room, reportedIp;
    if (socket.data.partner) { room = socket.data.room; reportedIp = socket.data.partner.data.ip; }
    else if (socket.data.lastChat) { room = socket.data.lastChat.room; reportedIp = socket.data.lastChat.ip; }
    if (!room) return reply({ ok: false, error: 'Nobody to report.' });

    socket.data.lastReportAt = now;
    reports.push({
      id: crypto.randomUUID(),
      at: now,
      reason: String(payload.reason || 'other').slice(0, 60),
      details: String(payload.details || '').slice(0, 500),
      mode: room.mode,
      reporterIp: ip,
      reportedIp,
      log: room.log.map(m => ({ who: m.from === socket.id ? 'reporter' : 'reported', text: m.text, t: m.t })),
    });
    if (reports.length > 2000) reports = reports.slice(-2000);
    save('reports.json', reports);

    // automatic temp ban when several different people report the same IP within 24h
    const dayAgo = now - 24 * 3600_000;
    const reporters = new Set(reports.filter(r => r.reportedIp === reportedIp && r.at > dayAgo).map(r => r.reporterIp));
    if (reporters.size >= AUTO_BAN_REPORTS && !activeBan(reportedIp)) {
      banIp(reportedIp, `Auto-ban: reported by ${reporters.size} people`, 24);
    }

    if (socket.data.partner) endChat(socket);
    socket.data.lastChat = null;
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    endChat(socket);
    removeFromQueues(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Driftchat running on http://localhost:${PORT}  (admin: /admin)`);
});
