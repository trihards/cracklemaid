/*
 * Cracklemaid fire engine — an AudioWorklet that synthesizes a campfire in real time.
 *
 * Nothing here is a recording or a loop. Every layer is driven by its own random
 * process, so the fire never repeats:
 *
 *   bed      turbulent flame "roar" (pink noise, lapping at the flame-puffing rate),
 *            mid-band flutter, high fizzing hiss, and a sub-bass rumble
 *   crackle  tiny resin/steam micro-fractures. Arrivals follow a self-exciting
 *            (Hawkes) process, so they cluster the way real crackles do instead of
 *            ticking like uniform random clicks
 *   snap     resonant wood fractures, often a short cascade of sub-cracks
 *   pop      steam pockets bursting: a soft body thump + bright crack, sometimes
 *            followed by a spray of ember debris or a quiet "singing log" whistle
 *   settle   rare log shifts: a low thud, a trickle of embers, a brief flare-up
 *   wind     gusting breeze that also fans the flames
 *
 * Mood: several Ornstein–Uhlenbeck processes on different timescales (seconds to
 * minutes) create swells and lulls. All user parameters glide; nothing restarts.
 *
 * The same file runs under Node for offline analysis (tools/render.mjs).
 */

const SR = typeof sampleRate !== 'undefined' ? sampleRate : 48000;
const TWO_PI = Math.PI * 2;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;

// Calibration constants: per-layer levels, set by measuring each layer in isolation.
const K = {
  pink: 0.11,     // normalizes the Kellet pink filter to ~unit-ish RMS of white
  roar: 0.36,
  flutter: 0.36,
  hiss: 0.075,
  rumble: 0.75,
  tick: 16.5,
  snap: 8.2,
  pop: 15.5,
  steam: 0.07,
  thud: 6,
  wind: 0.65,
  leaves: 0.06,
  reverb: 0.55,
  master: 1.6,
};
// test seam: tools/render.mjs can override levels when soloing layers
if (typeof globalThis.__cracklemaidK === 'object') Object.assign(K, globalThis.__cracklemaidK);

// Loudness makeup (dB) by fire size, measured with tools/render.mjs + EBU R128 so
// that embers and a bonfire differ by ~6 LU instead of ~17.
const MAKEUP_SIZE = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1];
const MAKEUP_DB = [19.5, 14.4, 8.5, 5.3, 3, 0.6, -0.3, -1.8];
function makeupGain(size) {
  let i = 1;
  while (i < MAKEUP_SIZE.length - 1 && size > MAKEUP_SIZE[i]) i++;
  const t = clamp((size - MAKEUP_SIZE[i - 1]) / (MAKEUP_SIZE[i] - MAKEUP_SIZE[i - 1]), 0, 1);
  return Math.pow(10, lerp(MAKEUP_DB[i - 1], MAKEUP_DB[i], t) / 20);
}

/* ---------- small DSP building blocks ---------- */

class Rng { // sfc32: fast, good-quality PRNG for event decisions
  constructor(seed) {
    this.a = 0x9e3779b9 | 0; this.b = 0x243f6a88 | 0; this.c = 0xb7e15162 | 0; this.d = seed | 0;
    for (let i = 0; i < 16; i++) this.next();
  }
  next() {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  logRange(a, b) { return a * Math.pow(b / a, this.next()); }
  gauss() { return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508; }
  exp() { return -Math.log(1 - this.next()); }
  // Pareto-distributed amplitude in [1, cap]: many small events, few big ones
  // Event loudness: log-normal spread with occasional accents, capped so no
  // single crackle can ever jump out of the texture
  accent(sigma, pAccent, cap) {
    const a = Math.exp(sigma * this.gauss()) * (this.next() < pAccent ? 2 : 1);
    return Math.min(cap, a);
  }
}

// Topology-preserving state variable filter (Simper). Stable under modulation.
class Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 1; this.a2 = 0; this.a3 = 0; this.k = 1; }
  set(fc, q) {
    const g = Math.tan(Math.PI * clamp(fc, 10, SR * 0.45) / SR);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
    return this;
  }
  lp(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }
  bp(x) { // unity peak gain
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return this.k * v1;
  }
  hp(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return x - this.k * v1 - v2;
  }
}

const onePoleCoef = (fc) => 1 - Math.exp(-TWO_PI * fc / SR);

// Mean-reverting random walk, updated at control rate
class Ou {
  constructor(tau) { this.tau = tau; this.x = 0; }
  step(dt, rng) {
    const a = dt / this.tau;
    this.x += -this.x * a + Math.sqrt(2 * a) * rng.gauss();
    return this.x;
  }
}

