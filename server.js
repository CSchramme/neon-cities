// NEON CITIES – Server
// Liefert die Webseiten aus und synchronisiert jeden Tastendruck per
// WebSocket an alle offenen Browserquellen (OBS, TikTok LIVE Studio, …).
// Keine Abhängigkeiten nötig: einfach `node server.js` starten.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCityIndex, NameIndex } from './public/js/game.js';
import { buildAchievements, makeContext, progress } from './public/js/achievements.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const PORT = Number(argValue('--port') || process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SAVE_FILE = process.env.SAVE_FILE || path.join(ROOT, 'spielstand.json');
// Optional: Passwort für die Steuerung (wichtig, wenn die Seite öffentlich im Netz läuft)
const CONTROL_KEY = argValue('--key') || process.env.NEON_KEY || '';

// ---------------------------------------------------------------- Spieldaten
const DATA = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data/germany.json'), 'utf8'));
const CITIES = DATA.cities;
const STATES = DATA.states;
const cityIndex = buildCityIndex(CITIES);
const idToIdx = new Map(CITIES.map((c, i) => [c.id, i]));
const ACHIEVEMENTS = buildAchievements(DATA);

const GEMEINDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/gemeinden.json'), 'utf8'));
const gemIndex = new NameIndex();
GEMEINDEN.forEach(([name], i) => gemIndex.addName(name, i, { base: false }));

// ---------------------------------------------------------------- Spielstand
/** found: cityIdx -> { t: timestamp, by: string } */
const found = new Map();
let streak = 0;
let bestStreak = 0;
let bestMulti = 0;
/** freigeschaltete Erfolge: id -> timestamp */
const unlocked = new Map();
let typing = { text: '', by: '' };

