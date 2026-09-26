// Portata — server
// Serve la web app, tiene le stanze, calcola le distanze e fa da "centralino"
// per collegare i telefoni tra loro con WebRTC. Le posizioni arrivano solo a chi è
// nella stessa stanza, per la mappa; chi è in pausa non viene mostrato. Nulla viene salvato.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const MAX_RADIUS = 1000;        // metri, raggio massimo consentito
const EXIT_MARGIN = 0.10;       // si esce solo oltre raggio + 10%
const STALE_MS = 5 * 60 * 1000; // posizione considerata vecchia dopo 5 minuti
const MAX_ROOM = 12;            // persone per stanza

// STUN pubblico di Google. Per le reti mobili serve anche un server TURN (vedi README).
let ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.ICE_SERVERS) {
  try { ICE = JSON.parse(process.env.ICE_SERVERS); }
  catch (e) { console.error('ICE_SERVERS non è un JSON valido, uso solo STUN'); }
}
// Modo semplice: bastano utente e password del server TURN (di default quelli di Metered).
if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
  const urls = (process.env.TURN_URLS ||
    'turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:80?transport=tcp,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443?transport=tcp')
    .split(',').map(s => s.trim()).filter(Boolean);
  ICE.push({ urls, username: process.env.TURN_USERNAME.trim(), credential: process.env.TURN_CREDENTIAL.trim() });
  console.log(`TURN attivo: ${urls.length} indirizzi`);
}

/* ---------------- file statici ---------------- */
// Tutti i file stanno nella stessa cartella del server (si caricano su GitHub anche dal telefono).
// Si servono solo questi.
const PUBLIC = __dirname;
const SERVED = new Set(['index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/geocode') return geocode(url, res);
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (path.dirname(file) !== PUBLIC || !SERVED.has(path.basename(file))) { res.writeHead(404); return res.end('Non trovato'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Non trovato'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Permissions-Policy': 'microphone=(self), geolocation=(self), screen-wake-lock=(self), picture-in-picture=(self)',
    });
    res.end(data);
  });
});

/* ---------------- ricerca indirizzi ---------------- */
// Usa Photon (OpenStreetMap, pensato per la ricerca mentre scrivi) e, se non risponde,
// Nominatim. Le risposte restano in memoria per un po' per non ripetere le stesse richieste.
const PHOTON_URL = process.env.PHOTON_URL || 'https://photon.komoot.io/api/';
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const UA = 'Portata/0.3 (chiamata di prossimita; https://github.com)';
const geoCache = new Map();

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function geocode(url, res) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
  const near = validLatLon(lat, lon);
  if (q.length < 2) return json(res, { results: [] });
  const key = q.toLowerCase() + '|' + (near ? `${lat.toFixed(2)},${lon.toFixed(2)}` : '');
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return json(res, { results: hit.results });

  // prima Photon; se non risponde o trova poco, anche Nominatim, e si uniscono i risultati
  let results = [], errors = [];
  try { results = await photon(q, near && lat, near && lon); } catch (e) { errors.push('photon ' + e.message); }
  if (results.length < 2) {
    try {
      const more = await nominatim(q, near && lat, near && lon);
      const key = r => r.name.toLowerCase() + Math.round(r.lat * 1000) + Math.round(r.lon * 1000);
      const seen = new Set(results.map(key));
      for (const r of more) if (!seen.has(key(r))) { seen.add(key(r)); results.push(r); }
    } catch (e) { errors.push('nominatim ' + e.message); }
  }
  if (!results.length && errors.length === 2) {
    console.error('ricerca non riuscita:', errors.join(' / '));
    return json(res, { results: [], error: 'Ricerca non disponibile al momento. Riprova tra poco o scegli il punto sulla mappa.' }, 502);
  }
  results = results.slice(0, 8);
  if (geoCache.size > 500) geoCache.delete(geoCache.keys().next().value);
  geoCache.set(key, { ts: Date.now(), results });
  json(res, { results });
}

async function getJson(u) {
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'it' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function photon(q, lat, lon) {
  const u = new URL(PHOTON_URL);
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '7');
  if (lat !== false && lat != null) { u.searchParams.set('lat', lat); u.searchParams.set('lon', lon); }
  const j = await getJson(u);
  const seen = new Set();
  return (j.features || []).map(f => {
    const p = f.properties || {};
    const [flon, flat] = (f.geometry && f.geometry.coordinates) || [];
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const name = p.name || street || p.city || '';
    const detail = [p.name && street ? street : null, p.postcode, p.city || p.town || p.village || p.county, p.country]
      .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i && v !== name).join(', ');
    return { name, detail, lat: +flat, lon: +flon };
  }).filter(r => r.name && validLatLon(r.lat, r.lon) && !seen.has(r.name + r.detail) && seen.add(r.name + r.detail));
}

async function nominatim(q, lat, lon) {
  const u = new URL(NOMINATIM_URL);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '7');
  u.searchParams.set('accept-language', 'it');
  if (lat !== false && lat != null) u.searchParams.set('viewbox', `${lon - 0.3},${lat + 0.3},${lon + 0.3},${lat - 0.3}`);
  const j = await getJson(u);
  return (j || []).map(r => {
    const parts = String(r.display_name || '').split(',').map(s => s.trim());
    const name = r.name || parts[0] || '';
    return { name, detail: parts.slice(r.name ? 1 : 1, 4).join(', '), lat: +r.lat, lon: +r.lon };
  }).filter(r => r.name && validLatLon(r.lat, r.lon));
}

/* ---------------- stanze ---------------- */
// rooms: codice -> { clients: Map(id -> client), dest: {lat,lon,label,byName,ts} | null }
// client: { id, ws, name, pos, radius, paused, music, muted, links:Set(id) }
const rooms = new Map();

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const send = (c, msg) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); };
const hasFreshPos = c => c.pos && Date.now() - c.pos.ts < STALE_MS;
const validLatLon = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