// Noise-driven resonator at control rate: gives the flame-lapping motion a
// preferred tempo without ever becoming a regular rhythm.
class Lapper {
  constructor() { this.y1 = 0; this.y2 = 0; this.c1 = 0; this.c2 = 0; this.norm = 1; this.f = 0; }
  tune(freq, ctrlRate) {
    if (Math.abs(freq - this.f) < 1e-3) return;
    this.f = freq;
    const w = TWO_PI * freq / ctrlRate;
    const r = Math.exp(-Math.PI * freq * 1.3 / ctrlRate);
    this.c1 = 2 * r * Math.cos(w); this.c2 = -r * r;
    const r2 = r * r, cw = Math.cos(w);
    const variance = (1 + r2) / ((1 - r2) * ((1 + r2) * (1 + r2) - 4 * r2 * cw * cw));
    this.norm = 1 / Math.sqrt(variance);
  }
  step(rng) {
    const y = this.c1 * this.y1 + this.c2 * this.y2 + rng.gauss();
    this.y2 = this.y1; this.y1 = y;
    return y * this.norm;
  }
}

// 8-line feedback delay network with input diffusion: a soft, diffuse space
class Reverb {
  constructor() {
    const base = [631, 797, 1031, 1259, 1499, 1747, 2011, 2269];
    this.len = base.map((n) => Math.round(n * SR / 48000));
    this.buf = this.len.map((n) => new Float32Array(n));
    this.idx = new Int32Array(8);
    this.lp = new Float64Array(8);
    this.g = new Float64Array(8);
    this.x = new Float64Array(8);
    this.ap = [Math.round(142 * SR / 48000), Math.round(379 * SR / 48000), Math.round(107 * SR / 48000), Math.round(331 * SR / 48000)]
      .map((n) => ({ buf: new Float32Array(n), i: 0 }));
    this.damp = onePoleCoef(5200);
    for (let i = 0; i < 8; i++) this.g[i] = Math.pow(10, -3 * this.len[i] / (SR * 1.15));
  }
  allpass(a, x) {
    const d = a.buf[a.i];
    const y = d - 0.6 * x;
    a.buf[a.i] = x + 0.6 * y;
    if (++a.i >= a.buf.length) a.i = 0;
    return y;
  }
  tick(inL, inR, out) {
    inL = this.allpass(this.ap[1], this.allpass(this.ap[0], inL));
    inR = this.allpass(this.ap[3], this.allpass(this.ap[2], inR));
    const x = this.x;
    for (let i = 0; i < 8; i++) {
      const o = this.buf[i][this.idx[i]];
      this.lp[i] += this.damp * (o - this.lp[i]);
      x[i] = this.lp[i] * this.g[i];
    }
    out[0] = x[0] - x[2] + x[4] - x[6];
    out[1] = x[1] - x[3] + x[5] - x[7];
    // fast Walsh–Hadamard transform (orthogonal mixing), scaled by 1/sqrt(8)
    for (let h = 1; h < 8; h <<= 1) {
      for (let i = 0; i < 8; i += h << 1) {
        for (let j = i; j < i + h; j++) {
          const a = x[j], b = x[j + h];
          x[j] = a + b; x[j + h] = a - b;
        }
      }
    }
    const s = 0.35355339;
    for (let i = 0; i < 8; i++) {
      this.buf[i][this.idx[i]] = x[i] * s + ((i & 1) ? inR : inL) * ((i & 2) ? -1 : 1);
      if (++this.idx[i] >= this.len[i]) this.idx[i] = 0;
    }
  }
}

/* ---------- event voices ---------- */

// Crackles, snaps, and ember debris: a difference-of-exponentials burst of noise
// (smooth attack, no hard edge) through a resonant bandpass, with optional
// sub-impulses that make a single crack read as a tiny cascade.
class Tick {
  constructor(seed) { this.on = false; this.f = new Svf(); this.s = seed | 1; }
  trigger(amp, fc, q, tauA, tauD, mixD, pan, subs, gapMs, start) {
    this.f.set(fc, q); this.f.ic1 = 0; this.f.ic2 = 0;
    this.d1 = Math.exp(-1 / (tauD * SR)); this.d2 = Math.exp(-1 / (tauA * SR));
    this.e1 = 1; this.e2 = 1;
    // bandwidth compensation: high, wide bands would otherwise dominate
    const g = amp * Math.pow(q * 1500 / fc, 0.3);
    const ang = (pan + 1) * Math.PI / 4;
    this.gl = g * Math.cos(ang) * 1.4142; this.gr = g * Math.sin(ang) * 1.4142;
    this.mixB = 1 - mixD; this.mixD = mixD;
    this.subs = subs; this.gap = Math.max(4, Math.round(gapMs * 0.001 * SR)); this.subT = this.gap; this.subA = 0.6;
    this.life = Math.ceil((tauD * 9 + (q / (Math.PI * fc)) * 7) * SR) + this.gap * subs;
    this.start = start; this.on = true;
  }
  render(L, R, n) {
    let s = this.s, e1 = this.e1, e2 = this.e2;
    const d1 = this.d1, d2 = this.d2, f = this.f, mb = this.mixB, md = this.mixD, gl = this.gl, gr = this.gr;
    let i = this.start; this.start = 0;
    for (; i < n && this.life > 0; i++, this.life--) {
      if (this.subs > 0 && --this.subT <= 0) {
        e1 += this.subA; e2 += this.subA; this.subA *= 0.7; this.subs--;
        this.subT = Math.round(this.gap * 1.35); this.gap = this.subT;
      }
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const x = s * 4.656612873e-10 * (e1 - e2);
      e1 *= d1; e2 *= d2;
      const y = mb * f.bp(x) + md * x;
      L[i] += gl * y; R[i] += gr * y;
    }
    this.s = s; this.e1 = e1; this.e2 = e2;
    if (this.life <= 0) this.on = false;
  }
}

