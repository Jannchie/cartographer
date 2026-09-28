# 演示视频配乐：D 小调，按 scripts/demo.ts 的段落与切镜时间编排，全部合成（numpy + scipy）
# 用法：python scripts/demo-bgm.py [输出.wav]，默认 bgm.wav；再以 --audio=<wav> 交给 demo.ts 混进成片
# 段落（秒）：3D 0–6 · 纸图 6–10.8（每 0.8 切）· 成长 10.8–13.3 · 文明 13.3–22.9（每 1.6 切）· 皮肤 22.9–27.9 · 片尾定格 27.9–30.9
import sys

import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

SR = 44100
TOTAL = 30.9
N = int(SR * (TOTAL + 0.1))
rng = np.random.default_rng(7)

T3D, TMAP, TGROW, TCUL, TSKIN, TEND = 0.0, 6.0, 10.8, 13.3, 22.9, 27.9
CUL_D = 1.6


def hz(n):  # MIDI → Hz
    return 440.0 * 2 ** ((n - 69) / 12)


def bus():
    return np.zeros((N, 2))


def lp(x, fc, order=2):
    return sosfilt(butter(order, fc, 'low', fs=SR, output='sos'), x, axis=0)


def hp(x, fc, order=2):
    return sosfilt(butter(order, fc, 'high', fs=SR, output='sos'), x, axis=0)


def env(n, a, r, sustain=1.0):
    e = np.full(n, sustain)
    na, nr = int(a * SR), int(r * SR)
    if na: e[:na] = np.linspace(0, sustain, na) ** 1.5
    if nr: e[-nr:] *= np.linspace(1, 0, nr) ** 2
    return e


def saw(f, dur, detune=(0,), maxh=48):
    t = np.arange(int(dur * SR)) / SR
    out = np.zeros_like(t)
    for d in detune:
        ff = f * 2 ** (d / 1200)
        ph = rng.uniform(0, 2 * np.pi)
        for k in range(1, min(maxh, int(9000 / ff)) + 1):
            out += np.sin(2 * np.pi * k * ff * t + ph * k) / k
    return out / len(detune)


def add(b, x, t0, pan=0.0, gain=1.0):
    i = int(t0 * SR)
    j = min(N, i + len(x))
    if j <= i: return
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    b[i:j, 0] += x[: j - i] * gain * l
    b[i:j, 1] += x[: j - i] * gain * r


# —— 和声 ——
DM, BB, F, C, GM, A, D = [50, 53, 57], [46, 50, 53], [53, 57, 60], [48, 52, 55], [43, 50, 55], [45, 49, 52], [50, 54, 57]
chords = [  # (起, 止, 和弦)
    (0.0, 3.0, DM), (3.0, 6.0, BB),
    (6.0, 7.6, DM), (7.6, 9.2, BB), (9.2, 10.8, F),
    (10.8, 12.05, C), (12.05, 13.3, A),
] + [(TCUL + i * CUL_D, TCUL + (i + 1) * CUL_D, c) for i, c in enumerate([DM, BB, F, C, GM, A])] + [
    (22.9, 24.15, DM), (24.15, 25.4, BB), (25.4, 26.65, C), (26.65, 27.9, A), (27.9, 30.9, D),
]

pads, brass, ost, drums, sub, fx = bus(), bus(), bus(), bus(), bus(), bus()


def dyn(t):  # 整体力度曲线
    return float(np.interp(t, [0, 6, 10.8, 13.3, 22.9, 27.9, 30.9], [0.35, 0.6, 0.72, 0.9, 1.0, 1.0, 0.7]))


# 弦乐长音：超锯齿、慢起，三个八度铺开
for t0, t1, ch in chords:
    dur = t1 - t0 + 0.5
    for n in ch + [ch[0] + 12, ch[1] + 12]:
        x = saw(hz(n), dur, detune=(-9, -3, 4, 10), maxh=24)
        x = lp(x, 1800 + 1600 * dyn(t0)) * env(len(x), 0.35 if t0 else 2.5, 0.6)
        add(pads, x, t0, pan=rng.uniform(-0.6, 0.6), gain=0.05 * (0.5 + dyn(t0)))

# 低音：长音贯穿，文明段更厚
for t0, t1, ch in chords:
    dur = t1 - t0 + 0.3
    t = np.arange(int(dur * SR)) / SR
    f = hz(ch[0] - 12)
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t)
    add(sub, x * env(len(t), 0.08 if t0 else 3.0, 0.25), t0, gain=0.22 * (0.4 + dyn(t0)))

