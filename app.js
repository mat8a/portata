'use strict';
// Portata — client
// Posizione dal GPS del browser, audio con WebRTC (collegamenti diretti tra telefoni),
// mappa della stanza, meta condivisa, modalità musica, premi per parlare,
// mini finestra PiP disegnata su canvas e diagnostica del secondo piano.

const $ = s => document.querySelector(s);
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const state = {
  id: null, room: '', name: '', ice: [], radius: 1000, exitMargin: 0.1,
  ws: null, wsOk: false, retry: 1000, leaving: false,
  stream: null, micTrack: null, muted: false, music: false, musicTalk: false, micPending: false,
  ptt: false, talking: false, invisible: false,
  ctx: null, localAnalyser: null,
  watchId: null, lastPos: null, geoError: null, lastSent: null, lastSentAt: 0,
  peers: new Map(),
  dest: null, picking: false, pending: null,
  wake: null, wantWake: false, pipOpen: false,
};
let away = null; // statistiche mentre la pagina è in secondo piano

/* ---------------- utilità ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtD = d => d == null ? '—' : d < 995 ? `${Math.max(10, Math.round(d / 10) * 10)} m` : `${(d / 1000).toFixed(1).replace('.', ',')} km`;
const fmtR = r => r >= 1000 ? '1 km' : `${r} m`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function store(k, v) { try { localStorage.setItem('portata.' + k, v); } catch {} }
function load(k) { try { return localStorage.getItem('portata.' + k); } catch { return null; } }
function send(m) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(m)); }
function listNames(names) {
  if (names.length <= 2) return names.join(' e ');
  return `${names.slice(0, 2).join(', ')} e altri ${names.length - 2}`;
}

let toastTimer = null;
function toast(text, kind = '') {
  const el = $('#toast');
  el.textContent = text; el.className = 'toast ' + kind; el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, Math.min(7000, 2500 + text.length * 40));
}

/* ---------------- ingresso ---------------- */
(function prefill() {
  const q = new URLSearchParams(location.search).get('stanza');
  $('#room').value = (q || load('room') || '').toUpperCase();
  $('#name').value = load('name') || '';
  const r = +load('radius'); if (r >= 100 && r <= 1000) state.radius = r;
  state.ptt = load('ptt') === '1';
})();

function joinError(msg) { const e = $('#joinError'); e.textContent = msg; e.hidden = !msg; }

function micErrorText(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return isIOS
      ? 'Safari ha bloccato il microfono per questo sito. Tocca l\'icona a sinistra dell\'indirizzo → Impostazioni sito web → Microfono: Consenti. Poi ricarica la pagina.'
      : 'Il browser ha bloccato il microfono per questo sito. Tocca il lucchetto accanto all\'indirizzo, consenti il microfono e ricarica la pagina.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Non trovo nessun microfono su questo dispositivo.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Il microfono è occupato da un\'altra app, per esempio una chiamata in corso. Chiudila e riprova.';
  return `Non riesco ad attivare il microfono (${name || 'errore sconosciuto'}). Ricarica la pagina e riprova.`;
}

$('#joinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#name').value.trim();
  const room = $('#room').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!name || room.length < 3) return joinError('Scrivi il tuo nome e un codice stanza di almeno 3 lettere o numeri.');
  if (!window.isSecureContext || !navigator.mediaDevices) return joinError('Il browser dà accesso a microfono e posizione solo su pagine https://. Apri la versione pubblicata online.');
  if (!('geolocation' in navigator)) return joinError('Questo browser non può leggere la posizione.');

  const btn = $('#joinBtn'); btn.disabled = true; joinError('');
  setAudioSession('play-and-record');
  try { await acquireMic(); }
  catch (err) { btn.disabled = false; return joinError(micErrorText(err)); }
  setupMediaKeys();
  try { state.ctx = new (window.AudioContext || window.webkitAudioContext)(); await state.ctx.resume(); } catch { state.ctx = null; }
  attachLocalAnalyser();

  state.name = name; state.room = room;
  store('name', name); store('room', room);
  history.replaceState(null, '', '?stanza=' + room);
  $('#roomLabel').textContent = room;
  $('#radius').value = state.radius; $('#radiusOut').textContent = fmtR(state.radius);
  $('#pttToggle').checked = state.ptt;
  $('#carKeysToggle').checked = state.carKeys;
  startKeepAlive();
  $('#joinView').hidden = true; $('#callView').hidden = false;

  initMap();
  startGeo();
  startPip();
  connect();
  syncMic();
});

/* ---------------- microfono ---------------- */
// Regola: il microfono viene preso SOLO mentre deve trasmettere. Quando è spento (muto,
// premi per parlare a riposo, modalità musica) viene restituito al telefono, così
// la musica di Spotify o Apple Music può suonare. Riaccenderlo la mette in pausa.
function setAudioSession(type) {
  // Safari 17+: dice a iOS come trattare l'audio della pagina. "ambient" si mescola con la musica.
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch {}
}

async function acquireMic() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  state.stream = s;
  state.micTrack = s.getAudioTracks()[0];
  state.micTrack.addEventListener('mute', onMicMute);
  state.micTrack.addEventListener('unmute', () => renderDiag());
  state.micTrack.addEventListener('ended', () => { if (away) away.micEnded = true; renderDiag(); });
  attachLocalAnalyser();
}
function attachLocalAnalyser() {
  state.localAnalyser = null;
  if (!state.ctx || !state.stream) return;
  try {
    const src = state.ctx.createMediaStreamSource(state.stream);
    state.localAnalyser = state.ctx.createAnalyser(); state.localAnalyser.fftSize = 512;
    src.connect(state.localAnalyser);
  } catch {}
}
function setSenderTrack(pc, track) {
  if (!pc) return;
  for (const t of pc.getTransceivers()) {
    if (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio' && !t.stopped) t.sender.replaceTrack(track).catch(() => {});
  }
}

// deve trasmettere adesso?
const micWanted = () => state.music ? state.musicTalk : state.ptt ? state.talking : !state.muted;
const micOn = () => micWanted() && !!state.micTrack && !state.micPending;

let lastFlags = '';
async function syncMic() {
  const want = micWanted();
  if (want && !state.micTrack && !state.micPending) {
    state.micPending = true; render();
    setAudioSession('play-and-record');
    try { await acquireMic(); }
    catch (err) {
      state.micPending = false;
      setAudioSession('ambient');
      if (state.music) state.musicTalk = false; else if (state.ptt) state.talking = false; else state.muted = true;
      toast(micErrorText(err), 'bad'); render(); return;
    }
    state.micPending = false;
    if (!micWanted()) { releaseMic(); sendFlags(); render(); return; } // lasciato prima che fosse pronto
    for (const p of state.peers.values()) setSenderTrack(p.pc, state.micTrack);
    startKeepAlive();
    if (navigator.vibrate) navigator.vibrate(12);
  } else if (!want && state.micTrack) {
    releaseMic();
  }
  sendFlags();
  render();
}
function releaseMic() {
  for (const p of state.peers.values()) setSenderTrack(p.pc, null);
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  state.stream = null; state.micTrack = null; state.localAnalyser = null;
  stopKeepAlive();
  setAudioSession('ambient');
  if (state.ctx) state.ctx.resume().catch(() => {});
}
function sendFlags() {
  // agli altri: 🎵 se ascolti musica, microfono barrato se non ti sentono
  const music = state.music && !state.musicTalk;
  const muted = !music && !micWanted();
  const key = `${music}|${muted}`;
  if (key === lastFlags) return;
  lastFlags = key;
  send({ t: 'settings', music, muted });
}

function onMicMute() {
  if (away) away.micMuted = true;
  renderDiag();
  // un'altra app (per esempio la musica) si è presa l'audio mentre sei qui
  if (!document.hidden) setTimeout(checkMicTaken, 1500);
}
function checkMicTaken() {
  const t = state.micTrack;
  if (!t || !(t.muted || t.readyState === 'ended')) return;
  if (state.music) { state.musicTalk = false; syncMic(); }   // la musica è ripartita mentre parlavi
  else if (state.ptt) { state.talking = false; syncMic(); }
  else enterMusic(true);
}

/* ---------------- modalità musica ---------------- */
let musicHintShown = false;
function enterMusic(auto = false) {
  if (state.music) return;
  state.music = true; state.musicTalk = false; state.talking = false;
  syncMic();
  toast(auto
    ? 'È partita la musica: il tuo microfono è in pausa. Tocca il microfono quando vuoi parlare.'
    : 'Modalità musica: fai partire la tua musica. Senti ancora gli altri; per parlare tocca il microfono.', 'music');
}
function exitMusic() {
  if (!state.music) return;
  state.music = false; state.musicTalk = false; state.muted = false; state.talking = false;
  syncMic();
  toast(state.ptt ? 'Modalità musica chiusa.' : 'Microfono acceso.');
}
function setMusicTalk(on) {
  if (!state.music || state.musicTalk === on) return;
  state.musicTalk = on;
  syncMic();
  if (!on && isIOS && !musicHintShown) { musicHintShown = true; toast('Se la musica non riparte da sola, premi play dal Centro di Controllo.', 'music'); }
}
$('#musicBtn').addEventListener('click', () => { if (state.music) exitMusic(); else enterMusic(false); });

/* ---------------- tasto microfono ---------------- */
const micBtn = $('#micBtn');
micBtn.addEventListener('click', () => {
  if (state.ptt) return; // gestito da pressione e rilascio
  if (state.music) return setMusicTalk(!state.musicTalk);
  toggleMute();
});
function toggleMute() {
  state.muted = !state.muted;
  syncMic();
}
function talk(on) {
  if (!state.ptt) return;
  if (state.music) return setMusicTalk(on);
  if (state.talking === on) return;
  state.talking = on;
  syncMic();
}
micBtn.addEventListener('pointerdown', e => { if (state.ptt) { e.preventDefault(); micBtn.setPointerCapture?.(e.pointerId); talk(true); } });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => micBtn.addEventListener(ev, () => talk(false)));
micBtn.addEventListener('contextmenu', e => e.preventDefault());
micBtn.addEventListener('keydown', e => { if (e.key === ' ' && state.ptt) { e.preventDefault(); talk(true); } });
micBtn.addEventListener('keyup', e => { if (e.key === ' ' && state.ptt) talk(false); });