// Steam-pocket pop: a soft low "thoomp" body plus a short bright crack
class Pop {
  constructor(seed) { this.on = false; this.fb = new Svf(); this.fc = new Svf(); this.s = seed | 1; }
  trigger(rng, amp, pan, start) {
    const fb = rng.logRange(150, 380), qb = rng.range(1.1, 2.0);
    const fc = rng.logRange(1300, 3400), qc = rng.range(1.2, 2.6);
    this.fb.set(fb, qb); this.fb.ic1 = this.fb.ic2 = 0;
    this.fc.set(fc, qc); this.fc.ic1 = this.fc.ic2 = 0;
    const tauB = rng.logRange(0.014, 0.03), tauC = rng.logRange(0.0006, 0.0016);
    this.b1 = 1; this.b2 = 1; this.db1 = Math.exp(-1 / (tauB * SR)); this.db2 = Math.exp(-1 / (0.0015 * SR));
    this.c1 = 1; this.c2 = 1; this.dc1 = Math.exp(-1 / (tauC * SR)); this.dc2 = Math.exp(-1 / (0.00008 * SR));
    this.gb = amp * Math.sqrt(qb * 900 / fb) * 0.9;
    this.gc = amp * Math.sqrt(qc * 1500 / fc) * rng.range(0.35, 0.7);
    const ang = (pan + 1) * Math.PI / 4;
    this.pl = Math.cos(ang) * 1.4142; this.pr = Math.sin(ang) * 1.4142;
    this.life = Math.ceil(tauB * 8 * SR);
    this.start = start; this.on = true;
  }
  render(L, R, n) {
    let s = this.s;
    const fb = this.fb, fc = this.fc;
    let i = this.start; this.start = 0;
    for (; i < n && this.life > 0; i++, this.life--) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const w = s * 4.656612873e-10;
      const y = this.gb * fb.bp(w * (this.b1 - this.b2)) + this.gc * fc.bp(w * (this.c1 - this.c2));
      this.b1 *= this.db1; this.b2 *= this.db2; this.c1 *= this.dc1; this.c2 *= this.dc2;
      L[i] += this.pl * y; R[i] += this.pr * y;
    }
    this.s = s;
    if (this.life <= 0) this.on = false;
  }
}

// "Singing log": steam venting through a crack, a breathy, drifting whistle
class Steam {
  constructor(seed) { this.on = false; this.f = new Svf(); this.f2 = new Svf(); this.s = seed | 1; this.bub = new Ou(0.03); }
  trigger(rng, amp, pan) {
    this.fc0 = rng.logRange(2400, 4800); this.q = rng.range(5, 10);
    this.att = rng.range(0.3, 0.9); this.hold = rng.range(0.6, 3.2); this.rel = rng.range(0.8, 2.0);
    this.t = 0; this.amp = amp; this.drift = rng.range(-0.15, 0.1); this.g0 = 0; this.g1 = 0;
    const ang = (pan + 1) * Math.PI / 4; this.pl = Math.cos(ang) * 1.4142; this.pr = Math.sin(ang) * 1.4142;
    this.on = true;
  }
  control(dt, rng) {
    const t = this.t, end = this.att + this.hold + this.rel;
    let env = t < this.att ? t / this.att : t < this.att + this.hold ? 1 : Math.max(0, 1 - (t - this.att - this.hold) / this.rel);
    env = env * env * (3 - 2 * env);
    const p = t / end;
    const fc = this.fc0 * (1 + this.drift * p + 0.02 * Math.sin(t * 7.3));
    this.f.set(fc, this.q); this.f2.set(fc * 1.9, 3);
    this.g0 = this.g1;
    this.g1 = this.amp * env * Math.exp(0.6 * this.bub.step(dt, rng));
    this.t += dt;
    if (t > end) { this.on = false; this.g1 = 0; }
  }
  render(L, R, n) {
    let s = this.s;
    const dg = (this.g1 - this.g0) / n;
    let g = this.g0;
    for (let i = 0; i < n; i++, g += dg) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const w = s * 4.656612873e-10;
      const y = g * (this.f.bp(w) + 0.35 * this.f2.bp(w));
      L[i] += this.pl * y; R[i] += this.pr * y;
    }
    this.s = s;
  }
}

