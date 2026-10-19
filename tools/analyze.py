"""Objective checks on rendered fire audio (we can't listen in CI, so we measure).

    python3 tools/analyze.py file.wav [more.wav ...]

Reports loudness proxies, spectral balance, transient statistics, clustering
(crackles should be burstier than a Poisson process), discontinuities, and the
strongest periodicity in the loudness envelope (should be weak: no loops/rhythm).
"""
import sys
import wave
import numpy as np


def load(path):
    with wave.open(path) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768
        return sr, x.reshape(-1, w.getnchannels())


def db(x):
    return 20 * np.log10(np.maximum(x, 1e-12))


def band_energy(mono, sr):
    spec = np.abs(np.fft.rfft(mono * np.hanning(len(mono)))) ** 2
    f = np.fft.rfftfreq(len(mono), 1 / sr)
    total = spec.sum()
    bands = [(20, 60), (60, 250), (250, 1000), (1000, 3000), (3000, 7000), (7000, 20000)]
    return {f'{a}-{b}': 10 * np.log10(spec[(f >= a) & (f < b)].sum() / total) for a, b in bands}


def transients(mono, sr):
    # crude detector: HF energy (first difference) in 2 ms frames vs local median
    d = np.diff(mono)
    hop = int(sr * 0.002)
    frames = len(d) // hop
    e = np.sqrt((d[: frames * hop].reshape(frames, hop) ** 2).mean(axis=1))
    k = 250  # 0.5 s median window
    pad = np.pad(e, (k // 2, k // 2), mode='edge')
    med = np.array([np.median(pad[i:i + k]) for i in range(0, frames, 25)])
    med = np.repeat(med, 25)[:frames]
    hits = (e > med * 3.0) & np.r_[True, e[1:] > e[:-1]] & np.r_[e[:-1] >= e[1:], True]
    times = np.nonzero(hits)[0] * 0.002
    return times, e


def main():
    for path in sys.argv[1:]:
        sr, x = load(path)
        mono = x.mean(axis=1)
        rms = np.sqrt((x ** 2).mean())
        peak = np.abs(x).max()
        print(f'\n== {path}  ({len(x) / sr:.0f}s)')
        print(f'  RMS {db(rms):6.1f} dBFS   peak {db(peak):6.1f} dBFS   crest {db(peak / rms):5.1f} dB')
        lr = np.corrcoef(x[:, 0], x[:, 1])[0, 1]
        print(f'  L/R correlation {lr:.2f}')
        be = band_energy(mono, sr)
        print('  spectrum share (dB):', '  '.join(f'{k}:{v:5.1f}' for k, v in be.items()))

        # loudness envelope over 100 ms windows: swells/lulls and periodicity
        hop = int(sr * 0.1)
        n = len(mono) // hop
        env = db(np.sqrt((mono[: n * hop].reshape(n, hop) ** 2).mean(axis=1)))
        print(f'  100ms loudness: p5 {np.percentile(env, 5):.1f}  p50 {np.median(env):.1f}  p95 {np.percentile(env, 95):.1f}  (range {np.percentile(env, 95) - np.percentile(env, 5):.1f} dB)')
        sec = env[: (n // 10) * 10].reshape(-1, 10).mean(axis=1)
        print(f'  1s loudness std {sec.std():.2f} dB, min {sec.min():.1f}, max {sec.max():.1f}')
        ec = env - env.mean()
        ac = np.correlate(ec, ec, 'full')[len(ec) - 1:]
        ac /= ac[0]
        lag = np.argmax(ac[10:]) + 10  # ignore < 1 s
        print(f'  strongest envelope periodicity: r={ac[lag]:.2f} at {lag / 10:.1f}s (low = good)')

        times, _ = transients(mono, sr)
        dur = len(mono) / sr
        if len(times) > 3:
            iei = np.diff(times)
            cv = iei.std() / iei.mean()
            print(f'  transients ~{len(times) / dur:.1f}/s; inter-onset CV {cv:.2f} (Poisson=1, clustered>1)')
            per_s = np.histogram(times, bins=int(dur))[0]
            print(f'  per-second counts: min {per_s.min()}  median {int(np.median(per_s))}  max {per_s.max()}  (Fano {per_s.var() / max(per_s.mean(), 1e-9):.2f})')
        else:
            print(f'  transients: {len(times)}')

        # discontinuity check: largest sample step vs the 99.99th percentile step
        d = np.abs(np.diff(x, axis=0)).max(axis=1)
        print(f'  max step {d.max():.3f}  (p99.99 {np.percentile(d, 99.99):.3f}, ratio {d.max() / np.percentile(d, 99.99):.1f})')


if __name__ == '__main__':
    main()