/* ---------------- tasti del volante e delle cuffie ---------------- */
// Il tasto play/pausa (volante via Bluetooth, cuffie, AirPods) accende e spegne il microfono.
// Arriva a Portata solo se è lei l'audio "in riproduzione": per questo, mentre il microfono è
// acceso, suona un audio muto in sottofondo. A microfono spento si ferma, così i tasti tornano
// alla musica.
state.carKeys = load('carKeys') !== '0';
let keepAlive = null;
function silentWavUrl() {
  const rate = 8000, n = rate; // 1 secondo di silenzio
  const buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function startKeepAlive() {
  if (!state.carKeys || !state.micTrack) return;
  if (!keepAlive) { keepAlive = new Audio(silentWavUrl()); keepAlive.loop = true; keepAlive.setAttribute('playsinline', ''); }
  keepAlive.play().catch(() => {});
  try { navigator.mediaSession.playbackState = 'playing'; } catch {}
}
function stopKeepAlive() {
  if (keepAlive) keepAlive.pause();
  try { navigator.mediaSession.playbackState = 'paused'; } catch {}
}
function mediaKey() {
  if (!state.carKeys) return;
  if (state.music) setMusicTalk(!state.musicTalk);
  else if (state.ptt) talk(!state.talking);
  else toggleMute();
  toast(micWanted() ? 'Microfono acceso dal tasto' : 'Microfono spento dal tasto');
}
function setupMediaKeys() {
  if (!('mediaSession' in navigator)) return;
  for (const a of ['play', 'pause', 'togglemicrophone']) {
    try { navigator.mediaSession.setActionHandler(a, mediaKey); } catch {}
  }
}

/* ---------------- posizione ---------------- */
function startGeo() {
  state.watchId = navigator.geolocation.watchPosition(onPos, onGeoErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function onPos(p) {
  state.geoError = null;
  state.lastPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: Date.now() };
  if (away) away.pos++;
  maybeSendPos();
  render();
}
function onGeoErr(err) {
  state.geoError = err.code === 1
    ? 'Permesso posizione negato. Attivalo nelle impostazioni del browser per questo sito.'
    : 'Posizione non disponibile al momento. Riprovo da solo.';
  render();
}
function maybeSendPos(force = false) {
  const p = state.lastPos;
  if (!p || !state.id) return;
  const now = Date.now();
  const moved = state.lastSent ? distM(state.lastSent, p) : Infinity;
  const due = now - state.lastSentAt >= 4000 && (moved > 10 || now - state.lastSentAt >= 60000);
  if (force || !state.lastSent || due) {
    send({ t: 'pos', lat: p.lat, lon: p.lon, acc: p.acc });
    state.lastSent = p; state.lastSentAt = now;
    if (away) away.sent++;
  }
}

/* ---------------- server ---------------- */
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  state.ws = ws;
  ws.onopen = () => {
    state.wsOk = true; state.retry = 1000;
    send({ t: 'join', room: state.room, name: state.name, radius: state.radius, paused: state.invisible, music: state.music && !state.musicTalk, muted: !(state.music && !state.musicTalk) && !micWanted() });
    renderDiag();
  };
  ws.onmessage = e => { if (away) away.msgs++; let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
  ws.onclose = () => {
    const wasOk = state.wsOk;
    state.wsOk = false; state.id = null; state.lastSent = null;
    for (const id of [...state.peers.keys()]) closePeer(id);
    state.peers.clear();
    if (away && wasOk) away.wsDrops++;
    render();
    if (!state.leaving) { setTimeout(connect, state.retry); state.retry = Math.min(15000, state.retry * 2); }
  };
}
setInterval(() => send({ t: 'ping' }), 20000);

function handle(m) {
  switch (m.t) {
    case 'welcome':
      state.id = m.id; state.ice = m.ice || []; state.exitMargin = m.exitMargin ?? 0.1;
      state.dest = m.dest || null;
      maybeSendPos(true);
      render();
      break;
    case 'error':
      state.leaving = true; state.ws.close();
      stopAll();
      $('#callView').hidden = true; $('#joinView').hidden = false; $('#joinBtn').disabled = false;
      joinError(m.msg);
      break;
    case 'peers': {
      const seen = new Set();
      for (const info of m.peers) {
        seen.add(info.id);
        const p = peer(info.id);
        Object.assign(p, {
          name: info.name, distance: info.distance, linked: info.linked, paused: info.paused,
          music: info.music, muted: info.muted, hasPos: info.hasPos, lat: info.lat, lon: info.lon,
        });
        applyVolume(p);
      }
      for (const id of [...state.peers.keys()]) if (!seen.has(id)) { closePeer(id); state.peers.delete(id); }
      render();
      break;
    }
    case 'link': openPeer(m.peer, m.initiator); render(); break;
    case 'unlink': closePeer(m.peer); render(); break;
    case 'signal': onSignal(m.from, m.data); break;
    case 'dest':
      state.dest = m.dest;
      if (m.byId !== state.id) toast(m.dest ? `${m.by} ha condiviso la meta: ${m.dest.label}` : `${m.by} ha tolto la meta`);
      render();
      break;
  }
}

/* ---------------- WebRTC ---------------- */
function peer(id) {
  if (!state.peers.has(id)) state.peers.set(id, {
    id, name: '…', distance: null, linked: false, paused: false, music: false, muted: false, hasPos: false, lat: null, lon: null,
    pc: null, audio: null, analyser: null, src: null, queue: [], conn: 'new', level: 0, prevCls: null,
  });
  return state.peers.get(id);
}

function openPeer(id, initiator) {
  const p = peer(id);
  if (p.pc) closePeer(id);
  p.linked = true;
  const pc = new RTCPeerConnection({ iceServers: state.ice });
  p.pc = pc; p.initiator = initiator; p.queue = []; p.conn = 'new';
  if (initiator) {
    // un canale audio in andata e ritorno; se sei in modalità musica parte senza microfono
    pc.addTransceiver(state.micTrack || 'audio', { direction: 'sendrecv', streams: state.stream ? [state.stream] : [] });
  }
  pc.onicecandidate = e => { if (e.candidate) send({ t: 'signal', to: id, data: { cand: e.candidate } }); };
  pc.ontrack = e => attachAudio(p, e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => {
    p.conn = pc.connectionState;
    if (pc.connectionState === 'failed' && p.initiator) makeOffer(p, true);
    render();
  };
  if (initiator) makeOffer(p);
}

async function makeOffer(p, iceRestart = false) {
  try {
    const offer = await p.pc.createOffer({ iceRestart });
    await p.pc.setLocalDescription(offer);
    send({ t: 'signal', to: p.id, data: { sdp: p.pc.localDescription } });
  } catch (err) { console.warn('offer', err); }
}

async function onSignal(from, data) {
  const p = state.peers.get(from);
  if (!p || !p.pc) return;
  const pc = p.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of p.queue) await pc.addIceCandidate(c).catch(() => {});
      p.queue = [];
      if (data.sdp.type === 'offer') {
        for (const t of pc.getTransceivers()) {
          if (t.receiver.track && t.receiver.track.kind === 'audio' && !t.stopped) {
            t.direction = 'sendrecv';
            if (!t.sender.track && state.micTrack) await t.sender.replaceTrack(state.micTrack).catch(() => {});
          }
        }
        await pc.setLocalDescription(await pc.createAnswer());
        send({ t: 'signal', to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.cand) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.cand).catch(() => {});
      else p.queue.push(data.cand);
    }
  } catch (err) { console.warn('signal', err); }
}

function attachAudio(p, stream) {
  if (!p.audio) {
    p.audio = document.createElement('audio');
    p.audio.autoplay = true; p.audio.setAttribute('playsinline', '');
    $('#audioSinks').appendChild(p.audio);
  }
  if (p.audio.srcObject !== stream) {
    p.audio.srcObject = stream;
    p.audio.play().catch(() => document.addEventListener('click', resumeAudio, { once: true }));
    if (state.ctx) {
      try {
        if (p.src) p.src.disconnect();
        p.src = state.ctx.createMediaStreamSource(stream);
        p.analyser = state.ctx.createAnalyser(); p.analyser.fftSize = 512;
        p.src.connect(p.analyser);
      } catch { p.analyser = null; }
    }
  }
  applyVolume(p);
}
function resumeAudio() {
  if (state.ctx) state.ctx.resume().catch(() => {});
  for (const p of state.peers.values()) if (p.audio) p.audio.play().catch(() => {});
}

function closePeer(id) {
  const p = state.peers.get(id);
  if (!p) return;
  if (p.pc) { try { p.pc.close(); } catch {} p.pc = null; }
  if (p.src) { try { p.src.disconnect(); } catch {} p.src = null; }
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); p.audio = null; }
  p.analyser = null; p.linked = false; p.conn = 'closed'; p.level = 0;
}

