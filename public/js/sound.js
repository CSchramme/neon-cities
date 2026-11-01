// Kleine Synth-Soundeffekte (WebAudio) – keine Audiodateien nötig.
// In OBS/TikTok LIVE Studio laufen die Sounds automatisch; im normalen
// Browser erst nach einem Klick (Autoplay-Regeln).

const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

export class Sound {
  constructor({ enabled = true, ticks = true, volume = 0.6 } = {}) {
    this.enabled = enabled;
    this.ticks = ticks;
    this.volume = volume;
    this.ctx = null;
    const unlock = () => this.ensure();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  ensure() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        const comp = this.ctx.createDynamicsCompressor();
        this.master.connect(comp).connect(this.ctx.destination);
      } catch {
        this.enabled = false;
        return null;
      }
    }
    if (this.ctx.state === 'suspended') {
      // Ohne Klick blockiert der Browser Audio (OBS & TikTok LIVE Studio erlauben es)
      const active = navigator.userActivation ? navigator.userActivation.hasBeenActive : true;
      if (!active) return null;
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  tone({ freq = 440, type = 'sine', at = 0, dur = 0.3, gain = 0.3, attack = 0.005, slideTo = null }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  noise({ at = 0, dur = 0.05, gain = 0.1, freq = 3000 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
  }

  note(step, base = 523.25) {
    return base * 2 ** (step / 12);
  }

  // Jeder Buchstabe: kurzes "Neon-Zünden"
  tick() {
    if (!this.ticks) return;
    this.noise({ dur: 0.035, gain: 0.12, freq: 2500 + Math.random() * 2500 });
    this.tone({ freq: 1800 + Math.random() * 600, type: 'square', dur: 0.03, gain: 0.015 });
  }

  // Stadt gefunden – Tonhöhe hängt vom Bundesland ab
  found(stateIdx = 0, count = 1) {
    const root = PENTA[stateIdx % 6];
    const n = Math.min(count, 6);
    this.tone({ freq: this.note(root - 12), type: 'triangle', dur: 0.5, gain: 0.25 });
    for (let i = 0; i <= n; i++) {
      const step = root + PENTA[Math.min(i + 2, PENTA.length - 1)];
      this.tone({ freq: this.note(step), type: 'sine', at: i * 0.07, dur: 0.5, gain: 0.18 });
      this.tone({ freq: this.note(step + 12), type: 'triangle', at: i * 0.07 + 0.01, dur: 0.3, gain: 0.05 });
    }
    this.noise({ at: 0.02, dur: 0.4, gain: 0.05, freq: 7000 });
  }

  already() {
    this.tone({ freq: 660, type: 'sine', dur: 0.12, gain: 0.12 });
    this.tone({ freq: 660, type: 'sine', at: 0.13, dur: 0.15, gain: 0.1 });
  }

  miss() {
    this.tone({ freq: 140, type: 'sawtooth', dur: 0.28, gain: 0.12, slideTo: 90 });
    this.tone({ freq: 147, type: 'square', dur: 0.22, gain: 0.04, slideTo: 95 });
  }

  stateComplete(stateIdx = 0) {
    const root = PENTA[stateIdx % 5] - 5;
    [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => {
      this.tone({ freq: this.note(root + s, 261.63), type: 'sawtooth', at: i * 0.06, dur: 1.4, gain: 0.05, attack: 0.05 });
      this.tone({ freq: this.note(root + s, 523.25), type: 'sine', at: i * 0.06, dur: 1.2, gain: 0.08 });
    });
    this.noise({ at: 0, dur: 1.2, gain: 0.05, freq: 8000 });
  }

  milestone() {
    [0, 4, 7, 12].forEach((s, i) => this.tone({ freq: this.note(s), type: 'square', at: i * 0.09, dur: 0.25, gain: 0.06 }));
    this.tone({ freq: this.note(24), type: 'sine', at: 0.36, dur: 0.9, gain: 0.15 });
  }

  // Erfolg freigeschaltet: glitzerndes Glocken-Arpeggio
  achievement(tier = 'bronze') {
    const lift = { bronze: 0, silber: 2, gold: 4, platin: 7 }[tier] ?? 0;
    [0, 7, 12, 16, 19, 24].forEach((st, i) => {
      this.tone({ freq: this.note(st + lift, 659.25), type: 'triangle', at: i * 0.07, dur: 0.9, gain: 0.1 });
      this.tone({ freq: this.note(st + lift + 12, 659.25), type: 'sine', at: i * 0.07 + 0.02, dur: 0.6, gain: 0.04 });
    });
    this.tone({ freq: this.note(lift - 12, 659.25), type: 'sine', at: 0, dur: 1.4, gain: 0.12 });
    for (let i = 0; i < 4; i++) this.noise({ at: 0.35 + i * 0.12, dur: 0.25, gain: 0.03, freq: 9000 });
  }

  win() {
    const seq = [0, 4, 7, 12, 7, 12, 16, 19, 24];
    seq.forEach((s, i) => {
      this.tone({ freq: this.note(s), type: 'sawtooth', at: i * 0.12, dur: 0.6, gain: 0.06 });
      this.tone({ freq: this.note(s + 12), type: 'sine', at: i * 0.12, dur: 0.8, gain: 0.1 });
    });
    for (let i = 0; i < 6; i++) this.noise({ at: 1 + i * 0.25, dur: 0.6, gain: 0.08, freq: 3000 + i * 800 });
  }
}
