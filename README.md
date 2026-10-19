# Cracklemaid

A single-file campfire page for sleeping, sibling to Murmurmaid. Open `index.html` (or host it on GitHub Pages) on your phone and hit play.

- Keeps playing with the screen locked; phone volume buttons and lock-screen controls work.
- Presets: Embers, Campfire, Bonfire, Fireplace, Wood stove, Windy camp.
- Tend it with Fire (embers → bonfire), Crackle, Pops, Warmth (low-pass), Flicker and Breeze.
- Save your own fires; they live in the browser's local storage on that device.

How it works: every sound is synthesized in the browser when the page loads, with no audio files. The fire is seven looping layers, each a different length (31–113 s, all prime) so they never line up: a low roar, the airy flame "breath", continuous fine crackle, crackle runs, snaps, pops (thump + crack + a spray of embers, plus the odd hiss of wet wood), and log settling (knock, rumble, trickling embers, a brief flare-up). Every event has a random time, size, pitch and stereo position. Crackles arrive as a self-exciting process, so they cluster the way real ones do. Events are pre-rendered into the loop buffers rather than scheduled from timers, which phones throttle when locked.

The controls are live Web Audio gains, a filter and two slow control loops (flicker and gusts) that push the roar around. Every change glides instead of restarting. Loudness is predicted from measured per-layer power, so every preset plays at about the same level (−20 LUFS, within 0.3 dB). A silent looping `<audio>` element runs alongside: that's what the phone sees as "media playing", which gives you lock-screen controls and keeps the page from being suspended. On Safari the page also asks for the `playback` audio session, so the silent switch doesn't mute it.

Testing: open with `?test` to get `window.cracklemaid`, with offline rendering through the shipping graph (`measure(preset, secs)`) and the per-layer power table (`measureLayers()`). If you change a layer, re-measure and paste the result into `LAYER_POWER`.