// Log settling: low, padded thud (no sharp edge)
class Thud {
  constructor(seed) { this.on = false; this.f = new Svf(); this.s = seed | 1; }
  trigger(rng, amp, start) {
    this.f.set(rng.logRange(110, 220), 0.9); this.f.ic1 = this.f.ic2 = 0;
    this.e1 = 1; this.e2 = 1;
    this.d1 = Math.exp(-1 / (rng.logRange(0.05, 0.1) * SR)); this.d2 = Math.exp(-1 / (0.006 * SR));
    this.g = amp; this.life = Math.ceil(0.9 * SR); this.start = start; this.on = true;
  }
  render(L, R, n) {
    let s = this.s;
    let i = this.start; this.start = 0;
    for (; i < n && this.life > 0; i++, this.life--) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const y = this.g * this.f.lp(s * 4.656612873e-10 * (this.e1 - this.e2));
      this.e1 *= this.d1; this.e2 *= this.d2;
      L[i] += y; R[i] += y;
    }
    this.s = s;
    if (this.life <= 0) this.on = false;
  }
}

/* ---------- the fire ---------- */

const EV_TICK = 0, EV_SNAP = 1, EV_DEBRIS = 2, EV_POP = 3, EV_STEAM = 4, EV_SETTLE = 5;

const DEFAULTS = { size: 0.5, crackle: 0.5, pops: 0.35, warmth: 0.6, distance: 0.3, wind: 0 };
const PARAM_KEYS = Object.keys(DEFAULTS);

class Fire {
  constructor(seed, params) {
    this.rng = new Rng(seed);
    const r = () => (this.rng.next() * 4294967295) | 1;
    this.p = Object.assign({}, DEFAULTS, params);
    this.target = Object.assign({}, this.p);
    this.glideTau = 0.3;

    // audio-rate noise states (xorshift32)
    this.s1 = r(); this.s2 = r(); this.s3 = r();
    this.pk = new Float64Array(6); // pink filter states, L and R

    this.roarL = new Svf(); this.roarR = new Svf();
    this.flutL = new Svf(); this.flutR = new Svf();
    this.hissL = new Svf(); this.hissR = new Svf();
    this.hzL = 0; this.hzR = 0; this.aHz = onePoleCoef(9000);
    this.rum1 = new Svf().set(85, 0.7); this.rum2 = new Svf().set(36, 0.7);
    this.windL = new Svf(); this.windR = new Svf(); this.leaves = new Svf().set(3200, 0.7);
    this.roarHpL = 0; this.roarHpR = 0; this.aRoarHp = onePoleCoef(90);
    this.flutHpL = 0; this.flutHpR = 0; this.aFlutHp = onePoleCoef(220);
    this.tLpL = new Svf(); this.tLpR = new Svf();
    this.airL = new Svf(); this.airR = new Svf();
    this.reverb = new Reverb();
    this.rv = new Float64Array(2);
    this.lowL = 0; this.lowR = 0; this.hiL = 0; this.hiR = 0; this.dcL = 0; this.dcR = 0;
    this.aLow = onePoleCoef(170); this.aHi = onePoleCoef(3500); this.aDc = onePoleCoef(22);

    // mood: slow swells, medium breathing, crackliness drift, fast flicker
    this.ouSlow = new Ou(90); this.ouMid = new Ou(14); this.ouCrk = new Ou(20);
    this.ouFlick = new Ou(0.05); this.ouFizz = new Ou(0.025);
    this.ouGust = new Ou(5); this.ouGustSlow = new Ou(40); this.ouWindPan = new Ou(12); this.ouLeaf = new Ou(0.06);
    this.lapper = new Lapper();
    this.swell = 0;

    // event state (time-rescaled Poisson accumulators)
    this.ev = Array.from({ length: 6 }, () => ({ acc: 0, thr: this.rng.exp() }));
    this.D = { tickAmp: 0, snapAmp: 0, spread: 0, center: 0, branch: 0 };
    this.excite = 0; this.debris = 0;

    this.ticks = Array.from({ length: 40 }, () => new Tick(r()));
    this.pops = Array.from({ length: 4 }, () => new Pop(r()));
    this.steams = Array.from({ length: 2 }, () => new Steam(r()));
    this.thud = new Thud(r());

    this.tL = new Float32Array(128); this.tR = new Float32Array(128);
    this.bL = new Float32Array(128); this.bR = new Float32Array(128);

    // block-interpolated gains: [previous, current]
    this.g = { roar: [0, 0], flut: [0, 0], hiss: [0, 0], rum: [0, 0], wind: [0, 0], leaf: [0, 0], wpan: [0.5, 0.5],
      width: [1, 1], tGain: [1, 1], dry: [1, 1], wet: [0, 0], low: [0, 0], high: [0, 0], out: [1, 1] };

    this.gKeys = Object.keys(this.g);
    this.glow = 0; this.flash = 0;
    this.first = true;
  }

