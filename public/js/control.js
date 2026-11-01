// Steuerung: hier wird getippt – jeder Buchstabe geht sofort an alle Overlays.
import { STATE_COLORS, formatNumber } from './game.js';
import { Link } from './net.js';
import { TIERS, buildAchievements, makeContext, progress } from './achievements.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let DATA;
const found = new Map(); // idx -> { t, by }
let counts = [];
let link;
let typingFromRemote = false;
let ACH = [];
const unlocked = new Map(); // id -> timestamp
let bestStreak = 0;
let bestMulti = 0;
const openAch = new Set();

function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } }

// ---------------------------------------------------------------- UI-Helfer
let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 1800);
}

function setStatus(on, text) {
  const el = $('status');
  el.classList.toggle('off', !on);
  el.querySelector('span').textContent = text;
}

function setResult(kind, tag, text) {
  const el = $('result');
  el.className = `result ${kind}`;
  el.innerHTML = '';
  if (tag) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = tag;
    el.appendChild(t);
  }
  el.appendChild(document.createTextNode(text));
}

function timeAgo(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'gerade eben';
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60);
  return h < 24 ? `vor ${h} Std.` : new Date(t).toLocaleDateString('de-DE');
}

// ---------------------------------------------------------------- Bundesländer
function buildStates() {
  const box = $('states');
  box.innerHTML = '';
  DATA.states.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'srow';
    row.style.setProperty('--c', STATE_COLORS[i]);
    row.innerHTML = '<button type="button"><span class="sw"></span><span class="nm"></span><span class="num"></span><span class="mini"><b></b></span></button><div class="missing"></div>';
    row.querySelector('.nm').textContent = s.name;
    row.querySelector('button').addEventListener('click', () => {
      row.classList.toggle('open');
      if (row.classList.contains('open')) renderMissing(i);
    });
    box.appendChild(row);
  });
}

function renderMissing(s) {
  const row = $('states').children[s];
  const box = row.querySelector('.missing');
  const missing = DATA.cities
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => c.s === s && !found.has(i))
    .sort((a, b) => b.c.p - a.c.p);
  box.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = missing.length
    ? `${missing.length} fehlen noch (nach Einwohnern sortiert) – nur für dich sichtbar, Klick übernimmt den Namen ins Eingabefeld:`
    : 'Alle Städte leuchten! 🎉';
  box.appendChild(note);
  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const { c } of missing) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.n;
    b.addEventListener('click', () => {
      $('city').value = c.n;
      $('city').focus();
      sendTyping();
    });
    chips.appendChild(b);
  }
  box.appendChild(chips);
}

function updateStats() {
  counts = new Array(DATA.states.length).fill(0);
  for (const i of found.keys()) counts[DATA.cities[i].s]++;
  const total = DATA.cities.length;
  $('count').textContent = formatNumber(found.size);
  $('total').textContent = formatNumber(total);
  $('pct').textContent = `${((found.size / total) * 100).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  const rows = $('states').children;
  DATA.states.forEach((s, i) => {
    const row = rows[i];
    row.querySelector('.num').textContent = `${formatNumber(counts[i])} / ${formatNumber(s.total)}`;
    row.querySelector('.mini b').style.width = `${(counts[i] / s.total) * 100}%`;
    row.classList.toggle('done', counts[i] >= s.total);
    if (row.classList.contains('open')) renderMissing(i);
  });
  renderRecent();
  renderAchievements();
}

// ---------------------------------------------------------------- Erfolge
function renderAchievements() {
  if (!ACH.length) return;
  const ctx = makeContext(DATA, [...found.entries()].map(([i, v]) => [i, v.t, v.by]), { bestStreak, bestMulti });
  $('ach-count').textContent = `${unlocked.size} / ${ACH.length}`;
  const box = $('achievements');
  box.innerHTML = '';
  for (const a of ACH) {
    const done = unlocked.has(a.id);
    const { cur, max } = progress(a, ctx);
    const item = document.createElement('div');
    item.className = `ach${done ? ' done' : ''}${openAch.has(a.id) ? ' open' : ''}`;
    item.style.setProperty('--t', TIERS[a.tier].color);
    item.style.setProperty('--p', `${((done ? max : cur) / max) * 100}%`);
    item.innerHTML = '<button type="button"><span class="ic"></span><span class="tx"><b></b><small></small></span><span class="val"></span><span class="bar"><i></i></span></button>';
    item.querySelector('.ic').textContent = a.icon;
    item.querySelector('b').textContent = a.name;
    item.querySelector('small').textContent = a.desc;
    item.querySelector('.val').textContent = done
      ? `✓ ${new Date(unlocked.get(a.id)).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
      : `${formatNumber(cur)} / ${formatNumber(max)}`;
    item.title = `${TIERS[a.tier].name}-Erfolg`;
    if (a.type === 'set' && !done) {
      item.querySelector('button').addEventListener('click', () => {
        if (openAch.has(a.id)) openAch.delete(a.id);
        else openAch.add(a.id);
        renderAchievements();
      });
      if (openAch.has(a.id)) {
        const missing = a.set.filter((i) => !found.has(i)).sort((x, y) => DATA.cities[y].p - DATA.cities[x].p);
        const chips = document.createElement('div');
        chips.className = 'chips';
        for (const i of missing) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = DATA.cities[i].n;
          b.addEventListener('click', () => {
            $('city').value = DATA.cities[i].n;
            $('city').focus();
            sendTyping();
          });
          chips.appendChild(b);
        }
        item.appendChild(chips);
      }
    } else {
      item.querySelector('button').disabled = true;
    }
    box.appendChild(item);
  }
}

