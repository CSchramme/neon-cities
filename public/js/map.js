// Neon-Karte: zeichnet Deutschland, Bundesländer und leuchtende Städte auf ein Canvas.
import { STATE_COLORS } from './game.js';

const TAU = Math.PI * 2;
const now = () => performance.now() / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(h, a) {
  const [r, g, b] = hexToRgb(h);
  return `rgba(${r},${g},${b},${a})`;
}
export function mixWhite(h, w) {
  const [r, g, b] = hexToRgb(h);
  return `rgb(${(r + (255 - r) * w) | 0},${(g + (255 - g) * w) | 0},${(b + (255 - b) * w) | 0})`;
}

function sprite(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

const glowSprite = (color) => sprite(128, [
  [0, rgba(color, 1)], [0.2, rgba(color, 0.6)], [0.5, rgba(color, 0.18)], [1, rgba(color, 0)],
]);
const coreSprite = (color) => sprite(64, [
  [0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,255,255,0.95)'], [0.32, rgba(color, 0.85)], [1, rgba(color, 0)],
]);

export class NeonMap {
  constructor(canvas, data, { hints = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = data;
    this.cities = data.cities;
    this.states = data.states;
    this.W = data.width;
    this.H = data.height;
    this.hints = hints;
    this.found = new Set();
    this.counts = new Array(this.states.length).fill(0);
    this.paths = this.states.map((s) => {
      const p = new Path2D();
      for (const r of s.rings) {
        p.moveTo(r[0], r[1]);
        for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]);
        p.closePath();
      }
      return p;
    });
    // Städte direkt an der Grenze liegen durch die vereinfachten Umrisse
    // manchmal knapp außerhalb – deren Licht wird nicht abgeschnitten.
    const probe = document.createElement('canvas').getContext('2d');
    this.outside = new Set();
    this.cities.forEach((c, i) => {
      if (!probe.isPointInPath(this.paths[c.s], c.x, c.y, 'evenodd')) this.outside.add(i);
    });
    this.glow = STATE_COLORS.map(glowSprite);
    this.core = STATE_COLORS.map(coreSprite);
    this.white = glowSprite('#ffffff');
    this.effects = [];
    this.particles = [];
    this.labels = [];
    this.lastTwinkle = 0;
    this.pendingLight = new Set();
    this.foundArray = [];
    this.baseDirty = false;
    this.compDirty = false;
    this.anyDone = false;
    this.layout = null;
    this.running = false;
  }

  // ------------------------------------------------------------ Layout
  setLayout({ stageW, stageH, scale, dpr, rect }) {
    const k = scale * dpr;
    this.k = k;
    this.stageW = stageW;
    this.stageH = stageH;
    this.canvas.width = Math.round(stageW * k);
    this.canvas.height = Math.round(stageH * k);
    this.canvas.style.width = `${stageW}px`;
    this.canvas.style.height = `${stageH}px`;
    const m = Math.min(rect.w / this.W, rect.h / this.H);
    this.m = m;
    this.mapX = rect.x + (rect.w - this.W * m) / 2;
    this.mapY = rect.y + (rect.h - this.H * m) / 2;
    this.mapW = this.W * m;
    this.mapH = this.H * m;
    const pw = Math.max(1, Math.ceil(this.mapW * k));
    const ph = Math.max(1, Math.ceil(this.mapH * k));
    this.base = this.makeLayer(pw, ph);
    this.light = this.makeLayer(pw, ph);
    this.comp = this.makeLayer(pw, ph); // base + light, wird pro Frame nur einmal gezeichnet
    this.done = this.makeLayer(pw, ph); // fertige Bundesländer (pulsieren)
    this.layout = true;
    this.rebuildAll();
  }

  makeLayer(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /** Stadt-Position in Bühnen-Koordinaten */
  cityPos(i) {
    const c = this.cities[i];
    return { x: this.mapX + c.x * this.m, y: this.mapY + c.y * this.m };
  }

  stateCenter(s) {
    const [x, y] = this.states[s].label;
    return { x: this.mapX + x * this.m, y: this.mapY + y * this.m };
  }

  cityRadius(c) {
    return 6.5 + 5.5 * Math.log10(Math.max(c.p, 500) / 500);
  }

  coreRadius(c) {
    return 3.2 + 1.6 * Math.log10(Math.max(c.p, 1000) / 1000);
  }

  // ------------------------------------------------------------ Spielstand
  setFound(ids) {
    this.found = new Set(ids);
    this.foundArray = [];
    this.pendingLight.clear();
    this.counts.fill(0);
    for (const i of this.found) this.counts[this.cities[i].s]++;
    this.effects = [];
    this.particles = [];
    this.labels = [];
    this.rebuildAll();
  }

  addFound(ids, { animate = true, origin = null } = {}) {
    const fresh = ids.filter((i) => !this.found.has(i));
    for (const i of fresh) {
      this.found.add(i);
      this.counts[this.cities[i].s]++;
    }
    if (!this.layout) return;
    // Schutz: bei sehr vielen gleichzeitigen Effekten einfach direkt einschalten
    if (this.effects.length > 160) animate = false;
    if (!animate) {
      for (const i of fresh) this.drawCityLight(i);
      this.baseDirty = true;
      return;
    }
    // Erst unsichtbar markieren, Licht erscheint beim Einschlag des Kometen
    fresh.forEach((i, n) => {
      this.pendingLight.add(i);
      const to = this.cityPos(i);
      const color = STATE_COLORS[this.cities[i].s];
      const delay = n * 0.09;
      const big = fresh.length <= 3;
      if (origin) {
        this.effects.push({
          type: 'comet', from: origin, to, color, t0: now() + delay, dur: 0.75,
          bend: (Math.random() - 0.5) * 0.6,
          onDone: () => this.impact(i, big, fresh.length),
        });
      } else {
        setTimeout(() => this.impact(i, big, fresh.length), delay * 1000);
      }
    });
  }

  impact(i, big, total) {
    if (!this.found.has(i)) return;
    this.pendingLight.delete(i);
    this.drawCityLight(i);
    this.baseDirty = true;
    const c = this.cities[i];
    const p = this.cityPos(i);
    const color = STATE_COLORS[c.s];
    const t = now();
    if (this.effects.length > 200) return;
    this.effects.push({ type: 'ring', x: p.x, y: p.y, color, t0: t, dur: 1.1, r: big ? 90 : 50 });
    this.effects.push({ type: 'ring', x: p.x, y: p.y, color: '#ffffff', t0: t + 0.08, dur: 0.8, r: big ? 55 : 30 });
    this.effects.push({ type: 'flash', x: p.x, y: p.y, color, t0: t, dur: 0.7, r: big ? 140 : 70 });
    this.burst(p.x, p.y, color, big ? 34 : 14);
    const size = total > 6 ? 18 : total > 2 ? 22 : 30;
    if (this.labels.length >= 8) this.labels.shift();
    this.labels.push({ i, text: c.n, x: p.x, y: p.y, color, t0: t, dur: total > 6 ? 3.2 : 4.2, size });
  }

  removeFound(ids) {
    this.foundArray = [];
    this.labels = this.labels.filter((l) => !ids.includes(l.i));
    for (const i of ids) {
      this.pendingLight.delete(i);
      if (this.found.delete(i)) this.counts[this.cities[i].s]--;
    }
    this.rebuildAll();
  }

  stateComplete(s) {
    const t = now();
    this.effects.push({ type: 'stateFlash', s, t0: t + 0.6, dur: 2.8 });
    const inState = [...this.found].filter((i) => this.cities[i].s === s);
    for (let n = 0; n < 6; n++) {
      const i = inState[Math.floor(Math.random() * inState.length)];
      if (i === undefined) break;
      setTimeout(() => {
        const p = this.cityPos(i);
        this.burst(p.x, p.y, STATE_COLORS[s], 40, 1.4);
        this.effects.push({ type: 'ring', x: p.x, y: p.y, color: STATE_COLORS[s], t0: now(), dur: 1.3, r: 120 });
      }, 600 + n * 220);
    }
  }

  celebrate(seconds = 20) {
    const end = now() + seconds;
    const all = [...this.found];
    const fire = () => {
      if (now() > end || !all.length) return;
      const i = all[Math.floor(Math.random() * all.length)];
      const p = this.cityPos(i);
      const color = STATE_COLORS[this.cities[i].s];
      this.burst(p.x, p.y, color, 50, 1.8);
      this.effects.push({ type: 'ring', x: p.x, y: p.y, color, t0: now(), dur: 1.4, r: 150 });
      setTimeout(fire, 180 + Math.random() * 250);
    };
    fire();
    for (let s = 0; s < this.states.length; s++) {
      this.effects.push({ type: 'stateFlash', s, t0: now() + s * 0.12, dur: 3 });
    }
  }

  burst(x, y, color, count, power = 1) {
    if (this.particles.length > 900) return;
    for (let n = 0; n < count; n++) {
      const a = Math.random() * TAU;
      const v = (60 + Math.random() * 240) * power;
      this.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 0.6 + Math.random() * 0.9, age: 0, color, size: 3 + Math.random() * 6,
      });
    }
  }

  // ------------------------------------------------------------ Ebenen
  rebuildAll() {
    if (!this.layout) return;
    const g = this.light.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.light.width, this.light.height);
    // nach Bundesland gruppieren: nur 16 Clip-Operationen statt eine pro Stadt
    const byState = this.states.map(() => []);
    const loose = [];
    for (const i of this.found) {
      if (this.pendingLight.has(i)) continue;
      if (this.outside.has(i)) loose.push(i);
      else byState[this.cities[i].s].push(i);
    }
    const km = this.k * this.m;
    byState.forEach((list, s) => {
      if (!list.length) return;
      g.save();
      g.setTransform(km, 0, 0, km, 0, 0);
      g.clip(this.paths[s], 'evenodd');
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.42;
      for (const i of list) {
        const c = this.cities[i];
        const r = this.cityRadius(c);
        g.drawImage(this.glow[s], c.x - r, c.y - r, r * 2, r * 2);
      }
      g.restore();
    });
    g.save();
    g.setTransform(km, 0, 0, km, 0, 0);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.42;
    for (const i of loose) {
      const c = this.cities[i];
      const r = this.cityRadius(c);
      g.drawImage(this.glow[c.s], c.x - r, c.y - r, r * 2, r * 2);
    }
    for (const i of loose) byState[this.cities[i].s].push(i);
    g.globalAlpha = 0.95;
    byState.forEach((list, s) => {
      for (const i of list) {
        const c = this.cities[i];
        const cr = this.coreRadius(c);
        g.drawImage(this.core[s], c.x - cr, c.y - cr, cr * 2, cr * 2);
      }
    });
    g.restore();
    this.compDirty = true;
    this.baseDirty = true;
  }

  /** base + light zu einem Bild zusammenfassen (spart Rechenzeit pro Frame) */
  recomposite() {
    const g = this.comp.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.comp.width, this.comp.height);
    g.drawImage(this.base, 0, 0);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(this.light, 0, 0);
    g.globalCompositeOperation = 'source-over';
  }

  drawCityLight(i) {
    const c = this.cities[i];
    const g = this.light.getContext('2d');
    const km = this.k * this.m;
    g.save();
    g.setTransform(km, 0, 0, km, 0, 0);
    if (!this.outside.has(i)) g.clip(this.paths[c.s], 'evenodd');
    g.globalCompositeOperation = 'lighter';
    const r = this.cityRadius(c);
    g.globalAlpha = 0.42;
    g.drawImage(this.glow[c.s], c.x - r, c.y - r, r * 2, r * 2);
    g.restore();
    // heller Kern (nicht abgeschnitten)
    g.save();
    g.setTransform(km, 0, 0, km, 0, 0);
    g.globalCompositeOperation = 'lighter';
    const cr = this.coreRadius(c);
    g.globalAlpha = 0.95;
    g.drawImage(this.core[c.s], c.x - cr, c.y - cr, cr * 2, cr * 2);
    g.restore();
    this.compDirty = true;
  }

  rebuildBase() {
    if (!this.layout) return;
    const g = this.base.getContext('2d');
    const k = this.k;
    const m = this.m;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.base.width, this.base.height);
    g.setTransform(k * m, 0, 0, k * m, 0, 0);
    const px = 1 / m; // 1 Bühnenpixel in Karteneinheiten

    // dunkler Grund, damit die Karte auch auf transparentem Hintergrund wirkt
    for (let s = 0; s < this.states.length; s++) {
      g.fillStyle = 'rgba(8,6,24,0.82)';
      g.fill(this.paths[s], 'evenodd');
    }
    // Farbton je nach Fortschritt
    for (let s = 0; s < this.states.length; s++) {
      const p = this.counts[s] / this.states[s].total;
      const done = p >= 1;
      g.fillStyle = rgba(STATE_COLORS[s], done ? 0.42 : 0.05 + 0.25 * p);
      g.fill(this.paths[s], 'evenodd');
    }
    // Leuchtende Grenzen
    g.lineJoin = 'round';
    for (let s = 0; s < this.states.length; s++) {
      const p = this.counts[s] / this.states[s].total;
      const col = STATE_COLORS[s];
      g.save();
      g.shadowColor = col;
      g.shadowBlur = (6 + 22 * p) * k;
      g.strokeStyle = rgba(col, 0.35 + 0.65 * p);
      g.lineWidth = (1.6 + 1.6 * p) * px;
      g.stroke(this.paths[s]);
      g.restore();
      g.strokeStyle = p > 0 ? mixWhite(col, 0.55) : rgba(col, 0.4);
      g.globalAlpha = 0.35 + 0.65 * p;
      g.lineWidth = 0.7 * px;
      g.stroke(this.paths[s]);
      g.globalAlpha = 1;
    }
    // noch dunkle Städte als winzige Punkte
    if (this.hints) {
      g.fillStyle = 'rgba(200,210,255,0.16)';
      const d = 1.3 * px;
      for (let i = 0; i < this.cities.length; i++) {
        if (this.found.has(i)) continue;
        const c = this.cities[i];
        g.fillRect(c.x - d / 2, c.y - d / 2, d, d);
      }
    }
    // Ebene für fertige Bundesländer
    const d = this.done.getContext('2d');
    d.setTransform(1, 0, 0, 1, 0, 0);
    d.clearRect(0, 0, this.done.width, this.done.height);
    d.setTransform(k * m, 0, 0, k * m, 0, 0);
    for (let s = 0; s < this.states.length; s++) {
      if (this.counts[s] < this.states[s].total) continue;
      d.fillStyle = STATE_COLORS[s];
      d.fill(this.paths[s], 'evenodd');
    }
    this.anyDone = this.counts.some((n, s) => n >= this.states[s].total);
    this.compDirty = true;

    // Landeshauptstädte markieren
    for (let i = 0; i < this.cities.length; i++) {
      const c = this.cities[i];
      if (!c.cap) continue;
      const lit = this.found.has(i);
      g.strokeStyle = lit ? mixWhite(STATE_COLORS[c.s], 0.4) : 'rgba(220,225,255,0.35)';
      g.lineWidth = 1.2 * px;
      g.beginPath();
      g.arc(c.x, c.y, 5 * px, 0, TAU);
      g.stroke();
    }
  }

  // ------------------------------------------------------------ Animation
  start() {
    if (this.running) return;
    this.running = true;
    let last = now();
    const loop = () => {
      const t = now();
      const dt = Math.min(0.05, t - last);
      last = t;
      this.frame(t, dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  frame(t, dt) {
    if (!this.layout) return;
    if (this.baseDirty) {
      this.baseDirty = false;
      this.rebuildBase();
    }
    if (this.compDirty) {
      this.compDirty = false;
      this.recomposite();
    }
    const ctx = this.ctx;
    const k = this.k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.comp, this.mapX, this.mapY, this.mapW, this.mapH);
    ctx.globalCompositeOperation = 'lighter';

    // fertige Bundesländer pulsieren
    if (this.anyDone) {
      ctx.globalAlpha = 0.07 + 0.07 * Math.sin(t * 2.2);
      ctx.drawImage(this.done, this.mapX, this.mapY, this.mapW, this.mapH);
      ctx.globalAlpha = 1;
    }

    // Funkeln zufälliger Städte
    if (this.found.size && t - this.lastTwinkle > 0.12) {
      this.lastTwinkle = t;
      if (this.foundArray.length !== this.found.size) this.foundArray = [...this.found];
      const arr = this.foundArray;
      const i = arr[Math.floor(Math.random() * arr.length)];
      if (!this.pendingLight.has(i)) {
        const p = this.cityPos(i);
        this.effects.push({ type: 'twinkle', x: p.x, y: p.y, color: STATE_COLORS[this.cities[i].s], t0: t, dur: 0.9 });
      }
    }

    this.drawEffects(ctx, t);
    this.drawParticles(ctx, dt);
    ctx.globalCompositeOperation = 'source-over';
    this.drawLabels(ctx, t);
  }

  fillState(ctx, s, style) {
    ctx.save();
    ctx.translate(this.mapX, this.mapY);
    ctx.scale(this.m, this.m);
    ctx.fillStyle = style;
    ctx.fill(this.paths[s], 'evenodd');
    ctx.restore();
  }

  drawEffects(ctx, t) {
    const keep = [];
    for (const e of this.effects) {
      const p = (t - e.t0) / e.dur;
      if (p < 0) { keep.push(e); continue; }
      if (p >= 1) { e.onDone?.(); continue; }
      keep.push(e);
      switch (e.type) {
        case 'comet': this.drawComet(ctx, e, p); break;
        case 'ring': {
          const q = easeOut(p);
          ctx.strokeStyle = rgba(e.color, (1 - p) * 0.9);
          ctx.lineWidth = 4 * (1 - p) + 0.5;
          ctx.shadowColor = e.color;
          ctx.shadowBlur = 16 * this.k;
          ctx.beginPath();
          ctx.arc(e.x, e.y, 4 + e.r * q, 0, TAU);
          ctx.stroke();
          ctx.shadowBlur = 0;
          break;
        }
        case 'flash': {
          const r = e.r * (0.4 + 0.6 * easeOut(p));
          ctx.globalAlpha = (1 - p) ** 2;
          ctx.drawImage(this.glow[STATE_COLORS.indexOf(e.color)] || this.white, e.x - r, e.y - r, r * 2, r * 2);
          ctx.drawImage(this.white, e.x - r * 0.3, e.y - r * 0.3, r * 0.6, r * 0.6);
          ctx.globalAlpha = 1;
          break;
        }
        case 'twinkle': {
          const a = Math.sin(p * Math.PI);
          const r = 9 * a;
          ctx.globalAlpha = a * 0.9;
          ctx.strokeStyle = mixWhite(e.color, 0.6);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(e.x - r, e.y); ctx.lineTo(e.x + r, e.y);
          ctx.moveTo(e.x, e.y - r); ctx.lineTo(e.x, e.y + r);
          ctx.stroke();
          ctx.drawImage(this.white, e.x - r * 0.6, e.y - r * 0.6, r * 1.2, r * 1.2);
          ctx.globalAlpha = 1;
          break;
        }
        case 'stateFlash': {
          const a = Math.sin(clamp(p, 0, 1) * Math.PI) * 0.75;
          this.fillState(ctx, e.s, rgba(STATE_COLORS[e.s], a));
          ctx.save();
          ctx.translate(this.mapX, this.mapY);
          ctx.scale(this.m, this.m);
          ctx.shadowColor = STATE_COLORS[e.s];
          ctx.shadowBlur = 40 * this.k * a;
          ctx.strokeStyle = rgba('#ffffff', a);
          ctx.lineWidth = 3 / this.m;
          ctx.stroke(this.paths[e.s]);
          ctx.restore();
          break;
        }
        default: break;
      }
    }
    this.effects = keep;
  }

  drawComet(ctx, e, p) {
    const pos = (q) => {
      const { from, to } = e;
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const cx = mx - dy * e.bend;
      const cy = my + dx * e.bend - Math.hypot(dx, dy) * 0.25;
      const u = 1 - q;
      return { x: u * u * from.x + 2 * u * q * cx + q * q * to.x, y: u * u * from.y + 2 * u * q * cy + q * q * to.y };
    };
    const q = easeInOut(p);
    for (let n = 14; n >= 0; n--) {
      const qq = Math.max(0, q - n * 0.018);
      const pt = pos(qq);
      const r = (16 - n) * 1.4;
      ctx.globalAlpha = (1 - n / 15) * 0.8;
      ctx.drawImage(this.glow[STATE_COLORS.indexOf(e.color)], pt.x - r, pt.y - r, r * 2, r * 2);
    }
    const head = pos(q);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.white, head.x - 12, head.y - 12, 24, 24);
    if (Math.random() < 0.6) {
      this.particles.push({ x: head.x, y: head.y, vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60, life: 0.5, age: 0, color: e.color, size: 3 + Math.random() * 3 });
    }
  }

  drawParticles(ctx, dt) {
    const keep = [];
    for (const pt of this.particles) {
      pt.age += dt;
      if (pt.age >= pt.life) continue;
      pt.vx *= 0.94;
      pt.vy = pt.vy * 0.94 + 40 * dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      const a = 1 - pt.age / pt.life;
      const r = pt.size * (0.5 + a * 0.5);
      ctx.globalAlpha = a;
      ctx.drawImage(this.core[STATE_COLORS.indexOf(pt.color)] || this.white, pt.x - r, pt.y - r, r * 2, r * 2);
      keep.push(pt);
    }
    ctx.globalAlpha = 1;
    this.particles = keep;
  }

  drawLabels(ctx, t) {
    const keep = [];
    for (const l of this.labels) {
      const p = (t - l.t0) / l.dur;
      if (p >= 1) continue;
      keep.push(l);
      const a = p < 0.08 ? p / 0.08 : p > 0.75 ? (1 - p) / 0.25 : 1;
      const rise = easeOut(Math.min(1, p * 4)) * 14;
      ctx.font = `${l.size}px "Tilt Neon", "Rajdhani", sans-serif`;
      const w = ctx.measureText(l.text).width;
      const x = clamp(l.x, w / 2 + 8, this.stageW - w / 2 - 8);
      const y = l.y - 18 - rise;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.globalAlpha = a;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(5,3,20,0.75)';
      ctx.strokeText(l.text, x, y);
      ctx.shadowColor = l.color;
      ctx.shadowBlur = 14 * this.k;
      ctx.fillStyle = mixWhite(l.color, 0.6);
      ctx.fillText(l.text, x, y);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
    this.labels = keep;
  }
}