  setParams(p, glide) {
    for (const k of PARAM_KEYS) if (typeof p[k] === 'number') this.target[k] = clamp(p[k], 0, 1);
    if (glide === 0) Object.assign(this.p, this.target);
    this.glideTau = Math.max(0.02, glide == null ? 0.3 : glide);
  }

  freeTick() { for (const t of this.ticks) if (!t.on) return t; return null; }

  // kind: 0 crackle, 1 snap, 2 debris
  spawnTick(kind, start, D) {
    const t = this.freeTick();
    if (!t) return;
    const rng = this.rng, p = this.p;
    const width = D.spread;
    const pan = clamp(rng.gauss() * width * 0.5 + D.center, -0.95, 0.95);
    if (kind === 0) {
      const a = rng.accent(0.4, 0.06, 2.2);
      const fc = rng.logRange(1500, 7000) * (1.1 - 0.1 * a);
      const subs = rng.next() < 0.3 ? 1 + ((rng.next() * 2) | 0) : 0;
      t.trigger(D.tickAmp * a, fc, rng.range(0.7, 2.4), 0.00004, rng.logRange(0.00012, 0.0006), 0.3, pan, subs, rng.logRange(0.4, 3), start);
    } else if (kind === 1) {
      const a = rng.accent(0.4, 0.1, 2.5);
      const subs = (rng.next() * 4) | 0;
      t.trigger(D.snapAmp * a, rng.logRange(650, 2400), rng.range(2, 5.5), 0.00008, rng.logRange(0.0012, 0.0045), 0.15, pan, subs, rng.logRange(1, 7), start);
    } else {
      const a = rng.accent(0.5, 0, 2.5);
      t.trigger(D.tickAmp * 0.35 * a * (0.6 + 0.4 * p.crackle), rng.logRange(2800, 8500), rng.range(2, 6), 0.00003, rng.logRange(0.00008, 0.00028), 0.1, pan, 0, 1, start);
    }
    this.flash = Math.max(this.flash, kind === 1 ? 0.6 : 0.25);
  }

  // Advance an inhomogeneous Poisson process over one block (time-rescaling method)
  events(kind, n, rate) {
    const state = this.ev[kind];
    let pos = 0;
    for (;;) {
      const per = rate() / SR;
      if (!(per > 0)) return;
      const need = (state.thr - state.acc) / per;
      if (pos + need >= n) { state.acc += per * (n - pos); return; }
      pos += need;
      state.acc = 0; state.thr = this.rng.exp();
      this.onEvent(kind, pos | 0);
    }
  }

  onEvent(kind, o) {
    const rng = this.rng, p = this.p, D = this.D;
    switch (kind) {
      case EV_TICK: this.spawnTick(0, o, D); this.excite += D.branch; break;
      case EV_SNAP: this.spawnTick(1, o, D); this.excite += D.branch * 0.6; break;
      case EV_DEBRIS: this.spawnTick(2, o, D); break;
      case EV_POP: {
        const v = this.pops.find((x) => !x.on);
        if (!v) return;
        const amp = K.pop * 0.17 * (0.45 + 0.65 * p.pops) * (0.7 + 0.4 * p.size) * rng.range(0.55, 1);
        v.trigger(rng, amp, clamp(rng.gauss() * D.spread * 0.4 + D.center, -0.8, 0.8), o);
        this.flash = 1;
        if (rng.next() < 0.6) this.debris += rng.range(3, 12) / 0.35;
        if (p.size > 0.2 && rng.next() < 0.06 + 0.12 * p.pops) this.startSteam(0.6 + 0.4 * p.pops, D);
        break;
      }
      case EV_STEAM: this.startSteam(0.6, D); break;
      case EV_SETTLE:
        if (this.thud.on) return;
        this.thud.trigger(rng, K.thud * 0.14 * (0.4 + 0.8 * p.size) * (0.6 + 0.6 * p.warmth) * rng.range(0.6, 1), o);
        this.debris += rng.range(12, 35) / 0.35;
        this.swell += rng.range(0.12, 0.28);
        break;
    }
  }

