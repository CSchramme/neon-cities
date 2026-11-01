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

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    for (const [id, v] of Object.entries(raw.found || {})) {
      const i = idToIdx.get(id);
      if (i !== undefined) found.set(i, { t: v.t || Date.now(), by: v.by || '' });
    }
    bestStreak = raw.bestStreak || 0;
    bestMulti = raw.bestMulti || 0;
    for (const [id, t] of Object.entries(raw.achievements || {})) {
      if (ACHIEVEMENTS.some((a) => a.id === id)) unlocked.set(id, t);
    }
    checkAchievements(); // z. B. Spielstand aus älterer Version ohne Erfolge
    console.log(`  Spielstand geladen: ${found.size} Städte leuchten, ${unlocked.size} Erfolge freigeschaltet.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('  Spielstand konnte nicht gelesen werden:', e.message);
  }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {
      savedAt: new Date().toISOString(), bestStreak, bestMulti,
      achievements: Object.fromEntries(unlocked), found: {},
    };
    for (const [i, v] of found) out.found[CITIES[i].id] = v;
    const tmp = SAVE_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(out, null, 1), (err) => {
      if (err) return console.warn('  Speichern fehlgeschlagen:', err.message);
      fs.rename(tmp, SAVE_FILE, (err2) => err2 && console.warn('  Speichern fehlgeschlagen:', err2.message));
    });
  }, 250);
}

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

class Client {
  constructor(socket) {
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
    if (this.socket.destroyed) return;
    this.socket.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj)));
  }

  drop() {
    if (!clients.has(this)) return;
    clients.delete(this);
    this.socket.destroy();
    broadcastPresence();
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
      if (!this.socket.destroyed) this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
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
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
        this.role = ['control', 'preview'].includes(msg.role) ? msg.role : 'overlay';
        if (CONTROL_KEY && msg.key === CONTROL_KEY) this.authed = true;
        this.send({ t: 'welcome', id: this.id, needKey: !!CONTROL_KEY, authed: this.authed });
        this.send(fullState());
        broadcastPresence();
        return;
      case 'ping':
        this.send({ t: 'pong', at: msg.at });
        return;
    }
    if (!this.authed) {
      this.send({ t: 'denied' });
      return;
    }
    switch (msg.t) {
      case 'type':
        typing = { text: cleanText(msg.text), by: cleanText(msg.by, 40) };
        broadcast({ t: 'type', text: typing.text, by: typing.by, src: this.id }, this);
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
}

function broadcast(obj, except = null) {
  const frame = encodeFrame(JSON.stringify(obj));
  for (const c of clients) {
    if (c !== except && !c.socket.destroyed) c.socket.write(frame);
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
  const ping = Buffer.from([0x89, 0]);
  for (const c of clients) {
    if (!c.alive) { c.drop(); continue; }
    c.alive = false;
    if (!c.socket.destroyed) c.socket.write(ping);
  }
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
  clients.add(new Client(socket));
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
