// Driftchat client
(() => {
  const $ = id => document.getElementById(id);
  // Where the matching server lives. Empty = same site (when server.js serves these files itself).
  const SERVER = (window.DRIFTCHAT_SERVER || '').replace(/\/$/, '');
  const socket = io(SERVER || undefined, { autoConnect: true });
  const staticHost = /\.github\.io$/.test(location.hostname);

  const el = {
    home: $('home'), chat: $('chat'), videos: $('videos'),
    chips: $('chips'), interestInput: $('interestInput'), ageCheck: $('ageCheck'),
    startText: $('startText'), startVideo: $('startVideo'), homeError: $('homeError'),
    rules: $('rules'), rulesLink: $('rulesLink'), brand: $('brand'),
    onlineCount: $('onlineCount'), statusText: $('statusText'),
    log: $('log'), typing: $('typing'), composer: $('composer'), input: $('input'),
    sendBtn: $('sendBtn'), skipBtn: $('skipBtn'), skipLabel: $('skipLabel'),
    reportBtn: $('reportBtn'), saveLogBtn: $('saveLogBtn'),
    reportDialog: $('reportDialog'), reportForm: $('reportForm'), reportCancel: $('reportCancel'),
    remoteVideo: $('remoteVideo'), localVideo: $('localVideo'),
    remoteOverlay: $('remoteOverlay'), remoteOverlayText: $('remoteOverlayText'),
    micBtn: $('micBtn'), camBtn: $('camBtn'),
    banned: $('banned'), bannedReason: $('bannedReason'), bannedUntil: $('bannedUntil'),
    toast: $('toast'),
  };

  const state = {
    mode: null,               // 'text' | 'video'
    status: 'idle',           // idle | searching | chatting | ended
    interests: loadInterests(),
    skipStage: 0,             // 0 = "Stop", 1 = "Really?"
    transcript: [],           // for Save log
    pc: null, localStream: null, iceServers: null, pendingCandidates: [],
    typingSent: false, typingTimer: null, unread: 0,
  };

  // ---------------- interests ----------------
  function loadInterests() {
    try { return JSON.parse(localStorage.getItem('dc_interests') || '[]').slice(0, 10); } catch { return []; }
  }
  function saveInterests() {
    try { localStorage.setItem('dc_interests', JSON.stringify(state.interests)); } catch {}
  }
  function renderChips() {
    el.chips.querySelectorAll('.chip').forEach(c => c.remove());
    state.interests.forEach((tag, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = tag;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${tag}`);
      x.onclick = () => { state.interests.splice(i, 1); saveInterests(); renderChips(); };
      chip.appendChild(x);
      el.chips.insertBefore(chip, el.interestInput);
    });
  }
  function addInterest(raw) {
    const t = raw.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!t || state.interests.includes(t) || state.interests.length >= 10) return;
    state.interests.push(t);
    saveInterests();
    renderChips();
  }
  el.interestInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addInterest(el.interestInput.value);
      el.interestInput.value = '';
    } else if (e.key === 'Backspace' && !el.interestInput.value && state.interests.length) {
      state.interests.pop(); saveInterests(); renderChips();
    }
  });
  el.interestInput.addEventListener('blur', () => {
    if (el.interestInput.value.trim()) { addInterest(el.interestInput.value); el.interestInput.value = ''; }
  });
  el.chips.addEventListener('click', () => el.interestInput.focus());
  renderChips();

  try { el.ageCheck.checked = localStorage.getItem('dc_age') === '1'; } catch {}
  el.rulesLink.addEventListener('click', e => {
    e.preventDefault();
    el.rules.scrollIntoView({ behavior: 'smooth' });
    el.rules.classList.remove('flash'); void el.rules.offsetWidth; el.rules.classList.add('flash');
  });

  // ---------------- starting ----------------
  el.startText.addEventListener('click', () => start('text'));
  el.startVideo.addEventListener('click', () => start('video'));

  function homeError(msg) {
    el.homeError.textContent = msg;
    const card = el.homeError.closest('.card');
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  }

  async function start(mode) {
    el.homeError.textContent = '';
    if (staticHost && !SERVER) return homeError('This site has no chat server configured yet (set DRIFTCHAT_SERVER).');
    if (!socket.connected) return homeError('Waking up the chat server… try again in a few seconds.');
    if (!el.ageCheck.checked) return homeError('Tick the 18+ box to continue.');
    try { localStorage.setItem('dc_age', '1'); } catch {}
    if (el.interestInput.value.trim()) { addInterest(el.interestInput.value); el.interestInput.value = ''; }

    state.mode = mode;
    if (mode === 'video') {
      if (!navigator.mediaDevices?.getUserMedia) return homeError('Video needs HTTPS (or localhost) and a modern browser.');
      try {
        state.localStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        return homeError(err.name === 'NotAllowedError'
          ? 'Camera/mic permission was blocked. Allow it in your browser and try again.'
          : 'Could not start your camera: ' + err.message);
      }
      el.localVideo.srcObject = state.localStream;
      if (!state.iceServers) {
        try { state.iceServers = await (await fetch(SERVER + '/api/ice')).json(); }
        catch { state.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; }
      }
    }

    el.home.hidden = true;
    el.chat.hidden = false;
    el.videos.hidden = mode !== 'video';
    el.chat.classList.toggle('video-mode', mode === 'video');
    history.pushState({ chat: true }, '', '#chat');
    search();
  }

  function goHome() {
    if (state.status === 'chatting' || state.status === 'searching') socket.emit('leave');
    teardownPeer();
    state.localStream?.getTracks().forEach(t => t.stop());
    state.localStream = null;
    state.status = 'idle';
    el.chat.hidden = true;
    el.home.hidden = false;
    document.title = 'Driftchat — talk to strangers';
  }
  el.brand.addEventListener('click', e => { e.preventDefault(); if (location.hash) history.back(); else goHome(); });
  window.addEventListener('popstate', () => { if (!el.chat.hidden) goHome(); });

  // ---------------- chat flow ----------------
  function search() {
    teardownPeer();
    el.log.replaceChildren();
    state.transcript = [];
    state.status = 'searching';
    setSkip(0);
    setInput(false);
    el.typing.hidden = true;
    setStatus('Looking for someone…');
    el.reportBtn.disabled = true;
    el.saveLogBtn.disabled = true;
    addSys(state.interests.length
      ? `Looking for someone who likes <b>${escapeHtml(state.interests.join(', '))}</b>…`
      : 'Looking for someone you can chat with…', true);
    showRemoteOverlay('Looking for someone…', true);
    socket.emit('find', { mode: state.mode, interests: state.interests });
  }

  socket.on('matched', ({ common, initiator }) => {
    if (state.status !== 'searching') return;
    state.status = 'chatting';
    el.log.replaceChildren();
    addSys("You're now chatting with a random stranger. Say hi!");
    if (common?.length) addSys(`You both like <span class="common">${escapeHtml(common.join(', '))}</span>.`, true);
    else if (state.interests.length) addSys('No one shared your interests, so you got someone random.');
    setStatus(state.mode === 'video' ? 'Connected — video' : 'Connected', true);
    setSkip(0);
    setInput(true);
    el.reportBtn.disabled = false;
    el.saveLogBtn.disabled = false;
    if (state.mode === 'video') {
      showRemoteOverlay('Connecting video…', true);
      setupPeer(initiator);
    }
    if (window.matchMedia('(pointer:fine)').matches) el.input.focus();
    notify('Stranger found!');
  });

  socket.on('message', text => {
    if (state.status !== 'chatting') return;
    el.typing.hidden = true;
    addMsg('stranger', text);
    notify('New message');
  });

  socket.on('typing', on => { if (state.status === 'chatting') { el.typing.hidden = !on; scrollLog(); } });
  socket.on('notice', msg => toast(msg));

  socket.on('partner-left', () => {
    if (state.status !== 'chatting') return;
    addSys('<b>Stranger has disconnected.</b>', true);
    ended();
  });

  function stopChat() {
    socket.emit('leave');
    if (state.status === 'chatting') addSys('<b>You have disconnected.</b>', true);
    else addSys('Stopped searching.');
    ended();
  }

  function ended() {
    state.status = 'ended';
    teardownPeer();
    setInput(false);
    el.typing.hidden = true;
    setStatus('Disconnected');
    setSkip(0);
    showRemoteOverlay('Disconnected', false);
    const hadChat = state.transcript.length > 0 || !el.reportBtn.disabled;

    const row = document.createElement('div');
    row.className = 'after-actions';
    const btn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; row.appendChild(b);
    };
    btn('New chat', 'btn-new', search);
    if (hadChat) btn('Report', 'btn-ghost', openReport);
    if (state.transcript.length) btn('Save log', 'btn-ghost', saveLog);
    btn('Change interests', 'btn-ghost', () => history.back());
    el.log.appendChild(row);
    scrollLog();
  }

  // Skip button: Stop -> Really? -> (disconnect) -> New
  function setSkip(stage) {
    state.skipStage = stage;
    el.skipBtn.classList.remove('really', 'new');
    if (state.status === 'ended') { el.skipLabel.textContent = 'New'; el.skipBtn.classList.add('new'); }
    else if (stage === 1) { el.skipLabel.textContent = 'Really?'; el.skipBtn.classList.add('really'); }
    else el.skipLabel.textContent = state.status === 'searching' ? 'Stop' : 'Skip';
  }
  function pressSkip() {
    if (state.status === 'ended') return search();
    if (state.status === 'searching') return stopChat();
    if (state.status !== 'chatting') return;
    if (state.skipStage === 0) return setSkip(1);
    stopChat();
  }
  el.skipBtn.addEventListener('click', pressSkip);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || el.chat.hidden || el.reportDialog.open) return;
    e.preventDefault();
    pressSkip();
  });

  // ---------------- composer ----------------
  function setInput(enabled) {
    el.input.disabled = !enabled;
    el.sendBtn.disabled = !enabled;
    if (!enabled) el.input.value = '';
    autoGrow();
  }
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 140) + 'px';
  }
  el.input.addEventListener('input', () => {
    autoGrow();
    if (state.skipStage === 1) setSkip(0);
    if (!state.typingSent) { socket.emit('typing', true); state.typingSent = true; }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(stopTyping, 2500);
  });
  function stopTyping() {
    if (state.typingSent) { socket.emit('typing', false); state.typingSent = false; }
  }
  el.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.composer.requestSubmit(); }
  });
  el.composer.addEventListener('submit', e => {
    e.preventDefault();
    const text = el.input.value.trim();
    if (!text || state.status !== 'chatting') return;
    socket.emit('message', text);
    addMsg('you', text);
    el.input.value = '';
    autoGrow();
    clearTimeout(state.typingTimer);
    stopTyping();
    if (state.skipStage === 1) setSkip(0);
  });

  // ---------------- log rendering ----------------
  function addMsg(who, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + who;
    const name = document.createElement('span');
    name.className = 'who';
    name.textContent = who === 'you' ? 'You' : 'Stranger';
    div.append(name, document.createTextNode(text));
    el.log.appendChild(div);
    state.transcript.push(`${who === 'you' ? 'You' : 'Stranger'}: ${text}`);
    scrollLog();
  }
  function addSys(content, isHtml = false) {
    const div = document.createElement('div');
    div.className = 'sys';
    if (isHtml) div.innerHTML = content; else div.textContent = content;
    el.log.appendChild(div);
    scrollLog();
  }
  function scrollLog() { el.log.scrollTop = el.log.scrollHeight; }
  function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function setStatus(text, live = false) { el.statusText.textContent = text; el.statusText.classList.toggle('live', live); }

  function saveLog() {
    const header = `Driftchat log — ${new Date().toLocaleString()}\n\n`;
    const blob = new Blob([header + state.transcript.join('\n') + '\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `driftchat-${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  el.saveLogBtn.addEventListener('click', saveLog);

  // ---------------- notifications ----------------
  function notify(what) {
    if (!document.hidden) return;
    state.unread++;
    document.title = `(${state.unread}) ${what} — Driftchat`;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { state.unread = 0; document.title = 'Driftchat — talk to strangers'; }
  });
  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), 2600);
  }

  // ---------------- reporting ----------------
  function openReport() {
    el.reportForm.reset();
    el.reportDialog.showModal();
  }
  el.reportBtn.addEventListener('click', openReport);
  el.reportCancel.addEventListener('click', () => el.reportDialog.close());
  el.reportForm.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(el.reportForm);
    el.reportDialog.close();
    socket.emit('report', { reason: fd.get('reason'), details: fd.get('details') }, res => {
      if (!res?.ok) return toast(res?.error || 'Report failed.');
      toast('Report sent. Thanks for keeping it decent.');
      el.reportBtn.disabled = true;
      el.log.querySelectorAll('.after-actions .btn-ghost').forEach(b => { if (b.textContent === 'Report') b.remove(); });
      if (state.status === 'chatting') { addSys('<b>You reported and left this chat.</b>', true); ended(); }
    });
  });

  // ---------------- video (WebRTC) ----------------
  function setupPeer(initiator) {
    teardownPeer();
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    state.pc = pc;
    state.pendingCandidates = [];
    state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));

    pc.ontrack = e => {
      if (el.remoteVideo.srcObject !== e.streams[0]) el.remoteVideo.srcObject = e.streams[0];
      el.remoteOverlay.hidden = true;
    };
    pc.onicecandidate = e => { if (e.candidate) socket.emit('signal', { candidate: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc !== state.pc) return;
      if (pc.connectionState === 'failed') {
        showRemoteOverlay('Video could not connect (network blocked). Text still works.', false);
      }
    };

    if (initiator) {
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => socket.emit('signal', { description: pc.localDescription.toJSON() }))
        .catch(err => console.error('offer failed', err));
    }
  }

  socket.on('signal', async data => {
    const pc = state.pc;
    if (!pc) return;
    try {
      if (data.description) {
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          socket.emit('signal', { description: pc.localDescription.toJSON() });
        }
        for (const c of state.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else state.pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      console.error('signal error', err);
    }
  });

  function teardownPeer() {
    if (state.pc) {
      state.pc.ontrack = state.pc.onicecandidate = state.pc.onconnectionstatechange = null;
      state.pc.close();
      state.pc = null;
    }
    el.remoteVideo.srcObject = null;
  }

  function showRemoteOverlay(text, spinning) {
    if (state.mode !== 'video') return;
    el.remoteOverlay.hidden = false;
    el.remoteOverlay.classList.toggle('idle', !spinning);
    el.remoteOverlayText.textContent = text;
  }

  function toggleTrack(kind, btn, offTitle, onTitle) {
    const track = state.localStream?.getTracks().find(t => t.kind === kind);
    if (!track) return;
    track.enabled = !track.enabled;
    btn.setAttribute('aria-pressed', String(!track.enabled));
    btn.title = track.enabled ? offTitle : onTitle;
  }
  el.micBtn.addEventListener('click', () => toggleTrack('audio', el.micBtn, 'Mute mic', 'Unmute mic'));
  el.camBtn.addEventListener('click', () => toggleTrack('video', el.camBtn, 'Turn camera off', 'Turn camera on'));

  // ---------------- connection / server events ----------------
  socket.on('online', n => { el.onlineCount.textContent = Number(n).toLocaleString(); });
  socket.on('searching', () => {});

  socket.on('banned', ban => {
    goHome();
    el.banned.hidden = false;
    el.bannedReason.textContent = ban?.reason ? `Reason: ${ban.reason}` : '';
    el.bannedUntil.textContent = ban?.until
      ? `Ends ${new Date(ban.until).toLocaleString()}.`
      : 'This ban is permanent.';
  });

  socket.on('disconnect', () => {
    if (!el.banned.hidden) return;
    if (state.status === 'chatting' || state.status === 'searching') {
      addSys('<b>Lost connection to the server.</b> Reconnecting…', true);
      ended();
    }
    setStatus('Reconnecting…');
  });
  socket.on('connect', () => {
    if (state.status === 'ended') setStatus('Disconnected');
  });
})();