# 低音弦乐断奏固定音型：纸图段开始，八分音符 0.2 秒一拍
for t0, t1, ch in chords:
    if t0 < TMAP or t0 >= TEND: continue
    step = 0.2
    pat = [0, 0, 12, 0, 7, 0, 12, 7]
    k = 0
    tt = t0
    while tt < t1 - 1e-6:
        n = ch[0] - 12 + pat[k % len(pat)]
        x = saw(hz(n), 0.18, detune=(-6, 6), maxh=30)
        x = lp(x, 900 + 1500 * dyn(tt)) * env(len(x), 0.004, 0.12)
        add(ost, x, tt, pan=-0.25 if k % 2 else 0.25, gain=0.11 * (0.55 + 0.45 * (k % 4 == 0)) * dyn(tt))
        tt += step
        k += 1

# 铜管：文明段与皮肤段，和弦起处一记长音
for t0, t1, ch in chords:
    if t0 < TCUL - 1e-6: continue
    dur = t1 - t0 + 0.2
    for n in ch:
        x = saw(hz(n), dur, detune=(-4, 5), maxh=40)
        n_ = len(x)
        # 滤波包络：起音亮、随后变暗
        bright = lp(x, 3200)
        dark = lp(x, 900)
        k = np.exp(-np.arange(n_) / (0.35 * SR))
        x = (bright * k + dark * (1 - k)) * env(n_, 0.05, 0.3)
        add(brass, x, t0, pan=rng.uniform(-0.3, 0.3), gain=0.07)


def drum(freq, decay, noise=0.3, dur=2.0):
    t = np.arange(int(dur * SR)) / SR
    f = freq * (1 + 1.6 * np.exp(-t / 0.03))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / decay)
    nz = lp(rng.standard_normal(len(t)), 2500) * np.exp(-t / 0.05) * noise
    return np.tanh(1.6 * (body + nz))


# 大鼓：3D 段末、纸图开头、成长段末、文明段每次切镜、皮肤段与结尾
hits = [TMAP, TCUL] + [TCUL + i * CUL_D for i in range(1, 6)] + [22.9, 24.15, 25.4, 26.65, TEND]
for h in hits:
    add(drums, drum(52, 0.55), h, gain=0.75)
    add(drums, drum(90, 0.25, noise=0.5, dur=1.0), h + 0.01, pan=0.2, gain=0.3)
# 纸图段每次换风格一记轻鼓
for i in range(1, 6):
    add(drums, drum(80, 0.2, noise=0.4, dur=0.8), TMAP + i * 0.8, pan=-0.2, gain=0.3)
# 文明段的后半拍小鼓：每小节第 3 拍
for i in range(6):
    for off in (0.8, 1.2):
        add(drums, drum(110, 0.12, noise=0.7, dur=0.5), TCUL + i * CUL_D + off, pan=0.3 if off > 1 else -0.3, gain=0.2)

# 滚奏渐强：成长段（10.8–13.3），越来越密越来越响
tt = TGROW
while tt < TCUL - 0.03:
    u = (tt - TGROW) / (TCUL - TGROW)
    add(drums, drum(95, 0.1, noise=0.8, dur=0.3), tt, pan=rng.uniform(-0.4, 0.4), gain=0.06 + 0.3 * u ** 2)
    tt += 0.16 - 0.1 * u

# 反向镲片：进入 3D 结尾、文明段与皮肤段前的吸气声
for t_hit, length in [(TMAP, 2.0), (TCUL, 2.5), (22.9, 1.6), (TEND, 1.25)]:
    n = int(length * SR)
    x = hp(rng.standard_normal(n), 3000) * np.linspace(0, 1, n) ** 3
    add(fx, np.tile(x[:, None], 1)[:, 0], t_hit - length, gain=0.08)
    add(fx, hp(rng.standard_normal(int(1.8 * SR)), 4000) * np.exp(-np.arange(int(1.8 * SR)) / (0.5 * SR)), t_hit, gain=0.05)

# —— 混音：混响（合成的冲激响应）、总线压缩感、淡出 ——
ir_n = int(3.2 * SR)
ir = rng.standard_normal((ir_n, 2)) * np.exp(-np.arange(ir_n) / (0.9 * SR))[:, None]
ir = lp(ir, 5000)
ir /= np.abs(ir).sum(axis=0) ** 0.5 * 12


def verb(x, amt):
    wet = np.stack([fftconvolve(x[:, c], ir[:, c])[:N] for c in range(2)], axis=1)
    return x + wet * amt


mix = verb(pads, 0.9) + verb(brass, 0.6) + verb(ost, 0.3) + verb(drums, 0.45) + sub + verb(fx, 0.5)
mix = hp(mix, 30)
# 淡入淡出
t = np.arange(N) / SR
mix *= np.clip(t / 1.2, 0, 1)[:, None] * np.clip((TOTAL - t) / 2.2, 0, 1)[:, None]
mix = np.tanh(mix / np.max(np.abs(mix)) * 1.6)
mix *= 0.89 / np.max(np.abs(mix))
OUT = sys.argv[1] if len(sys.argv) > 1 else 'bgm.wav'
wavfile.write(OUT, SR, (mix * 32767).astype(np.int16))
print(OUT, round(N / SR, 2), 's')