/** Übernimmt einen Spielstand (aus Datei oder Upload). Gibt false bei ungültigem Inhalt zurück. */
function applySave(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.found !== 'object' || raw.found === null) return false;
  found.clear();
  unlocked.clear();
  for (const [id, v] of Object.entries(raw.found)) {
    const i = idToIdx.get(id);
    if (i !== undefined) found.set(i, { t: Number(v?.t) || Date.now(), by: cleanText(v?.by, 40) });
  }
  bestStreak = Number(raw.bestStreak) || 0;
  streak = Number(raw.streak) || 0; // laufende Combo übersteht einen Neustart
  bestMulti = Number(raw.bestMulti) || 0;
  for (const [id, t] of Object.entries(raw.achievements || {})) {
    if (ACHIEVEMENTS.some((a) => a.id === id)) unlocked.set(id, Number(t) || Date.now());
  }
  checkAchievements(); // z. B. Spielstand aus älterer Version ohne Erfolge
  return true;
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    if (!applySave(raw)) throw new Error('unbekanntes Format');
    console.log(`  Spielstand geladen: ${found.size} Städte leuchten, ${unlocked.size} Erfolge freigeschaltet.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('  Spielstand konnte nicht gelesen werden:', e.message);
  }
}

let saveTimer = null;
function snapshot() {
  const out = {
    savedAt: new Date().toISOString(), streak, bestStreak, bestMulti,
    achievements: Object.fromEntries(unlocked), found: {},
  };
  for (const [i, v] of found) out.found[CITIES[i].id] = v;
  return JSON.stringify(out, null, 1);
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = SAVE_FILE + '.tmp';
    fs.writeFile(tmp, snapshot(), (err) => {
      if (err) return console.warn('  Speichern fehlgeschlagen:', err.message);
      fs.rename(tmp, SAVE_FILE, (err2) => err2 && console.warn('  Speichern fehlgeschlagen:', err2.message));
    });
  }, 250);
}

/** Sofort speichern, z. B. wenn Plesk/Passenger die App beendet */
function saveNow() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.writeFileSync(SAVE_FILE, snapshot());
  } catch (e) {
    console.warn('  Speichern fehlgeschlagen:', e.message);
  }
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    saveNow();
    process.exit(0);
  });
}
process.on('exit', saveNow);

function stateCounts() {
  const counts = new Array(STATES.length).fill(0);
  for (const i of found.keys()) counts[CITIES[i].s]++;
  return counts;
}

function foundList() {
  const list = [...found.entries()].map(([i, v]) => [i, v.t, v.by]);
  list.sort((a, b) => a[1] - b[1]);
  return list;
}

function fullState() {
  return {
    t: 'state', found: foundList(), typing, streak, bestStreak, bestMulti,
    achievements: [...unlocked.entries()], total: CITIES.length,
  };
}

/** Prüft alle Erfolge und gibt die neu freigeschalteten IDs zurück */
function checkAchievements() {
  const ctx = makeContext(DATA, foundList(), { bestStreak, bestMulti });
  const fresh = [];
  const now = Date.now();
  for (const a of ACHIEVEMENTS) {
    if (unlocked.has(a.id)) continue;
    const { cur, max } = progress(a, ctx);
    if (cur >= max) {
      unlocked.set(a.id, now);
      fresh.push(a.id);
    }
  }
  return fresh;
}

// ---------------------------------------------------------------- Spielzüge
function cleanText(v, max = 80) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function handleSubmit(rawText, rawBy) {
  const input = cleanText(rawText).trim();
  const by = cleanText(rawBy, 40).trim();
  if (!input) return;
  typing = { text: '', by };
  const matches = cityIndex.match(input);
  const now = Date.now();

  if (matches.length === 0) {
    streak = 0;
    saveState();
    const g = gemIndex.match(input)[0];
    const gem = g !== undefined ? { n: GEMEINDEN[g][0], s: GEMEINDEN[g][1], k: GEMEINDEN[g][2] } : null;
    broadcast({ t: 'result', kind: 'miss', input, by, gem, streak });
    return;
  }

  const fresh = matches.filter((i) => !found.has(i));
  if (fresh.length === 0) {
    broadcast({ t: 'result', kind: 'already', input, by, ids: matches, streak });
    return;
  }

  const before = stateCounts();
  for (const i of fresh) found.set(i, { t: now, by });
  const after = stateCounts();
  const completed = [];
  for (let s = 0; s < STATES.length; s++) {
    if (before[s] < STATES[s].total && after[s] === STATES[s].total) completed.push(s);
  }
  streak += 1;
  bestStreak = Math.max(bestStreak, streak);
  bestMulti = Math.max(bestMulti, fresh.length);
  const achievements = checkAchievements();
  const prevTotal = found.size - fresh.length;
  const milestone = Math.floor(found.size / 100) > Math.floor(prevTotal / 100) ? Math.floor(found.size / 100) * 100 : 0;
  const win = found.size === CITIES.length;
  saveState();
  broadcast({
    t: 'result', kind: 'found', input, by, ids: fresh, t0: now,
    completed, streak, bestStreak, bestMulti, milestone, win, count: found.size, achievements,
  });
}

function handleUndo(i) {
  if (!Number.isInteger(i) || !found.has(i)) return;
  found.delete(i);
  saveState();
  broadcast({ t: 'removed', ids: [i], count: found.size });
}

function handleReset() {
  found.clear();
  unlocked.clear();
  streak = 0;
  bestStreak = 0;
  bestMulti = 0;
  typing = { text: '', by: '' };
  saveState();
  broadcast({ ...fullState(), reset: true });
}

// ---------------------------------------------------------------- WebSocket
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();
let nextClientId = 1;

function encodeFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Gemeinsame Verarbeitung aller Nachrichten – egal ob per WebSocket oder HTTP */
function handleMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'hello':
      client.role = ['control', 'preview'].includes(msg.role) ? msg.role : 'overlay';
      if (CONTROL_KEY && msg.key === CONTROL_KEY) client.authed = true;
      client.send({ t: 'welcome', id: client.id, needKey: !!CONTROL_KEY, authed: client.authed, transport: client.kind });
      client.send(fullState());
      broadcastPresence();
      return;
    case 'ping':
      client.send({ t: 'pong', at: msg.at });
      return;
    default:
      break;
  }
  if (!client.authed) {
    client.send({ t: 'denied' });
    return;
  }
  switch (msg.t) {
    case 'type':
      typing = { text: cleanText(msg.text), by: cleanText(msg.by, 40) };
      broadcast({ t: 'type', text: typing.text, by: typing.by, src: client.id }, client);
      break;
    case 'submit':
      handleSubmit(msg.text, msg.by);
      break;
    case 'undo':
      handleUndo(msg.i);
      break;
    case 'reset':
      handleReset();
      break;
    default:
      break;
  }
}

class WsClient {
  constructor(socket) {
    this.kind = 'ws';
    this.id = nextClientId++;
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.alive = true;
    this.role = 'unknown';
    this.authed = !CONTROL_KEY;
    socket.setNoDelay(true); // jeder Buchstabe sofort raus
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.drop());
    socket.on('end', () => this.drop());
    socket.on('error', () => this.drop());
  }

  send(obj) {
    this.writeFrame(encodeFrame(JSON.stringify(obj)));
  }

  writeFrame(frame) {
    if (!this.socket.destroyed) this.socket.write(frame);
  }

  drop() {
    if (!clients.has(this)) return;
    clients.delete(this);
    this.socket.destroy();
    broadcastPresence();
  }

  heartbeat() {
    if (!this.alive) return this.drop();
    this.alive = false;
    this.writeFrame(Buffer.from([0x89, 0]));
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > 1_000_000n) return this.drop();
        len = Number(big); offset = 10;
      }
      if (len > 1_000_000) return this.drop();
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return;
      let payload = this.buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(offset, offset + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      this.buf = this.buf.subarray(offset + maskLen + len);
      this.onFrame(fin, opcode, payload);
      if (this.socket.destroyed) return;
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === 0x8) { // close
      try { this.socket.end(encodeFrame('', 0x8)); } catch { /* egal */ }
      return this.drop();
    }
    if (opcode === 0x9) { // ping -> pong
      this.writeFrame(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      return;
    }
    if (opcode === 0xa) { this.alive = true; return; }
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      this.fragments.push(payload);
      if (!fin) return;
      const data = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.alive = true;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      handleMessage(this, msg);
    }
  }
}

// ---------------------------------------------------------------- HTTP-Ersatzweg
// Falls ein Hoster (z. B. Plesk im Proxy-Modus) keine WebSockets durchlässt:
// Empfang per Server-Sent Events (/events) oder Long-Polling (/poll),
// Senden per POST (/send). Die Seiten wechseln automatisch dorthin.
const httpClients = new Map(); // cid -> HttpClient

class HttpClient {
  constructor(cid) {
    this.kind = 'http';
    this.id = nextClientId++;
    this.cid = cid;
    this.role = 'unknown';
    this.authed = !CONTROL_KEY;
    this.queue = [];
    this.sse = null;
    this.poll = null;
    this.pollTimer = null;
    this.lastSeen = Date.now();
  }

  send(obj) {
    this.sendText(JSON.stringify(obj));
  }

  sendText(json) {
    if (this.sse) {
      this.sse.write(`data: ${json}\n\n`);
      return;
    }
    this.queue.push(json);
    if (this.queue.length > 500) this.queue = [JSON.stringify(fullState())]; // zu weit hinterher: neu synchronisieren
    this.flushPoll();
  }

  flushPoll() {
    if (!this.poll || !this.queue.length) return;
    const res = this.poll;
    this.poll = null;
    clearTimeout(this.pollTimer);
    this.lastSeen = Date.now();
    res.end(`[${this.queue.join(',')}]`);
    this.queue = [];
  }

  attachSse(req, res) {
    if (this.sse) this.sse.end();
    this.sse = res;
    this.lastSeen = Date.now();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: nicht puffern
    });
    res.socket?.setNoDelay(true);
    // etwas Polster, damit Zwischen-Puffer sofort weiterreichen
    res.write(`:${' '.repeat(2048)}\nretry: 2000\n\n`);
    for (const json of this.queue) res.write(`data: ${json}\n\n`);
    this.queue = [];
    req.on('close', () => {
      if (this.sse === res) {
        this.sse = null;
        this.lastSeen = Date.now();
      }
    });
  }

  attachPoll(req, res) {
    if (this.poll) this.poll.end('[]');
    this.poll = res;
    this.lastSeen = Date.now();
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      if (this.poll === res) {
        this.poll = null;
        res.end('[]');
      }
    }, 25000);
    req.on('close', () => {
      if (this.poll === res) {
        this.poll = null;
        clearTimeout(this.pollTimer);
      }
    });
    this.flushPoll();
  }

  heartbeat() {
    if (this.sse) {
      this.sse.write(': ping\n\n');
      this.lastSeen = Date.now();
    } else if (!this.poll && Date.now() - this.lastSeen > 60000) {
      this.drop();
    }
  }

  drop() {
    if (!clients.has(this)) return;
    clients.delete(this);
    httpClients.delete(this.cid);
    this.sse?.end();
    if (this.poll) this.poll.end('[]');
    clearTimeout(this.pollTimer);
    broadcastPresence();
  }
}

function httpClientFor(url, { create }) {
  const cid = String(url.searchParams.get('cid') || '').slice(0, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(cid)) return null;
  let c = httpClients.get(cid);
  if (!c && create) {
    c = new HttpClient(cid);
    httpClients.set(cid, c);
    clients.add(c);
    handleMessage(c, { t: 'hello', role: url.searchParams.get('role'), key: url.searchParams.get('key') || '' });
  }
  return c || null;
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > limit) {
        reject(new Error('zu groß'));
        req.destroy();
      } else {
        chunks.push(ch);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Liefert true, wenn die Anfrage ein Sync-Endpunkt war */
function handleSyncHttp(req, res, url) {
  if (url.pathname === '/events' && req.method === 'GET') {
    const c = httpClientFor(url, { create: true });
    if (!c) return res.writeHead(400).end(), true;
    c.attachSse(req, res);
    return true;
  }
  if (url.pathname === '/poll' && req.method === 'GET') {
    const c = httpClientFor(url, { create: true });
    if (!c) return res.writeHead(400).end(), true;
    c.attachPoll(req, res);
    return true;
  }
  if (url.pathname === '/send' && req.method === 'POST') {
    const c = httpClientFor(url, { create: false });
    if (!c) return res.writeHead(409, { 'Content-Type': 'text/plain' }).end('unbekannt – bitte neu verbinden'), true;
    c.lastSeen = Date.now();
    readBody(req).then((text) => {
      let msgs;
      try { msgs = JSON.parse(text); } catch { msgs = null; }
      if (!Array.isArray(msgs)) return res.writeHead(400).end();
      for (const m of msgs.slice(0, 200)) handleMessage(c, m);
      res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
    }).catch(() => res.writeHead(413).end());
    return true;
  }
  return false;
}

/** Spielstand herunterladen (GET) oder hochladen (POST) – mit Passwort, falls gesetzt */
function handleSaveHttp(req, res, url) {
  const key = url.searchParams.get('key') || req.headers['x-neon-key'] || '';
  if (CONTROL_KEY && key !== CONTROL_KEY) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Passwort fehlt oder ist falsch');
    return;
  }
  if (req.method === 'GET') {
    const date = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="spielstand-${date}.json"`,
    });
    res.end(snapshot());
    return;
  }
  if (req.method === 'POST') {
    readBody(req, 4 * 1024 * 1024).then((text) => {
      let raw;
      try { raw = JSON.parse(text); } catch { raw = null; }
      if (!applySave(raw)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Das ist keine gültige spielstand.json');
        return;
      }
      typing = { text: '', by: '' };
      saveState();
      broadcast({ ...fullState(), imported: true });
      res.writeHead(200, { 'Content-Type': MIME['.json'] }).end(JSON.stringify({ cities: found.size, achievements: unlocked.size }));
      console.log(`  Spielstand hochgeladen: ${found.size} Städte, ${unlocked.size} Erfolge.`);
    }).catch(() => res.writeHead(413).end());
    return;
  }
  res.writeHead(405).end();
}

