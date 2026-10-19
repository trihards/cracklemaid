// Offline renderer for the fire engine: runs js/fire-worklet.js under Node and writes WAV.
//
//   node tools/render.mjs --preset hearth --seconds 60 --out out.wav
//   node tools/render.mjs --params '{"size":0.9}' --seconds 30 --out big.wav
//   node tools/render.mjs --preset hearth --sweep --out sweep.wav   (abrupt param jumps)
//   node tools/render.mjs --preset hearth --solo roar                (one layer only)
//   node tools/render.mjs --bench                                    (realtime factor)
//   node tools/render.mjs --tour 30 --out tour.wav                   (every preset, gliding like the app)

import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { PRESETS } from '../js/presets.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const sr = Number(opt('sr', 48000));
const seconds = Number(opt('seconds', 30));
const seed = Number(opt('seed', 12345));
const preset = opt('preset', 'hearth');
let params = PRESETS.find((p) => p.id === preset)?.params;
if (opt('params')) params = Object.assign({}, params, JSON.parse(opt('params')));

// Solo a layer by zeroing every other level constant
const LAYERS = ['reverb', 'roar', 'flutter', 'hiss', 'rumble', 'tick', 'snap', 'pop', 'steam', 'thud', 'wind', 'leaves'];
const solo = opt('solo');
const kOverride = {};
if (solo) for (const l of LAYERS) if (!solo.split(',').includes(l)) kOverride[l] = 0;

function loadProcessor(initial) {
  let Proc;
  const ctx = {
    sampleRate: sr,
    __cracklemaidK: kOverride,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => messages.push(m), onmessage: null }; } },
    registerProcessor: (_name, cls) => { Proc = cls; },
    Math, Float32Array, Float64Array, Int32Array, Array, Object,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../js/fire-worklet.js', import.meta.url), 'utf8'), ctx);
  return new Proc({ processorOptions: { seed, params: initial || params } });
}

const messages = [];
const tour = Number(opt('tour', 0));
const proc = loadProcessor(tour ? PRESETS[0].params : undefined);
const total = Math.round(seconds * sr);
const L = new Float32Array(total), R = new Float32Array(total);
const block = 128;
const sweep = opt('sweep');
const bL = new Float32Array(block), bR = new Float32Array(block);

const t0 = performance.now();
for (let pos = 0, b = 0; pos < total; pos += block, b++) {
  if (sweep && b % Math.round(sr / block * 2) === 0 && pos > 0) {
    // every 2 s, jump every control to a random value with the UI's fastest glide
    const r = () => Math.random();
    proc.port.onmessage({ data: { type: 'params', glide: 0.25, params: { size: r(), crackle: r(), pops: r(), warmth: r(), distance: r(), wind: r() } } });
  }
  if (tour && b % Math.round(sr / block * tour) === 0 && pos > 0) {
    const next = PRESETS[Math.round(pos / sr / tour) % PRESETS.length];
    proc.port.onmessage({ data: { type: 'params', glide: 1.6, params: next.params } });
  }
  bL.fill(0); bR.fill(0);
  proc.process([], [[bL, bR]], {});
  const n = Math.min(block, total - pos);
  L.set(bL.subarray(0, n), pos); R.set(bR.subarray(0, n), pos);
}
const ms = performance.now() - t0;

if (opt('bench')) {
  console.log(`rendered ${seconds}s in ${ms.toFixed(0)}ms → ${(seconds * 1000 / ms).toFixed(1)}x realtime`);
}

const out = opt('out');
if (out) {
  const data = Buffer.alloc(44 + total * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + total * 4, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(total * 4, 40);
  let nan = 0, peak = 0;
  for (let i = 0; i < total; i++) {
    for (const [ch, v0] of [[0, L[i]], [1, R[i]]]) {
      let v = v0;
      if (!Number.isFinite(v)) { nan++; v = 0; }
      peak = Math.max(peak, Math.abs(v));
      data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 4 + ch * 2);
    }
  }
  writeFileSync(out, data);
  console.log(`${out}: ${seconds}s, peak ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS, non-finite samples: ${nan}`);
}
