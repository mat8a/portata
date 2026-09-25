// Portata — server
// Serve la web app, tiene le stanze, calcola le distanze e fa da "centralino"
// per collegare i telefoni tra loro con WebRTC. Non inoltra mai le coordinate:
// ai client arrivano solo nomi e distanze.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// versione "piatta": tutti i file stanno nella stessa cartella del server,
// così si possono caricare su GitHub anche dal telefono. Si servono solo questi.
const PUBLIC = __dirname;
const SERVED = new Set(['index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png']);

const MAX_RADIUS = 1000;        // metri, raggio massimo consentito
const EXIT_MARGIN = 0.10;       // si esce solo oltre raggio + 10%
const STALE_MS = 5 * 60 * 1000; // posizione considerata vecchia dopo 5 minuti
const MAX_ROOM = 12;            // persone per stanza

// STUN pubblico di Google. Per reti mobili difficili aggiungi un server TURN
// con la variabile d'ambiente ICE_SERVERS (vedi README).
let ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.ICE_SERVERS) {
  try { ICE = JSON.parse(process.env.ICE_SERVERS); }
  catch (e) { console.error('ICE_SERVERS non è un JSON valido, uso solo STUN'); }
}

/* ---------------- file statici ---------------- */
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
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (path.dirname(file) !== PUBLIC || !SERVED.has(path.basename(file))) { res.writeHead(404); return res.end('Non trovato'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Non trovato'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // la pagina può usare microfono e posizione solo per sé
      'Permissions-Policy': 'microphone=(self), geolocation=(self), screen-wake-lock=(self)',
    });
    res.end(data);
  });
});

/* ---------------- stanze ---------------- */
// rooms: codice -> Map(id -> client)
// client: { id, ws, name, pos:{lat,lon,acc,ts}|null, radius, paused, links:Set(id) }
const rooms = new Map();

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const send = (c, msg) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); };
const hasFreshPos = c => c.pos && Date.now() - c.pos.ts < STALE_MS;

function evaluate(code) {
  const room = rooms.get(code);
  if (!room) return;
  const list = [...room.values()];
  const dists = new Map(); // "a|b" -> metri

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
      return {
        id: o.id,
        name: o.name,
        distance: d == null ? null : Math.max(10, Math.round(d / 10) * 10),
        linked: me.links.has(o.id),
        paused: o.paused,
        hasPos: hasFreshPos(o),
      };
    });
    send(me, { t: 'peers', peers, radius: me.radius });
  }
}

function leave(client, code) {
  const room = rooms.get(code);
  if (!room) return;
  room.delete(client.id);
  for (const other of room.values()) {
    if (other.links.delete(client.id)) send(other, { t: 'unlink', peer: client.id });
  }
  if (room.size === 0) rooms.delete(code);
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
      if (!rooms.has(code)) rooms.set(code, new Map());
      const room = rooms.get(code);
      if (room.size >= MAX_ROOM) return send({ ws }, { t: 'error', msg: `La stanza ${code} è piena (massimo ${MAX_ROOM} persone).` });
      client = {
        id: crypto.randomUUID().slice(0, 8), ws, name,
        pos: null, radius: clampRadius(m.radius), paused: false, links: new Set(),
      };
      room.set(client.id, client);
      send(client, { t: 'welcome', id: client.id, room: code, ice: ICE, maxRadius: MAX_RADIUS, exitMargin: EXIT_MARGIN });
      evaluate(code);
      return;
    }
    if (!client) return;

    switch (m.t) {
      case 'pos': {
        const lat = +m.lat, lon = +m.lon, acc = +m.acc || 0;
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
        client.pos = { lat, lon, acc, ts: Date.now() };
        evaluate(code);
        break;
      }
      case 'settings': {
        if (m.radius != null) client.radius = clampRadius(m.radius);
        if (m.paused != null) client.paused = !!m.paused;
        evaluate(code);
        break;
      }
      case 'signal': {
        // inoltra offer/answer/candidati solo a chi è collegato
        const room = rooms.get(code), to = room && room.get(m.to);
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