function renderRecent() {
  const list = $('recent');
  list.innerHTML = '';
  const items = [...found.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, 30);
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Noch nichts – leg los!';
    list.appendChild(li);
    return;
  }
  for (const [i, v] of items) {
    const c = DATA.cities[i];
    const li = document.createElement('li');
    li.style.setProperty('--c', STATE_COLORS[c.s]);
    li.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="meta"></span><button type="button" class="undo" title="Wieder ausschalten">↩ zurück</button>';
    li.querySelector('.nm').textContent = c.n;
    li.querySelector('.meta').textContent = `${DATA.states[c.s].id}${v.by ? ` · ${v.by}` : ''} · ${timeAgo(v.t)}`;
    li.querySelector('.undo').addEventListener('click', () => {
      link.send({ t: 'undo', i });
    });
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------- Browserquellen
const SOURCES = [
  { name: 'TikTok LIVE · Hochformat', size: '1080 × 1920', q: { layout: 'hoch' } },
  { name: 'YouTube / OBS · Querformat', size: '1920 × 1080', q: { layout: 'quer' } },
  { name: 'Nur Karte', size: '760 × 1030', q: { view: 'karte' } },
  { name: 'Nur Eingabe-Leiste', size: '1400 × 210', q: { view: 'eingabe' } },
  { name: 'Nur Statistik', size: '600 × 1680', q: { view: 'statistik' } },
  { name: 'Nur Erfolge', size: '640 × 1480', q: { view: 'erfolge' } },
];

function buildLinks() {
  const box = $('links');
  box.innerHTML = '';
  const transparent = $('opt-transparent').checked;
  const nosound = $('opt-nosound').checked;
  const noticks = $('opt-noticks').checked;
  const nohints = $('opt-nohints').checked;
  for (const src of SOURCES) {
    const q = new URLSearchParams(src.q);
    if (transparent && !src.q.view) q.set('bg', '0');
    if (nosound) q.set('sound', '0');
    if (noticks && !nosound) q.set('ticks', '0');
    if (nohints) q.set('hints', '0');
    const url = `${location.origin}/overlay?${q.toString()}`;
    const row = document.createElement('div');
    row.className = 'link';
    row.innerHTML = '<span class="name"></span><code></code><button type="button">Kopieren</button>';
    row.querySelector('.name').innerHTML = '';
    row.querySelector('.name').append(src.name);
    const small = document.createElement('small');
    small.textContent = src.size;
    row.querySelector('.name').append(small);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = url;
    row.querySelector('code').appendChild(a);
    row.querySelector('button').addEventListener('click', () => copy(url));
    box.appendChild(row);
  }
  storageSet('nc-opts', JSON.stringify({ transparent, nosound, noticks, nohints }));
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* egal */ }
    ta.remove();
  }
  toast('Link kopiert ✓');
}

// ---------------------------------------------------------------- Eingabe
function sendTyping() {
  if (typingFromRemote) return;
  link.send({ t: 'type', text: $('city').value, by: $('by').value });
}

