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
const MAX_MSG_LEN = 1000;
const MAX_LOG = 1000;              // messages kept per chat for report review
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

// Admin-editable settings (changed live from /admin, saved to data/settings.json)
const DEFAULT_SETTINGS = {
  textEnabled: true,
  videoEnabled: true,
  maintenance: false,
  maintenanceMsg: 'Driftchat is down for maintenance. Back soon!',
  announcement: '',                 // banner shown at the top of the site; empty = none
  bannedWords: [],                  // word filter list
  filterMode: 'mask',               // 'mask' = replace with ***, 'block' = don't deliver the message
  autoBanReports: Number(process.env.AUTO_BAN_REPORTS) || 5, // distinct reporters in 24h -> 24h ban; 0 = off
  interestTimeoutSec: 10,           // how long to wait for an interest match before going random
  msgRateLimit: 6,                  // max messages per 3 seconds per user
};
let settings = { ...DEFAULT_SETTINGS, ...load('settings.json', {}) };

function activeBan(ip) {
  const b = bans[ip];
  if (!b) return null;
  if (b.until && b.until < Date.now()) { delete bans[ip]; save('bans.json', bans); return null; }
  return b;
}

// ---------- word filter ----------
let wordRe = null;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function buildFilter() {
  const words = settings.bannedWords.map(w => w.trim()).filter(Boolean).map(escapeRe);
  wordRe = words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${words.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
}
buildFilter();

// ---------- stats (since server start) ----------
const stats = {
  startedAt: Date.now(),
  chats: 0, messages: 0, reports: 0, peakOnline: 0,
  chatMsTotal: 0, chatsEnded: 0,
  hourly: [],                       // [{ hour: epochHour, chats, messages, peak }] last 24 hours
};
function bucket() {
  const hour = Math.floor(Date.now() / 3600_000);
  let b = stats.hourly[stats.hourly.length - 1];
  if (!b || b.hour !== hour) {
    b = { hour, chats: 0, messages: 0, peak: 0 };
    stats.hourly.push(b);
    if (stats.hourly.length > 24) stats.hourly.shift();
  }
  return b;
}

// ---------- http ----------
const app = express();
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && originOk(origin)) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'content-type, x-admin-key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Expose-Headers': 'content-disposition',
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

const sockets = () => [...io.sockets.sockets.values()];
const findSocket = id => (typeof id === 'string' && io.sockets.sockets.get(id)) || null;
const inQueue = s => Object.values(queues).some(q => q.includes(s));
const statusOf = s => (s.data.partner ? 'chatting' : inQueue(s) ? 'searching' : 'idle');

app.get('/api/admin/state', adminAuth, (_req, res) => {
  Object.keys(bans).forEach(activeBan); // prune expired
  const all = sockets();
  const users = all.slice(0, 500).map(s => ({
    id: s.id,
    ip: s.data.ip,
    mode: s.data.mode,
    status: statusOf(s),
    interests: s.data.interests,
    connectedAt: s.data.connectedAt,
    partnerId: s.data.partner?.id || null,
    chatStartedAt: s.data.room?.startedAt || null,
    msgs: s.data.msgCount,
    reportsAgainst: reports.filter(r => r.reportedIp === s.data.ip).length,
  }));
  const seen = new Set();
  const chats = [];
  for (const s of all) {
    const p = s.data.partner;
    if (!p || seen.has(s.data.room.id)) continue;
    seen.add(s.data.room.id);
    chats.push({ a: s.id, b: p.id, aIp: s.data.ip, bIp: p.data.ip, mode: s.data.room.mode, startedAt: s.data.room.startedAt, msgs: s.data.room.log.length });
  }
  res.json({
    reports: [...reports].reverse(),
    bans,
    online: io.engine.clientsCount,
    queued: { text: queues.text.length, video: queues.video.length },
    users,
    chats,
    settings,
    stats: {
      ...stats,
      avgChatSec: stats.chatsEnded ? Math.round(stats.chatMsTotal / stats.chatsEnded / 1000) : 0,
      activeChats: chats.length,
    },
  });
});