function broadcast(obj, except = null) {
  const json = JSON.stringify(obj);
  let frame = null;
  for (const c of clients) {
    if (c === except) continue;
    if (c.kind === 'ws') c.writeFrame(frame ||= encodeFrame(json));
    else c.sendText(json);
  }
}

function broadcastPresence() {
  let controls = 0;
  let overlays = 0;
  for (const c of clients) {
    if (c.role === 'control') controls++;
    else if (c.role === 'overlay') overlays++;
  }
  broadcast({ t: 'presence', controls, overlays });
}

// Verbindungen prüfen (z. B. wenn OBS die Quelle hart beendet)
setInterval(() => {
  for (const c of [...clients]) c.heartbeat();
}, 20000).unref();

// ---------------------------------------------------------------- HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const ROUTES = {
  '/': 'index.html',
  '/steuerung': 'index.html',
  '/control': 'index.html',
  '/overlay': 'overlay.html',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (handleSyncHttp(req, res, url)) return;
  if (url.pathname === '/api/spielstand') {
    handleSaveHttp(req, res, url);
    return;
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...fullState(), cities: CITIES.length }));
    return;
  }
  let rel = ROUTES[url.pathname.replace(/\/+$/, '') || '/'];
  if (rel === undefined) {
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      res.writeHead(400).end('Ungültige Adresse');
      return;
    }
  }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('Verboten');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.woff2' ? 'public, max-age=604800' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  clients.add(new WsClient(socket));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} ist schon belegt. Läuft NEON CITIES vielleicht schon?`);
    console.error(`  Anderen Port nutzen:  node server.js --port 3001\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch { /* egal */ }
}

loadState();
server.listen(PORT, HOST, () => {
  const base = `http://localhost:${PORT}`;
  const c = (s) => `\x1b[95m${s}\x1b[0m`;
  console.log(`
  ${c('N E O N   C I T I E S')}  – ${CITIES.length} Städte warten darauf zu leuchten

  Steuerung (hier tippst du):   ${base}/
  Overlay TikTok (Hochformat):  ${base}/overlay?layout=hoch
  Overlay YouTube/OBS (Quer):   ${base}/overlay?layout=quer
${lanAddresses().map((ip) => `  Im Heimnetz (z. B. Handy):    http://${ip}:${PORT}/`).join('\n')}
${CONTROL_KEY ? '\n  Steuerung ist mit Passwort geschützt (?key=…)\n' : ''}
  Zum Beenden: Strg + C
`);
  if (args.includes('--open')) openBrowser(base + '/');
});