// Tutti si sentono a volume pieno. Puoi silenziare una persona solo per te:
// lei non lo sa e continua a sentirti. La scelta si ricorda per nome.
let silenced = new Set();
try { silenced = new Set(JSON.parse(load('silenced') || '[]')); } catch {}
const isSilenced = p => silenced.has(p.name);
function applyVolume(p) {
  if (!p.audio) return;
  p.audio.volume = 1;
  p.audio.muted = isSilenced(p);
}
function toggleSilence(p) {
  if (isSilenced(p)) silenced.delete(p.name); else silenced.add(p.name);
  store('silenced', JSON.stringify([...silenced]));
  applyVolume(p);
  toast(isSilenced(p) ? `Hai silenziato ${p.name} solo per te` : `Senti di nuovo ${p.name}`);
  renderPeople();
}

function rms(an) {
  if (!an) return 0;
  const buf = new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(buf);
  let s = 0; for (const v of buf) { const x = (v - 128) / 128; s += x * x; }
  return Math.sqrt(s / buf.length);
}

/* ---------------- stato e testi ---------------- */
function peerStatus(p) {
  if (p.paused) return ['paused', 'Invisibile'];
  if (!p.hasPos) return ['nopos', 'Posizione non disponibile'];
  if (p.linked && p.conn === 'connected') return ['live', 'In chiamata'];
  if (p.linked) return ['connecting', p.conn === 'failed' ? 'Collegamento non riuscito' : 'Collegamento…'];
  return ['out', 'Fuori portata'];
}
const livePeers = () => [...state.peers.values()].filter(p => peerStatus(p)[0] === 'live');

function statusText() {
  const live = livePeers(), total = state.peers.size;
  if (!state.wsOk) return ['Connessione…', 'Se non si collega, controlla la connessione internet.'];
  if (state.invisible) return ['Sei invisibile', 'Non compari sulla mappa e non entri in chiamata.'];
  if (!state.lastPos) return ['Cerco la tua posizione…', state.geoError || 'Può servire qualche secondo, meglio all\'aperto.'];
  if (live.length > 0) {
    const sub = state.music && state.musicTalk ? 'Ti sentono: la musica è in pausa finché parli.'
      : state.music ? (state.ptt ? 'Modalità musica: tieni premuto il microfono per parlare.' : 'Modalità musica: tu senti loro. Tocca il microfono per parlare.')
      : state.ptt ? 'Tieni premuto il microfono per parlare.'
      : state.muted ? 'Il tuo microfono è spento.'
      : 'Vi sentite finché siete vicini.';
    return [`In chiamata con ${listNames(live.map(p => p.name))}`, sub];
  }
  return [`Nessuno entro ${fmtR(state.radius)}`,
    total === 0 ? 'Invita qualcuno: entrate in chiamata appena siete vicini.' : 'Entri in chiamata appena qualcuno si avvicina.'];
}

/* ---------------- interfaccia ---------------- */
function render() {
  const [title, sub] = statusText();
  $('#statusTitle').textContent = title;
  $('#statusSub').textContent = sub;
  // in basso compaiono solo gli avvisi: chi è in chiamata si vede in alto a sinistra
  $('#statusPill').hidden = !(!state.wsOk || state.invisible || !state.lastPos);
  const live = livePeers().length;
  $('#liveDot').classList.toggle('on', live > 0);

  const badge = $('#modeBadge');
  const b = state.invisible ? ['invisible', 'Invisibile'] : state.music ? ['music', 'Musica'] : (state.muted && !state.ptt) ? ['muted', 'Muto'] : null;
  badge.hidden = !b;
  if (b) { badge.className = 'badge ' + b[0]; badge.textContent = b[1]; }

  // avvisi quando qualcuno entra o esce dalla chiamata
  for (const p of state.peers.values()) {
    const [cls] = peerStatus(p);
    if (p.prevCls && p.prevCls !== 'live' && cls === 'live') toast(`Sei in chiamata con ${p.name}`);
    if (p.prevCls === 'live' && cls !== 'live' && cls !== 'connecting') toast(`${p.name} ora è fuori portata`);
    p.prevCls = cls;
  }

  renderPeople();
  renderDest();
  renderDock();
  updateMap();
  updateMediaSession();
  renderDiag();
}

