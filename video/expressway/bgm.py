# 《中国高速公路网 1988–2025》配乐：D 小调电子乐，100 BPM，全部合成（numpy + scipy），各段落与画面的时刻对齐
# 用法：
#   pnpm tsx video/expressway/cues.ts > cues.json
#   python video/expressway/bgm.py cues.json bgm.wav
# 再以 --audio=bgm.wav 交给 video/record.ts 混进成片。
#
# 编排（时刻取自 cues.json）：
#   片头  标题故障闪现时一记低频冲击、数码碎音与扫频；沙盘搭建时每个部件画出一声金属瞬态，其间夹着数据声；
#         国界亮起时霓虹灯管的电流声；地图展开时铺底和声渐亮；演进开始前一段上扬，开始的一刻重拍落下
#   演进  Dm–B♭–F–C 每两小节换和弦。低音八分音符贯穿；鼓、琶音、镲片与高声部随年份逐层加入，越往后越满；
#         背景里稀疏的数据声；信息栏（事件提示、状态栏、读数）弹出时噪声上扫与金属瞬态，收回时下扫
#   片尾  演进结束重拍收住，只留长音；沙盘收起时低通噪声收拢、低音下沉；数据说明弹出，随后淡出
#   音效全部取自 cues.json（沙盘各部件画出的时刻、国界闪烁的亮度曲线都来自全息沙盘的进入动画），与画面同步
import json
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

cues = json.load(open(sys.argv[1], encoding='utf-8'))
OUT = sys.argv[2] if len(sys.argv) > 2 else 'bgm.wav'
SR = 48000
DUR = cues['duration']
N = int(SR * DUR)
rng = np.random.default_rng(1988)
T0, T1 = cues['tStart'], cues['tEnd']
INTRO, OUTRO = cues['intro'], cues['outro']
FOLD = OUTRO['fold'][0]
SOURCES = OUTRO['sources']
BEAT = 60 / 100
BAR = 4 * BEAT


def hz(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def bus():
    return np.zeros((N, 2))


def lp(x, fc, order=2):
    return np.asarray(sosfilt(butter(order, fc, "low", fs=SR, output="sos"), x, axis=0))


def hp(x, fc, order=2):
    return np.asarray(sosfilt(butter(order, fc, "high", fs=SR, output="sos"), x, axis=0))


def bp(x, lo, hi, order=2):
    return np.asarray(sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x, axis=0))


def lp_var(x, cutoff, block=2048):
    """随时间变化的低通：按块换系数，块间带上滤波器状态。cutoff(t) 给出每块的截止频率"""
    out = np.zeros_like(x)
    zi = np.zeros((1, 2, x.shape[1]))
    for s in range(0, len(x), block):
        fc = float(np.clip(cutoff((s + block / 2) / SR), 40, SR * 0.45))
        sos = butter(2, fc, 'low', fs=SR, output='sos')
        out[s:s + block], zi = sosfilt(sos, x[s:s + block], axis=0, zi=zi)
    return out


def env(n, a, r, curve=2.0):
    """起音 a 秒、尾音 r 秒（指数下落）的包络"""
    e = np.ones(n)
    na, nr = min(n, int(a * SR)), min(n, int(r * SR))
    if na:
        e[:na] = np.linspace(0, 1, na)
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr) ** curve
    return e


def decay(n, tau):
    return np.exp(-np.arange(n) / SR / tau)


def saw(f, n, ph=0.0):
    return 2 * ((f * np.arange(n) / SR + ph) % 1) - 1


def sine(f, n, ph=0.0):
    return np.sin(2 * np.pi * (f * np.arange(n) / SR + ph))


def add(b, x, t0, pan=0.0, gain=1.0):
    """把单声道 x 放到 t0 秒，等功率声像（pan -1 左 ~ 1 右）"""
    i = int(t0 * SR)
    if i >= N:
        return
    x = x[: N - max(i, 0)]
    if i < 0:
        x, i = x[-i:], 0
    a = (pan + 1) * np.pi / 4
    b[i:i + len(x), 0] += x * gain * np.cos(a)
    b[i:i + len(x), 1] += x * gain * np.sin(a)


def prog(t):
    """演进进度（0~1）"""
    return float(np.clip((t - T0) / (T1 - T0), 0, 1))


