// Overlay / Browserquelle für OBS, TikTok LIVE Studio, Streamlabs …
import { STATE_COLORS, formatNumber } from './game.js';
import { NeonMap } from './map.js';
import { Link } from './net.js';
import { Sound } from './sound.js';
import { TIERS, buildAchievements, makeContext, progress, closestGoals } from './achievements.js';

const params = new URLSearchParams(location.search);
const flag = (name, def) => {
  const v = params.get(name);
  if (v === null) return def;
  return !['0', 'false', 'nein', 'aus', 'off', 'no'].includes(v.toLowerCase());
};

const LAYOUT_ALIASES = {
  hoch: 'hoch', tiktok: 'hoch', portrait: 'hoch', vertical: 'hoch', vertikal: 'hoch', '9x16': 'hoch',
  quer: 'quer', youtube: 'quer', landscape: 'quer', horizontal: 'quer', obs: 'quer', '16x9': 'quer',
};
const VIEW_ALIASES = {
  map: 'map', karte: 'map', typing: 'typing', eingabe: 'typing', stats: 'stats', statistik: 'stats',
  erfolge: 'erfolge', achievements: 'erfolge',
};
const VIEW = VIEW_ALIASES[(params.get('view') || '').toLowerCase()] || 'full';
const FORCED_LAYOUT = LAYOUT_ALIASES[(params.get('layout') || '').toLowerCase()] || null;
const WITH_BG = flag('bg', VIEW === 'full');

const STAGE = {
  quer: [1920, 1080],
  hoch: [1080, 1920],
  map: [760, 1030],
  typing: [1400, 210],
  stats: [600, 1680],
  erfolge: [640, 1480],
};

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvas = $('fx');
const body = document.body;
if (WITH_BG) body.classList.add('with-bg');
body.classList.add(`view-${VIEW}`);

const sound = new Sound({
  enabled: flag('sound', true),
  ticks: flag('ticks', true),
  volume: Math.max(0, Math.min(100, Number(params.get('vol') ?? 60))) / 100,
});

let DATA;
let map;
let layout = null;
let stageScale = 1;
const feedItems = []; // { i, t, by }
let typedText = '';
let msgTimer = null;
const bannerQueue = [];
let bannerBusy = false;

// Erfolge
let ACH = [];
const unlocked = new Map(); // id -> timestamp
const foundMeta = new Map(); // cityIdx -> { t, by }
let bestStreak = 0;
let bestMulti = 0;
const recentUnlock = new Map(); // id -> performance.now() beim Freischalten
const toastQueue = [];
let toastBusy = false;
let rotateTimer = null;
const ROTATES = VIEW === 'full' || VIEW === 'stats';

// ---------------------------------------------------------------- Layout
function chooseLayout() {
  if (VIEW === 'typing') return 'quer';
  if (VIEW !== 'full') return 'quer';
  if (FORCED_LAYOUT) return FORCED_LAYOUT;
  return innerWidth < innerHeight ? 'hoch' : 'quer';
}

function stageSize(l) {
  if (VIEW === 'full') return STAGE[l];
  return STAGE[VIEW];
}

function applyLayout() {
  const l = chooseLayout();
  if (l !== layout) {
    body.classList.remove(`layout-${layout}`);
    body.classList.add(`layout-${l}`);
    layout = l;
  }
  const [W, H] = stageSize(l);
  stageScale = Math.min(innerWidth / W, innerHeight / H);
  stage.style.width = `${W}px`;
  stage.style.height = `${H}px`;
  const ox = (innerWidth - W * stageScale) / 2;
  const oy = (innerHeight - H * stageScale) / 2;
  stage.style.transform = `translate(${ox}px, ${oy}px) scale(${stageScale})`;
  if (map && (VIEW === 'full' || VIEW === 'map')) {
    const box = $('mapbox');
    const dpr = Math.min(2.5 / stageScale, window.devicePixelRatio || 1);
    map.setLayout({
      stageW: W, stageH: H, scale: stageScale, dpr,
      rect: { x: box.offsetLeft, y: box.offsetTop, w: box.offsetWidth, h: box.offsetHeight },
    });
  }
  fitTyped();
  if (map) {
    updateStats();
    renderAchievements();
  }
}