function renderPeople() {
  const order = { live: 0, connecting: 1, out: 2, nopos: 3, paused: 4 };
  const list = [...state.peers.values()].sort((a, b) =>
    order[peerStatus(a)[0]] - order[peerStatus(b)[0]] || (a.distance ?? 1e9) - (b.distance ?? 1e9));
  const MAX = 5, extra = list.length - MAX;
  const shown = state.showAllPeople || extra <= 0 ? list : list.slice(0, MAX - 1);
  const moreBtn = extra > 0
    ? `<li><button type="button" class="more glass" data-more>${state.showAllPeople ? 'Mostra meno' : `+${list.length - shown.length} altri`}</button></li>` : '';
  $('#people').innerHTML = shown.map(p => {
    const [cls, label] = peerStatus(p);
    const tag = p.music ? '<span class="tag music"><svg class="ic"><use href="#i-music"/></svg></span>'
      : p.muted && cls === 'live' ? '<span class="tag muted"><svg class="ic"><use href="#i-mic-off"/></svg></span>' : '';
    const dist = p.distance != null ? `<span class="mono">${fmtD(p.distance)}</span> · ` : '';
    const off = isSilenced(p);
    const spk = p.linked
      ? `<button type="button" class="spk${off ? ' off' : ''}" data-spk="${esc(p.id)}" aria-pressed="${off}" aria-label="${off ? 'Torna a sentire' : 'Silenzia per me'} ${esc(p.name)}"><svg class="ic"><use href="#${off ? 'i-volume-off' : 'i-volume'}"/></svg></button>` : '';
    return `<li class="person glass p-${cls}" data-id="${esc(p.id)}">
      <button type="button" class="pmain" data-go="${esc(p.id)}" aria-label="Mostra ${esc(p.name)} sulla mappa, ${esc(label)}">
        <span class="av">${esc((p.name[0] || '?').toUpperCase())}${tag}</span>
        <span class="pinfo"><span class="pname">${esc(p.name)}</span><span class="pmeta">${dist}<span class="pstate${off && p.linked ? ' off' : ''}">${esc(off && p.linked ? 'Silenziato da te' : label)}</span></span></span>
      </button>${spk}</li>`;
  }).join('') + moreBtn;
}
// tocca una persona: la mappa va su di lei; tocca l'altoparlante: la silenzi solo per te
$('#people').addEventListener('click', e => {
  if (e.target.closest('[data-more]')) { state.showAllPeople = !state.showAllPeople; return renderPeople(); }
  const s = e.target.closest('[data-spk]');
  if (s) { const p = state.peers.get(s.dataset.spk); if (p) toggleSilence(p); return; }
  const b = e.target.closest('[data-go]'); if (!b) return;
  const p = state.peers.get(b.dataset.go);
  if (!p || p.lat == null || !map.m) return toast(`${p ? p.name : 'Questa persona'} non ha una posizione da mostrare`);
  flyToPoint(p.lat, p.lon);
});
// tocca lo stato: se sei solo inviti, altrimenti torni a vedere tutto il cerchio
$('#statusPill').addEventListener('click', () => {
  if (state.peers.size === 0 && state.wsOk) return share();
  map.follow = true; fitRadius();
});

function renderDock() {
  const on = micOn();
  micBtn.classList.toggle('music', state.music);
  micBtn.classList.toggle('muted', !state.music && !state.ptt && state.muted);
  micBtn.classList.toggle('ptt', !state.music && state.ptt);
  micBtn.classList.toggle('talking', on && (state.music || state.ptt));
  micBtn.classList.toggle('pending', !!state.micPending);
  micBtn.querySelector('use').setAttribute('href', micWanted() ? '#i-mic' : '#i-mic-off');
  $('#micLbl').textContent = state.micPending ? 'Un attimo…'
    : on && (state.music || state.ptt) ? 'Parli…'
    : state.ptt ? 'Tieni premuto'
    : state.music ? 'Parla'
    : state.muted ? 'Muto' : 'Microfono';
  micBtn.setAttribute('aria-label', state.ptt ? 'Tieni premuto per parlare'
    : state.music ? (state.musicTalk ? 'Torna alla musica' : 'Parla, la musica va in pausa')
    : state.muted ? 'Riaccendi il microfono' : 'Spegni il microfono');
  $('#musicBtn').classList.toggle('on', state.music);
  $('#musicBtn').setAttribute('aria-pressed', String(state.music));
  $('#destBtn').classList.toggle('on', !!state.dest);
  $('#pipBtn').classList.toggle('on', state.pipOpen);
  updateMediaSession();
}

function tickLevels() {
  for (const p of state.peers.values()) {
    p.level = p.analyser ? rms(p.analyser) : 0;
    const speaking = p.level > 0.03;
    const av = document.querySelector(`.person[data-id="${CSS.escape(p.id)}"] .av`);
    if (av) av.classList.toggle('speaking', speaking);
    const pin = map.markers.get(p.id)?.getElement()?.querySelector('.pin');
    if (pin) pin.classList.toggle('speaking', speaking);
  }
}

function renderDiag() {
  const set = (id, text, cls) => { const el = $(id); el.textContent = text; el.className = cls || ''; };
  if (state.lastPos) set('#dPos', `${ago(state.lastPos.ts)} fa · ±${Math.round(state.lastPos.acc)} m`, Date.now() - state.lastPos.ts < 30000 ? 'ok' : 'meh');
  else set('#dPos', state.geoError ? 'non disponibile' : 'in attesa', state.geoError ? 'ko' : 'meh');
  set('#dWs', state.wsOk ? 'collegato' : 'non collegato', state.wsOk ? 'ok' : 'ko');
  const t = state.micTrack;
  if (state.micPending) set('#dMic', 'in accensione…', 'meh');
  else if (t && t.readyState === 'ended') set('#dMic', 'terminato', 'ko');
  else if (t && t.muted) set('#dMic', 'silenziato dal sistema', 'ko');
  else if (t) set('#dMic', 'acceso', 'ok');
  else set('#dMic', state.music ? 'libero (musica)' : state.ptt ? 'libero, premi per parlare' : 'spento, libero per la musica', 'meh');
  set('#dPip', state.pipOpen ? 'aperta' : 'chiusa', state.pipOpen ? 'ok' : '');
  set('#dWake', state.wake ? 'sì' : 'no', state.wake ? 'ok' : '');
}

/* ---------------- meta condivisa ---------------- */
// App per le indicazioni: scelta ogni volta oppure ricordata.
const NAV_APPS = [
  { id: 'apple', name: 'Apple Mappe', color: '#1F8BFF', letter: 'A', modes: ['walk', 'car', 'transit'] },
  { id: 'google', name: 'Google Maps', color: '#34A853', letter: 'G', modes: ['walk', 'car', 'transit'] },
  { id: 'waze', name: 'Waze', color: '#33CCFF', letter: 'W', modes: ['car'] },
];
state.navApp = load('navApp') || '';
// Su iPhone si usa il collegamento diretto all'app (maps:// e comgooglemaps://): il link web
// ignora la modalità e apre sempre in auto.
function navUrl(app, mode, d) {
  const ll = `${d.lat},${d.lon}`;
  if (app === 'apple') {
    const flg = { walk: 'w', car: 'd', transit: 'r' }[mode];
    return isIOS ? `maps://?daddr=${ll}&dirflg=${flg}` : `https://maps.apple.com/?daddr=${ll}&dirflg=${flg}`;
  }
  if (app === 'google') {
    return isIOS
      ? `comgooglemaps://?daddr=${ll}&directionsmode=${{ walk: 'walking', car: 'driving', transit: 'transit' }[mode]}`
      : `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=${{ walk: 'walking', car: 'driving', transit: 'transit' }[mode]}`;
  }
  if (app === 'waze') return `https://waze.com/ul?ll=${ll}&navigate=yes`;
  return '#';
}

