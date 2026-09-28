import type { Dice } from '../ctx'
import type { Tier } from '../types'
import { centroid, obb, type Frame, type P, type Poly } from '../geom'

/**
 * 组合式的地标生成：骨架规则 + 元素池。
 * 宫殿、寺观、教堂、城堡、清真寺不再从几套写死的形制里抽一套，而是按各自建筑传统的骨架（中轴一进进的院落、
 * 主楼加翼楼、中殿加耳堂加东端……）一格格地从元素池里抽元素拼起来；以前的几套形制变成"预设"——
 * 只是给某些槽位的选项加权，抽到"自由"时不加权，于是能拼出多得多、但仍合乎规矩的组合。
 *
 * 选择都走 Dice（cityDice / siteDice）按名字取（V.pick('槽位名', ...)）：同一座建筑、同一个名字的抽签总是同一个结果，
 * 与抽签的先后无关，人口变了、别的片区变了都不会连带重抽。
 */

/** 元素能摆的位置（槽位） */
export type Slot =
  | 'axis-front' // 中轴最前（门、门前的阙、塔）
  | 'axis-centre' // 中轴当中（正殿、礼拜殿、主楼）
  | 'axis-rear' // 中轴后部（后殿、藏经阁、后宫）
  | 'flank' // 中轴两侧（配殿、厢房、翼楼）
  | 'corner' // 四角（角楼、宣礼塔）
  | 'court-centre' // 院子当中（塔、水池、碑亭）
  | 'attached-side' // 贴在主体一侧（礼拜堂、回廊院、陵墓）
  | 'end-pavilion' // 长楼两端的角阁
  | 'side-axis' // 东西路（旁边的一路院落）
  | 'rear' // 最后面（园林、后门）

/** 元素池里的一项：出现的基本权重、能放的槽位、至少要多大的地盘（米）与多高的等级（0 地方、1 大城、2 都城） */
export interface Elem<K extends string = string> {
  id: K
  w: number
  slots?: readonly Slot[]
  min?: number
  rank?: number
  /** 只在这几档规模里出现（缺省不限）：同心城、回廊院只在 grand，贝壳主楼、门廊只在 small…… */
  tiers?: readonly Tier[]
}

/** 预设：给槽位的选项乘权重（bias.槽位名.选项 = 倍数，0 就是不选），或收窄数值的范围 */
export interface Preset {
  id: string
  w: number
  /** 只在这几档规模里抽得到（缺省不限） */
  tiers?: readonly Tier[]
  bias?: Record<string, Record<string, number>>
  num?: Record<string, [number, number]>
}

/** 调试：打开后记下每座按语法拼成的建筑的构成签名（测多样性、测稳定性用） */
export const composeTrace = { on: false, list: [] as { kind: string; sig: string; p: P }[] }

/**
 * 一座建筑的"作曲者"：先抽一个预设（或自由组合），之后每个槽位按名字抽签。
 * size 是地盘的尺寸（米，元素的 min 与它比），rank 是等级（元素的 rank 与它比）。
 * 所有离散的选择都记进签名（sig），用来统计有多少种不同的构成。
 */
