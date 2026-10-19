import { FireAudio, supportsAudio } from './audio.js';
import { CONTROLS, PRESETS } from './presets.js';

const $ = (s) => document.querySelector(s);
const STORE_KEY = 'cracklemaid:v1';

/* ---------- state ---------- */

const defaults = {
  presetId: 'hearth',
  params: { ...PRESETS[1].params },
  volume: 0.8,
  mode: 'live',
  motion: 'auto',
  userPresets: [], // { id, name, params }
};

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s === 'object') return { ...defaults, ...s, params: { ...defaults.params, ...s.params } };
  } catch (_) { /* private mode or corrupted */ }
  return structuredClone(defaults);
}
const state = load();
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* storage full or blocked */ }
  }, 250);
}

const allPresets = () => [...PRESETS, ...state.userPresets.map((p) => ({ ...p, user: true }))];
const currentPreset = () => allPresets().find((p) => p.id === state.presetId) || null;
const isModified = () => {
  const p = currentPreset();
  return !p || CONTROLS.some(({ key }) => Math.abs(p.params[key] - state.params[key]) > 0.005);
};

/* ---------- audio ---------- */

const root = document.documentElement;
const body = document.body;
let glowFrame = 0, glowVal = 0.6, flashVal = 0;

const audio = new FireAudio({
  onGlow(g, f) {
    if (!root.classList.contains('motion')) return; // reduced motion: keep the glow steady
    glowVal = g; flashVal = f;
    if (!glowFrame) glowFrame = requestAnimationFrame(() => {
      glowFrame = 0;
      root.style.setProperty('--glow', Math.min(1.6, glowVal).toFixed(3));
      root.style.setProperty('--flash', Math.min(1, flashVal).toFixed(3));
    });
  },
  onState(s) {
    body.classList.toggle('playing', s === 'playing');
    body.classList.toggle('paused', s === 'paused');
    body.classList.toggle('starting', s === 'starting');
    const btn = $('#playBtn');
    btn.setAttribute('aria-label', s === 'paused' ? 'Play' : 'Pause');
    $('#playHint').textContent = s === 'starting'
      ? (audio.mode === 'loop' ? 'Kindling your fire…' : 'Kindling…')
      : s === 'playing' ? hintPlaying() : 'Tap to light the fire';
    if (s === 'paused') { root.style.setProperty('--glow', '0.35'); root.style.setProperty('--flash', '0'); }
  },
  onTimer(deadline, finished) {
    renderTimer();
    if (finished) toast('Sleep timer finished. Sweet dreams.');
  },
});
audio.params = { ...state.params };
audio.volume = state.volume;
audio.mode = state.mode;

function hintPlaying() {
  const lines = ['Crackling away', 'The fire is lit', 'Toasty', 'Settle in'];
  return lines[Math.floor(Math.random() * lines.length)];
}

async function togglePlay() {
  if (!supportsAudio()) {
    toast('This browser can’t run the fire engine. Try a recent Safari, Chrome, or Firefox.');
    return;
  }
  try {
    await audio.toggle();
  } catch (err) {
    console.error(err);
    toast('The fire wouldn’t catch. Tap again to retry.');
  }
}

/* ---------- presets row ---------- */

function renderPresets() {
  const nav = $('#presets');
  nav.textContent = '';
  for (const p of allPresets()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (p.user ? ' user' : '') + (p.id === state.presetId ? ' active' : '');
    b.setAttribute('aria-pressed', String(p.id === state.presetId));
    b.textContent = p.name;
    b.addEventListener('click', () => selectPreset(p.id));
    nav.append(b);
    if (p.user && p.id === state.presetId) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'chip more';
      more.setAttribute('aria-label', `Rename or delete ${p.name}`);
      more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
      more.addEventListener('click', () => openSheet('#presetMenu'));
      nav.append(more);
    }
  }
  if (isModified()) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip add';
    add.textContent = '+ Save this fire';
    add.addEventListener('click', () => askName('', (name) => saveNew(name)));
    nav.append(add);
  }
  const active = nav.querySelector('.chip.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderNow() {
  const p = currentPreset();
  const name = $('#presetName');
  name.textContent = p ? p.name : 'Your fire';
  if (p && isModified()) {
    const t = document.createElement('span');
    t.className = 'tuned';
    t.textContent = 'tuned';
    name.append(t);
  }
  $('#presetBlurb').textContent = p ? (p.blurb || 'One of your fires') : 'Tuned by hand';
  root.style.setProperty('--size', state.params.size.toFixed(2));
  audio.setMetadata(p ? p.name : 'Your fire');
  $('#revertBtn').disabled = !p || !isModified();
}