function renderDest() {
  const d = state.dest, card = $('#destCard');
  card.hidden = !d;
  if (!d) return;
  $('#destLabel').textContent = d.label;
  const parts = [];
  if (state.lastPos) parts.push(`a ${fmtD(distM(state.lastPos, d))} da te`);
  parts.push(`da ${d.byName}`);
  $('#destMeta').textContent = parts.join(' · ');
  const open = $('#destOpen');
  open.href = state.navApp ? navUrl(state.navApp, 'car', d) : '#';
  setLinkTarget(open);
}
$('#destOpen').addEventListener('click', e => {
  if (!state.dest) return e.preventDefault();
  if (!state.navApp) { e.preventDefault(); openNavSheet(); }
});

function openNavSheet() {
  renderNavApps();
  openModal('#navSheet');
}
function renderNavApps() {
  const d = state.dest; if (!d) return;
  const apps = isIOS ? NAV_APPS : [NAV_APPS[1], NAV_APPS[2], NAV_APPS[0]]; // su iPhone Apple Mappe per prima
  $('#navApps').innerHTML = apps.map(a => `<a class="appbtn" data-app="${a.id}" href="${navUrl(a.id, 'car', d)}" rel="noopener">
      <span class="logo" style="background:${a.color}">${a.letter}</span><span><b>${a.name}</b><small>Indicazioni in auto</small></span></a>`).join('');
  $('#navApps').querySelectorAll('.appbtn').forEach(setLinkTarget);
}
// i link web si aprono in una nuova scheda (la chiamata resta qui); quelli delle app no
function setLinkTarget(a) {
  if (/^https?:/.test(a.getAttribute('href'))) a.target = '_blank'; else a.removeAttribute('target');
}
// se l'app scelta non è installata, iPhone non apre niente: lo diciamo
function watchAppOpen(app) {
  if (!isIOS || app !== 'google') return;
  setTimeout(() => { if (!document.hidden) toast('Google Maps non si è aperta: forse non è installata. Scegli un\'altra app nelle impostazioni.', 'bad'); }, 1800);
}
$('#destOpen').addEventListener('click', () => { if (state.navApp) watchAppOpen(state.navApp); });
$('#navApps').addEventListener('click', e => {
  const link = e.target.closest('.appbtn'); if (link) watchAppOpen(link.dataset.app);
  const a = e.target.closest('.appbtn'); if (!a) return;
  if ($('#navRemember').checked) {
    state.navApp = a.dataset.app;
    store('navApp', state.navApp);
    $('#navPref').value = state.navApp;
    renderDest();
  }
  setTimeout(closeModals, 300); // il link si apre nell'app scelta; la chiamata resta qui
});
$('#navClose').addEventListener('click', closeModals);
$('#navCopy').addEventListener('click', async () => {
  const d = state.dest; if (!d) return;
  const text = `${d.label} — ${d.lat.toFixed(6)}, ${d.lon.toFixed(6)}\nhttps://www.google.com/maps/search/?api=1&query=${d.lat},${d.lon}`;
  try { await navigator.clipboard.writeText(text); toast('Posizione della meta copiata'); }
  catch { toast(`${d.lat.toFixed(6)}, ${d.lon.toFixed(6)}`); }
});
$('#navPref').value = state.navApp;
$('#navPref').addEventListener('change', e => {
  state.navApp = e.target.value; store('navApp', state.navApp);
  renderDest();
  toast(state.navApp ? `Indicazioni con ${NAV_APPS.find(a => a.id === state.navApp).name}` : 'Ti chiederò ogni volta quale app usare');
});

$('#destClear').addEventListener('click', () => { send({ t: 'dest', clear: true }); state.dest = null; render(); toast('Meta tolta per tutti'); });
$('#destBtn').addEventListener('click', () => {
  $('#destSearch').value = ''; $('#destResults').innerHTML = ''; $('#destChoices').hidden = false;
  openModal('#destChoose');
});
$('#chooseCancel').addEventListener('click', closeModals);
$('#chooseMap').addEventListener('click', () => {
  closeModals();
  state.picking = true;
  $('#pickBar').hidden = false;
  if (map.m) map.m.getCanvas().style.cursor = 'crosshair';
});
$('#chooseHere').addEventListener('click', () => {
  if (!state.lastPos) return toast('Aspetto ancora la tua posizione.', 'bad');
  setPending({ lat: state.lastPos.lat, lon: state.lastPos.lon });
});
$('#pickCancel').addEventListener('click', stopPicking);
function stopPicking() {
  state.picking = false;
  $('#pickBar').hidden = true;
  if (map.m) map.m.getCanvas().style.cursor = '';
}
function setPending(pt, label = '', fly = false) {
  stopPicking();
  state.pending = pt;
  drawPending();
  if (fly) flyToPoint(pt.lat, pt.lon);
  $('#destWhere').textContent = state.lastPos
    ? `A ${fmtD(distM(state.lastPos, pt))} da te. Tutti nella stanza la vedranno sulla mappa.`
    : 'Tutti nella stanza la vedranno sulla mappa.';
  $('#destName').value = label;
  openModal('#destSheet');
  if (!label) setTimeout(() => $('#destName').focus(), 250);
}

// ricerca per indirizzo (il server interroga OpenStreetMap)
let searchTimer = null, searchSeq = 0, lastResults = [];
$('#destSearch').addEventListener('input', e => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  $('#destChoices').hidden = q.length > 0;
  if (q.length < 3) { $('#destResults').innerHTML = ''; return; }
  searchTimer = setTimeout(() => runSearch(q), 350);
});
$('#destSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); const q = e.target.value.trim(); if (q.length >= 2) runSearch(q); }
});
async function runSearch(q) {
  const seq = ++searchSeq;
  const list = $('#destResults');
  if (!lastResults.length) list.innerHTML = '<li class="note">Cerco…</li>';
  const params = new URLSearchParams({ q });
  if (state.lastPos) { params.set('lat', state.lastPos.lat.toFixed(4)); params.set('lon', state.lastPos.lon.toFixed(4)); }
  let data;
  try {
    const r = await fetch('/geocode?' + params);
    data = await r.json();
  } catch { data = { results: [], error: 'Ricerca non disponibile: controlla la connessione.' }; }
  // se il server non ce la fa, chiede direttamente a Photon dal telefono
  if (!data.results?.length && data.error) {
    try {
      const u = new URL('https://photon.komoot.io/api/');
      u.searchParams.set('q', q); u.searchParams.set('limit', '7');
      if (state.lastPos) { u.searchParams.set('lat', state.lastPos.lat.toFixed(4)); u.searchParams.set('lon', state.lastPos.lon.toFixed(4)); }
      const j = await (await fetch(u)).json();
      const results = (j.features || []).map(f => {
        const p = f.properties || {}, [lon, lat] = f.geometry.coordinates;
        const street = [p.street, p.housenumber].filter(Boolean).join(' ');
        return { name: p.name || street || p.city || '', detail: [p.city || p.town || p.village, p.country].filter(Boolean).join(', '), lat, lon };
      }).filter(r => r.name);
      if (results.length) data = { results };
    } catch {}
  }
  if (seq !== searchSeq) return; // è arrivata una ricerca più recente
  lastResults = data.results || [];
  if (!lastResults.length) {
    list.innerHTML = `<li class="note">${esc(data.error || 'Nessun risultato. Prova ad aggiungere la città.')}</li>`;
    return;
  }
  list.innerHTML = lastResults.map((r, i) => {
    const dist = state.lastPos ? fmtD(distM(state.lastPos, r)) : '';
    return `<li><button type="button" data-i="${i}"><b>${esc(r.name)}</b><small>${esc([r.kind, r.detail].filter(Boolean).join(' · '))}</small><span class="rdist">${dist}</span></button></li>`;
  }).join('');
}
$('#destResults').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  const r = lastResults[+b.dataset.i]; if (!r) return;
  setPending({ lat: r.lat, lon: r.lon }, r.name.slice(0, 40), true);
});