function cometOrigin() {
  if (VIEW !== 'full' || !map) return null;
  const t = $('typing');
  const cx = t.offsetLeft + t.offsetWidth / 2;
  const mapCenterY = map.mapY + map.mapH / 2;
  const top = t.offsetTop + t.offsetHeight / 2 > mapCenterY;
  return { x: cx, y: top ? t.offsetTop + 10 : t.offsetTop + t.offsetHeight - 10 };
}

// ---------------------------------------------------------------- Statistik
function buildStates() {
  const list = $('state-list');
  list.innerHTML = '';
  DATA.states.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'state';
    row.style.setProperty('--c', STATE_COLORS[i]);
    row.style.setProperty('--p', 0);
    row.innerHTML = `<span class="sw"></span><span class="nm"><span class="long"></span><span class="short"></span></span><span class="num"></span><span class="mini"><b></b></span>`;
    row.querySelector('.long').textContent = s.name;
    row.querySelector('.short').textContent = s.id;
    list.appendChild(row);
  });
  const segs = $('bar-segs');
  segs.innerHTML = '';
  DATA.states.forEach((_, i) => {
    const seg = document.createElement('i');
    seg.style.setProperty('--c', STATE_COLORS[i]);
    seg.style.width = '0%';
    segs.appendChild(seg);
  });
  $('total').textContent = formatNumber(DATA.cities.length);
}