function setupInput() {
  const city = $('city');
  const by = $('by');
  const keepBy = $('keepBy');
  keepBy.checked = storageGet('nc-keepby') === '1';
  keepBy.addEventListener('change', () => storageSet('nc-keepby', keepBy.checked ? '1' : '0'));
  city.addEventListener('input', sendTyping);
  by.addEventListener('input', sendTyping);
  city.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      city.value = '';
      sendTyping();
    }
  });
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = city.value.trim();
    if (!text) return;
    if (!link.send({ t: 'submit', text, by: by.value.trim() })) {
      setResult('miss', 'OFFLINE', 'Keine Verbindung zum Server – läuft „node server.js“ noch?');
      return;
    }
    city.value = '';
    if (!keepBy.checked) by.value = '';
    sendTyping();
    city.focus();
  });
}

// ---------------------------------------------------------------- Server-Events
function onState(msg) {
  found.clear();
  for (const [i, t, by] of msg.found) found.set(i, { t, by });
  unlocked.clear();
  for (const [id, t] of msg.achievements || []) unlocked.set(id, t);
  bestStreak = msg.bestStreak || 0;
  bestMulti = msg.bestMulti || 0;
  updateStats();
  $('streak').textContent = msg.bestStreak ? `Beste Combo: ${msg.bestStreak}` : '';
  if (msg.typing && document.activeElement !== $('city')) {
    $('city').value = msg.typing.text || '';
  }
  if (msg.reset) setResult('', '', 'Neue Runde – alle Lichter sind aus.');
  if (msg.imported) setResult('found', 'GELADEN', `Spielstand übernommen: ${formatNumber(found.size)} Städte, ${unlocked.size} ${unlocked.size === 1 ? 'Erfolg' : 'Erfolge'}.`);
}

function onResult(r) {
  const city = $('city');
  if (document.activeElement !== city || city.value.trim() === r.input) city.value = '';
  if (r.kind === 'found') {
    for (const i of r.ids) found.set(i, { t: r.t0, by: r.by });
    const names = r.ids.map((i) => `${DATA.cities[i].n} (${DATA.states[DATA.cities[i].s].id})`);
    let text = r.ids.length === 1 ? names[0] : `${r.ids.length} Städte: ${names.join(', ')}`;
    if (r.completed?.length) text += ` – ${r.completed.map((s) => DATA.states[s].name).join(', ')} komplett!`;
    bestStreak = r.bestStreak ?? bestStreak;
    bestMulti = r.bestMulti ?? bestMulti;
    const freshAch = ACH.filter((a) => (r.achievements || []).includes(a.id));
    for (const a of freshAch) unlocked.set(a.id, r.t0);
    if (freshAch.length) text += ` 🏆 ${freshAch.map((a) => a.name).join(', ')}`;
    setResult('found', r.ids.length > 1 ? `+${r.ids.length}` : '+1', text);
    $('streak').textContent = `Combo ${r.streak} · Beste: ${r.bestStreak}`;
    updateStats();
  } else if (r.kind === 'already') {
    const names = r.ids.map((i) => DATA.cities[i].n);
    setResult('already', 'SCHON AN', `${names.join(', ')} leuchtet bereits.`);
  } else if (r.kind === 'miss') {
    const text = r.gem
      ? `„${r.input}“: ${r.gem.n} ist eine ${r.gem.k} in ${DATA.states[r.gem.s].name}, aber keine Stadt.`
      : `„${r.input}“ wurde nicht gefunden. Tippfehler?`;
    setResult('miss', 'NICHT GEFUNDEN', text);
  }
}

function onRemoved(msg) {
  for (const i of msg.ids) found.delete(i);
  updateStats();
  toast(`${msg.ids.map((i) => DATA.cities[i].n).join(', ')} ausgeschaltet`);
}

function onType(msg) {
  // Eine andere Steuerung (z. B. Handy) tippt gerade
  typingFromRemote = true;
  if ($('city').value !== msg.text) $('city').value = msg.text;
  if ($('by').value !== msg.by) $('by').value = msg.by;
  typingFromRemote = false;
}