function selectPreset(id) {
  const p = allPresets().find((x) => x.id === id);
  if (!p) return;
  state.presetId = id;
  state.params = { ...p.params };
  audio.setParams(state.params, 1.6); // glide: the fire settles into its new shape
  syncSliders();
  renderPresets();
  renderNow();
  save();
}

function saveNew(name) {
  const id = 'u' + Date.now().toString(36);
  state.userPresets.push({ id, name, params: { ...state.params } });
  state.presetId = id;
  renderPresets(); renderNow(); save();
  toast(`Saved “${name}”`);
}

/* ---------- tuning sliders ---------- */

const sliderEls = {};
function buildSliders() {
  const wrap = $('#sliders');
  for (const c of CONTROLS) {
    const row = document.createElement('div');
    row.className = 'slider';
    const id = 'sl-' + c.key;
    row.innerHTML = `<div class="slider-top"><label for="${id}">${c.label}</label></div>
      <input type="range" id="${id}" min="0" max="1" step="0.01">
      <div class="ends" aria-hidden="true"><span>${c.low}</span><span>${c.high}</span></div>`;
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      state.params[c.key] = Number(input.value);
      paintRange(input);
      queueParams();
    });
    input.addEventListener('change', () => { renderPresets(); renderNow(); save(); });
    sliderEls[c.key] = input;
    wrap.append(row);
  }
}
function syncSliders() {
  for (const c of CONTROLS) {
    const el = sliderEls[c.key];
    el.value = state.params[c.key];
    el.setAttribute('aria-valuetext', `${Math.round(state.params[c.key] * 100)} percent, ${c.low} to ${c.high}`);
    paintRange(el);
  }
}
function paintRange(el) { el.style.setProperty('--p', (Number(el.value) * 100) + '%'); }

let paramFrame = 0;
function queueParams() {
  if (paramFrame) return;
  paramFrame = requestAnimationFrame(() => {
    paramFrame = 0;
    audio.setParams(state.params, 0.25);
    renderNow();
  });
}

/* ---------- sheets ---------- */

function openSheet(sel) {
  const d = $(sel);
  if (!d.open) d.showModal();
}
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  });
});

let nameCallback = null;
function askName(initial, cb) {
  nameCallback = cb;
  $('#nameInput').value = initial;
  openSheet('#nameDialog');
  setTimeout(() => $('#nameInput').focus(), 50);
}
$('#nameForm').addEventListener('submit', () => {
  const name = $('#nameInput').value.trim().slice(0, 32);
  if (name && nameCallback) nameCallback(name);
  nameCallback = null;
});

$('#saveBtn').addEventListener('click', () => {
  $('#tuneSheet').close();
  askName('', (name) => saveNew(name));
});
$('#revertBtn').addEventListener('click', () => selectPreset(state.presetId));

const userPreset = () => state.userPresets.find((p) => p.id === state.presetId);
$('#menuRename').addEventListener('click', () => {
  const p = userPreset();
  $('#presetMenu').close();
  if (p) askName(p.name, (name) => { p.name = name; renderPresets(); renderNow(); save(); });
});
$('#menuUpdate').addEventListener('click', () => {
  const p = userPreset();
  if (p) { p.params = { ...state.params }; renderPresets(); renderNow(); save(); toast(`Updated “${p.name}”`); }
  $('#presetMenu').close();
});
$('#menuDelete').addEventListener('click', () => {
  const p = userPreset();
  $('#presetMenu').close();
  if (!p || !confirm(`Delete “${p.name}”?`)) return;
  state.userPresets = state.userPresets.filter((x) => x !== p);
  state.presetId = 'hearth';
  selectPreset('hearth');
});

$('#tuneBtn').addEventListener('click', () => { syncSliders(); openSheet('#tuneSheet'); });
$('#settingsBtn').addEventListener('click', () => openSheet('#settingsSheet'));
$('#timerBtn').addEventListener('click', () => { renderTimer(); openSheet('#timerSheet'); });

/* ---------- sleep timer ---------- */