function updateStats({ bump = false, flashStates = [] } = {}) {
  const total = DATA.cities.length;
  const count = map.found.size;
  const countEl = $('count');
  countEl.textContent = formatNumber(count);
  if (bump) {
    countEl.classList.remove('bump');
    void countEl.offsetWidth;
    countEl.classList.add('bump');
  }
  const pct = (count / total) * 100;
  $('pct').textContent = `${pct.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  const rows = $('state-list').children;
  const segs = $('bar-segs').children;
  DATA.states.forEach((s, i) => {
    const n = map.counts[i];
    const p = n / s.total;
    const row = rows[i];
    row.style.setProperty('--p', p.toFixed(4));
    row.querySelector('.num').textContent = layout === 'hoch' && VIEW === 'full'
      ? `${Math.floor(p * 100)} %`
      : `${formatNumber(n)} / ${formatNumber(s.total)}`;
    row.classList.toggle('done', n >= s.total);
    if (flashStates.includes(i)) {
      row.classList.remove('flash');
      void row.offsetWidth;
      row.classList.add('flash');
    }
    segs[i].style.width = `${(n / total) * 100}%`;
  });
}

function setCombo(streak, animate) {
  const el = $('combo');
  if (streak >= 2) {
    el.textContent = `Combo ×${streak}`;
    el.classList.add('on');
    if (animate) {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    }
  } else {
    el.classList.remove('on');
  }
}

// ---------------------------------------------------------------- Feed
function renderFeed(newIds = []) {
  const list = $('feed-list');
  list.innerHTML = '';
  const max = 5;
  if (!feedItems.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Noch ist alles dunkel … tippt die erste Stadt!';
    list.appendChild(li);
    return;
  }
  for (const it of feedItems.slice(0, max)) {
    const c = DATA.cities[it.i];
    const li = document.createElement('li');
    li.style.setProperty('--c', STATE_COLORS[c.s]);
    if (newIds.includes(it.i)) li.className = 'new';
    li.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="by"></span><span class="st"></span>';
    li.querySelector('.nm').textContent = c.n;
    li.querySelector('.st').textContent = DATA.states[c.s].id;
    li.querySelector('.by').textContent = it.by ? `· ${it.by}` : '';
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------- Eingabe
function fitTyped() {
  const typing = $('typing');
  if (!typing) return;
  const base = layout === 'hoch' && VIEW === 'full' ? 88 : 72;
  const avail = typing.clientWidth - 150;
  const len = Math.max(1, typedText.length + 1);
  const fs = Math.max(30, Math.min(base, avail / (len * 0.66)));
  typing.style.setProperty('--fs', `${fs.toFixed(1)}px`);
}

function renderTyped(text, { animate = true } = {}) {
  const up = String(text).toUpperCase();
  const el = $('typed');
  let i = 0;
  while (i < typedText.length && i < up.length && typedText[i] === up[i]) i++;
  while (el.childNodes.length > i) el.lastChild.remove();
  for (let j = i; j < up.length; j++) {
    const sp = document.createElement('span');
    sp.className = animate ? 'ch ignite' : 'ch';
    sp.textContent = up[j] === ' ' ? ' ' : up[j];
    el.appendChild(sp);
  }
  const grew = up.length > typedText.length;
  typedText = up;
  fitTyped();
  return grew;
}

function setBy(by) {
  $('typing-by').textContent = by ? `Tipp von ${by}` : '';
}

function ghost(kind, text, color) {
  const typing = $('typing');
  const g = document.createElement('div');
  g.className = `ghost ${kind}`;
  g.textContent = String(text).toUpperCase();
  const line = typing.querySelector('.typing-line').getBoundingClientRect();
  const tr = $('typed').getBoundingClientRect();
  const br = typing.getBoundingClientRect();
  g.style.left = `${(tr.left - br.left) / stageScale - 2}px`;
  g.style.top = `${((line.top + line.bottom) / 2 - br.top) / stageScale - 2}px`;
  if (color) g.style.setProperty('--hit', color);
  typing.appendChild(g);
  setTimeout(() => g.remove(), 1300);
  typing.style.setProperty('--hit', color || 'var(--cyan)');
  typing.classList.remove('flash-found', 'flash-miss', 'flash-already');
  void typing.offsetWidth;
  typing.classList.add(`flash-${kind}`);
  renderTyped('', { animate: false });
}

function showMsg(kind, text, color) {
  const el = $('typing-msg');
  el.className = `typing-msg ${kind} on`;
  if (color) el.style.setProperty('--hit', color);
  el.textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => el.classList.remove('on'), 4200);
}

// ---------------------------------------------------------------- Banner
function banner(big, small, color = '#ff2bd6', { urgent = false } = {}) {
  if (urgent) bannerQueue.length = 0;
  else if (bannerQueue.length >= 3) bannerQueue.shift(); // nicht ewig nachlaufen lassen
  bannerQueue.push({ big, small, color });
  if (!bannerBusy) nextBanner();
}

function nextBanner() {
  const b = bannerQueue.shift();
  if (!b) { bannerBusy = false; return; }
  bannerBusy = true;
  const el = $('banner');
  el.style.setProperty('--c', b.color);
  el.innerHTML = '<span class="big"></span><span class="small"></span>';
  el.querySelector('.big').textContent = b.big;
  el.querySelector('.small').textContent = b.small || '';
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  setTimeout(nextBanner, 3300);
}

// ---------------------------------------------------------------- Erfolge
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function tierVars(el, tier) {
  const c = TIERS[tier].color;
  el.style.setProperty('--t', c);
  el.style.setProperty('--ta', hexA(c, 0.45));
  el.style.setProperty('--tb', hexA(c, 0.22));
}

function achContext() {
  const list = [...foundMeta.entries()].map(([i, v]) => [i, v.t, v.by]);
  return makeContext(DATA, list, { bestStreak, bestMulti });
}

function goalRow(a, cur, max, { done = false, fresh = false } = {}) {
  const row = document.createElement('div');
  row.className = `goal${done ? ' done' : ' locked'}${fresh ? ' fresh' : ''}`;
  tierVars(row, a.tier);
  row.style.setProperty('--p', `${(cur / max) * 100}%`);
  row.innerHTML = '<span class="ic"></span><span class="gn"></span><span class="gv"></span><span class="gbar"><b></b></span>';
  row.querySelector('.ic').textContent = a.icon;
  row.querySelector('.gn').textContent = a.name;
  row.querySelector('.gv').textContent = done ? '✓' : `${formatNumber(cur)} / ${formatNumber(max)}`;
  return row;
}

function renderAchievements() {
  if (!ACH.length) return;
  const nowMs = performance.now();
  for (const [id, t] of recentUnlock) if (nowMs - t > 90_000) recentUnlock.delete(id);
  const freshIds = [...recentUnlock.keys()];
  const isNew = (id) => recentUnlock.has(id) && nowMs - recentUnlock.get(id) < 3000;
  const ctx = achContext();
  const tr = $('trophies');
  tr.querySelector('b').textContent = unlocked.size;
  tr.querySelector('span').textContent = ACH.length;
  const countText = `${unlocked.size} / ${ACH.length}`;
  $('goals-count').textContent = countText;
  $('ach-all-count').textContent = countText;

  // "Fast geschafft": zuerst gerade Freigeschaltetes, dann die nächsten Ziele
  const n = layout === 'hoch' && VIEW === 'full' ? 6 : 5;
  const list = $('goals-list');
  list.innerHTML = '';
  const recent = ACH.filter((a) => freshIds.includes(a.id)).sort((x, y) => recentUnlock.get(y.id) - recentUnlock.get(x.id));
  for (const a of recent.slice(0, 2)) list.appendChild(goalRow(a, a.max, a.max, { done: true, fresh: isNew(a.id) }));
  const goals = closestGoals(ACH, ctx, unlocked, n - Math.min(recent.length, 2));
  for (const g of goals) list.appendChild(goalRow(g.a, g.cur, g.max));
  if (!list.children.length) {
    const p = document.createElement('div');
    p.className = 'goals-empty';
    p.textContent = 'Alle Erfolge freigeschaltet! 🏆';
    list.appendChild(p);
  }

  if (VIEW === 'erfolge') {
    const all = $('ach-all-list');
    all.innerHTML = '';
    const sorted = [...ACH].sort((x, y) => (unlocked.has(y.id) - unlocked.has(x.id)));
    for (const a of sorted) {
      const { cur, max } = progress(a, ctx);
      all.appendChild(goalRow(a, unlocked.has(a.id) ? max : cur, max, { done: unlocked.has(a.id), fresh: isNew(a.id) }));
    }
  }
}

function setGoalsVisible(on) {
  body.classList.toggle('show-goals', on);
}

function startRotation() {
  if (!ROTATES) return;
  clearInterval(rotateTimer);
  rotateTimer = setInterval(() => setGoalsVisible(!body.classList.contains('show-goals')), 14000);
}

function showGoalsNow() {
  if (!ROTATES) return;
  setGoalsVisible(true);
  startRotation(); // Timer neu starten, damit die Liste eine Weile sichtbar bleibt
}

function toast(a) {
  toastQueue.push(a);
  if (!toastBusy) nextToast();
}

function nextToast() {
  const a = toastQueue.shift();
  if (!a) { toastBusy = false; return; }
  toastBusy = true;
  const el = $('achv');
  tierVars(el, a.tier);
  el.querySelector('.achv-ic').textContent = a.icon;
  el.querySelector('.achv-lb').textContent = `Erfolg freigeschaltet · ${TIERS[a.tier].name}`;
  el.querySelector('.achv-nm').textContent = a.name;
  el.querySelector('.achv-ds').textContent = a.desc;
  // stehen weitere Erfolge an, jede Karte kürzer zeigen
  const dur = toastQueue.length ? 3000 : 4800;
  el.style.animationDuration = `${dur}ms`;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  sound.achievement(a.tier);
  highlightAchievement(a);
  setTimeout(nextToast, dur + 100);
}

/** Die Städte des Erfolgs auf der Karte aufblitzen lassen */
function highlightAchievement(a) {
  if (!map?.layout || a.type !== 'set') return;
  const color = TIERS[a.tier].color;
  const ids = a.set.filter((i) => map.found.has(i)).slice(0, 60);
  ids.forEach((i, n) => {
    setTimeout(() => {
      const p = map.cityPos(i);
      map.effects.push({ type: 'ring', x: p.x, y: p.y, color, t0: performance.now() / 1000, dur: 1.2, r: 46 });
      map.effects.push({ type: 'twinkle', x: p.x, y: p.y, color, t0: performance.now() / 1000, dur: 1.2 });
    }, 300 + n * Math.min(90, 1500 / ids.length));
  });
}

function bumpTrophies() {
  const tr = $('trophies');
  tr.classList.remove('bump');
  void tr.offsetWidth;
  tr.classList.add('bump');
}

// ---------------------------------------------------------------- Server-Events
function onState(msg) {
  const ids = msg.found.map(([i]) => i);
  map.setFound(ids);
  foundMeta.clear();
  for (const [i, t, by] of msg.found) foundMeta.set(i, { t, by });
  unlocked.clear();
  for (const [id, t] of msg.achievements || []) unlocked.set(id, t);
  bestStreak = msg.bestStreak || 0;
  bestMulti = msg.bestMulti || 0;
  renderAchievements();
  feedItems.length = 0;
  for (const [i, t, by] of [...msg.found].reverse()) feedItems.push({ i, t, by });
  renderFeed();
  updateStats();
  setCombo(msg.streak, false);
  renderTyped(msg.typing?.text || '', { animate: false });
  setBy(msg.typing?.by || '');
  if (msg.reset) {
    banner('Lichter aus!', 'Neue Runde – alles dunkel', '#00f0ff');
    sound.already();
  }
}

const recentResults = [];
function isFlood() {
  const t = performance.now();
  recentResults.push(t);
  while (recentResults.length && t - recentResults[0] > 1000) recentResults.shift();
  return recentResults.length > 8;
}

let statsTimer = null;
const pendingTouched = new Set();
const pendingFeed = new Set();
function scheduleStats(touched, newIds) {
  for (const s of touched) pendingTouched.add(s);
  for (const i of newIds) pendingFeed.add(i);
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    renderFeed([...pendingFeed]);
    updateStats({ bump: true, flashStates: [...pendingTouched] });
    renderAchievements();
    pendingTouched.clear();
    pendingFeed.clear();
  }, 650);
}

function onResult(r) {
  const flood = isFlood();
  if (r.kind === 'found') {
    const first = DATA.cities[r.ids[0]];
    const color = STATE_COLORS[first.s];
    if (flood) renderTyped('', { animate: false });
    else ghost('found', r.input, color);
    const names = r.ids.map((i) => DATA.cities[i].n);
    const stateName = DATA.states[first.s].name;
    const extra = r.by ? `  ·  Danke ${r.by}!` : '';
    showMsg('found', r.ids.length === 1
      ? `✓ ${names[0]} · ${stateName}${extra}`
      : `✓ ${r.ids.length} Städte: ${names.join(', ')}${extra}`, color);
    map.addFound(r.ids, { origin: cometOrigin(), animate: !flood });
    for (const i of r.ids) foundMeta.set(i, { t: r.t0, by: r.by });
    bestStreak = r.bestStreak ?? bestStreak;
    bestMulti = r.bestMulti ?? bestMulti;
    const freshAch = ACH.filter((a) => (r.achievements || []).includes(a.id));
    for (const a of freshAch) unlocked.set(a.id, r.t0);
    if (freshAch.length) {
      for (const a of freshAch) recentUnlock.set(a.id, performance.now());
      setTimeout(() => {
        showGoalsNow();
        bumpTrophies();
      }, 700);
      // bei Massen-Eingaben nur die wichtigsten Karten zeigen
      for (const a of flood ? freshAch.slice(-1) : freshAch) setTimeout(() => toast(a), 900);
    }
    for (const i of r.ids) feedItems.unshift({ i, t: r.t0, by: r.by });
    feedItems.length = Math.min(feedItems.length, 40);
    scheduleStats(r.ids.map((i) => DATA.cities[i].s), r.ids);
    if (!flood) sound.found(first.s, r.ids.length);
    setCombo(r.streak, true);
    if (r.ids.length >= 3) banner(`${r.ids.length}× ${r.input}`, 'Mega-Treffer!', color);
    for (const s of r.completed || []) {
      if (!flood) {
        setTimeout(() => {
          map.stateComplete(s);
          sound.stateComplete(s);
        }, 700);
      }
      banner(DATA.states[s].name, 'komplett beleuchtet!', STATE_COLORS[s]);
    }
    const countAch = freshAch.some((a) => a.type === 'count');
    if (r.milestone && !r.win && !countAch) {
      banner(`${formatNumber(r.milestone)} Städte!`, 'Deutschland wird heller', '#b6ff3b');
      if (!flood) setTimeout(() => sound.milestone(), 900);
    }
    if (r.win) {
      setTimeout(() => {
        map.celebrate(25);
        sound.win();
      }, 1200);
      banner('Ganz Deutschland', 'leuchtet! Alle Städte gefunden!', '#ff2bd6', { urgent: true });
    }
  } else if (r.kind === 'already') {
    const c = DATA.cities[r.ids[0]];
    if (flood) renderTyped('', { animate: false });
    else ghost('already', r.input, '#ffb020');
    const names = r.ids.map((i) => DATA.cities[i].n);
    showMsg('already', `Leuchtet schon: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ' …' : ''}`);
    sound.already();
    // kurz aufblitzen lassen, wo die Stadt ist
    for (const i of r.ids.slice(0, 12)) {
      const p = map.cityPos(i);
      map.effects.push({ type: 'ring', x: p.x, y: p.y, color: '#ffb020', t0: performance.now() / 1000, dur: 1, r: 40 });
    }
    if (c) setCombo(r.streak, false);
  } else if (r.kind === 'miss') {
    if (flood) renderTyped('', { animate: false });
    else ghost('miss', r.input, '#ff3355');
    if (r.gem) {
      const st = DATA.states[r.gem.s]?.name || '';
      showMsg('miss', `${r.gem.n} ist eine ${r.gem.k} in ${st} – keine Stadt`);
    } else {
      showMsg('miss', `„${r.input}“ ist keine deutsche Stadt`);
    }
    sound.miss();
    setCombo(0, false);
  }
}

function onRemoved(msg) {
  map.removeFound(msg.ids);
  for (const i of msg.ids) foundMeta.delete(i);
  renderAchievements();
  for (let k = feedItems.length - 1; k >= 0; k--) if (msg.ids.includes(feedItems[k].i)) feedItems.splice(k, 1);
  renderFeed();
  updateStats();
}

// ---------------------------------------------------------------- Start
async function main() {
  DATA = await fetch('/data/germany.json').then((r) => r.json());
  map = new NeonMap(canvas, DATA, { hints: flag('hints', true) });
  ACH = buildAchievements(DATA);
  window.neonMap = map; // für Fehlersuche in der Browser-Konsole
  buildStates();
  renderFeed();
  applyLayout();
  renderAchievements();
  startRotation();
  map.start();
  addEventListener('resize', applyLayout);
  document.fonts?.load('30px "Tilt Neon"').then(() => fitTyped()).catch(() => {});

  const link = new Link(flag('preview', false) ? 'preview' : 'overlay');
  let offlineTimer = null;
  const offline = $('offline');
  const setOffline = (on) => {
    clearTimeout(offlineTimer);
    if (on) offlineTimer = setTimeout(() => offline.classList.add('on'), 2500);
    else offline.classList.remove('on');
  };
  setOffline(true);
  link.on('open', () => setOffline(false));
  link.on('close', () => setOffline(true));
  link.on('state', onState);
  link.on('result', onResult);
  link.on('removed', onRemoved);
  link.on('type', (m) => {
    const grew = renderTyped(m.text);
    setBy(m.by);
    if (grew) sound.tick();
  });
}

main();
