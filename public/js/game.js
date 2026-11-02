// Gemeinsame Spiel-Logik – läuft im Browser UND im Node-Server.

// Neonfarben je Bundesland (Reihenfolge = Index in germany.json).
// Nachbarländer haben bewusst stark unterschiedliche Farbtöne.
export const STATE_COLORS = [
  '#2f7bff', // SH Schleswig-Holstein
  '#e040ff', // HH Hamburg
  '#ffa31a', // NI Niedersachsen
  '#00f0ff', // HB Bremen
  '#5a3dff', // NW Nordrhein-Westfalen (kräftig, damit es voll beleuchtet nicht weiß wird)
  '#c8ff1a', // HE Hessen
  '#ff6a1a', // RP Rheinland-Pfalz
  '#ff2d6f', // BW Baden-Württemberg
  '#00b4ff', // BY Bayern
  '#00ffc8', // SL Saarland
  '#fff04d', // BE Berlin
  '#ff3b30', // BB Brandenburg
  '#00ffa2', // MV Mecklenburg-Vorpommern
  '#39ff14', // SN Sachsen
  '#b04dff', // ST Sachsen-Anhalt
  '#ff4fa0', // TH Thüringen
];

const PREPOSITIONS = '(?:an der|an dem|am|im|in der|in|bei|vor der|auf dem|ob der|unter der|zu)';

/** Liefert die Vergleichsschlüssel eines Textes (ä→a und ä→ae Varianten). */
export function fold(str) {
  let s = String(str ?? '').toLowerCase().normalize('NFC');
  s = s.replace(/ß/g, 'ss').replace(/\bsankt\b/g, 'st').replace(/\bst\./g, 'st ');
  const clean = (x) => x
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/[^a-z0-9]/g, '');
  const a = clean(s.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u'));
  const b = clean(s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'));
  return a === b ? (a ? [a] : []) : [a, b];
}

/** "Frankfurt am Main" -> "Frankfurt", "Halle (Saale)" -> "Halle" */
export function baseName(name) {
  const re = new RegExp(`\\s*\\(|/|\\s+${PREPOSITIONS}\\s+|\\s+[aibv]\\.\\s*`, 'i');
  return String(name).split(re)[0].trim();
}

/** "Frankfurt am Main" -> "Frankfurt Main" (damit "Frankfurt/Main" passt) */
function withoutPrepositions(name) {
  return String(name).replace(new RegExp(`\\s+${PREPOSITIONS}\\s+`, 'gi'), ' ');
}

/** Suchindex: Eingabe -> Liste von Indizes. */
export class NameIndex {
  constructor() { this.map = new Map(); }
  add(key, i) {
    let list = this.map.get(key);
    if (!list) this.map.set(key, (list = []));
    if (!list.includes(i)) list.push(i);
  }
  addName(name, i, { base = true } = {}) {
    const variants = [name, withoutPrepositions(name)];
    if (base) {
      const b = baseName(name);
      if (b.length >= 3) variants.push(b);
    }
    for (const v of variants) for (const k of fold(v)) this.add(k, i);
  }
  match(text) {
    const out = new Set();
    for (const k of fold(text)) for (const i of this.map.get(k) || []) out.add(i);
    return [...out];
  }
}

// Zusätzliche, im Alltag übliche Schreibweisen
const EXTRA_ALIASES = {
  'Hann. Münden': ['Hannoversch Münden'],
  'Frankfurt am Main': ['Frankfurt a.M.', 'Frankfurt a. M.'],
  'Frankfurt (Oder)': ['Frankfurt a.d.O.', 'Frankfurt an der Oder'],
  'Halle (Saale)': ['Halle an der Saale'],
  'Wittenberg': ['Lutherstadt Wittenberg'],
};

export function buildCityIndex(cities) {
  const idx = new NameIndex();
  cities.forEach((c, i) => {
    idx.addName(c.n, i);
    for (const a of EXTRA_ALIASES[c.n] || []) idx.addName(a, i);
    if (c.o) idx.addName(c.o, i);
    for (const a of c.a || []) idx.addName(a, i);
  });
  return idx;
}

export function formatNumber(n) {
  return Number(n).toLocaleString('de-DE');
}