  control(n) {
    const dt = n / SR, rng = this.rng, p = this.p, t = this.target;
    const c = 1 - Math.exp(-dt / this.glideTau);
    for (const k of PARAM_KEYS) p[k] += (t[k] - p[k]) * c;

    const size = p.size, crackle = p.crackle, pops = p.pops, warmth = p.warmth, dist = p.distance, wind = p.wind;

    // --- mood ---
    const slow = this.ouSlow.step(dt, rng), mid = this.ouMid.step(dt, rng);
    this.swell *= Math.exp(-dt / 5);
    const gustRaw = 0.55 * this.ouGust.step(dt, rng) + 0.45 * this.ouGustSlow.step(dt, rng);
    const gust = Math.max(0, 0.45 + 0.42 * gustRaw);
    const fan = 1 + 0.45 * wind * gust;
    const mood = Math.exp(0.12 * slow + 0.1 * mid) * (1 + this.swell) * fan;

    // flame lapping: bigger flames puff more slowly (≈ 1.5/√D Hz for a fire of diameter D)
    const puffHz = lerp(3.2, 0.9, Math.sqrt(size));
    this.lapper.tune(puffHz, SR / n);
    const lapDepth = 0.25 + 0.55 * size;
    const lapN = this.lapper.step(rng);
    const lap = Math.exp(lapDepth * 0.5 * lapN - 0.125 * lapDepth * lapDepth);
    const flick = Math.exp(0.45 * this.ouFlick.step(dt, rng) - 0.1);
    const fizz = Math.exp(0.5 * this.ouFizz.step(dt, rng) - 0.125);

    // --- bed levels ---
    const g = this.g;
    for (const k of this.gKeys) g[k][0] = g[k][1];
    const sizeLvl = lerp(0.12, 1, Math.pow(size, 0.85));
    g.roar[1] = K.roar * Math.pow(size, 1.3) * (0.75 + 0.35 * warmth) * mood * lap;
    g.flut[1] = K.flutter * (0.03 + 0.97 * Math.pow(size, 1.2)) * mood * flick * Math.sqrt(lap);
    g.hiss[1] = K.hiss * sizeLvl * (1.25 - 0.55 * warmth) * Math.pow(mood, 0.7) * fizz;
    g.rum[1] = K.rumble * (0.12 + 0.88 * warmth) * (0.08 + 0.92 * size * size) * mood * (0.8 + 0.2 * lap);

    // filter tunings (smooth enough to retune per block)
    const roarFc = lerp(320, 1100, size) * lerp(1.15, 0.8, warmth);
    this.roarL.set(roarFc, 0.6); this.roarR.set(roarFc, 0.6);
    const flutFc = lerp(3400, 1900, size);
    this.flutL.set(flutFc, 0.55); this.flutR.set(flutFc, 0.55);
    const hissFc = lerp(2600, 2000, size);
    this.hissL.set(hissFc, 0.6); this.hissR.set(hissFc, 0.6);

    // --- wind ---
    const windFc = Math.max(150, 260 + 650 * gust + 90 * slow);
    this.windL.set(windFc, 1.1); this.windR.set(windFc * 1.13, 1.1);
    g.wind[1] = K.wind * Math.pow(wind, 1.4) * (0.15 + gust * gust);
    g.leaf[1] = K.leaves * wind * gust * Math.exp(0.7 * this.ouLeaf.step(dt, rng));
    g.wpan[1] = clamp(0.5 + 0.3 * this.ouWindPan.step(dt, rng), 0.1, 0.9);

    // --- space: distance and warmth ---
    g.width[1] = (0.35 + 0.5 * size) * (1 - 0.55 * dist);
    // quiet fires get loudness makeup, but their crackles shouldn't get all of it
    const makeup = makeupGain(size);
    g.tGain[1] = lerp(1, 0.42, dist) / Math.pow(makeup, 0.6);
    g.dry[1] = lerp(1, 0.6, dist);
    g.wet[1] = lerp(0.1, 0.5, dist);
    g.low[1] = 0.1 + 0.6 * warmth;
    g.high[1] = 0.55 * warmth + 0.25 * dist;
    g.out[1] = K.master * makeup;
    const air = lerp(17000, 2600, Math.pow(dist, 0.8));
    this.airL.set(air, 0.6); this.airR.set(air, 0.6);
    const tAir = lerp(10500, 2300, dist);
    this.tLpL.set(tAir, 0.6); this.tLpR.set(tAir, 0.6);

    // --- events ---
    const crk = Math.exp(0.35 * this.ouCrk.step(dt, rng));
    const sizeEv = 0.3 + 0.7 * size;
    const D = this.D;
    D.tickAmp = K.tick * 0.05 * (0.55 + 0.9 * crackle) * (0.75 + 0.4 * size);
    D.snapAmp = K.snap * 0.11 * (0.55 + 0.6 * crackle) * (0.8 + 0.3 * size);
    D.spread = (0.25 + 0.65 * size) * (1 - 0.5 * dist);
    D.center = 0.08 * slow;
    D.branch = (0.5 + 0.2 * crackle) / 0.07;
    this.excite *= Math.exp(-dt / 0.07);
    this.debris *= Math.exp(-dt / 0.35);

    // crackle intensity is re-read after every event so clusters self-excite (Hawkes)
    this.events(EV_TICK, n, () => (0.15 + 20 * Math.pow(crackle, 1.6)) * sizeEv * Math.pow(mood, 1.6) * crk * Math.sqrt(lap) + this.excite);
    // ember "tinkle": cooling charcoal ticks, most noticeable when the fire is small
    const tinkle = (1 - size) * (1 - size) * (0.2 + crackle) * 1.2 * mood;
    this.events(EV_DEBRIS, n, () => this.debris + tinkle);
    this.events(EV_SNAP, n, () => (0.015 + 0.9 * crackle * crackle) * sizeEv * Math.pow(mood, 1.6) * crk);
    this.events(EV_POP, n, () => (0.002 + 0.22 * Math.pow(pops, 1.6)) * (0.35 + 0.65 * size) * mood);
    this.events(EV_STEAM, n, () => 0.0025 * (0.3 + pops) * size);
    this.events(EV_SETTLE, n, () => (1 / 240) * (0.4 + size) * (0.5 + pops));

    for (const s of this.steams) if (s.on) s.control(dt, rng);

    // visuals: smoothed fire energy
    const energy = (0.4 + 0.6 * size) * mood * Math.sqrt(lap);
    this.glow += (energy - this.glow) * (1 - Math.exp(-dt / 0.12));
    this.flash *= Math.exp(-dt / 0.15);

    if (this.first) { for (const k of this.gKeys) g[k][0] = g[k][1]; this.first = false; }
  }

