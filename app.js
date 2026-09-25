'use strict';
// Portata — client
// Posizione dal GPS del browser, audio con WebRTC (collegamenti diretti tra telefoni),
// mini finestra PiP disegnata su canvas, diagnostica di cosa succede in secondo piano.

const $ = s => document.querySelector(s);
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const state = {
  id: null, room: '', name: '', ice: [], radius: 1000, exitMargin: 0.1,
  ws: null, wsOk: false, retry: 1000, leaving: false,
  stream: null, micTrack: null, muted: false, paused: false,
  ctx: null, localAnalyser: null,
  watchId: null, lastPos: null, geoError: null, lastSent: null, lastSentAt: 0,
  peers: new Map(),
  wake: null, wantWake: false, pipOpen: false,
};
let away = null; // statistiche mentre la pagina è in secondo piano

/* ---------------- utilità ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtD = d => d == null ? '—' : d < 995 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(2).replace('.', ',')} km`;
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
function flash(btn, text) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old; btn.textContent = text;
  setTimeout(() => { btn.textContent = btn.dataset.label; delete btn.dataset.label; }, 2000);
}
function send(m) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(m)); }

/* ---------------- ingresso ---------------- */
(function prefill() {
  const q = new URLSearchParams(location.search).get('stanza');
  $('#room').value = (q || load('room') || '').toUpperCase();
  $('#name').value = load('name') || '';
  const r = +load('radius'); if (r >= 100 && r <= 1000) state.radius = r;
})();

function micErrorText(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return isIOS
      ? 'Safari ha bloccato il microfono per questo sito. Tocca l\'icona a sinistra dell\'indirizzo → Impostazioni sito web → Microfono: Consenti. Poi ricarica la pagina.'
      : 'Il browser ha bloccato il microfono per questo sito. Tocca il lucchetto o l\'icona accanto all\'indirizzo, consenti il microfono e ricarica la pagina.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Non trovo nessun microfono su questo dispositivo.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Il microfono è occupato da un\'altra app, per esempio una chiamata in corso. Chiudila e riprova.';
  return `Non riesco ad attivare il microfono (${name || 'errore sconosciuto'}). Ricarica la pagina e riprova.`;
}

function joinError(msg) { const e = $('#joinError'); e.textContent = msg; e.hidden = !msg; }

$('#joinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#name').value.trim();
  const room = $('#room').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!name || room.length < 3) return joinError('Scrivi il tuo nome e un codice stanza di almeno 3 lettere o numeri.');
  if (!window.isSecureContext || !navigator.mediaDevices) return joinError('Il browser dà accesso a microfono e posizione solo su pagine https://. Apri la versione pubblicata online.');
  if (!('geolocation' in navigator)) return joinError('Questo browser non può leggere la posizione.');

  const btn = $('#joinBtn'); btn.disabled = true; joinError('');
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (err) {
    btn.disabled = false;
    return joinError(micErrorText(err));
  }
  try { state.ctx = new (window.AudioContext || window.webkitAudioContext)(); await state.ctx.resume(); } catch { state.ctx = null; }
  state.micTrack = state.stream.getAudioTracks()[0];
  state.micTrack.addEventListener('mute', () => { if (away) away.micMuted = true; renderDiag(); });
  state.micTrack.addEventListener('ended', () => { if (away) away.micEnded = true; renderDiag(); });
  if (state.ctx) {
    try {
      const src = state.ctx.createMediaStreamSource(state.stream);
      state.localAnalyser = state.ctx.createAnalyser(); state.localAnalyser.fftSize = 512;
      src.connect(state.localAnalyser);
    } catch {}
  }

  state.name = name; state.room = room;
  store('name', name); store('room', room);
  history.replaceState(null, '', '?stanza=' + room);
  $('#roomLabel').textContent = room;
  $('#radius').value = state.radius; $('#radiusOut').textContent = fmtR(state.radius);
  $('#joinView').hidden = true; $('#callView').hidden = false;

  initMap();
  startGeo();
  startPip();
  connect();
  render();
});

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
    send({ t: 'join', room: state.room, name: state.name, radius: state.radius });
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
      if (state.paused) send({ t: 'settings', paused: true });
      maybeSendPos(true);
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
        Object.assign(p, { name: info.name, distance: info.distance, linked: info.linked, paused: info.paused, hasPos: info.hasPos, lat: info.lat, lon: info.lon });
        applyVolume(p);
      }
      for (const id of [...state.peers.keys()]) if (!seen.has(id)) { closePeer(id); state.peers.delete(id); }
      render();
      break;
    }
    case 'link': openPeer(m.peer, m.initiator); render(); break;
    case 'unlink': closePeer(m.peer); render(); break;
    case 'signal': onSignal(m.from, m.data); break;
  }
}