$('#destCancel').addEventListener('click', () => { clearPending(); closeModals(); });
$('#destShare').addEventListener('click', shareDest);
$('#destName').addEventListener('keydown', e => { if (e.key === 'Enter') shareDest(); });
function shareDest() {
  if (!state.pending) return;
  const label = $('#destName').value.trim() || "Punto d'incontro";
  send({ t: 'dest', lat: state.pending.lat, lon: state.pending.lon, label });
  clearPending(); closeModals();
  toast('Meta condivisa con la stanza');
}

/* ---------------- fogli ---------------- */
function openModal(sel) {
  document.querySelectorAll('.modal').forEach(m => { m.hidden = true; });
  $(sel).hidden = false; $('#scrim').hidden = false;
}
function closeModals() {
  document.querySelectorAll('.modal').forEach(m => { m.hidden = true; });
  $('#scrim').hidden = true;
}
$('#scrim').addEventListener('click', () => { clearPending(); closeModals(); });
$('#moreBtn').addEventListener('click', () => { renderDiag(); openModal('#moreSheet'); });
$('#moreClose').addEventListener('click', closeModals);
new ResizeObserver(([e]) => {
  const h = Math.round(e.target.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--sheet-h', h + 'px');
}).observe($('#bottom'));

/* ---------------- impostazioni ---------------- */
$('#radius').addEventListener('input', e => { state.radius = +e.target.value; $('#radiusOut').textContent = fmtR(state.radius); });
$('#radius').addEventListener('change', () => {
  send({ t: 'settings', radius: state.radius }); store('radius', state.radius);
  for (const p of state.peers.values()) applyVolume(p);
  render();
  if (map.follow) fitRadius();
});
$('#pttToggle').addEventListener('change', e => {
  state.ptt = e.target.checked; state.talking = false;
  store('ptt', state.ptt ? '1' : '0');
  if (state.ptt) state.muted = false;
  syncMic();
  toast(state.ptt ? 'Premi per parlare attivo: tieni premuto il microfono quando vuoi parlare.' : 'Microfono sempre aperto.');
});
$('#carKeysToggle').addEventListener('change', e => {
  state.carKeys = e.target.checked;
  store('carKeys', state.carKeys ? '1' : '0');
  if (state.carKeys) startKeepAlive(); else stopKeepAlive();
});
$('#invisibleToggle').addEventListener('change', e => {
  state.invisible = e.target.checked;
  send({ t: 'settings', paused: state.invisible });
  render();
});
$('#wakeToggle').addEventListener('change', async e => {
  if (!('wakeLock' in navigator)) { e.target.checked = false; return toast('Questo browser non può tenere lo schermo acceso.', 'bad'); }
  state.wantWake = e.target.checked;
  if (state.wantWake) await acquireWake(); else { try { await state.wake?.release(); } catch {} state.wake = null; }
  renderDiag();
});
async function acquireWake() {
  try {
    state.wake = await navigator.wakeLock.request('screen');
    state.wake.addEventListener('release', () => { state.wake = null; renderDiag(); });
  } catch { state.wake = null; }
}
$('#leaveBtn').addEventListener('click', () => {
  state.leaving = true;
  try { state.ws.close(); } catch {}
  stopAll();
  location.href = '/?stanza=' + state.room;
});
function stopAll() {
  for (const id of [...state.peers.keys()]) closePeer(id);
  state.peers.clear();
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  stopKeepAlive();
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  try { state.wake?.release(); } catch {}
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
}

/* ---------------- invito ---------------- */
async function share() {
  const url = `${location.origin}/?stanza=${state.room}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Portata', text: `Entra nella stanza ${state.room} su Portata`, url }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link della stanza copiato'); }
  catch { toast(url); }
}
$('#roomPill').addEventListener('click', share);

/* ---------------- mappa ---------------- */
// Mappa vettoriale MapLibre con gli stili gratuiti di OpenFreeMap (nessuna chiave, nessun limite).
// Standard: "liberty", chiara e pulita, simile a Google Maps. Scura: "dark".
// Satellite: immagini Esri con strade e nomi sopra.
const OFM = 'https://tiles.openfreemap.org/styles/';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const SAT_STYLE = {
  version: 8,
  sources: {
    sat: { type: 'raster', tileSize: 256, maxzoom: 19, attribution: 'Immagini &copy; Esri, Maxar, Earthstar Geographics',
      tiles: [ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
    roads: { type: 'raster', tileSize: 256, maxzoom: 19, tiles: [ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'] },
    places: { type: 'raster', tileSize: 256, maxzoom: 19, tiles: [ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'] },
  },
  layers: [
    { id: 'sat', type: 'raster', source: 'sat' },
    { id: 'roads', type: 'raster', source: 'roads', paint: { 'raster-opacity': 0.85 } },
    { id: 'places', type: 'raster', source: 'places' },
  ],
};
const STYLES = { std: OFM + 'liberty', dark: OFM + 'dark', sat: SAT_STYLE };
state.mapStyle = ['std', 'dark', 'sat'].includes(load('mapStyle')) ? load('mapStyle') : 'std';

const map = { m: null, ready: false, me: null, destMk: null, pendingMk: null, markers: new Map(), follow: true, fitted: false, lastHere: null };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const sheetH = () => parseInt(cssVar('--sheet-h')) || 0;
const pad = () => ({ top: 90, bottom: sheetH() + 20, left: 24, right: 24 });

// i pannelli in vetro prendono il tono della mappa sotto: chiari sulla mappa chiara, scuri sulle altre
function applyTone() {
  const tone = state.mapStyle === 'std' ? 'light' : 'dark';
  $('#callView').dataset.tone = tone;
}

function setMapStyle(style) {
  state.mapStyle = style; store('mapStyle', style);
  applyTone();
  document.querySelectorAll('#layersMenu button').forEach(b => {
    b.classList.toggle('on', b.dataset.style === style);
    b.setAttribute('aria-checked', String(b.dataset.style === style));
  });
  if (!map.m) return;
  map.ready = false;
  map.m.setStyle(STYLES[style]);
}
$('#layersBtn').addEventListener('click', e => {
  const menu = $('#layersMenu'); menu.hidden = !menu.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!menu.hidden));
});
$('#layersMenu').addEventListener('click', e => {
  const b = e.target.closest('button[data-style]'); if (!b) return;
  setMapStyle(b.dataset.style);
  $('#layersMenu').hidden = true; $('#layersBtn').setAttribute('aria-expanded', 'false');
});

function initMap() {
  applyTone();
  if (!window.maplibregl) { toast('Mappa non disponibile: controlla la connessione e ricarica la pagina.', 'bad'); return; }
  try {
    map.m = new maplibregl.Map({
      container: 'map', style: STYLES[state.mapStyle], center: [12.5, 41.9], zoom: 5,
      attributionControl: { compact: true }, pitchWithRotate: false, dragRotate: false, touchPitch: false, maxZoom: 19,
    });
  } catch (err) {
    console.warn(err);
    toast('Questo telefono non riesce a disegnare la mappa.', 'bad'); return;
  }
  map.m.touchZoomRotate.disableRotation();
  map.m.on('style.load', () => { addOverlay(); map.ready = true; updateMap(); });
  map.m.on('dragstart', () => { map.follow = false; map.closeUp = false; });
  map.m.on('click', e => {
    $('#layersMenu').hidden = true; $('#layersBtn').setAttribute('aria-expanded', 'false');
    if (state.picking) setPending({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  });
  // come su Google Maps: primo tocco ti centra da vicino, il secondo mostra tutto il cerchio
  $('#recenterBtn').addEventListener('click', () => {
    if (!state.lastPos) return toast('Aspetto ancora la tua posizione.');
    const { lat, lon } = state.lastPos;
    const centred = map.follow && distM({ lat: map.m.getCenter().lat, lon: map.m.getCenter().lng }, { lat, lon }) < 60;
    map.follow = true;
    if (map.closeUp && centred) { map.closeUp = false; fitRadius(); }
    else { map.closeUp = true; map.m.easeTo({ center: [lon, lat], zoom: 16.5, padding: pad(), duration: 700 }); }
  });
  document.querySelectorAll('#layersMenu button').forEach(b => b.classList.toggle('on', b.dataset.style === state.mapStyle));
}

// cerchio del raggio e linee verso chi è in chiamata: livelli disegnati sopra la mappa
function circle(lat, lon, r, steps = 72) {
  const pts = [], dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
  for (let i = 0; i <= steps; i++) { const a = i / steps * 2 * Math.PI; pts.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]); }
  return pts;
}
const EMPTY = { type: 'FeatureCollection', features: [] };
function addOverlay() {
  const m = map.m;
  const accent = cssVar('--accent'), live = cssVar('--live'), warn = cssVar('--warn');
  for (const id of ['radius', 'links']) if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: EMPTY });
  const add = l => { if (!m.getLayer(l.id)) m.addLayer(l); };
  add({ id: 'radius-fill', type: 'fill', source: 'radius', filter: ['==', ['get', 'k'], 'inner'], paint: { 'fill-color': accent, 'fill-opacity': 0.08 } });
  add({ id: 'radius-line', type: 'line', source: 'radius', filter: ['==', ['get', 'k'], 'inner'], paint: { 'line-color': accent, 'line-width': 2.5 } });
  add({ id: 'margin-line', type: 'line', source: 'radius', filter: ['==', ['get', 'k'], 'outer'], paint: { 'line-color': accent, 'line-width': 1.2, 'line-opacity': 0.5, 'line-dasharray': [2, 3] } });
  add({ id: 'links-live', type: 'line', source: 'links', filter: ['==', ['get', 's'], 'live'], layout: { 'line-cap': 'round' }, paint: { 'line-color': live, 'line-width': 3, 'line-opacity': 0.8 } });
  add({ id: 'links-wait', type: 'line', source: 'links', filter: ['==', ['get', 's'], 'connecting'], layout: { 'line-cap': 'round' }, paint: { 'line-color': warn, 'line-width': 2.5, 'line-opacity': 0.8, 'line-dasharray': [1, 2] } });
}

function fitRadius() {
  if (!map.m || !state.lastPos) return;
  const { lat, lon } = state.lastPos, r = state.radius * (1 + state.exitMargin);
  const dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
  map.m.fitBounds([[lon - dLon, lat - dLat], [lon + dLon, lat + dLat]], { padding: pad(), duration: map.fitted ? 700 : 0, maxZoom: 17 });
}
function flyToPoint(lat, lon) {
  if (!map.m) return;
  map.follow = false;
  map.m.flyTo({ center: [lon, lat], zoom: Math.max(map.m.getZoom(), 16), padding: pad(), duration: 900 });
}

function pinEl(cls, letter, label) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="pin ${cls}"><div class="dot">${esc(letter)}</div>${label ? `<div class="lbl">${esc(label)}</div>` : ''}</div>`;
  return el;
}
function destEl(label, pending) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="destpin${pending ? ' pending' : ''}"><div class="head"></div><div class="lbl">${esc(label)}</div></div>`;
  return el;
}
function marker(el, lat, lon) { return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(map.m); }

function drawPending() {
  if (!map.m || !state.pending) return;
  if (map.pendingMk) map.pendingMk.setLngLat([state.pending.lon, state.pending.lat]);
  else map.pendingMk = marker(destEl('Nuova meta', true), state.pending.lat, state.pending.lon);
}
function clearPending() {
  state.pending = null;
  if (map.pendingMk) { map.pendingMk.remove(); map.pendingMk = null; }
}

function updateMap() {
  if (!map.m) return;
  // meta
  if (state.dest) {
    const key = state.dest.label;
    if (map.destMk && map.destMk._key !== key) { map.destMk.remove(); map.destMk = null; }
    if (!map.destMk) { map.destMk = marker(destEl(key), state.dest.lat, state.dest.lon); map.destMk._key = key; }
    else map.destMk.setLngLat([state.dest.lon, state.dest.lat]);
  } else if (map.destMk) { map.destMk.remove(); map.destMk = null; }

  // persone
  const seen = new Set(), links = [];
  const here = state.lastPos && [state.lastPos.lon, state.lastPos.lat];
  for (const p of state.peers.values()) {
    if (p.lat == null || p.lon == null) continue;
    seen.add(p.id);
    const [cls] = peerStatus(p);
    const pinCls = cls + (p.music ? ' music' : '');
    const key = pinCls + '|' + p.name;
    let mk = map.markers.get(p.id);
    if (mk && mk._key !== key) { mk.remove(); mk = null; }
    if (!mk) { mk = marker(pinEl(pinCls, (p.name[0] || '?').toUpperCase(), p.name), p.lat, p.lon); mk._key = key; map.markers.set(p.id, mk); }
    else mk.setLngLat([p.lon, p.lat]);
    if (here && (cls === 'live' || cls === 'connecting')) links.push({ type: 'Feature', properties: { s: cls }, geometry: { type: 'LineString', coordinates: [here, [p.lon, p.lat]] } });
  }
  for (const [id, mk] of map.markers) if (!seen.has(id)) { mk.remove(); map.markers.delete(id); }

  if (!state.lastPos) return;
  const { lat, lon } = state.lastPos;
  if (!map.me) map.me = marker(pinEl('me', ''), lat, lon);
  map.me.setLngLat([lon, lat]);

  if (map.ready) {
    map.m.getSource('radius')?.setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { k: 'inner' }, geometry: { type: 'Polygon', coordinates: [circle(lat, lon, state.radius)] } },
      { type: 'Feature', properties: { k: 'outer' }, geometry: { type: 'LineString', coordinates: circle(lat, lon, state.radius * (1 + state.exitMargin)) } },
    ] });
    map.m.getSource('links')?.setData({ type: 'FeatureCollection', features: links });
  }
  if (!map.fitted) { fitRadius(); map.fitted = true; }
  else if (map.follow && (!map.lastHere || distM({ lat, lon }, map.lastHere) > 5)) map.m.easeTo({ center: [lon, lat], padding: pad(), duration: 600 });
  map.lastHere = { lat, lon };
}

/* ---------------- mini finestra (PiP) ---------------- */
const pipCanvas = document.createElement('canvas');
pipCanvas.width = 640; pipCanvas.height = 360;
const pctx = pipCanvas.getContext('2d');

function startPip() {
  const v = $('#pipVideo');
  drawPip();
  if (!pipCanvas.captureStream) return;
  v.srcObject = pipCanvas.captureStream(10);
  v.play().catch(() => {});
  v.addEventListener('enterpictureinpicture', () => { state.pipOpen = true; renderDock(); renderDiag(); });
  v.addEventListener('leavepictureinpicture', () => { state.pipOpen = false; renderDock(); renderDiag(); });
  v.addEventListener('webkitpresentationmodechanged', () => { state.pipOpen = v.webkitPresentationMode === 'picture-in-picture'; renderDock(); renderDiag(); });
  // Chrome può aprire la mini finestra da solo quando cambi app
  try { navigator.mediaSession.setActionHandler('enterpictureinpicture', () => openPip()); } catch {}
}

async function openPip() {
  const v = $('#pipVideo');
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
    if (v.webkitPresentationMode === 'picture-in-picture') { v.webkitSetPresentationMode('inline'); return; }
    if (v.paused) v.play().catch(() => {});
    if (document.pictureInPictureEnabled && v.requestPictureInPicture) await v.requestPictureInPicture();
    else if (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) v.webkitSetPresentationMode('picture-in-picture');
    else throw new Error('pip non supportato');
  } catch (err) {
    console.warn(err);
    toast('La mini finestra non è disponibile su questo browser.', 'bad');
  }
}
$('#pipBtn').addEventListener('click', async () => { await openPip(); closeModals(); });

function drawPip() {
  const c = pctx, W = 640, H = 360;
  const live = livePeers();
  c.fillStyle = '#0B1016'; c.fillRect(0, 0, W, H);
  const accent = state.music ? '#A98BFF' : live.length ? '#3DDC84' : '#6B7887';
  c.fillStyle = accent; c.fillRect(0, 0, W, 8);
  c.textBaseline = 'alphabetic'; c.textAlign = 'left';
  c.font = '600 22px -apple-system, system-ui, sans-serif'; c.fillStyle = '#9AA7B6';
  c.fillText(`PORTATA · ${state.room}`, 28, 50);
  c.textAlign = 'right'; c.fillText(new Date().toLocaleTimeString('it-IT'), W - 28, 50); c.textAlign = 'left';
  c.fillStyle = '#EEF2F7'; c.font = '700 40px -apple-system, system-ui, sans-serif';
  c.fillText(live.length ? `In chiamata · ${live.length}` : statusText()[0], 28, 104, W - 56);

  const rows = [...state.peers.values()].filter(p => p.linked).sort((a, b) => b.level - a.level).slice(0, 3);
  rows.forEach((p, i) => {
    const y = 158 + i * 52;
    c.fillStyle = p.level > 0.03 ? '#3DDC84' : '#26313C';
    c.beginPath(); c.arc(46, y - 11, 15, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#EEF2F7'; c.font = '600 30px -apple-system, system-ui, sans-serif';
    c.fillText(p.name, 76, y, 330);
    c.fillStyle = '#9AA7B6'; c.font = '500 25px ui-monospace, monospace'; c.textAlign = 'right';
    c.fillText(fmtD(p.distance), W - 28, y); c.textAlign = 'left';
  });
  if (!rows.length) {
    c.fillStyle = '#9AA7B6'; c.font = '500 27px -apple-system, system-ui, sans-serif';
    c.fillText(state.dest ? `Meta: ${state.dest.label}` : `Ti avviso qui quando qualcuno è entro ${fmtR(state.radius)}`, 28, 172, W - 56);
  }
  const micText = state.music ? (state.musicTalk ? 'Stai parlando · musica in pausa' : 'Musica · microfono in pausa') : state.ptt ? 'Premi per parlare' : state.muted ? 'Microfono spento' : 'Microfono attivo';
  c.fillStyle = state.music ? '#A98BFF' : state.muted && !state.ptt ? '#FF6B6E' : '#3DDC84';
  c.font = '600 23px -apple-system, system-ui, sans-serif';
  c.fillText(micText, 28, H - 28);
  c.fillStyle = '#9AA7B6'; c.textAlign = 'right';
  c.fillText(state.dest && state.lastPos ? `meta a ${fmtD(distM(state.lastPos, state.dest))}` : state.lastPos ? `posizione ${ago(state.lastPos.ts)} fa` : 'posizione in attesa', W - 28, H - 28);
  c.textAlign = 'left';
}

// Quello che compare sullo schermo dell'auto, nel Centro di Controllo e sulla schermata di blocco.
let lastMeta = '';
function updateMediaSession() {
  if (!('mediaSession' in navigator) || !window.MediaMetadata || !state.room || state.music) return;
  const mic = state.ptt ? (state.talking ? 'Stai parlando' : 'Premi per parlare')
    : state.muted ? 'Microfono spento' : 'Microfono acceso';
  const title = mic, artist = statusText()[0], album = `Portata · ${state.room}`;
  const key = title + '|' + artist;
  if (key === lastMeta) return;
  lastMeta = key;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist, album,
      artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    });
  } catch {}
}

/* ---------------- secondo piano: diagnostica ---------------- */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    talk(false);
    away = { start: Date.now(), pos: 0, sent: 0, msgs: 0, wsDrops: 0, micMuted: !!state.micTrack?.muted, micEnded: false, pip: state.pipOpen, wake: !!state.wake, music: state.music };
    return;
  }
  if (state.wantWake && !state.wake) acquireWake();
  if (state.ctx) state.ctx.resume().catch(() => {});
  if (away && !away.music && state.micTrack) report(away);
  away = null;
  maybeSendPos(true);
  render();
  // se tornando qui il microfono è ancora preso da un'altra app (musica), passa alla modalità musica
  setTimeout(checkMicTaken, 2000);
});

function report(a) {
  const secs = Math.round((Date.now() - a.start) / 1000);
  if (secs < 5) return;
  const dur = secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${secs % 60} s`;
  const short = secs < 20;
  const posOk = a.pos > 0, micOk = !a.micMuted && !a.micEnded, wsOk = a.wsDrops === 0;
  const line = (ok, text) => `<span class="${ok ? 'ok' : short ? 'meh' : 'ko'}">${text}</span>`;
  const items = [
    line(posOk, posOk ? `Posizione aggiornata ${a.pos} ${a.pos === 1 ? 'volta' : 'volte'}` : 'Posizione mai aggiornata'),
    line(micOk, micOk ? 'Microfono sempre attivo' : 'Microfono interrotto dal sistema'),
    line(wsOk, wsOk ? 'Collegamento al server mantenuto' : 'Collegamento al server perso'),
  ];
  const cls = posOk && micOk && wsOk ? 'good' : !posOk && !micOk ? 'bad' : 'mixed';
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = `<b>Fuori per ${dur} · mini finestra ${a.pip ? 'aperta' : 'chiusa'}${a.wake ? ' · schermo acceso' : ''}</b>${items.join('<br>')}${short ? '<br><span class="muted small">Resta fuori almeno 30 secondi per un risultato affidabile.</span>' : ''}`;
  $('#awayLog').prepend(li);
  while ($('#awayLog').children.length > 8) $('#awayLog').lastChild.remove();
}

/* ---------------- cicli ---------------- */
setInterval(() => {
  if (!document.hidden) tickLevels();
  else for (const p of state.peers.values()) p.level = p.analyser ? rms(p.analyser) : 0;
  if (state.room) drawPip();
}, 250);
setInterval(() => { if (state.room) { renderDiag(); maybeSendPos(); renderDest(); } }, 1000);
