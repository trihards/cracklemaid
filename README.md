# Cracklemaid

A single-file campfire page for sleeping, sibling to Murmurmaid. Open `index.html` (or host it on GitHub Pages) on your phone and hit play.

- Keeps playing with the screen locked; phone volume buttons and lock-screen controls work.
- Presets: Embers, Campfire, Bonfire, Fireplace, Wood stove, Windy camp.
- Tend it with Fire (embers → bonfire), Crackle, Pops, Warmth (low-pass), Flicker and Breeze.
- Save your own fires; they live in the browser's local storage on that device.

How it works: every sound is synthesized in the browser when the page loads, with no audio files. The sound design is measured against a real campfire recording: a fire is a quiet, nearly white sizzle with loud broadband crackles on top (2–10 ms each, about 9 a second, a couple of them big), and very little low roar. So the fire is six looping layers, each a different length (37–89 s, all prime) so they never line up: the sizzle bed, crackles, big crackles with a woody body, pops (thump + crack + a spray of embers, plus the odd hiss of wet wood), log settling (knocks, a low rumble, a trickle and flurry of embers), and a faint low roar that only a big fire has. Every event has a random time, size, colour and stereo position. Crackles arrive as a self-exciting process, so they cluster the way real ones do. Events are pre-rendered into the loop buffers rather than scheduled from timers, which phones throttle when locked.

The controls are live Web Audio gains, a filter and two slow control loops (flicker and gusts) that push the roar around. Every change glides instead of restarting. Loudness is predicted from measured per-layer power: Warmth is fully compensated (it's a tone control), and the other sliders are 80% compensated, so presets land within about 2 dB of each other (around −24 LUFS) while turning the fire down still makes it quieter. A silent looping `<audio>` element runs alongside: that's what the phone sees as "media playing", which gives you lock-screen controls and keeps the page from being suspended. On Safari the page also asks for the `playback` audio session, so the silent switch doesn't mute it.

Testing: open with `?test` to get `window.cracklemaid`, with offline rendering through the shipping graph (`measure(preset, secs)`) and the per-layer power table (`measureLayers()`). If you change a layer, re-measure and paste the result into `LAYER_POWER`.