# —— 和声：Dm – B♭ – F – C，每两小节一换（演进从 T0 起对齐小节线；片头片尾停在 Dm）——
CHORDS = [
    (38, [50, 53, 57, 62]),  # Dm
    (34, [50, 53, 58, 62]),  # B♭
    (41, [48, 53, 57, 60]),  # F
    (36, [48, 52, 55, 60]),  # C
]
SPAN = 2 * BAR


def chord_at(t):
    if t < T0 or t >= T1:
        return CHORDS[0]
    return CHORDS[int((t - T0) // SPAN) % 4]


# —— 铺底和声：超锯齿（每音三支微失谐的锯齿波），随段落开合滤波器 ——
pad = bus()
windows = [(0.0, T0)]
t = T0
while t < T1:
    windows.append((t, min(t + SPAN, T1)))
    t += SPAN
windows.append((T1, DUR))
for a, b in windows:
    _, notes = chord_at(a + 0.01)
    if b == DUR:
        notes = notes + [64]  # 收尾的 Dm 加九音
    n = int((b - a + 1.2) * SR)
    for k, m in enumerate(notes):
        x = sum(saw(hz(m) * 2 ** (d / 1200), n, rng.random()) for d in (-9, 0, 8)) / 3
        add(pad, x * env(n, 0.8 if a == 0 else 0.5, 1.4), a - (0.3 if a > 0 else 0), pan=(k - 1.5) * 0.35, gain=0.05)


def pad_cut(t):
    if t < T0:
        # 片头：展开时渐亮，演进前的上扬里继续打开
        return 300 + 900 * np.clip((t - INTRO['unfold'][0]) / (T0 - INTRO['unfold'][0]), 0, 1) ** 1.5
    if t < T1:
        return 1200 + 2600 * prog(t) ** 1.2
    if t < FOLD:
        return 2400
    # 收起：滤波器一路合上
    return max(250, 2400 * np.exp(-(t - FOLD) * 0.9))


pad = lp_var(pad, pad_cut)

# —— 低音：长音贯穿片头，演进中八分音符 ——
bass = bus()
n = int((T0 - INTRO['unfold'][0] + 0.5) * SR)
add(bass, sine(hz(26), n) * env(n, 2.0, 0.6), INTRO['unfold'][0], gain=0.22)
t = T0
while t < T1 - 1e-6:
    root, _ = chord_at(t + 0.01)
    n = int(BEAT / 2 * 0.9 * SR)
    x = 0.6 * saw(hz(root), n) + 0.5 * sine(hz(root - 12), n)
    add(bass, x * env(n, 0.005, 0.12, 1.5), t, gain=0.16 + 0.08 * prog(t))
    t += BEAT / 2
bass = lp(bass, 900)

# —— 鼓 ——
drums = bus()
kicks = []


def kick(t, gain=1.0):
    n = int(0.45 * SR)
    f = 45 + 110 * np.exp(-np.arange(n) / SR / 0.035)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * decay(n, 0.16)
    x[: int(0.004 * SR)] += rng.uniform(-1, 1, int(0.004 * SR)) * 0.5
    add(drums, x, t, gain=0.5 * gain)
    kicks.append(t)


def clap(t, gain=1.0):
    n = int(0.25 * SR)
    x = bp(rng.uniform(-1, 1, (n, 1)), 900, 2600)[:, 0] * decay(n, 0.06) + 0.3 * sine(190, n) * decay(n, 0.05)
    add(drums, x, t, gain=0.28 * gain)


def hat(t, open_=False, gain=1.0, pan=0.0):
    n = int((0.3 if open_ else 0.06) * SR)
    x = hp(rng.uniform(-1, 1, (n, 1)), 7000)[:, 0] * decay(n, 0.11 if open_ else 0.018)
    add(drums, x, t, pan=pan, gain=0.12 * gain)


t = T0
i = 0
while t < T1 - 1e-6:
    p = prog(t)
    beat = i % 4
    if p < 0.29:
        if beat in (0, 2):
            kick(t)
    else:
        kick(t)
    if p > 0.45 and beat in (1, 3):
        clap(t)
    if p > 0.4:
        for s in range(4):
            hat(t + s * BEAT / 4, gain=0.6 + 0.4 * (s % 2 == 0), pan=0.3)
    if p > 0.6:
        hat(t + BEAT / 2, open_=True, gain=0.8, pan=-0.2)
    t += BEAT
    i += 1

# 演进开始与结束的重拍、片头标题的低频冲击
for tt, g in ((T0, 1.4), (T1, 1.4), (INTRO['title'][0], 1.1)):
    kick(tt, g)
    n = int(1.8 * SR)
    add(drums, sine(38, n) * decay(n, 0.6), tt, gain=0.3 * g)
    m = int(2.2 * SR)
    add(drums, hp(rng.uniform(-1, 1, (m, 1)), 3500)[:, 0] * decay(m, 0.7), tt, gain=0.08 * g)

# 闪避：鼓点处把铺底与低音压下去一点
duck = np.ones(N)
for k in kicks:
    i0 = int(k * SR)
    n = min(int(0.35 * SR), N - i0)
    if n > 0:
        duck[i0:i0 + n] = np.minimum(duck[i0:i0 + n], 1 - 0.45 * decay(n, 0.09))
pad *= duck[:, None]
bass *= duck[:, None]

# —— 琶音：拨弦音色的十六分音符，在和弦内音上下行；2000 年前后加入，越往后越亮 ——
arp = bus()
t = T0
i = 0
while t < T1 + 3 * BAR:
    p = prog(t)
    if p > 0.3:
        _, notes = chord_at(min(t, T1 - 0.01) + 0.01)
        seq = notes + [m + 12 for m in notes]
        order = list(range(len(seq))) + list(range(len(seq) - 2, 0, -1))
        m = seq[order[i % len(order)]]
        n = int(0.22 * SR)
        x = saw(hz(m), n) * decay(n, 0.07)
        fade = 1.0 if t < T1 else max(0.0, 1 - (t - T1) / (3 * BAR))
        add(arp, x, t, pan=0.5 * np.sin(i * 0.7), gain=0.05 * (0.4 + 0.6 * (p - 0.3) / 0.7) * fade)
    t += BEAT / 4
    i += 1
arp = lp_var(arp, lambda t: 900 + 3200 * prog(t))

# —— 高声部：2013 年前后加入的长音旋律，取和弦的三音与五音 ——
lead = bus()
t = T0
while t < T1 - 1e-6:
    if prog(t) > 0.66:
        _, notes = chord_at(t + 0.01)
        for j, m in enumerate((notes[1] + 12, notes[2] + 12)):
            n = int((SPAN / 2 - 0.05) * SR)
            x = 0.6 * saw(hz(m), n) + 0.4 * sine(hz(m) * 2, n)
            add(lead, x * env(n, 0.25, 0.8), t + j * SPAN / 2, pan=0.15, gain=0.03)
    t += SPAN
lead = lp(lead, 2600)

# —— 界面音效：滤波噪声扫频、固定音高的金属瞬态与短促的数据声，配合标题故障、沙盘搭建、霓虹国界、信息栏与收起 ——
fx = bus()
# 数据声取 D 小调五声音阶的高音区（D F G A C），零碎的声音也落在调内
DATA_NOTES = [m for o in (84, 96) for m in (o + 2, o + 5, o + 7, o + 9, o + 12)]


def bp_var(x, center, width=0.5, block=256):
    """随时间变化的带通（单声道）：center(t) 给出中心频率（t 为相对起点的秒数），带宽为中心频率的 width 倍"""
    out = np.zeros_like(x)
    zi = np.zeros((2, 2))
    for s0 in range(0, len(x), block):
        fc = float(np.clip(center((s0 + block / 2) / SR), 80, SR * 0.4))
        sos = butter(2, [fc * (1 - width / 2), min(fc * (1 + width / 2), SR * 0.45)], 'band', fs=SR, output='sos')
        out[s0:s0 + block], zi = sosfilt(sos, x[s0:s0 + block], zi=zi)
    return out


def whoosh(t, f0, f1, dur, gain=1.0, pan=0.0):
    """噪声扫频：带通的中心频率从 f0 移到 f1，像气流掠过"""
    n = int(dur * SR)
    x = bp_var(rng.uniform(-1, 1, n), lambda u: f0 * (f1 / f0) ** (u / dur), 0.6) * np.sin(np.linspace(0, np.pi, n)) ** 1.5
    add(fx, x, t, pan=pan, gain=0.22 * gain)


def tick(t, gain=1.0, pan=0.0, base=2900.0):
    """金属瞬态：几个非谐和的高频分音十几毫秒内衰减，前端一个极短的噪声咔嗒"""
    n = int(0.05 * SR)
    x = sum(a * sine(base * r, n) * decay(n, d) for r, a, d in ((1, 1, 0.012), (1.47, 0.6, 0.008), (2.13, 0.35, 0.005)))
    c = int(0.002 * SR)
    x[:c] += rng.uniform(-1, 1, c) * 0.8
    add(fx, x, t, pan=pan, gain=0.06 * gain)


def thump(t, gain=1.0):
    n = int(0.09 * SR)
    add(fx, sine(68, n) * decay(n, 0.022), t, gain=0.12 * gain)


def blip(t, m, dur=0.025, gain=1.0, pan=0.0):
    """数据声：固定音高的纯净短音（MIDI 音高 m）"""
    n = int(dur * SR)
    add(fx, sine(hz(m), n) * env(n, 0.001, dur * 0.7, 1.2), t, pan=pan, gain=0.04 * gain)


def chatter(a, b, density, gain=1.0):
    """数据通讯声：三十二分音符网格上随机的短音"""
    t = a
    while t < b:
        if rng.random() < density:
            blip(t, int(rng.choice(DATA_NOTES)), rng.uniform(0.015, 0.03), gain, rng.uniform(-0.8, 0.8))
        t += BEAT / 8


def panel(t, opening, gain=1.0, pan=0.0):
    """信息栏弹出（opening）或收回：噪声由低到高（收回时由高到低）扫过，弹出的一刻一声金属瞬态，底下一个很轻的低频落点"""
    if opening:
        whoosh(t - 0.02, 1800, 9000, 0.1, gain, pan)
        tick(t + 0.05, gain, pan)
    else:
        tick(t, 0.7 * gain, pan, base=2400)
        whoosh(t, 9000, 1800, 0.1, 0.8 * gain, pan)
    thump(t, 0.8 * gain)


def grains(a, b, count, gain):
    """数码碎音：短促的噪声与方波颗粒，量化成粗糙的位深"""
    for _ in range(count):
        t = rng.uniform(a, b)
        n = int(rng.uniform(0.01, 0.045) * SR)
        x = rng.uniform(-1, 1, n) if rng.random() < 0.5 else np.sign(sine(rng.uniform(300, 2400), n))
        x = np.round(x * 3) / 3 * env(n, 0.001, 0.005)
        add(fx, x, t, pan=rng.uniform(-0.7, 0.7), gain=gain)


def neon_buzz(a, b, rising):
    """霓虹灯管的电流声：100 Hz 嗡声与噼啪声，按国界闪烁的亮度曲线通断（rising 为亮起，否则倒放熄灭）"""
    n = int((b - a) * SR)
    curve = np.array(cues['neon'])
    p = np.linspace(0, 1, n) if rising else np.linspace(1, 0, n)
    gate = np.interp(p, np.linspace(0, 1, len(curve)), curve)
    # 亮度跳变的一瞬间一声噼啪
    jump = np.abs(np.diff(gate, prepend=gate[0])) > 0.2
    spark = np.zeros(n)
    for i in np.flatnonzero(jump):
        m = min(n - i, int(0.03 * SR))
        spark[i:i + m] += rng.uniform(-1, 1, m) * decay(m, 0.006)
    hum = (0.5 * saw(100, n) + 0.3 * saw(200, n)) * gate * (1 - 0.7 * np.clip(p - 0.8, 0, 1) / 0.2)
    x = lp(hum[:, None], 1800)[:, 0] + 0.6 * spark
    add(fx, x, a, gain=0.09)


# 标题：故障闪现时的数码碎音与一道扫频，消失时再来一次
ta, tb = INTRO['title']
grains(ta, ta + 0.45, 26, 0.06)
whoosh(ta - 0.05, 900, 7000, 0.3, 0.8)
grains(tb - 0.32, tb, 14, 0.045)
whoosh(tb - 0.25, 7000, 900, 0.3, 0.6)
# 沙盘搭建：每个部件开始画出时一声金属瞬态与一小段高频气声，其间夹着数据声
for k, t in enumerate(cues['boot']):
    pan = 0.5 * np.sin(k * 1.7)
    tick(t, 0.9, pan, base=2200 + 140 * k)
    whoosh(t, 5000, 9000, 0.06, 0.45, pan)
chatter(INTRO['boot'], INTRO['boot'] + 4.6, 0.3, 0.8)
# 国界：霓虹灯管通电与熄灭
neon_buzz(*INTRO['neon'], True)
neon_buzz(*OUTRO['neon'], False)
# 顶部状态栏、左下读数刷出：弹出声与一阵快速的数据声
for t in (INTRO['status'], INTRO['body']):
    panel(t, True)
    chatter(t + 0.08, t + 0.45, 0.6, 0.8)
# 演进开始前的上扬：噪声扫频与上行的音高
a = T0 - 2.4
n = int(2.4 * SR)
ramp = np.linspace(0, 1, n)
riser = bus()
add(riser, rng.uniform(-1, 1, n) * ramp ** 2, a, gain=0.12)
riser = lp_var(riser, lambda t: 300 + 9000 * np.clip((t - a) / 2.4, 0, 1) ** 2)
fx += riser
add(fx, np.sin(2 * np.pi * np.cumsum(200 * 4 ** ramp) / SR) * ramp ** 2, a, gain=0.05)
# 演进：背景里稀疏的数据声，每两小节一小簇，越往后越密
t = T0 + BAR
while t < T1 - BAR:
    if rng.random() < 0.55 + 0.35 * prog(t):
        s = t + rng.choice([0, 1, 2, 3]) * BEAT
        chatter(s, s + rng.uniform(0.15, 0.4), 0.6, 0.9)
    t += 2 * BAR
# 事件提示：弹出与收回
for k, c in enumerate(cues['captions']):
    pan = 0.3 if k % 2 else -0.3
    panel(c['open'], True, 1.0, pan)
    panel(c['close'] - 0.1, False, 0.8, pan)
# 收起：低通噪声收拢、低音缓缓下沉的"关机"声，夹着碎音
n = int(1.6 * SR)
down = bus()
add(down, rng.uniform(-1, 1, n) * env(n, 0.02, 1.2), FOLD, gain=0.16)
fx += lp_var(down, lambda t: 300 + 6000 * np.exp(-max(0.0, t - FOLD) * 3))
f = 160 * np.exp(-np.linspace(0, 1.5, n))
add(fx, np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.02, 0.8), FOLD, gain=0.18)
grains(FOLD, FOLD + 0.9, 18, 0.04)
# 数据说明：弹出声与一小段数据声
panel(SOURCES, True, 1.2)
chatter(SOURCES + 0.1, SOURCES + 0.5, 0.5, 0.6)

# —— 混音：混响（合成的冲激响应）、柔和限幅、整体淡入淡出 ——
def verb(x, seconds, amt):
    n = int(seconds * SR)
    ir = rng.uniform(-1, 1, (n, 2)) * np.exp(-np.arange(n) / SR / (seconds / 4))[:, None]
    ir = lp(ir, 6000)
    wet = np.stack([fftconvolve(x[:, c], ir[:, c])[:N] for c in range(2)], axis=1)
    return x + amt * wet / np.max(np.abs(ir).sum(axis=0))


mix = verb(pad + lead, 3.0, 0.9) + bass + drums + verb(arp, 1.8, 0.7) + verb(fx, 2.6, 0.8)
t = np.arange(N) / SR
mix *= np.clip(t / 0.05, 0, 1)[:, None] * np.clip((DUR - 0.2 - t) / 4.0, 0, 1)[:, None]
mix = np.tanh(mix * 1.6) / np.tanh(1.6)
mix *= 0.89 / np.max(np.abs(mix))
wavfile.write(OUT, SR, (mix * 32767).astype(np.int16))
print(f'{OUT}：{DUR:.1f} 秒，峰值 -1 dBFS，RMS {20 * np.log10(np.sqrt(np.mean(mix ** 2))):.1f} dBFS')
