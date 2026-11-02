// Erfolge (Achievements) – gemeinsam genutzt von Server, Overlay und Steuerung.
// Der Server entscheidet, wann ein Erfolg freigeschaltet wird; die Seiten
// berechnen damit nur den Fortschritt für die Anzeige.
import { baseName } from './game.js';

export const TIERS = {
  bronze: { name: 'Bronze', color: '#ff9f43' },
  silber: { name: 'Silber', color: '#bfe1ff' },
  gold: { name: 'Gold', color: '#ffd23f' },
  platin: { name: 'Platin', color: '#d18cff' },
};

const RUHR = ['Bochum', 'Bottrop', 'Dortmund', 'Duisburg', 'Essen', 'Gelsenkirchen', 'Hagen', 'Hamm', 'Herne', 'Mülheim an der Ruhr', 'Oberhausen'];

/** Anfangsbuchstabe ohne Umlaut-Punkte (Ö -> O) */
export function initial(name) {
  return String(name).trim().charAt(0).toUpperCase().normalize('NFD').charAt(0);
}

export function normalizeViewer(by) {
  return String(by || '').trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Erzeugt die Liste aller Erfolge für die gegebenen Spieldaten.
 * Typen: count (Anzahl Städte), set (bestimmte Städte), states (Bundesländer komplett),
 * letters (Anfangsbuchstaben), combo, speed, multi, viewers.
 */
export function buildAchievements(data) {
  const C = data.cities;
  const idx = (pred) => C.map((c, i) => (pred(c, i) ? i : -1)).filter((i) => i >= 0);
  const byName = (names) => idx((c) => names.includes(c.n));
  const byPop = [...C.keys()].sort((a, b) => C[b].p - C[a].p);
  const total = C.length;
  const stateId = (c) => data.states[c.s].id;
  const extremes = [
    C.reduce((b, c, i) => (c.y < C[b].y ? i : b), 0), // Norden
    C.reduce((b, c, i) => (c.y > C[b].y ? i : b), 0), // Süden
    C.reduce((b, c, i) => (c.x < C[b].x ? i : b), 0), // Westen
    C.reduce((b, c, i) => (c.x > C[b].x ? i : b), 0), // Osten
  ];
  const letters = [...new Set(C.map((c) => initial(c.n)))].sort();
  const smallest = [...byPop].reverse().slice(0, 5);
  const shortNames = idx((c) => c.n.replace(/[^A-Za-zÄÖÜäöüß]/g, '').length <= 3);
  const missingLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((l) => !letters.includes(l));

  const list = [
    // ---- Fortschritt
    { id: 'erste', icon: '💡', name: 'Es werde Licht', desc: 'Die erste Stadt leuchtet', tier: 'bronze', type: 'count', max: 1 },
    { id: 'c100', icon: '✨', name: 'Hundert Lichter', desc: '100 Städte leuchten', tier: 'bronze', type: 'count', max: 100 },
    { id: 'c500', icon: '🌆', name: 'Lichtermeer', desc: '500 Städte leuchten', tier: 'silber', type: 'count', max: 500 },
    { id: 'halbzeit', icon: '🌗', name: 'Halbzeit', desc: 'Die Hälfte aller Städte leuchtet', tier: 'gold', type: 'count', max: Math.ceil(total / 2) },
    { id: 'c1500', icon: '🌃', name: 'Fast taghell', desc: '1.500 Städte leuchten', tier: 'gold', type: 'count', max: 1500 },
    { id: 'alle', icon: '🏆', name: 'Ganz Deutschland', desc: `Alle ${total.toLocaleString('de-DE')} Städte leuchten`, tier: 'platin', type: 'count', max: total },

    // ---- Besondere Städte
    { id: 'hauptstaedte', icon: '👑', name: 'Hauptstadt-Tour', desc: 'Alle 16 Landeshauptstädte', tier: 'gold', type: 'set', set: idx((c) => c.cap) },
    { id: 'millionen', icon: '🏙️', name: 'Millionen-Club', desc: 'Berlin, Hamburg, München & Köln', tier: 'silber', type: 'set', set: idx((c) => c.p >= 1_000_000) },
    { id: 'top10', icon: '🔟', name: 'Top 10', desc: 'Die 10 größten Städte', tier: 'silber', type: 'set', set: byPop.slice(0, 10) },
    { id: 'grossstaedte', icon: '🏢', name: 'Großstadt-Jäger', desc: `Alle ${idx((c) => c.p >= 100_000).length} Großstädte (ab 100.000 Einwohnern)`, tier: 'gold', type: 'set', set: idx((c) => c.p >= 100_000) },
    { id: 'stadtstaaten', icon: '🏛️', name: 'Stadtstaaten', desc: 'Berlin, Hamburg, Bremen & Bremerhaven', tier: 'bronze', type: 'set', set: idx((c) => ['BE', 'HH', 'HB'].includes(stateId(c))) },
    { id: 'ruhrpott', icon: '⚒️', name: 'Ruhrpott', desc: 'Die 11 Großstädte des Ruhrgebiets', tier: 'silber', type: 'set', set: byName(RUHR) },
    { id: 'hanse', icon: '⚓', name: 'Die Hanse', desc: `Alle ${idx((c) => c.h || c.n === 'Bremen').length} Hansestädte`, tier: 'gold', type: 'set', set: idx((c) => c.h || c.n === 'Bremen') },
    { id: 'kompass', icon: '🧭', name: 'Kompass', desc: 'Nördlichste, südlichste, westlichste & östlichste Stadt', tier: 'silber', type: 'set', set: extremes },
    { id: 'zwerge', icon: '🐭', name: 'Klein, aber oho', desc: 'Die 5 kleinsten Städte Deutschlands', tier: 'gold', type: 'set', set: smallest },
    { id: 'kurz', icon: '✂️', name: 'Kurz & knapp', desc: `Die Städte mit nur 3 Buchstaben`, tier: 'bronze', type: 'set', set: shortNames },
    { id: 'neustadt', icon: '🔁', name: 'Neustadt-Sammler', desc: `Alle ${idx((c) => baseName(c.n) === 'Neustadt').length} Neustadts`, tier: 'bronze', type: 'set', set: idx((c) => baseName(c.n) === 'Neustadt') },
    { id: 'bad', icon: '♨️', name: 'Kurlaub', desc: '25 Städte mit „Bad“ im Namen', tier: 'silber', type: 'set', set: idx((c) => c.n.startsWith('Bad ')), need: 25 },
    { id: 'main', icon: '🌉', name: 'Am Main', desc: 'Alle Städte „am Main“', tier: 'silber', type: 'set', set: idx((c) => /\bam Main\b/.test(c.n)) },
    { id: 'rhein', icon: '🍇', name: 'Am Rhein', desc: 'Alle Städte „am Rhein“', tier: 'silber', type: 'set', set: idx((c) => /\bam Rhein\b/.test(c.n)) },
    { id: 'donau', icon: '🌊', name: 'Donau-Welle', desc: 'Alle Städte „an der Donau“', tier: 'silber', type: 'set', set: idx((c) => /an der Donau|\(Donau\)/.test(c.n)) },
    {
      id: 'abc', icon: '🔤', name: 'Von A bis Z', tier: 'gold', type: 'letters', letters,
      desc: `Zu jedem Anfangsbuchstaben eine Stadt${missingLetters.length ? ` (${missingLetters.join(', ')} gibt's nicht!)` : ''}`,
    },

    // ---- Bundesländer
    { id: 'land1', icon: '🗺️', name: 'Erstes Bundesland', desc: 'Ein Bundesland komplett beleuchtet', tier: 'silber', type: 'states', max: 1 },
    { id: 'land5', icon: '🌍', name: 'Fünf Länder', desc: '5 Bundesländer komplett beleuchtet', tier: 'gold', type: 'states', max: 5 },

    // ---- Spielweise
    { id: 'combo10', icon: '🔥', name: 'Im Flow', desc: '10er-Combo ohne Fehlversuch', tier: 'bronze', type: 'combo', max: 10 },
    { id: 'combo25', icon: '☄️', name: 'Unaufhaltsam', desc: '25er-Combo ohne Fehlversuch', tier: 'silber', type: 'combo', max: 25 },
    { id: 'combo50', icon: '🚀', name: 'Neon-Maschine', desc: '50er-Combo ohne Fehlversuch', tier: 'gold', type: 'combo', max: 50 },
    { id: 'speed', icon: '⚡', name: 'Blitzlicht', desc: '10 Städte innerhalb einer Minute', tier: 'silber', type: 'speed', max: 10, window: 60_000 },
    { id: 'mega', icon: '💥', name: 'Mega-Treffer', desc: '5 Städte mit einer einzigen Eingabe', tier: 'bronze', type: 'multi', max: 5 },
    { id: 'team10', icon: '🤝', name: 'Teamwork', desc: 'Tipps von 10 verschiedenen Zuschauern', tier: 'silber', type: 'viewers', max: 10 },
    { id: 'team25', icon: '🎉', name: 'Der ganze Chat', desc: 'Tipps von 25 verschiedenen Zuschauern', tier: 'gold', type: 'viewers', max: 25 },
  ];
  for (const a of list) {
    if (a.type === 'set') a.max = Math.min(a.need || a.set.length, a.set.length);
    if (a.type === 'letters') a.max = letters.length;
  }
  return list;
}

/**
 * Fasst den Spielstand für die Berechnung zusammen.
 * found: Iterable von [cityIdx, timestamp, by]
 */
export function makeContext(data, found, { bestStreak = 0, bestMulti = 0 } = {}) {
  const list = [...found];
  const set = new Set(list.map(([i]) => i));
  const counts = new Array(data.states.length).fill(0);
  const letters = new Set();
  const viewers = new Set();
  for (const [i, , by] of list) {
    const c = data.cities[i];
    counts[c.s]++;
    letters.add(initial(c.n));
    const v = normalizeViewer(by);
    if (v) viewers.add(v);
  }
  const statesDone = counts.filter((n, s) => n >= data.states[s].total).length;
  // meiste Funde innerhalb von 60 Sekunden
  const times = list.map(([, t]) => t).sort((a, b) => a - b);
  let speed = 0;
  for (let a = 0, b = 0; b < times.length; b++) {
    while (times[b] - times[a] > 60_000) a++;
    speed = Math.max(speed, b - a + 1);
  }
  return { set, count: set.size, statesDone, letters, viewers: viewers.size, speed, bestStreak, bestMulti };
}

/** Fortschritt eines Erfolgs: { cur, max } */
export function progress(a, ctx) {
  let cur = 0;
  switch (a.type) {
    case 'count': cur = ctx.count; break;
    case 'set': for (const i of a.set) if (ctx.set.has(i)) cur++; break;
    case 'letters': for (const l of a.letters) if (ctx.letters.has(l)) cur++; break;
    case 'states': cur = ctx.statesDone; break;
    case 'combo': cur = ctx.bestStreak; break;
    case 'speed': cur = ctx.speed; break;
    case 'multi': cur = ctx.bestMulti; break;
    case 'viewers': cur = ctx.viewers; break;
    default: break;
  }
  return { cur: Math.min(cur, a.max), max: a.max };
}

/**
 * Was fehlt noch? letters: fehlende Anfangsbuchstaben, cities: fehlende Städte
 * (nur bei Erfolgen mit fester Städteliste, nicht bei "25 von 106").
 */
export function missing(a, ctx) {
  if (a.type === 'letters') return { letters: a.letters.filter((l) => !ctx.letters.has(l)) };
  if (a.type === 'set' && !a.need) return { cities: a.set.filter((i) => !ctx.set.has(i)) };
  return {};
}

/** Die noch offenen Erfolge, die am nächsten am Ziel sind */
export function closestGoals(achievements, ctx, unlocked, n = 5) {
  return achievements
    .filter((a) => !unlocked.has(a.id))
    .map((a) => ({ a, ...progress(a, ctx) }))
    .sort((x, y) => (y.cur / y.max) - (x.cur / x.max) || (x.max - x.cur) - (y.max - y.cur))
    .slice(0, n);
}
