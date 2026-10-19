// Playback controller: owns the AudioContext, the fire worklet, volume, the sleep
// timer, lock-screen integration, and the "steady loop" fallback.
//
// Background playback strategy (no guarantees — browsers decide):
//  * navigator.audioSession.type = 'playback' (Safari 16.4+) so iOS treats the
//    page as a media player: plays with the ringer switch on silent and, on
//    iOS 17.5+, keeps the AudioContext running when the screen locks.
//  * A silent looping <audio> element started from the same tap, which gives the
//    page a "Now Playing" presence and lock-screen controls via Media Session.
//  * The sleep fade is scheduled on the audio clock, not with JS timers, so it
//    still happens if the browser freezes the page's JavaScript.
//  * "Steady loop" mode renders ~90 s of the current fire offline and plays it
//    through a plain <audio> element: the most reliable path on iPhones where
//    Web Audio stops when the screen locks.

const WORKLET_URL = new URL('./fire-worklet.js', import.meta.url);
const LOOP_SR = 32000;
const LOOP_SECONDS = 90;
const LOOP_XFADE = 5;

export const supportsAudio = () => typeof window.AudioContext === 'function' && typeof AudioWorkletNode === 'function';

function wavBlob(channels, sr) {
  const n = channels[0].length, nc = channels.length;
  const buf = new ArrayBuffer(44 + n * nc * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * nc * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * nc * 2, true);
  const out = new Int16Array(buf, 44);
  for (let i = 0, k = 0; i < n; i++) {
    for (let c = 0; c < nc; c++, k++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      out[k] = s < 0 ? s * 32768 : s * 32767;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const silentUrl = () => URL.createObjectURL(wavBlob([new Float32Array(8000)], 8000));

// perceptual fade: cubic, smooth at both ends of the useful range
function fadeCurve(points = 256) {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) c[i] = Math.pow(1 - i / (points - 1), 3);
  return c;
}

export class FireAudio {
  constructor({ onGlow, onState, onTimer } = {}) {
    this.onGlow = onGlow || (() => {});
    this.onState = onState || (() => {});
    this.onTimer = onTimer || (() => {});
    this.params = null;
    this.volume = 0.8;
    this.mode = 'live';
    this.state = 'paused'; // 'paused' | 'starting' | 'playing'
    this.ctx = null;
    this.node = null;
    this.ready = null;
    this.sleepDeadline = 0; // wall-clock ms while playing, 0 = none
    this.sleepPending = 0;  // seconds left while paused (the timer counts listening time)
    this.sleepTimeout = 0;
    this.loopUrl = null;
    this.loopEnv = null;
    this.loopKey = '';
    this.loopRendering = null;
    this.el = document.createElement('audio');
    this.el.setAttribute('playsinline', '');
    this.el.loop = true;
    this.el.preload = 'auto';
    this.silent = silentUrl();
    this.setupMediaSession();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.state === 'playing' && this.mode === 'live' && this.ctx && this.ctx.state !== 'running') {
        this.ctx.resume().catch(() => {});
      }
    });
    this.ignorePauseUntil = 0;
    this.el.addEventListener('pause', () => {
      // In loop mode the element *is* the fire: if the system pauses it (another
      // app takes audio, headphones unplugged), reflect that in the UI.
      if (this.mode === 'loop' && this.state === 'playing' && performance.now() > this.ignorePauseUntil) this.pause();
    });
    this.loopTick = this.loopTick.bind(this);
  }

  // Element volume is fixed at 1 on iOS; we detect that rather than sniff the UA.
  get elementVolumeWorks() {
    const a = document.createElement('audio');
    a.volume = 0.5;
    return a.volume === 0.5;
  }

  setupMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const safe = (a, fn) => { try { ms.setActionHandler(a, fn); } catch (_) { /* unsupported action */ } };
    safe('play', () => this.play());
    safe('pause', () => this.pause());
    safe('stop', () => this.pause());
  }

  setMetadata(title) {
    if (!navigator.mediaSession || typeof MediaMetadata !== 'function') return;
    const icon = (s) => ({ src: new URL(`../icons/icon-${s}.png`, import.meta.url).href, sizes: `${s}x${s}`, type: 'image/png' });
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Cracklemaid', album: 'Fireside', artwork: [icon(192), icon(512)] });
  }

  createContext() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* ignore */ }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback' });
    const ctx = this.ctx;
    this.gate = ctx.createGain(); this.gate.gain.value = 0;   // play/pause fades
    this.sleepGain = ctx.createGain();                         // sleep-timer fade
    this.vol = ctx.createGain(); this.vol.gain.value = this.volume * this.volume;
    this.gate.connect(this.sleepGain).connect(this.vol).connect(ctx.destination);
    this.ready = ctx.audioWorklet.addModule(WORKLET_URL).then(() => {
      this.node = new AudioWorkletNode(ctx, 'cracklemaid-fire', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { params: this.params },
      });
      this.node.port.onmessage = (e) => {
        if (e.data.type === 'glow') this.onGlow(e.data.glow, e.data.flash);
      };
      this.node.connect(this.gate);
    });
    ctx.onstatechange = () => {
      // iOS reports 'interrupted' during calls/Siri; try to come back afterwards
      if (this.state === 'playing' && this.mode === 'live' && ctx.state !== 'running' && document.visibilityState === 'visible') {
        setTimeout(() => ctx.resume().catch(() => {}), 300);
      }
    };
  }

  // Must be called synchronously from a user gesture (tap) the first time.
  async play() {
    if (this.state !== 'paused') return;
    if (this.sleepPending) { this.sleepDeadline = Date.now() + this.sleepPending * 1000; this.sleepPending = 0; }
    this.setState('starting');
    // Start the media element inside the gesture so later play() calls are allowed.
    const loopReady = this.mode === 'loop' && this.loopUrl && this.loopKey === JSON.stringify(this.params);
    this.setSrc(loopReady ? this.loopUrl : this.silent);
    const elPlay = this.el.play().catch(() => {});

    if (this.mode === 'live') {
      if (!this.ctx) this.createContext();
      const resumed = this.ctx.resume();
      try { await this.ready; await resumed; } catch (err) { this.setState('paused'); throw err; }
      if (this.state !== 'starting') return; // paused while starting
      const t = this.ctx.currentTime;
      this.gate.gain.cancelScheduledValues(t);
      this.gate.gain.setValueAtTime(this.gate.gain.value, t);
      this.gate.gain.linearRampToValueAtTime(1, t + 1.5);
      this.scheduleSleepFade();
      await elPlay;
    } else {
      await this.ensureLoop();
      if (this.state !== 'starting') return;
      this.el.volume = this.elementVolumeWorks ? this.volume * this.volume : 1;
      if (this.setSrc(this.loopUrl) || this.el.paused) {
        try { await this.el.play(); } catch (err) { this.setState('paused'); throw err; }
      }
      requestAnimationFrame(this.loopTick);
    }
    this.setState('playing');
    this.armSleepTimeout();
  }

  pause() {
    if (this.state === 'paused') return;
    if (this.sleepDeadline) { this.sleepPending = this.sleepRemaining; this.sleepDeadline = 0; }
    this.setState('paused');
    clearTimeout(this.sleepTimeout);
    if (this.ctx && this.gate) {
      const t = this.ctx.currentTime;
      this.gate.gain.cancelScheduledValues(t);
      this.gate.gain.setValueAtTime(this.gate.gain.value, t);
      this.gate.gain.linearRampToValueAtTime(0, t + 0.35);
      setTimeout(() => { if (this.state === 'paused') this.ctx.suspend().catch(() => {}); }, 450);
    }
    this.expectPause();
    this.el.pause();
  }

  // Ignore the element's own pause/abort events for a moment after we change it
  expectPause() { this.ignorePauseUntil = performance.now() + 800; }

  setSrc(url) {
    if (this.el.src === url) return false;
    this.expectPause();
    this.el.src = url;
    return true;
  }

  toggle() { return this.state === 'paused' ? this.play() : this.pause(); }

  setState(s) {
    this.state = s;
    if (navigator.mediaSession) navigator.mediaSession.playbackState = s === 'paused' ? 'paused' : 'playing';
    this.onState(s);
  }

  setParams(params, glide = 0.3) {
    this.params = { ...params };
    if (this.node) this.node.port.postMessage({ type: 'params', params: this.params, glide });
    if (this.mode === 'loop') this.scheduleLoopRefresh();
  }

  setVolume(v) {
    this.volume = v;
    const g = v * v;
    if (this.vol) this.vol.gain.setTargetAtTime(g, this.ctx.currentTime, 0.05);
    if (this.mode === 'loop' && this.elementVolumeWorks) this.el.volume = this.sleepDeadline ? Math.min(g, this.el.volume) : g;
  }

  async setMode(mode) {
    if (mode === this.mode) return;
    const wasPlaying = this.state !== 'paused';
    if (wasPlaying) this.pause();
    this.mode = mode;
    if (mode === 'loop') this.ensureLoop().catch(() => {});
    if (wasPlaying) await this.play();
  }

  /* ---------- sleep timer ---------- */

  setSleep(minutes) {
    const playing = this.state !== 'paused';
    this.sleepDeadline = minutes && playing ? Date.now() + minutes * 60000 : 0;
    this.sleepPending = minutes && !playing ? minutes * 60 : 0;
    this.sleepTotal = minutes * 60;
    if (this.state === 'playing') { this.scheduleSleepFade(); this.armSleepTimeout(); }
    if (!minutes) {
      clearTimeout(this.sleepTimeout);
      this.resetSleepGain();
      if (this.node) this.node.port.postMessage({ type: 'stopAt', frame: null });
      if (this.mode === 'loop' && this.elementVolumeWorks) this.el.volume = this.volume * this.volume;
    }
    this.onTimer(this.sleepDeadline);
  }

  get sleepRemaining() {
    if (this.sleepPending) return this.sleepPending;
    return this.sleepDeadline ? Math.max(0, (this.sleepDeadline - Date.now()) / 1000) : 0;
  }

  fadeLength() { return Math.min(600, Math.max(30, this.sleepTotal * 0.35)); }

  resetSleepGain() {
    if (!this.sleepGain) return;
    const t = this.ctx.currentTime;
    this.sleepGain.gain.cancelScheduledValues(t);
    this.sleepGain.gain.setValueAtTime(1, t);
  }

  // Schedule the fade on the audio clock so it happens even if JS is frozen.
  scheduleSleepFade() {
    if (!this.sleepGain) return;
    this.resetSleepGain();
    if (!this.sleepDeadline || this.mode !== 'live') return;
    const t = this.ctx.currentTime, remaining = this.sleepRemaining, fade = this.fadeLength();
    const fadeStart = t + Math.max(0, remaining - fade);
    const fadeDur = Math.min(fade, remaining);
    if (fadeDur > 0.05) {
      const startVal = fadeDur < fade ? Math.pow(fadeDur / fade, 3) : 1;
      this.sleepGain.gain.setValueAtTime(startVal, fadeStart);
      this.sleepGain.gain.setValueCurveAtTime(fadeCurve().map((x) => x * startVal), fadeStart, fadeDur);
    } else {
      this.sleepGain.gain.setValueAtTime(0, t);
    }
    if (this.node) this.node.port.postMessage({ type: 'stopAt', frame: Math.round((t + remaining + 0.5) * this.ctx.sampleRate) });
  }

  armSleepTimeout() {
    clearTimeout(this.sleepTimeout);
    if (!this.sleepDeadline) return;
    const step = () => {
      const left = this.sleepRemaining;
      if (left <= 0) {
        this.sleepDeadline = 0;
        this.pause();
        this.resetSleepGain();
        if (this.node) this.node.port.postMessage({ type: 'stopAt', frame: null });
        this.onTimer(0, true);
        return;
      }
      if (this.mode === 'loop' && this.elementVolumeWorks) {
        const fade = this.fadeLength();
        const k = left < fade ? Math.pow(left / fade, 3) : 1;
        this.el.volume = this.volume * this.volume * k;
      }
      this.sleepTimeout = setTimeout(step, Math.min(1000, left * 1000));
    };
    step();
  }

  /* ---------- steady loop mode ---------- */

  async ensureLoop() {
    const key = JSON.stringify(this.params);
    if (this.loopUrl && key === this.loopKey) return;
    if (this.loopRendering && this.loopRendering.key === key) return this.loopRendering.promise;
    const promise = this.renderLoop(this.params).then(({ url, env }) => {
      if (this.loopUrl) setTimeout((u) => URL.revokeObjectURL(u), 5000, this.loopUrl);
      this.loopUrl = url; this.loopEnv = env; this.loopKey = key;
    });
    this.loopRendering = { key, promise };
    try { await promise; } finally { if (this.loopRendering && this.loopRendering.promise === promise) this.loopRendering = null; }
  }

  async renderLoop(params) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const total = (LOOP_SECONDS + LOOP_XFADE) * LOOP_SR;
    const off = new OAC(2, total, LOOP_SR);
    await off.audioWorklet.addModule(WORKLET_URL);
    const node = new AudioWorkletNode(off, 'cracklemaid-fire', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { params, quiet: true },
    });
    node.connect(off.destination);
    const buf = await off.startRendering();
    // Seamless loop: crossfade the extra tail into the head (equal power, since
    // the two stretches of fire are uncorrelated).
    const len = LOOP_SECONDS * LOOP_SR, xf = LOOP_XFADE * LOOP_SR;
    const chans = [0, 1].map((c) => {
      const src = buf.getChannelData(c);
      const out = src.slice(0, len);
      for (let i = 0; i < xf; i++) {
        const a = (i / xf) * Math.PI / 2;
        out[i] = src[i] * Math.sin(a) + src[len + i] * Math.cos(a);
      }
      return out;
    });
    // loudness envelope at ~15 Hz so the visuals can still breathe with the sound
    const hop = Math.round(LOOP_SR / 15), env = new Float32Array(Math.floor(len / hop));
    for (let k = 0; k < env.length; k++) {
      let s = 0;
      for (let i = k * hop; i < (k + 1) * hop; i++) s += chans[0][i] * chans[0][i];
      env[k] = Math.sqrt(s / hop);
    }
    return { url: URL.createObjectURL(wavBlob(chans, LOOP_SR)), env };
  }

  scheduleLoopRefresh() {
    clearTimeout(this.loopRefresh);
    this.loopRefresh = setTimeout(async () => {
      try {
        await this.ensureLoop();
        if (this.state === 'playing' && this.mode === 'loop' && this.setSrc(this.loopUrl)) {
          await this.el.play().catch(() => {});
        }
      } catch (_) { /* keep the previous loop */ }
    }, 1200);
  }

  loopTick() {
    if (this.mode !== 'loop' || this.state !== 'playing') return;
    if (this.loopEnv && document.visibilityState === 'visible') {
      const i = Math.floor(this.el.currentTime * 15) % this.loopEnv.length;
      const v = this.loopEnv[i] * 6;
      this.onGlow(Math.min(1.6, 0.5 + v), Math.max(0, v - 0.6));
    }
    requestAnimationFrame(this.loopTick);
  }
}