// ---------------------------------------------------------------- Vorschau
function setupPreview() {
  const frame = $('preview-frame');
  const box = $('preview');
  for (const b of $('preview-switch').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      const l = b.dataset.layout;
      $('preview-switch').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      box.className = `preview ${l}`;
      frame.src = `/overlay?layout=${l}&sound=0&preview=1`;
      storageSet('nc-preview', l);
    });
  }
  const saved = storageGet('nc-preview');
  if (saved === 'hoch') $('preview-switch').querySelector('[data-layout="hoch"]').click();
}

// ---------------------------------------------------------------- Start
// Eingabefeld klebt beim Scrollen oben und wird dabei kompakter
function setupStickyInput() {
  const header = document.querySelector('.top');
  const card = $('input-card');
  const sentinel = $('input-sentinel');
  const update = () => {
    const h = header.offsetHeight;
    document.documentElement.style.setProperty('--header-h', `${h}px`);
    card.classList.toggle('stuck', sentinel.getBoundingClientRect().top < h + 4);
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  update();
}

async function main() {
  setupStickyInput();
  DATA = await fetch('/data/germany.json').then((r) => r.json());
  ACH = buildAchievements(DATA);
  buildStates();
  updateStats();
  setupInput();
  setupPreview();

  try {
    const o = JSON.parse(storageGet('nc-opts') || '{}');
    $('opt-transparent').checked = !!o.transparent;
    $('opt-nosound').checked = !!o.nosound;
    $('opt-noticks').checked = !!o.noticks;
    $('opt-nohints').checked = !!o.nohints;
  } catch { /* egal */ }
  for (const id of ['opt-transparent', 'opt-nosound', 'opt-noticks', 'opt-nohints']) $(id).addEventListener('change', buildLinks);
  buildLinks();

  const urlKey = params.get('key');
  if (urlKey) storageSet('nc-key', urlKey);
  link = new Link('control', { key: urlKey || storageGet('nc-key') || '' });
  let presence = { overlays: 0, controls: 0 };
  const showPresence = () => {
    const via = link.mode === 'ws' ? '' : ' · HTTP';
    setStatus(true, `Live${via} · ${presence.overlays} Browserquelle${presence.overlays === 1 ? '' : 'n'}`);
  };
  link.on('open', showPresence);
  link.on('close', () => setStatus(false, 'Getrennt – verbinde neu …'));
  link.on('presence', (p) => { presence = p; if (link.connected) showPresence(); });
  link.on('welcome', (w) => {
    if (w.needKey && !w.authed) $('keybox').hidden = false;
  });
  link.on('denied', () => {
    $('keybox').hidden = false;
    setResult('miss', 'GESPERRT', 'Falsches oder fehlendes Passwort.');
  });
  link.on('state', onState);
  link.on('result', onResult);
  link.on('removed', onRemoved);
  link.on('type', onType);

  $('keyform').addEventListener('submit', (e) => {
    e.preventDefault();
    storageSet('nc-key', $('keyinput').value);
    location.reload();
  });

  // Spielstand herunterladen / hochladen
  const saveKey = () => urlKey || storageGet('nc-key') || '';
  $('save-dl').addEventListener('click', () => {
    const k = saveKey();
    $('save-dl').href = `/api/spielstand${k ? `?key=${encodeURIComponent(k)}` : ''}`;
  });
  $('save-ul').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let text;
    let n = 0;
    try {
      text = await file.text();
      const raw = JSON.parse(text);
      n = Object.keys(raw.found || {}).length;
    } catch {
      toast('Das ist keine gültige spielstand.json');
      return;
    }
    if (!confirm(`Spielstand aus „${file.name}“ laden?\n\nDer aktuelle Stand (${formatNumber(found.size)} Städte) wird ersetzt durch ${formatNumber(n)} Städte aus der Datei.`)) return;
    const k = saveKey();
    try {
      const res = await fetch(`/api/spielstand${k ? `?key=${encodeURIComponent(k)}` : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text,
      });
      if (!res.ok) throw new Error(await res.text());
      toast('Spielstand geladen ✓');
    } catch (err) {
      setResult('miss', 'FEHLER', `Hochladen fehlgeschlagen: ${err.message}`);
    }
  });

  $('reset').addEventListener('click', () => {
    const n = found.size;
    if (!confirm(`Wirklich ALLES zurücksetzen?\n\n${formatNumber(n)} leuchtende Städte gehen wieder aus. Das kann man nicht rückgängig machen.`)) return;
    link.send({ t: 'reset' });
  });

  setInterval(renderRecent, 30000);
}

main();