  startSteam(level, D) {
    const v = this.steams.find((x) => !x.on);
    if (v) v.trigger(this.rng, K.steam * level * this.rng.range(0.4, 1), clamp(this.rng.gauss() * D.spread * 0.4, -0.7, 0.7));
  }

  render(outL, outR, n) {
    this.control(n);
    const tL = this.tL, tR = this.tR, bL = this.bL, bR = this.bR;
    tL.fill(0, 0, n); tR.fill(0, 0, n); bL.fill(0, 0, n); bR.fill(0, 0, n);
    for (const v of this.ticks) if (v.on) v.render(tL, tR, n);
    for (const v of this.pops) if (v.on) v.render(tL, tR, n);
    for (const v of this.steams) if (v.on) v.render(bL, bR, n);
    if (this.thud.on) this.thud.render(bL, bR, n);

    const g = this.g, inv = 1 / n;
    const it = (k) => g[k][0];
    const dt = (k) => (g[k][1] - g[k][0]) * inv;
    let roar = it('roar'), dRoar = dt('roar'), flut = it('flut'), dFlut = dt('flut');
    let hiss = it('hiss'), dHiss = dt('hiss'), rum = it('rum'), dRum = dt('rum');
    let wnd = it('wind'), dWnd = dt('wind'), leaf = it('leaf'), dLeaf = dt('leaf'), wpan = it('wpan'), dWpan = dt('wpan');
    let width = it('width'), dWidth = dt('width'), tg = it('tGain'), dTg = dt('tGain');
    let dry = it('dry'), dDry = dt('dry'), wet = it('wet'), dWet = dt('wet');
    let low = it('low'), dLow = dt('low'), high = it('high'), dHigh = dt('high');
    let og = it('out'), dOg = dt('out');

    let s1 = this.s1, s2 = this.s2, s3 = this.s3;
    const pk = this.pk, rv = this.rv;
    const aLow = this.aLow, aHi = this.aHi, aDc = this.aDc, aRoarHp = this.aRoarHp, aFlutHp = this.aFlutHp;
    const kp = K.pink;

    for (let i = 0; i < n; i++) {
      s1 ^= s1 << 13; s1 ^= s1 >>> 17; s1 ^= s1 << 5;
      s2 ^= s2 << 13; s2 ^= s2 >>> 17; s2 ^= s2 << 5;
      s3 ^= s3 << 13; s3 ^= s3 >>> 17; s3 ^= s3 << 5;
      const w1 = s1 * 4.656612873e-10, w2 = s2 * 4.656612873e-10, w3 = s3 * 4.656612873e-10;

      // pink noise (Kellet, economy), independent L/R
      pk[0] = 0.99765 * pk[0] + w1 * 0.099046; pk[1] = 0.963 * pk[1] + w1 * 0.2965164; pk[2] = 0.57 * pk[2] + w1 * 1.0526913;
      pk[3] = 0.99765 * pk[3] + w2 * 0.099046; pk[4] = 0.963 * pk[4] + w2 * 0.2965164; pk[5] = 0.57 * pk[5] + w2 * 1.0526913;
      const pL = (pk[0] + pk[1] + pk[2] + w1 * 0.1848) * kp;
      const pR = (pk[3] + pk[4] + pk[5] + w2 * 0.1848) * kp;

      // roar: low-mid flame body, high-passed to keep it out of the mud
      let rl = this.roarL.lp(pL), rr = this.roarR.lp(pR);
      this.roarHpL += aRoarHp * (rl - this.roarHpL); this.roarHpR += aRoarHp * (rr - this.roarHpR);
      rl -= this.roarHpL; rr -= this.roarHpR;

      this.hzL += this.aHz * (this.hissL.hp(w1) - this.hzL);
      this.hzR += this.aHz * (this.hissR.hp(w2) - this.hzR);
      // flutter: the same turbulent broadband as the roar, brighter, with fast flicker AM
      let fl = this.flutL.lp(pR), fr = this.flutR.lp(pL);
      this.flutHpL += aFlutHp * (fl - this.flutHpL); this.flutHpR += aFlutHp * (fr - this.flutHpR);
      fl -= this.flutHpL; fr -= this.flutHpR;
      let l = roar * rl + flut * fl + hiss * this.hzL;
      let r = roar * rr + flut * fr + hiss * this.hzR;
      const rumble = rum * this.rum2.hp(this.rum1.lp(w3));

      // stereo width of the fire itself (mid/side)
      const m = 0.5 * (l + r), sd = 0.5 * (l - r) * width;
      l = m + sd + rumble + bL[i];
      r = m - sd + rumble + bR[i];

      // breeze: drifting band of pink noise + rustle, panned by the gusts
      const wl = this.windL.bp(pL), wr = this.windR.bp(pR);
      const lv = leaf * this.leaves.hp(w3);
      l += wnd * wl * (1.4 - wpan) + lv * (1 - wpan);
      r += wnd * wr * (0.4 + wpan) + lv * wpan;

      // transients (crackles, snaps, pops) with their own air absorption
      l += tg * this.tLpL.lp(tL[i]);
      r += tg * this.tLpR.lp(tR[i]);

      // distance: air absorption + diffuse space
      l = this.airL.lp(l); r = this.airR.lp(r);
      this.reverb.tick(l * wet, r * wet, rv);
      l = l * dry + rv[0] * K.reverb; r = r * dry + rv[1] * K.reverb;

      // warmth: low shelf up, top end gently down (one-pole tilt, glitch-free under modulation)
      this.lowL += aLow * (l - this.lowL); this.lowR += aLow * (r - this.lowR);
      this.hiL += aHi * (l - this.hiL); this.hiR += aHi * (r - this.hiR);
      l += low * this.lowL - high * (l - this.hiL);
      r += low * this.lowR - high * (r - this.hiR);

      // remove sub-sonic drift
      this.dcL += aDc * (l - this.dcL); this.dcR += aDc * (r - this.dcR);
      l = (l - this.dcL) * og; r = (r - this.dcR) * og;

      // soft knee: never a hard clip, even on an unlucky pile-up of pops
      outL[i] = l > 0.6 || l < -0.6 ? Math.sign(l) * (0.6 + 0.4 * Math.tanh((Math.abs(l) - 0.6) / 0.4)) : l;
      outR[i] = r > 0.6 || r < -0.6 ? Math.sign(r) * (0.6 + 0.4 * Math.tanh((Math.abs(r) - 0.6) / 0.4)) : r;

      roar += dRoar; flut += dFlut; hiss += dHiss; rum += dRum; wnd += dWnd; leaf += dLeaf; wpan += dWpan;
      width += dWidth; tg += dTg; dry += dDry; wet += dWet; low += dLow; high += dHigh; og += dOg;
    }
    this.s1 = s1; this.s2 = s2; this.s3 = s3;
  }
}

/* ---------- worklet wrapper ---------- */

class FireProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.fire = new Fire(o.seed || (Math.random() * 4294967295) | 0, o.params);
    this.stopAt = Infinity;
    this.stopped = false;
    this.frame = 0;
    this.postEvery = Math.round(SR / 15 / 128);
    this.blocks = 0;
    this.quiet = !!o.quiet; // offline renders don't need visual updates
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'params') this.fire.setParams(d.params, d.glide);
      else if (d.type === 'stopAt') { this.stopAt = d.frame == null ? Infinity : d.frame; this.stopped = false; }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    const now = typeof currentFrame !== 'undefined' ? currentFrame : this.frame;
    this.frame += n;
    if (now >= this.stopAt) {
      // sleep timer has finished: stay silent and cheap until we're told otherwise
      if (!this.stopped) { this.stopped = true; this.port.postMessage({ type: 'stopped' }); }
      return true;
    }
    this.fire.render(L, R, n);
    if (!this.quiet && ++this.blocks >= this.postEvery) {
      this.blocks = 0;
      this.port.postMessage({ type: 'glow', glow: this.fire.glow, flash: this.fire.flash });
    }
    return true;
  }
}

registerProcessor('cracklemaid-fire', FireProcessor);
