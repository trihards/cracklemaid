# Cracklemaid 🔥🧜🏽‍♀️

A fireside sound machine for falling asleep: the cozy cousin of Murmurmaid. Pick a
fire, tune it until it sounds right, set a sleep timer, turn the screen off.

It's a static site with no build step, no dependencies, no backend, and no tracking.
It installs as a PWA and works offline once loaded.

## Run it

```sh
npm run serve        # or any static server: python3 -m http.server
open http://localhost:8080
```

Audio worklets need a secure context, so use `localhost` or HTTPS. Opening
`index.html` from the file system won't work.

**GitHub Pages:** push to a branch and enable Pages for it (Settings → Pages →
Deploy from branch, root folder). All paths are relative, so a project URL like
`/cracklemaid/` works.

## How the fire is made

Every sound is synthesized live in an AudioWorklet (`js/fire-worklet.js`). There
are no recordings and no loops, so the fire never repeats, every control changes
the actual sound generation instead of crossfading samples, and there are no
licensing questions. The layers:

| Layer | What it is | Why it sounds alive |
|---|---|---|
| Flame bed | Pink-noise roar, broadband turbulence, a soft hiss, a sub rumble | Lapping at the flame-puffing rate (≈1.5/√D Hz: big fires breathe slower) plus fast flicker and fizz modulation |
| Crackles | Tiny noise bursts through resonant band-passes, sometimes in 2–3 micro-fracture cascades | Arrivals are a **self-exciting (Hawkes) process**: one crackle raises the odds of the next, so they come in natural clusters instead of uniform random ticks |
| Snaps | Longer, more resonant "tock"s of wood fracturing | Rate tied to the crackle mood |
| Pops | Steam pockets: a soft low thump plus a short crack | Sometimes followed by an ember spray, or rarely a quiet "singing log" steam whistle |
| Settling | A padded low thud, a trickle of embers, and a brief flare-up | Every few minutes |
| Breeze | Gusting band of noise plus leaf rustle, drifting across the stereo field | Gusts also *fan the fire*: flames swell and crackle more |

Several slow random walks (seconds to minutes) create swells and lulls. Event
loudness follows a capped log-normal, so nothing ever jumps out of the texture, and
a soft knee catches the rare pile-up. Every parameter glides; changing presets
takes about 1.6 s, like the fire settling into a new shape.

### Controls

Six controls, each mapped to several internal parameters so any combination stays
pleasant:

- **Fire** (embers → bonfire): bed level and bandwidth, lapping tempo and depth, crackle density, stereo width. Loudness is compensated so embers aren't 17 dB quieter than a bonfire (measured spread is about 6 LU).
- **Crackle**: density and intensity of crackles and snaps.
- **Pops**: frequency and weight of steam pops, ember sprays, and settling.
- **Warmth**: low-end body vs. airy top end.
- **Distance** (toes warm → across camp): air absorption, crackles receding faster than the bed, a diffuse space, a narrower image.
- **Breeze**: gusting wind that also fans the flames.

## Listening with the screen off

What actually happens on phones, without overpromising:

- **Live fire** (default) uses Web Audio, with `navigator.audioSession.type = 'playback'` (Safari 16.4+), a silent looping media element started from the same tap, and Media Session metadata and lock-screen controls. A WebKit fix shipped in iOS 17.5 means the AudioContext should keep running when the screen locks. Reports still vary, especially for Home Screen web apps.
- **Steady loop** (Settings) renders 90 seconds of your exact fire offline, crossfades the ends into a seamless loop, and plays it through a plain `<audio>` element. That's the most reliable background path on iOS. The tradeoffs: it repeats every 90 s, changes take about a second to re-render, and iOS ignores web volume for media elements, so you use the hardware buttons.
- **The sleep timer's fade runs on the audio clock**, not on JavaScript timers. If the browser freezes the page while you sleep, the fire still fades out on schedule. The engine also goes idle when the timer ends. (In Steady loop mode the fade is JavaScript-driven, so on iOS it may stop abruptly, or late.)
- The timer counts listening time: pausing pauses it.

## Project layout

```
index.html            app shell, placeholder mascot (inline SVG)
css/style.css         all styling; colors are tokens on :root
js/app.js             UI: presets, tuning, saving, timer, lights-out, settings
js/audio.js           playback: context, volume, sleep fade, lock screen, loop mode
js/fire-worklet.js    the fire (AudioWorklet; also runs under Node for tests)
js/presets.js         built-in fires and control definitions
sw.js                 offline cache (bump CACHE when you ship changes)
assets/               drop mascot.png here, see assets/README.md
tools/                offline rendering and analysis (below)
```

## Testing the sound without ears

```sh
node tools/render.mjs --preset hearth --seconds 60 --out hearth.wav
node tools/render.mjs --tour 36 --seconds 180 --out tour.wav    # all presets, gliding
node tools/render.mjs --preset hearth --sweep --seconds 180 --out sweep.wav  # random control jumps
node tools/render.mjs --preset stories --solo tick,snap --out crackles.wav    # one layer
node tools/render.mjs --bench
python3 tools/analyze.py hearth.wav     # loudness, spectrum, clustering, clicks, periodicity
```

`render.mjs` runs the real worklet file under Node, so what you analyze is what
ships. Level constants live at the top of `fire-worklet.js` (`K`, `MAKEUP_DB`).

## Mascot

`assets/mascot.png` replaces the placeholder automatically. The stage sizes itself
to the space available, so square-ish transparent art works best.