export function composer(V: Dice, kind: string, presets: readonly Preset[], o: { free?: number; size?: number; rank?: number; tier?: Tier } = {}) {
  const tier: Tier = o.tier ?? 'standard'
  const fits = (t?: readonly Tier[]) => !t || t.includes(tier)
  // 规模档收窄预设：大档专属的预设（同心城、朝圣大教堂）在别的档里抽不到，别的档的抽签也就不受影响
  const all: Preset[] = [...presets.filter((p) => fits(p.tiers)), { id: 'free', w: o.free ?? 1 }]
  const preset = V.pick('preset', all, all.map((p) => p.w))
  const sig: string[] = [preset.id]
  const size = o.size ?? Infinity
  const rank = o.rank ?? 0
  // 同一个名字只记第一次（同名的抽签结果相同）
  const seen = new Set<string>()
  const rec = (name: string, v: string | number | boolean) => {
    if (seen.has(name)) return
    seen.add(name)
    sig.push(`${name}=${v}`)
  }
  const C = {
    preset: preset.id,
    size,
    rank,
    tier,
    /**
     * 从元素池里按槽位抽一个：先按槽位、等级、only 过滤，乘上预设的偏好抽签；抽到的要比地盘大（min）时
     * 退到放得下的里权重最大的一个。先抽后退（而不是先按大小过滤再抽），地盘伸缩时只有放不下的那一格会变。
     * 全被滤掉时取池里第一个。
     */
    pick<K extends string>(name: string, pool: readonly Elem<K>[], f: { slot?: Slot; size?: number; only?: (id: K) => boolean; bias?: Partial<Record<K, number>> } = {}): K {
      const sz = f.size ?? size
      const ok = pool.filter((e) => (!f.slot || !e.slots || e.slots.includes(f.slot)) && (e.rank ?? 0) <= rank && fits(e.tiers) && (!f.only || f.only(e.id)))
      const b = preset.bias?.[name] ?? {}
      const wOf = (e: Elem<K>) => e.w * (b[e.id] ?? 1) * (f.bias?.[e.id] ?? 1)
      const ws = ok.map(wOf)
      let got = ws.some((w) => w > 0) ? V.pick(name, ok, ws) : (ok[0] ?? pool[0])
      if ((got.min ?? 0) > sz) {
        const fits = ok.filter((e) => (e.min ?? 0) <= sz)
        if (fits.length) got = fits.reduce((x, y) => (wOf(y) > wOf(x) ? y : x))
      }
      rec(name, got.id)
      return got.id
    },
    /** lo ~ hi 之间的一个数（预设可以收窄范围）；不进签名 */
    num(name: string, lo: number, hi: number) {
      const r = preset.num?.[name]
      const [a, b] = r ? [Math.max(lo, r[0]), Math.min(hi, r[1])] : [lo, hi]
      return V.num(name, a, b >= a ? b : a)
    },
    /** lo ~ hi 之间的整数（预设可以收窄范围） */
    int(name: string, lo: number, hi: number) {
      const r = preset.num?.[name]
      const [a, b] = r ? [Math.max(lo, r[0]), Math.min(hi, r[1])] : [lo, hi]
      const v = V.int(name, a, Math.max(a, b))
      rec(name, v)
      return v
    },
    /** 概率 p 为真；预设可用 bias.名字 = { yes, no } 调整 */
    chance(name: string, p: number) {
      const b = preset.bias?.[name]
      const y = p * (b?.yes ?? 1)
      const n = (1 - p) * (b?.no ?? 1)
      const v = V.h(name) < (y + n > 0 ? y / (y + n) : 0)
      rec(name, v ? 'y' : 'n')
      return v
    },
    /** ±1 */
    side(name: string) {
      const v = V.side(name)
      rec(name, v)
      return v
    },
    /** 记下落地后的实际情况（放不下退了一档之类），也进签名 */
    note(name: string, v: string | number | boolean) {
      rec(name, v)
    },
    sig: () => sig.join(' '),
    /** 盖完了：打开调试时记下签名 */
    done(p: P) {
      if (composeTrace.on) composeTrace.list.push({ kind, sig: sig.join(' '), p })
    },
  }
  return C
}
export type Composer = ReturnType<typeof composer>

/**
 * 沿一条轴按偏好分配长度：每段 {pref, min, max, drop}，总长 L，段间留 gap。
 * 放不下时按 drop 从小到大（drop 越小越先舍，undefined 不舍）舍段，多出来的给 grow 指定的段（缺省最后一段）。
 * 返回留下的段的下标与各段的长度。
 */
export function allot(items: { pref: number; min: number; max?: number; drop?: number }[], L: number, gap: number, grow?: number) {
  const keep = items.map((_, i) => i)
  const need = () => keep.reduce((s, i) => s + items[i].min, 0) + gap * (keep.length - 1)
  const order = keep.filter((i) => items[i].drop !== undefined).sort((a, b) => items[a].drop! - items[b].drop!)
  for (const i of order) if (need() > L && keep.length > 1) keep.splice(keep.indexOf(i), 1)
  const avail = L - gap * (keep.length - 1)
  const ps = keep.reduce((s, i) => s + items[i].pref, 0) || 1
  let len = keep.map((i) => Math.max(items[i].min, Math.min(items[i].max ?? Infinity, (items[i].pref * avail) / ps)))
  const left = avail - len.reduce((s, x) => s + x, 0)
  if (left > 0) {
    const g = grow !== undefined && keep.includes(grow) ? keep.indexOf(grow) : keep.length - 1
    len[g] += left
  } else len = len.map((x) => (x * avail) / (avail - left))
  return { keep, len }
}

/**
 * 矩形地盘的标架：o 是正面的中点，f 从正面朝里（进深 a：0 ~ D），l 横向（b：-W/2 ~ W/2）。
 * front 是正面朝外的方向（单位向量）；矩形的两条轴里与 front 更平行的是进深方向。
 */
export function rectFrame(R: Poly, front: P): { F: Frame; W: number; D: number } {
  const b = obb(R)
  const c = centroid(R)
  const a: P = b.axis
  const across: P = [-a[1], a[0]]
  const alongDepth = Math.abs(a[0] * front[0] + a[1] * front[1]) > Math.abs(across[0] * front[0] + across[1] * front[1])
  let f: P = alongDepth ? a : across
  if (f[0] * front[0] + f[1] * front[1] > 0) f = [-f[0], -f[1]]
  const D = alongDepth ? b.len : b.wid
  const W = alongDepth ? b.wid : b.len
  const l: P = [-f[1], f[0]]
  return { F: { o: [c[0] - f[0] * D * 0.5, c[1] - f[1] * D * 0.5], f, l }, W, D }
}

/** 按对称规则取两侧的选项：mirror 为真时两侧相同，否则各抽各的 */
export function flanks<K extends string>(C: Composer, name: string, pool: readonly Elem<K>[], mirror: boolean, f: Parameters<Composer['pick']>[2] = {}): [K, K] {
  const a = C.pick(`${name}.w`, pool, f)
  return [a, mirror ? a : C.pick(`${name}.e`, pool, f)]
}