/* ---------------- WebRTC ---------------- */
function peer(id) {
  if (!state.peers.has(id)) state.peers.set(id, { id, name: '…', distance: null, linked: false, paused: false, hasPos: false, pc: null, audio: null, analyser: null, src: null, queue: [], conn: 'new', level: 0 });
  return state.peers.get(id);
}

function openPeer(id, initiator) {
  const p = peer(id);
  if (p.pc) closePeer(id);
  p.linked = true;
  const pc = new RTCPeerConnection({ iceServers: state.ice });
  p.pc = pc; p.initiator = initiator; p.queue = []; p.conn = 'new';
  for (const t of state.stream.getTracks()) pc.addTrack(t, state.stream);
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

// volume che scende con la distanza (su iPhone il browser ignora questa impostazione)
function applyVolume(p) {
  if (!p.audio) return;
  const d = p.distance ?? 0, R = state.radius;
  p.audio.volume = d <= 50 ? 1 : clamp(1 - (d - 50) / (R * (1 + state.exitMargin) - 50), 0.15, 1);
}

function rms(an) {
  if (!an) return 0;
  const buf = new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(buf);
  let s = 0; for (const v of buf) { const x = (v - 128) / 128; s += x * x; }
  return Math.sqrt(s / buf.length);
}

/* ---------------- interfaccia ---------------- */
function peerStatus(p) {
  if (p.paused) return ['paused', 'In pausa'];
  if (!p.hasPos) return ['nopos', 'Posizione non disponibile'];
  if (p.linked && p.conn === 'connected') return ['live', 'In chiamata'];
  if (p.linked) return ['connecting', p.conn === 'failed' ? 'Collegamento non riuscito' : 'Collegamento…'];
  return ['out', 'Fuori portata'];
}
const liveCount = () => [...state.peers.values()].filter(p => peerStatus(p)[0] === 'live').length;

function statusText() {
  const n = liveCount(), total = state.peers.size;
  if (!state.wsOk) return ['Connessione al server…', 'Se non si collega, controlla la connessione internet.'];
  if (state.paused) return ['In pausa', 'Non entri in nessuna chiamata e non compari sulla mappa degli altri.'];
  if (!state.lastPos) return ['Cerco la tua posizione…', state.geoError || 'Può servire qualche secondo, meglio all\'aperto.'];
  if (n > 0) return [`In chiamata con ${n} ${n === 1 ? 'persona' : 'persone'}`,
    isIOS ? 'Su iPhone il volume non cambia con la distanza.' : 'Il volume scende con la distanza.'];
  return [`Nessuno entro ${fmtR(state.radius)}`,
    `Entri in chiamata appena qualcuno della stanza si avvicina. ${total === 0 ? 'Per ora nella stanza ci sei solo tu.' : `Nella stanza: ${total} ${total === 1 ? 'altra persona' : 'altre persone'}.`}`];
}

function render() {
  const [title, sub] = statusText();
  $('#statusTitle').textContent = title;
  $('#statusSub').textContent = sub;
  $('#statusCard').classList.toggle('is-live', liveCount() > 0);
  const order = { live: 0, connecting: 1, out: 2, nopos: 3, paused: 4 };
  const list = [...state.peers.values()].sort((a, b) =>
    order[peerStatus(a)[0]] - order[peerStatus(b)[0]] || (a.distance ?? 1e9) - (b.distance ?? 1e9));
  $('#people').innerHTML = list.map(p => {
    const [cls, label] = peerStatus(p);
    return `<li class="person p-${cls}" data-id="${esc(p.id)}">
      <span class="av">${esc(p.name[0] || '?').toUpperCase()}</span>
      <div><div class="pname">${esc(p.name)}</div><div class="pmeta"><span class="mono">${fmtD(p.distance)}</span> · <span class="pstate">${label}</span></div></div>
      <div class="meter" aria-hidden="true"><i></i></div></li>`;
  }).join('');
  $('#emptyRoom').hidden = state.peers.size > 0 || !state.wsOk;
  updateMap();
  updateMediaSession(title);
  renderDiag();
}

function tickLevels() {
  for (const p of state.peers.values()) {
    p.level = p.analyser ? rms(p.analyser) : 0;
    const li = document.querySelector(`.person[data-id="${CSS.escape(p.id)}"]`);
    if (!li) continue;
    li.querySelector('.meter i').style.width = `${Math.round(clamp(p.level * 600, 0, 100))}%`;
    li.querySelector('.av').classList.toggle('speaking', p.level > 0.03);
    const pin = map.markers.get(p.id)?.getElement()?.querySelector('.pin');
    if (pin) pin.classList.toggle('speaking', p.level > 0.03);
  }
}

/* ---------------- mappa ---------------- */
const map = { m: null, me: null, radius: null, margin: null, markers: new Map(), lines: new Map(), follow: true, fitted: false, lastHere: null };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function initMap() {
  if (!window.L) { $('#mapHint').textContent = 'Mappa non disponibile: controlla la connessione e ricarica la pagina.'; return; }
  map.m = L.map('map', { zoomControl: true }).setView([41.9, 12.5], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map.m);
  map.m.on('dragstart', () => { map.follow = false; $('#recenterBtn').hidden = false; });
  $('#recenterBtn').addEventListener('click', () => { map.follow = true; $('#recenterBtn').hidden = true; fitRadius(); });
  setTimeout(() => map.m.invalidateSize(), 100);
}

function fitRadius() { if (map.m && map.margin) map.m.fitBounds(map.margin.getBounds(), { padding: [8, 8] }); }

function pinIcon(cls, letter, label) {
  return L.divIcon({
    className: '', iconSize: [0, 0],
    html: `<div class="pin ${cls}"><div class="dot">${esc(letter)}</div>${label ? `<div class="lbl">${esc(label)}</div>` : ''}</div>`,
  });
}

function updateMap() {
  if (!map.m || !state.lastPos) return;
  const here = [state.lastPos.lat, state.lastPos.lon];
  const accent = cssVar('--accent'), warn = cssVar('--warn'), live = cssVar('--live');
  const outer = state.radius * (1 + state.exitMargin);

  if (!map.me) {
    map.radius = L.circle(here, { radius: state.radius, color: accent, weight: 2, fillColor: accent, fillOpacity: 0.08, interactive: false }).addTo(map.m);
    map.margin = L.circle(here, { radius: outer, color: warn, weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(map.m);
    map.me = L.marker(here, { icon: pinIcon('me', 'Tu'), zIndexOffset: 1000, keyboard: false }).addTo(map.m);
    $('#mapHint').hidden = true;
  }
  map.me.setLatLng(here);
  map.radius.setLatLng(here).setRadius(state.radius);
  map.margin.setLatLng(here).setRadius(outer);
  if (!map.fitted) { fitRadius(); map.fitted = true; }
  else if (map.follow && (!map.lastHere || distM({ lat: here[0], lon: here[1] }, map.lastHere) > 5)) map.m.panTo(here);
  map.lastHere = { lat: here[0], lon: here[1] };

  const seen = new Set();
  for (const p of state.peers.values()) {
    if (p.lat == null || p.lon == null) continue;
    seen.add(p.id);
    const [cls] = peerStatus(p), ll = [p.lat, p.lon], key = cls + '|' + p.name;
    let mk = map.markers.get(p.id);
    if (!mk) {
      mk = L.marker(ll, { icon: pinIcon(cls, (p.name[0] || '?').toUpperCase(), p.name), keyboard: false }).addTo(map.m);
      mk._key = key; map.markers.set(p.id, mk);
    } else {
      mk.setLatLng(ll);
      if (mk._key !== key) { mk.setIcon(pinIcon(cls, (p.name[0] || '?').toUpperCase(), p.name)); mk._key = key; }
    }
    let ln = map.lines.get(p.id);
    if (cls === 'live' || cls === 'connecting') {
      const color = cls === 'live' ? live : warn;
      if (!ln) { ln = L.polyline([here, ll], { color, weight: 2, opacity: 0.7, interactive: false }).addTo(map.m); map.lines.set(p.id, ln); }
      else { ln.setLatLngs([here, ll]); ln.setStyle({ color }); }
    } else if (ln) { ln.remove(); map.lines.delete(p.id); }
  }
  for (const [id, mk] of map.markers) {
    if (seen.has(id)) continue;
    mk.remove(); map.markers.delete(id);
    const ln = map.lines.get(id); if (ln) { ln.remove(); map.lines.delete(id); }
  }
}

function renderDiag() {
  const set = (id, text, cls) => { const el = $(id); el.textContent = text; el.className = cls || ''; };
  if (state.lastPos) set('#dPos', `${ago(state.lastPos.ts)} fa · ±${Math.round(state.lastPos.acc)} m`, Date.now() - state.lastPos.ts < 30000 ? 'ok' : 'meh');
  else set('#dPos', state.geoError ? 'non disponibile' : 'in attesa', state.geoError ? 'ko' : 'meh');
  set('#dWs', state.wsOk ? 'collegato' : 'non collegato', state.wsOk ? 'ok' : 'ko');
  const t = state.micTrack;
  if (!t) set('#dMic', '—');
  else if (t.readyState === 'ended') set('#dMic', 'terminato', 'ko');
  else if (t.muted) set('#dMic', 'silenziato dal sistema', 'ko');
  else if (state.muted) set('#dMic', 'spento da te', 'meh');
  else set('#dMic', 'attivo', 'ok');
  set('#dPip', state.pipOpen ? 'aperta' : 'chiusa', state.pipOpen ? 'ok' : '');
  set('#dWake', state.wake ? 'sì' : 'no', state.wake ? 'ok' : '');
}

/* ---------------- controlli ---------------- */
$('#micBtn').addEventListener('click', e => {
  state.muted = !state.muted;
  if (state.micTrack) state.micTrack.enabled = !state.muted;
  e.currentTarget.setAttribute('aria-pressed', String(state.muted));
  e.currentTarget.textContent = state.muted ? 'Microfono spento' : 'Microfono attivo';
  renderDiag();
});
$('#pauseBtn').addEventListener('click', e => {
  state.paused = !state.paused;
  send({ t: 'settings', paused: state.paused });
  e.currentTarget.setAttribute('aria-pressed', String(state.paused));
  e.currentTarget.textContent = state.paused ? 'Riprendi' : 'Pausa';
  render();
});
$('#radius').addEventListener('input', e => { state.radius = +e.target.value; $('#radiusOut').textContent = fmtR(state.radius); });
$('#radius').addEventListener('change', () => {
  send({ t: 'settings', radius: state.radius }); store('radius', state.radius);
  for (const p of state.peers.values()) applyVolume(p);
  render();
  if (map.follow) fitRadius();
});
$('#shareBtn').addEventListener('click', async e => {
  const btn = e.currentTarget;
  const url = `${location.origin}/?stanza=${state.room}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Portata', text: `Entra nella stanza ${state.room} su Portata`, url }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); flash(btn, 'Link copiato'); }
  catch { prompt('Copia questo link', url); }
});
$('#wakeBtn').addEventListener('click', async e => {
  const btn = e.currentTarget;
  if (!('wakeLock' in navigator)) return flash(btn, 'Non supportato');
  state.wantWake = !state.wantWake;
  if (state.wantWake) await acquireWake(); else { try { await state.wake?.release(); } catch {} state.wake = null; }
  btn.setAttribute('aria-pressed', String(state.wantWake));
  renderDiag();
});
async function acquireWake() {
  try {
    state.wake = await navigator.wakeLock.request('screen');
    state.wake.addEventListener('release', () => { state.wake = null; renderDiag(); });
  } catch { state.wake = null; }
}
$('#pipBtn').addEventListener('click', openPip);
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
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  try { state.wake?.release(); } catch {}
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
}

/* ---------------- mini finestra (PiP) ---------------- */
const pipCanvas = document.createElement('canvas');
pipCanvas.width = 640; pipCanvas.height = 360;
const pctx = pipCanvas.getContext('2d');

function startPip() {
  const v = $('#pipVideo');
  drawPip();
  if (!pipCanvas.captureStream) { $('#pipBtn').disabled = true; return; }
  v.srcObject = pipCanvas.captureStream(10);
  v.play().catch(() => {});
  v.addEventListener('enterpictureinpicture', () => { state.pipOpen = true; renderDiag(); });
  v.addEventListener('leavepictureinpicture', () => { state.pipOpen = false; renderDiag(); });
  v.addEventListener('webkitpresentationmodechanged', () => { state.pipOpen = v.webkitPresentationMode === 'picture-in-picture'; renderDiag(); });
  // Chrome può aprire la mini finestra da solo quando cambi scheda o app
  try { navigator.mediaSession.setActionHandler('enterpictureinpicture', () => openPip()); } catch {}
}

async function openPip() {
  const v = $('#pipVideo');
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
    if (v.webkitPresentationMode === 'picture-in-picture') { v.webkitSetPresentationMode('inline'); return; }
    if (v.paused) await v.play();
    if (document.pictureInPictureEnabled && v.requestPictureInPicture) await v.requestPictureInPicture();
    else if (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) v.webkitSetPresentationMode('picture-in-picture');
    else throw new Error('pip non supportato');
  } catch (err) {
    console.warn(err);
    flash($('#pipBtn'), 'Non disponibile qui');
  }
}

function drawPip() {
  const c = pctx, W = 640, H = 360;
  const n = liveCount();
  c.fillStyle = '#0D1317'; c.fillRect(0, 0, W, H);
  c.fillStyle = n > 0 ? '#3FC48C' : '#66737E'; c.fillRect(0, 0, W, 8);
  c.textBaseline = 'alphabetic';
  c.font = '600 22px system-ui, sans-serif'; c.fillStyle = '#98A6B1'; c.textAlign = 'left';
  c.fillText(`PORTATA · ${state.room}`, 28, 52);
  c.textAlign = 'right';
  c.fillText(new Date().toLocaleTimeString('it-IT'), W - 28, 52);
  c.textAlign = 'left'; c.fillStyle = '#E3E9EE'; c.font = '700 42px system-ui, sans-serif';
  c.fillText(statusText()[0], 28, 110, W - 56);

  const rows = [...state.peers.values()].filter(p => p.linked).sort((a, b) => b.level - a.level).slice(0, 3);
  rows.forEach((p, i) => {
    const y = 162 + i * 56;
    const speaking = p.level > 0.03;
    c.fillStyle = speaking ? '#3FC48C' : '#27333C';
    c.beginPath(); c.arc(46, y - 11, 16, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#E3E9EE'; c.font = '600 32px system-ui, sans-serif';
    c.fillText(p.name, 78, y, 300);
    c.fillStyle = '#98A6B1'; c.font = '500 26px ui-monospace, monospace'; c.textAlign = 'right';
    c.fillText(fmtD(p.distance), W - 28, y); c.textAlign = 'left';
  });
  if (rows.length === 0) {
    c.fillStyle = '#98A6B1'; c.font = '500 28px system-ui, sans-serif';
    c.fillText(state.paused ? 'Chiamata in pausa' : `Ti avviso qui quando qualcuno è entro ${fmtR(state.radius)}`, 28, 180, W - 56);
  }
  c.fillStyle = state.muted ? '#FF7A6B' : '#3FC48C'; c.font = '600 24px system-ui, sans-serif';
  c.fillText(state.muted ? 'Microfono spento' : 'Microfono attivo', 28, H - 28);
  c.fillStyle = '#98A6B1'; c.textAlign = 'right';
  c.fillText(state.lastPos ? `posizione ${ago(state.lastPos.ts)} fa` : 'posizione in attesa', W - 28, H - 28);
  c.textAlign = 'left';
}

function updateMediaSession(title) {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  try { navigator.mediaSession.metadata = new MediaMetadata({ title, artist: `Portata · ${state.room}` }); } catch {}
}

/* ---------------- secondo piano: diagnostica ---------------- */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    away = { start: Date.now(), pos: 0, sent: 0, msgs: 0, wsDrops: 0, micMuted: !!state.micTrack?.muted, micEnded: false, pip: state.pipOpen, wake: !!state.wake, live: liveCount() };
    return;
  }
  if (state.wantWake && !state.wake) acquireWake();
  if (state.ctx) state.ctx.resume().catch(() => {});
  if (away && state.micTrack) report(away);
  away = null;
  maybeSendPos(true);
  render();
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
  li.innerHTML = `<b>Fuori per ${dur} · mini finestra ${a.pip ? 'aperta' : 'chiusa'}${a.wake ? ' · schermo acceso' : ''}</b>${items.join('<br>')}${short ? '<br><span class="hint">Resta fuori almeno 30 secondi per un risultato affidabile.</span>' : ''}`;
  $('#awayLog').prepend(li);
  while ($('#awayLog').children.length > 8) $('#awayLog').lastChild.remove();
}

/* ---------------- cicli ---------------- */
setInterval(() => { if (!document.hidden) tickLevels(); else for (const p of state.peers.values()) p.level = p.analyser ? rms(p.analyser) : 0; drawPip(); }, 250);
setInterval(() => { renderDiag(); maybeSendPos(); }, 1000);