let timerTick = 0;
function fmtRemaining(sec) {
  const m = Math.ceil(sec / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}m`;
}
function renderTimer() {
  const left = audio.sleepRemaining;
  $('#timerLabel').textContent = left > 0 ? fmtRemaining(left) : 'Sleep';
  $('#timerBtn').classList.toggle('on', left > 0);
  $('#timerBtn').setAttribute('aria-label', left > 0 ? `Sleep timer, ${fmtRemaining(left)} left` : 'Sleep timer');
  $('#loTimer').textContent = left > 0 ? `fading out in ${fmtRemaining(left)}` : '';
  document.querySelectorAll('#timerGrid button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.min) === (left > 0 ? state.timerMinutes : 0));
  });
  clearTimeout(timerTick);
  if (left > 0) timerTick = setTimeout(renderTimer, left > 120 ? 15000 : 1000);
}
$('#timerGrid').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-min]');
  if (!b) return;
  const min = Number(b.dataset.min);
  state.timerMinutes = min;
  audio.setSleep(min);
  $('#timerSheet').close();
  if (min) toast(audio.state === 'paused' ? `Timer set for ${b.textContent}. Light the fire when you’re ready.` : `The fire will fade out in ${b.textContent}`);
});

/* ---------- volume ---------- */

const vol = $('#volume');
vol.value = state.volume;
paintRange(vol);
vol.addEventListener('input', () => {
  state.volume = Number(vol.value);
  audio.setVolume(state.volume);
  paintRange(vol);
  save();
});
function renderVolNote() {
  $('#volNote').hidden = !(state.mode === 'loop' && !audio.elementVolumeWorks);
}

/* ---------- lights out ---------- */

const lo = $('#lightsOut');
const themeMeta = document.querySelector('meta[name="theme-color"]');
function lightsOut(on) {
  lo.hidden = !on;
  lo.classList.remove('settled');
  themeMeta.content = on ? '#000000' : '#12070a';
  if (on) {
    renderTimer();
    requestAnimationFrame(() => lo.classList.add('settled'));
    lo.focus();
  }
}
$('#lightsBtn').addEventListener('click', () => lightsOut(true));
lo.addEventListener('click', () => lightsOut(false));
lo.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { e.preventDefault(); lightsOut(false); } });

/* ---------- settings ---------- */

const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
function applyMotion() {
  const on = state.motion === 'on' || (state.motion === 'auto' && !reduceMQ.matches);
  root.classList.toggle('motion', on);
  if (!on) { root.style.setProperty('--glow', '0.8'); root.style.setProperty('--flash', '0'); }
}
reduceMQ.addEventListener?.('change', applyMotion);

document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.checked = r.value === state.mode;
  r.addEventListener('change', async () => {
    state.mode = r.value; save(); renderVolNote();
    try { await audio.setMode(r.value); } catch (_) { toast('Tap play to restart the fire.'); }
    if (r.value === 'loop') toast('Steady loop: a seamless 90-second recording of your fire.');
  });
});
document.querySelectorAll('input[name="motion"]').forEach((r) => {
  r.checked = r.value === state.motion;
  r.addEventListener('change', () => { state.motion = r.value; applyMotion(); save(); });
});

/* ---------- misc ---------- */

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function buildSparks() {
  const wrap = $('#sparks');
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('span');
    s.className = 'spark';
    s.style.setProperty('--x', `${62 + Math.random() * 16}%`);
    s.style.setProperty('--d', `${3 + Math.random() * 3}s`);
    s.style.setProperty('--delay', `${-Math.random() * 6}s`);
    s.style.setProperty('--drift', `${(Math.random() - 0.5) * 60}px`);
    wrap.append(s);
  }
}

// Real mascot artwork, if present, replaces the placeholder illustration.
function probeMascot() {
  const img = $('#mascotImg');
  const probe = new Image();
  probe.onload = () => { img.src = probe.src; img.hidden = false; $('#mascotSvg').style.display = 'none'; };
  probe.src = 'assets/mascot.png';
}

$('#playBtn').addEventListener('click', togglePlay);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !document.querySelector('dialog[open]') && lo.hidden && e.target === document.body) {
    e.preventDefault();
    togglePlay();
  }
});

buildSliders();
syncSliders();
buildSparks();
renderPresets();
renderNow();
renderTimer();
renderVolNote();
applyMotion();
body.classList.add('paused');
probeMascot();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// handy for debugging from the console
window.cracklemaid = { audio, state };