function evaluate(code) {
  const room = rooms.get(code);
  if (!room) return;
  const list = [...room.clients.values()];
  const dists = new Map();

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      let d = null;
      if (hasFreshPos(a) && hasFreshPos(b)) d = haversine(a.pos, b.pos);
      dists.set(a.id + '|' + b.id, d);
      dists.set(b.id + '|' + a.id, d);

      const linked = a.links.has(b.id);
      const r = Math.min(a.radius, b.radius);
      const usable = d !== null && !a.paused && !b.paused;
      const want = usable && (linked ? d <= r * (1 + EXIT_MARGIN) : d <= r);

      if (want && !linked) {
        a.links.add(b.id); b.links.add(a.id);
        const aStarts = a.id < b.id; // uno solo dei due avvia la connessione
        send(a, { t: 'link', peer: b.id, initiator: aStarts });
        send(b, { t: 'link', peer: a.id, initiator: !aStarts });
      } else if (!want && linked) {
        a.links.delete(b.id); b.links.delete(a.id);
        send(a, { t: 'unlink', peer: b.id });
        send(b, { t: 'unlink', peer: a.id });
      }
    }
  }

  for (const me of list) {
    const peers = list.filter(o => o !== me).map(o => {
      const d = dists.get(me.id + '|' + o.id);
      const showPos = hasFreshPos(o) && !o.paused;
      return {
        id: o.id,
        name: o.name,
        distance: d == null ? null : Math.max(10, Math.round(d / 10) * 10),
        lat: showPos ? +o.pos.lat.toFixed(5) : null,
        lon: showPos ? +o.pos.lon.toFixed(5) : null,
        linked: me.links.has(o.id),
        paused: o.paused,
        music: o.music,
        muted: o.muted,
        hasPos: hasFreshPos(o),
      };
    });
    send(me, { t: 'peers', peers });
  }
}

function broadcast(code, msg) {
  const room = rooms.get(code);
  if (room) for (const c of room.clients.values()) send(c, msg);
}

function leave(client, code) {
  const room = rooms.get(code);
  if (!room) return;
  room.clients.delete(client.id);
  for (const other of room.clients.values()) {
    if (other.links.delete(client.id)) send(other, { t: 'unlink', peer: client.id });
  }
  if (room.clients.size === 0) rooms.delete(code); // la meta sparisce con la stanza vuota
  else evaluate(code);
}

/* ---------------- websocket ---------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let client = null, code = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join' && !client) {
      code = String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
      const name = String(m.name || '').trim().slice(0, 24);
      if (code.length < 3 || !name) return send({ ws }, { t: 'error', msg: 'Servono un nome e un codice stanza di almeno 3 caratteri.' });
      if (!rooms.has(code)) rooms.set(code, { clients: new Map(), dest: null });
      const room = rooms.get(code);
      if (room.clients.size >= MAX_ROOM) return send({ ws }, { t: 'error', msg: `La stanza ${code} è piena (massimo ${MAX_ROOM} persone).` });
      client = {
        id: crypto.randomUUID().slice(0, 8), ws, name,
        pos: null, radius: clampRadius(m.radius), paused: !!m.paused, music: !!m.music, muted: !!m.muted, links: new Set(),
      };
      room.clients.set(client.id, client);
      send(client, { t: 'welcome', id: client.id, room: code, ice: ICE, maxRadius: MAX_RADIUS, exitMargin: EXIT_MARGIN, dest: room.dest });
      evaluate(code);
      return;
    }
    if (!client) return;
    const room = rooms.get(code);
    if (!room) return;

    switch (m.t) {
      case 'pos': {
        const lat = +m.lat, lon = +m.lon, acc = +m.acc || 0;
        if (!validLatLon(lat, lon)) return;
        client.pos = { lat, lon, acc, ts: Date.now() };
        evaluate(code);
        break;
      }
      case 'settings': {
        if (m.radius != null) client.radius = clampRadius(m.radius);
        if (m.paused != null) client.paused = !!m.paused;
        if (m.music != null) client.music = !!m.music;
        if (m.muted != null) client.muted = !!m.muted;
        evaluate(code);
        break;
      }
      case 'dest': {
        if (m.clear) {
          if (!room.dest) return;
          room.dest = null;
          broadcast(code, { t: 'dest', dest: null, by: client.name, byId: client.id });
          return;
        }
        const lat = +m.lat, lon = +m.lon;
        if (!validLatLon(lat, lon)) return;
        const label = String(m.label || '').trim().slice(0, 40) || "Punto d'incontro";
        room.dest = { lat: +lat.toFixed(6), lon: +lon.toFixed(6), label, byName: client.name, ts: Date.now() };
        broadcast(code, { t: 'dest', dest: room.dest, by: client.name, byId: client.id });
        break;
      }
      case 'signal': {
        // inoltra offer/answer/candidati solo a chi è collegato
        const to = room.clients.get(m.to);
        if (to && client.links.has(to.id)) send(to, { t: 'signal', from: client.id, data: m.data });
        break;
      }
      case 'ping': send(client, { t: 'pong' }); break;
    }
  });

  ws.on('close', () => { if (client) leave(client, code); });
});

function clampRadius(r) {
  r = Math.round(+r || MAX_RADIUS);
  return Math.min(MAX_RADIUS, Math.max(50, r));
}

// tiene vive le connessioni e toglie chi è sparito
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  for (const code of rooms.keys()) evaluate(code); // scadenza delle posizioni vecchie
}, 25000);

server.listen(PORT, () => console.log(`Portata in ascolto su http://localhost:${PORT}`));