app.post('/api/admin/ban', adminAuth, (req, res) => {
  const { ip, reason = 'Violation of rules', hours = 0, reportId } = req.body || {};
  if (!ip || typeof ip !== 'string') return res.status(400).json({ error: 'ip required' });
  banIp(ip.trim(), String(reason).slice(0, 200), Number(hours) || 0);
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

app.post('/api/admin/unban-all', adminAuth, (_req, res) => {
  bans = {};
  save('bans.json', bans);
  res.json({ ok: true });
});

app.post('/api/admin/dismiss', adminAuth, (req, res) => {
  reports = reports.filter(r => r.id !== req.body?.id);
  save('reports.json', reports);
  res.json({ ok: true });
});

// Dismiss every report, or every report against one IP.
app.post('/api/admin/dismiss-all', adminAuth, (req, res) => {
  const ip = req.body?.ip;
  reports = ip ? reports.filter(r => r.reportedIp !== ip) : [];
  save('reports.json', reports);
  res.json({ ok: true });
});

// Disconnect one user without banning them.
app.post('/api/admin/kick', adminAuth, (req, res) => {
  const s = findSocket(req.body?.id);
  if (!s) return res.status(404).json({ error: 'user not online' });
  kick(s, String(req.body?.reason || 'Removed by a moderator.').slice(0, 200));
  res.json({ ok: true });
});

// Kick every connection from one IP.
app.post('/api/admin/kick-ip', adminAuth, (req, res) => {
  const ip = req.body?.ip;
  const hits = sockets().filter(s => s.data.ip === ip);
  hits.forEach(s => kick(s, String(req.body?.reason || 'Removed by a moderator.').slice(0, 200)));
  res.json({ ok: true, kicked: hits.length });
});

// End a chat without kicking anyone; both go back to "New chat".
app.post('/api/admin/end-chat', adminAuth, (req, res) => {
  const s = findSocket(req.body?.id);
  if (!s?.data.partner) return res.status(404).json({ error: 'not in a chat' });
  const p = s.data.partner;
  endChat(s);                      // tells the partner
  s.emit('partner-left');          // and the caller
  [s, p].forEach(x => x.emit('notice', 'A moderator ended this chat.'));
  res.json({ ok: true });
});

// Send one user a warning popup.
app.post('/api/admin/warn', adminAuth, (req, res) => {
  const s = findSocket(req.body?.id);
  if (!s) return res.status(404).json({ error: 'user not online' });
  s.emit('mod-warning', String(req.body?.message || 'Please follow the rules.').slice(0, 300));
  res.json({ ok: true });
});

// One-time message to everyone online right now.
app.post('/api/admin/broadcast', adminAuth, (req, res) => {
  const msg = String(req.body?.message || '').trim().slice(0, 300);
  if (!msg) return res.status(400).json({ error: 'message required' });
  io.emit('broadcast', msg);
  res.json({ ok: true, sent: io.engine.clientsCount });
});

app.post('/api/admin/settings', adminAuth, (req, res) => {
  const body = req.body || {};
  const next = { ...settings };
  for (const k of ['textEnabled', 'videoEnabled', 'maintenance']) if (k in body) next[k] = !!body[k];
  if ('maintenanceMsg' in body) next.maintenanceMsg = String(body.maintenanceMsg).slice(0, 300);
  if ('announcement' in body) next.announcement = String(body.announcement).slice(0, 300);
  if ('filterMode' in body) next.filterMode = body.filterMode === 'block' ? 'block' : 'mask';
  if ('bannedWords' in body) {
    const list = Array.isArray(body.bannedWords) ? body.bannedWords : String(body.bannedWords).split(/[\n,]/);
    next.bannedWords = [...new Set(list.map(w => String(w).trim().toLowerCase()).filter(Boolean))].slice(0, 500);
  }
  const num = (k, min, max) => {
    if (!(k in body)) return;
    const n = Math.round(Number(body[k]));
    if (Number.isFinite(n)) next[k] = Math.min(max, Math.max(min, n));
  };
  num('autoBanReports', 0, 100);
  num('interestTimeoutSec', 0, 120);
  num('msgRateLimit', 1, 50);

  const turnedOff = [];
  if (next.maintenance && !settings.maintenance) turnedOff.push('text', 'video');
  if (!next.textEnabled && settings.textEnabled) turnedOff.push('text');
  if (!next.videoEnabled && settings.videoEnabled) turnedOff.push('video');

  settings = next;
  save('settings.json', settings);
  buildFilter();

  // anyone in a mode that was just switched off gets sent home
  for (const s of sockets()) {
    if (turnedOff.includes(s.data.mode)) { endChat(s); removeFromQueues(s); }
  }
  io.emit('config', publicConfig());
  res.json({ ok: true, settings });
});

// Everything known about one IP.
app.get('/api/admin/ip', adminAuth, (req, res) => {
  const ip = String(req.query.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'ip required' });
  res.json({
    ip,
    ban: activeBan(ip),
    online: sockets().filter(s => s.data.ip === ip).map(s => ({ id: s.id, status: statusOf(s), mode: s.data.mode, connectedAt: s.data.connectedAt })),
    reportsAgainst: reports.filter(r => r.reportedIp === ip).reverse(),
    reportsFiled: reports.filter(r => r.reporterIp === ip).reverse(),
  });
});

app.get('/api/admin/export', adminAuth, (_req, res) => {
  res.set('content-disposition', `attachment; filename="driftchat-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), settings, bans, reports, stats });
});

// Restore bans (and optionally settings) from an export file — useful after a free-tier restart wipes data/.
app.post('/api/admin/import', adminAuth, (req, res) => {
  const body = req.body || {};
  let added = 0;
  if (body.bans && typeof body.bans === 'object') {
    for (const [ip, b] of Object.entries(body.bans)) {
      if (!b || typeof b !== 'object') continue;
      if (b.until && b.until < Date.now()) continue;
      bans[ip] = { reason: String(b.reason || 'Imported').slice(0, 200), at: Number(b.at) || Date.now(), until: b.until ? Number(b.until) : null };
      added++;
    }
    save('bans.json', bans);
  }
  if (body.settings && typeof body.settings === 'object') {
    settings = { ...DEFAULT_SETTINGS, ...settings, ...body.settings };
    save('settings.json', settings);
    buildFilter();
    io.emit('config', publicConfig());
  }
  res.json({ ok: true, bansImported: added });
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  cors: { origin: (origin, cb) => cb(null, originOk(origin)) },
});

const publicConfig = () => ({
  textEnabled: settings.textEnabled,
  videoEnabled: settings.videoEnabled,
  maintenance: settings.maintenance,
  maintenanceMsg: settings.maintenanceMsg,
  announcement: settings.announcement,
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

const waitedLong = s => Date.now() - s.data.queuedAt > settings.interestTimeoutSec * 1000;
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
  stats.chats++;
  bucket().chats++;
  a.emit('matched', { common, initiator: true });
  b.emit('matched', { common, initiator: false });
}

// Ends a chat for both sides. The partner is told; the caller already knows.
function endChat(socket) {
  const p = socket.data.partner;
  if (!p) return;
  const room = socket.data.room;
  room.endedAt = Date.now();
  stats.chatsEnded++;
  stats.chatMsTotal += Date.now() - room.startedAt;
  socket.data.partner = null; p.data.partner = null;
  socket.data.room = null; p.data.room = null;
  socket.data.lastPartnerId = p.id; p.data.lastPartnerId = socket.id;
  // keep the last chat around so either side can still report after it ends
  socket.data.lastChat = { room, ip: p.data.ip };
  p.data.lastChat = { room, ip: socket.data.ip };
  p.emit('partner-left');
}

function kick(s, reason) {
  endChat(s);
  removeFromQueues(s);
  s.emit('kicked', reason);
  setTimeout(() => s.disconnect(true), 250);
}

// Sweep queues so people with interests fall back to random matches after the timeout.
setInterval(() => {
  for (const mode of Object.keys(queues)) {
    for (const s of [...queues[mode]]) {
      if (queues[mode].includes(s)) attemptMatch(s);
    }
  }
}, 2000);

// Online count broadcast (throttled) + peak tracking
let lastOnline = -1;
setInterval(() => {
  const n = io.engine.clientsCount;
  stats.peakOnline = Math.max(stats.peakOnline, n);
  const b = bucket();
  b.peak = Math.max(b.peak, n);
  if (n !== lastOnline) { lastOnline = n; io.emit('online', n); }
}, 3000);

function banIp(ip, reason, hours) {
  bans[ip] = { reason, at: Date.now(), until: hours > 0 ? Date.now() + hours * 3600_000 : null };
  save('bans.json', bans);
  for (const s of sockets()) {
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
    connectedAt: Date.now(), msgCount: 0,
  };

  const ban = activeBan(ip);
  if (ban) {
    socket.emit('banned', ban);
    setTimeout(() => socket.disconnect(true), 250);
    return;
  }
  socket.emit('config', publicConfig());
  socket.emit('online', io.engine.clientsCount);

  socket.on('find', (opts = {}) => {
    if (activeBan(ip)) return socket.emit('banned', bans[ip]);
    if (settings.maintenance) return socket.emit('maintenance', settings.maintenanceMsg);
    const mode = opts.mode === 'video' ? 'video' : 'text';
    if ((mode === 'text' && !settings.textEnabled) || (mode === 'video' && !settings.videoEnabled)) {
      return socket.emit('mode-disabled', mode);
    }
    endChat(socket);
    removeFromQueues(socket);
    socket.data.mode = mode;
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
    // rate limit: N messages per 3 seconds
    const now = Date.now();
    socket.data.msgTimes = socket.data.msgTimes.filter(t => now - t < 3000);
    if (socket.data.msgTimes.length >= settings.msgRateLimit) return socket.emit('notice', 'Slow down a little.');
    socket.data.msgTimes.push(now);

    let shown = text, blocked = false;
    if (wordRe) {
      const filtered = text.replace(wordRe, m => '*'.repeat(m.length));
      if (filtered !== text) {
        if (settings.filterMode === 'block') blocked = true;
        else shown = filtered;
      }
    }

    // full transcript kept with the chat so a report can show everything from the start
    const room = socket.data.room;
    const entry = { from: socket.id, text: shown, t: now };
    if (shown !== text || blocked) entry.original = text;
    if (blocked) entry.blocked = true;
    room.log.push(entry);
    if (room.log.length > MAX_LOG) { room.log.shift(); room.truncated = true; }

    if (blocked) return socket.emit('notice', "That message wasn't sent — it has a blocked word.");
    socket.data.msgCount++;
    stats.messages++;
    bucket().messages++;
    p.emit('message', shown);
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
    stats.reports++;
    reports.push({
      id: crypto.randomUUID(),
      at: now,
      reason: String(payload.reason || 'other').slice(0, 60),
      details: String(payload.details || '').slice(0, 500),
      mode: room.mode,
      reporterIp: ip,
      reportedIp,
      chatStartedAt: room.startedAt,
      chatEndedAt: room.endedAt || null,   // null = reported while the chat was still going
      truncated: !!room.truncated,
      log: room.log.map(m => ({
        who: m.from === socket.id ? 'reporter' : 'reported',
        text: m.text, t: m.t,
        ...(m.original ? { original: m.original } : {}),
        ...(m.blocked ? { blocked: true } : {}),
      })),
    });
    if (reports.length > 2000) reports = reports.slice(-2000);
    save('reports.json', reports);

    // automatic temp ban when several different people report the same IP within 24h
    if (settings.autoBanReports > 0) {
      const dayAgo = now - 24 * 3600_000;
      const reporters = new Set(reports.filter(r => r.reportedIp === reportedIp && r.at > dayAgo).map(r => r.reporterIp));
      if (reporters.size >= settings.autoBanReports && !activeBan(reportedIp)) {
        banIp(reportedIp, `Auto-ban: reported by ${reporters.size} people`, 24);
      }
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
