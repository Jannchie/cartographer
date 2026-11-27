/**
 * 【实验·第三轮】山水：与奇幻羊皮并列的一种纸图风格的原型（尚未登记进任何插件）。
 * 山用连嶂（./gradual.ts），林用点叶，散树用墨点树；这里是点叶与墨点树、宣纸底图、山水式的平铺笔触，以及把它们合成一个 Theme 的函数。
 * 另有"现有的树"两个条目（奇幻羊皮现有的树冠画法，供只换山的比较图用）。
 */
import { Biome, type World } from '../../../gen/types'
import { fnoise, hash, type Fields } from '../fields'
import type { Pen } from '../glyphBatch'
import { drawTreeGlyph, type GlyphColors } from '../glyphs'
import { hex, type RGB } from '../../palette'
import type { Theme, VectorDraw } from '../styles'
import { biomeLayers, FOREST, hillshade, rgb, ripples, type Layers, type VectorFields } from '../svg/layers'
import { addDab, addTaper, mixColor, rnd, type P } from './brush'
import { makeLianzhang } from './gradual'
import { kitDrawer, type SymbolStyle } from './index'
import type { Terrain, TreeKind } from './terrain'

// ———————————————————————— 墨点树：点叶林与散树共用的一棵树 ————————————————————————

interface InkTones {
  pale: string
  mid: string
  dark: string
  ink: string
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
type Tones = { leaf: InkTones; pine: InkTones; jungle: InkTones }
const tonesOf = (o: GlyphColors): Tones => ({
  leaf: { pale: mixColor(o.leaf, o.paper, 0.45), mid: o.leafDark, dark: mixColor(o.leafDark, o.ink, 0.55), ink: o.ink },
  pine: { pale: mixColor(o.pine, o.paper, 0.45), mid: o.pineDark, dark: mixColor(o.pineDark, o.ink, 0.6), ink: o.ink },
  jungle: { pale: mixColor(o.leaf, o.leafDark, 0.3), mid: mixColor(o.leafDark, o.ink, 0.2), dark: mixColor(o.leafDark, o.ink, 0.65), ink: o.ink },
})

/** 树冠的点法：米点（横向的扁点，一排排叠成馒头形）、胡椒点（小而圆的点，攒成一团） */
type Dot = 'mi' | 'pepper'

/**
 * 一团点叶：淡墨的大点垫底、中墨的点叠出树冠、浓墨的小点压在顶上。
 * (cx, cy) 为树冠中心，dense 0~1 决定浓点的多少，tone 0~2：0 只有淡点与几个中点（远、淡），1 常规，2 中点也偏浓
 */
function dotCrown(pen: Pen, cx: number, cy: number, s: number, dot: Dot, r: (i: number) => number, t: InkTones, dense: number, tone: number) {
  const rx = s * (dot === 'pepper' ? 1.15 : 1.3)
  // 淡
  pen.beginPath()
  addDab(pen, cx + (r(1) - 0.5) * s * 0.3, cy + s * 0.25, rx * 1.75, s * 0.75, (r(2) - 0.5) * 0.15)
  if (tone > 0) addDab(pen, cx + (r(3) - 0.5) * s * 0.5, cy - s * 0.35, rx * 1.2, s * 0.6, (r(4) - 0.5) * 0.25)
  pen.fillStyle = t.pale
  pen.fill()
  // 中
  pen.beginPath()
  if (dot === 'mi') {
    // 三排横点：下排宽、上排窄
    const rows: [number, number][] = tone > 0 ? [[0.42, 3], [-0.08, 2], [-0.56, 1]] : [[0.3, 2], [-0.25, 1]]
    rows.forEach(([v, n0], j) => {
      const n = Math.max(1, n0 + (r(10 + j) > 0.7 ? 1 : 0) - (r(13 + j) < 0.15 ? 1 : 0))
      const rw = rx * (1.5 - 0.42 * j)
      for (let q = 0; q < n; q++) {
        const u = n === 1 ? 0 : q / (n - 1) - 0.5
        addDab(pen, cx + u * rw + (r(20 + j * 5 + q) - 0.5) * s * 0.3, cy + v * s + (r(40 + j * 5 + q) - 0.5) * s * 0.18, s * (0.78 + r(60 + j * 5 + q) * 0.4), s * 0.34, (r(80 + j * 5 + q) - 0.5) * 0.3)
      }
    })
  } else {
    // 胡椒点：在一个下宽上窄的团里按黄金角撒开
    const n = tone > 0 ? 5 + Math.floor(r(10) * 4) : 3
    for (let q = 0; q < n; q++) {
      const a = q * 2.39996 + r(11) * 6
      const d = Math.sqrt((q + 0.5) / n)
      const px = cx + Math.cos(a) * d * rx * 0.95
      const py = cy + Math.sin(a) * d * s * 0.72 + d * s * 0.1
      const w = s * (0.36 + r(20 + q) * 0.18)
      addDab(pen, px, py, w, w * 0.95, r(40 + q) * 3)
    }
  }
  pen.fillStyle = tone > 1 ? mixColor(t.mid, t.dark, 0.45) : t.mid
  pen.fill()
  // 浓
  const nd = tone > 0 ? Math.round(dense * 2.6 + r(90) * 0.9) : 0
  if (!nd) return
  pen.beginPath()
  for (let j = 0; j < nd; j++) {
    const px = cx + (r(91 + j) - 0.55) * rx * 1.1
    const py = cy - s * (0.15 + 0.5 * r(95 + j))
    if (dot === 'mi') addDab(pen, px, py, s * (0.5 + r(99 + j) * 0.3), s * 0.28, (r(103 + j) - 0.5) * 0.4)
    else addDab(pen, px, py, s * 0.36, s * 0.34, r(103 + j) * 3)
  }
  pen.fillStyle = t.dark
  pen.fill()
}

/**
 * 一株针叶（介字 / 松针）：每层底下一个淡点，上面向外下撇的两笔；tiers 层数，trunk 为假时没有干（林子深处）
 */
function pineMark(pen: Pen, x: number, y: number, s: number, r: (i: number) => number, t: InkTones, k: number, trunk: boolean, tiers: number, heavy: boolean, pale: boolean) {
  const step = 0.62
  const top = y - s * (0.95 + (tiers - 1) * step + 0.62)
  if (pale) {
    pen.beginPath()
    for (let i = 0; i < tiers; i++) addDab(pen, x, y - s * (0.55 + i * step), s * (1.75 - i * 0.42), s * 0.36)
    pen.fillStyle = t.pale
    pen.fill()
  }
  if (trunk) {
    pen.beginPath()
    addTaper(pen, [[x, y + s * 0.25], [x + (r(1) - 0.5) * s * 0.12, top + s * 0.3]], (u) => (0.62 - 0.36 * u) * k)
    pen.fillStyle = t.ink
    pen.fill()
  }
  pen.beginPath()
  for (let i = 0; i < tiers; i++) {
    const cy = y - s * (0.95 + i * step)
    const hw = s * (0.86 - i * (0.6 / tiers)) * (0.9 + r(10 + i) * 0.25)
    for (const side of [-1, 1]) {
      const ex = x + side * hw
      const ey = cy + s * (0.42 + r(20 + i) * 0.12)
      // 一笔：起笔在干上，向外下撇，收成尖
      pen.moveTo(x, cy - 0.34 * k)
      pen.lineTo(x + side * 0.1 * k, cy + 0.42 * k)
      pen.lineTo(ex, ey)
      pen.closePath()
    }
  }
  pen.moveTo(x - 0.3 * k, top + s * 0.42)
  pen.lineTo(x + 0.3 * k, top + s * 0.42)
  pen.lineTo(x, top)
  pen.closePath()
  pen.fillStyle = heavy ? t.dark : t.mid
  pen.fill()
}

/**
 * 点簇松：针叶林深处的另一种写法——横点自下而上一层层收窄，叠成一个尖顶的簇，顶上一笔短的直点。
 * 与介字成片地相间，针叶林不至于满眼同一个字
 */
function pineStack(pen: Pen, x: number, y: number, s: number, r: (i: number) => number, t: InkTones, k: number, tone: number) {
  const tiers = r(31) > 0.5 ? 3 : 4
  pen.beginPath()
  addDab(pen, x, y - s * 0.9, s * 2.0, s * 0.9, (r(32) - 0.5) * 0.1)
  pen.fillStyle = t.pale
  pen.fill()
  pen.beginPath()
  for (let j = 0; j < tiers; j++) {
    const n = Math.max(1, tiers - j - (r(33 + j) < 0.3 ? 1 : 0))
    const cy = y - s * (0.35 + j * 0.5)
    const rw = s * (1.35 - j * (1.05 / tiers))
    for (let q = 0; q < n; q++) {
      const u = n === 1 ? 0 : q / (n - 1) - 0.5
      // 两侧的点略向外下斜，像枝梢下垂
      addDab(pen, x + u * rw + (r(40 + j * 4 + q) - 0.5) * s * 0.2, cy + Math.abs(u) * s * 0.12, s * (0.62 + r(60 + j * 4 + q) * 0.3), s * 0.3, u * 0.5)
    }
  }
  const top = y - s * (0.35 + tiers * 0.5)
  addTaper(pen, [[x, top + s * 0.5], [x, top - s * 0.05]], (u) => (0.55 - 0.4 * u) * k)
  pen.fillStyle = tone > 1 ? t.dark : tone > 0 ? t.mid : mixColor(t.mid, t.pale, 0.45)
  pen.fill()
}

/** 一棵带干的墨点树（林缘与散树）：干一笔，树冠是一团点叶 */
function inkTree(pen: Pen, x: number, y: number, s: number, kind: TreeKind, seed: number, tn: Tones, k: number, dense: number, dot: Dot, size = 1) {
  const r = rnd(seed)
  s *= size
  if (kind === 'pine') return pineMark(pen, x, y, s, r, tn.pine, k, true, 3, dense > 0.45, true)
  if (kind === 'bush') {
    pen.beginPath()
    addDab(pen, x, y - s * 0.35, s * 2.1, s * 0.5)
    pen.fillStyle = tn.leaf.pale
    pen.fill()
    pen.beginPath()
    addDab(pen, x - s * 0.4, y - s * 0.55, s * 1.1, s * 0.3, -0.15)
    addDab(pen, x + s * 0.45, y - s * 0.4, s * 1.0, s * 0.28, 0.1)
    pen.fillStyle = tn.leaf.mid
    pen.fill()
    return
  }
  const t = kind === 'jungle' ? tn.jungle : tn.leaf
  // 金合欢：树冠更宽更扁、树干分叉
  const wide = kind === 'acacia'
  const lean = (r(5) - 0.5) * s * 0.5
  const cx = x + lean
  const cy = y - s * 1.45
  pen.beginPath()
  const fork: P = [x + lean * 0.5 + (r(6) - 0.5) * s * 0.2, y - s * 0.5]
  addTaper(pen, [[x, y + s * 0.22], fork, [cx, cy + s * 0.1]], (u) => (0.72 - 0.42 * u) * k)
  if (wide || r(7) > 0.55) addTaper(pen, [fork, [fork[0] + (r(8) > 0.5 ? 1 : -1) * s * (wide ? 0.75 : 0.45), cy + s * 0.25]], (u) => (0.42 - 0.26 * u) * k)
  pen.fillStyle = t.ink
  pen.fill()
  dotCrown(pen, cx, cy, s * (wide ? 1.15 : 1), wide ? 'mi' : dot, r, t, dense, 1)
}

/**
 * 点叶：山水的点叶法，按群系分点法——阔叶林以米点、胡椒点为主（成片地换，不逐棵混），针叶林是介字与松针，混交林两者相杂，雨林是浓密的胡椒点。
 * 林缘的树带干、点得清楚；深处只剩点，浓淡分三层、大小与聚散按低频的"气"成片变化，大片林地留出气口；底下垫一层淡晕
 */
export const dianye: SymbolStyle = {
  id: 'dianye',
  name: '点叶',
  desc: '山水的点叶法：阔叶米点、胡椒点，针叶介字、松针，混交相杂；淡、中、浓三层，林缘带干、深处只剩点，聚散随势，大片林地留气口。',
  draw(T, o, out) {
    const k = T.k
    const tn = tonesOf(o)
    const wash = { leaf: mixColor(o.leaf, o.paper, 0.45), pine: mixColor(o.pine, o.paper, 0.45) }
    const blots: { leaf: number[]; pine: number[] } = { leaf: [], pine: [] }
    for (const sp of T.spots) {
      const edge = sp.depth <= 2.2
      // 气：低频的疏密。深处低于阈值的整片留空（气口），其余按气的大小取舍；林子越大，气口越多
      const qi = fnoise(sp.x, sp.y, 44 * k)
      const pick = hash(sp.seed, 21)
      const gap = sp.size > 400 ? 0.44 : 0.4
      // 深处：气越盛越密，气弱处整片留空；聚散的反差比林缘大
      if (!edge) {
        if (pick > 0.8 * smooth(gap, gap + 0.17, qi)) continue
      } else if (!sp.front && pick > 0.85) continue
      const dense = Math.min(1, Math.max(0, (fnoise(sp.x + 900, sp.y, 17 * k) - 0.36) * 3.2))
      // 浓淡三层：气弱处偏淡、气盛处偏浓；林缘的南缘（近处）偏浓
      const tv = fnoise(sp.x - 500, sp.y + 300, 26 * k) + (sp.front ? 0.12 : 0) + (qi - 0.5) * 0.6 + (hash(sp.seed, 24) - 0.5) * 0.16
      const tone = tv < 0.45 ? 0 : tv > 0.63 ? 2 : 1
      // 大小：低频的起伏，加上逐棵的一点差
      const size = (0.82 + 0.42 * fnoise(sp.x + 77, sp.y - 300, 30 * k)) * (0.88 + 0.26 * hash(sp.seed, 22)) * (edge ? 1.05 : 1)
      // 带干的只是林缘的一部分：南缘（近处）约一半，别处零星几棵
      const trunk = (sp.front && pick < 0.5) || (edge && pick < 0.1)
      // 阔叶的点法成片地换：一片林子里米点与胡椒点各成一片，而不是逐棵混
      const dot: Dot = sp.kind === 'jungle' || fnoise(sp.x + 3100, sp.y - 1700, 90 * k) > 0.56 ? 'pepper' : 'mi'
      if (hash(sp.seed, 23) < 0.6) blots[sp.kind === 'pine' ? 'pine' : 'leaf'].push(sp.x, sp.y - sp.s * 1.1, sp.s)
      out.item(sp.y, (pen) => {
        const r = rnd(sp.seed)
        const s = sp.s * size
        if (trunk) return inkTree(pen, sp.x, sp.y, sp.s, sp.kind, sp.seed, tn, k, dense, dot, size)
        // 针叶的写法也成片地换：深处以点簇松为主，介字成片地夹在其间
        if (sp.kind === 'pine' && fnoise(sp.x - 2100, sp.y + 900, 80 * k) < 0.58) return pineStack(pen, sp.x, sp.y, s * 0.9, r, tn.pine, k, tone)
        if (sp.kind === 'pine') return pineMark(pen, sp.x, sp.y, s * 0.92, r, tn.pine, k, false, r(30) > 0.45 ? 3 : 2, tone > 1 || (tone > 0 && dense > 0.5), tone < 2)
        const t = sp.kind === 'jungle' ? tn.jungle : tn.leaf
        dotCrown(pen, sp.x, sp.y - s * 1.05, s * (sp.kind === 'jungle' ? 1.12 : 1), dot, r, t, dense, tone)
      })
    }
    // 淡晕：每棵树下一团，连成一片林的底色
    out.under((pen) => {
      for (const key of ['leaf', 'pine'] as const) {
        const b = blots[key]
        if (!b.length) continue
        pen.beginPath()
        for (let i = 0; i < b.length; i += 3) addDab(pen, b[i], b[i + 1], b[i + 2] * 4.6, b[i + 2] * 1.5, (hash(i, 5) - 0.5) * 0.3)
        pen.fillStyle = wash[key]
        pen.globalAlpha = 0.5
        pen.fill()
        pen.globalAlpha = 1
      }
    })
  },
}

/** 丛里各棵的相对位置（以 s 为单位），自后向前 */
function clump(n: number, seed: number): [number, number][] {
  const r = rnd(seed)
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const u = i - (n - 1) / 2
    out.push([u * 1.25 + (r(i) - 0.5) * 0.4, -Math.abs(u) * 0.34 - r(10 + i) * 0.2])
  }
  return out.sort((a, b) => a[1] - b[1])
}

/** 墨点树：散树与小丛，与点叶林是同一棵树（带干） */
export const inkTrees: SymbolStyle = {
  id: 'ink-tree',
  name: '墨点树',
  desc: '与点叶林同一种树：一笔有粗细的树干，淡、中、浓三层墨点；小丛的几棵根部靠拢、前后错落。',
  draw(T, o, out) {
    const k = T.k
    const tn = tonesOf(o)
    for (const t of T.trees) {
      // 稀树草原与灌丛的树只留一半多：留白
      if ((t.kind === 'acacia' || t.kind === 'bush') && hash(t.seed, 31) < 0.42) continue
      const dot: Dot = t.kind === 'jungle' || hash(t.seed, 32) > 0.6 ? 'pepper' : 'mi'
      out.item(t.y, (pen) => {
        clump(t.n, t.seed).forEach(([dx, dy], i) => inkTree(pen, t.x + dx * t.s, t.y + dy * t.s, t.s, t.kind, t.seed + i * 131, tn, k, 0.7, dot, t.n > 1 ? 0.92 : 1.05))
      })
    }
  },
}

// ———————————————————————— 现有的树（奇幻羊皮的树冠画法，接在新的地物结构上） ————————————————————————

const CLASSIC_KIND = { leaf: 'tree', pine: 'conifer', jungle: 'jungle', acacia: 'acacia', bush: 'bush' } as const

export const classicForest: SymbolStyle = {
  id: 'classic-forest',
  name: '现有的树林',
  desc: '奇幻羊皮现有的树冠画法。',
  draw(T, o, out) {
    for (const sp of T.spots) out.item(sp.y, (pen) => drawTreeGlyph(pen, CLASSIC_KIND[sp.kind], sp.x, sp.y, sp.s, sp.seed, o, T.k))
  },
}
export const classicTree: SymbolStyle = {
  id: 'classic-tree',
  name: '现有的散树',
  desc: '奇幻羊皮现有的树冠画法。',
  draw(T, o, out) {
    for (const t of T.trees) {
      out.item(t.y, (pen) => clump(t.n, t.seed).forEach(([dx, dy], i) => drawTreeGlyph(pen, CLASSIC_KIND[t.kind], t.x + dx * t.s, t.y + dy * t.s, t.s, t.seed + i * 131, o, T.k)))
    }
  },
}

// ———————————————————————— 山水风格 ————————————————————————

/** 山水的符号配色：墨为主，林木是极淡的花青绿，背光处一点赭石。paper 不比宣纸亮（山体另按底图取色，见 groundTone） */
export const SHANSHUI_GLYPHS: GlyphColors = {
  ink: '#2b2a27',
  paper: 'rgb(230, 222, 200)',
  shadow: 'rgb(198, 178, 144)',
  snow: 'rgb(236, 230, 214)',
  leaf: 'rgb(170, 178, 156)',
  leafDark: 'rgb(96, 108, 92)',
  pine: 'rgb(152, 162, 150)',
  pineDark: 'rgb(68, 82, 78)',
  grass: 'rgb(92, 94, 72)',
}

/** 宣纸底图的颜色（底图与山体的底色共用） */
const SILK = hex('#e7dfca')
const LAND = hex('#ece5d1')
const OCHRE: RGB = [176, 138, 98]
/** 山地的赭石：在这几档高度（km）上各叠一层 */
const OCHRE_LEVELS = [1.3, 2.2, 3.2]
const OCHRE_ALPHA = 0.07
const BIOME_ALPHA = 0.32
const TINT: Record<number, RGB> = (() => {
  const t: Record<number, RGB> = {}
  for (let b = 0; b <= 17; b++) t[b] = LAND
  for (const b of FOREST) t[b] = hex('#bcc6ae')
  t[Biome.Grassland] = hex('#dfddbf')
  t[Biome.Savanna] = hex('#e2d6b0')
  t[Biome.HotDesert] = hex('#e4d2aa')
  t[Biome.ColdDesert] = hex('#dfd4b8')
  t[Biome.Shrubland] = hex('#ddd4b2')
  t[Biome.Wetland] = hex('#c5cdba')
  return t
})()

/** 宣纸底图：水面留白、近岸几道淡花青与水纹线；陆地只有极淡的设色，山地一点赭石，海岸是一道干笔 */
export const shanshuiVector: VectorDraw = (L: Layers, world: World, F: VectorFields) => {
  const INK = 'rgb(43,42,39)'
  L.rect(rgb(SILK))
  for (const [d, a] of [[30, 0.05], [16, 0.07], [7, 0.09], [2.5, 0.1]] as const) L.fill(world.coastDist, -d, 'rgb(116,140,150)', a)
  ripples(L, world, [2.2, 4.8, 7.8], 'rgb(66,82,90)', [0.34, 0.22, 0.12], 0.6)
  L.fill(F.ice, 0, 'rgb(246,244,238)')
  L.fill(F.land, 0, rgb(LAND))
  biomeLayers(L, world, TINT, BIOME_ALPHA)
  for (const lv of OCHRE_LEVELS) L.fill(F.land, lv, rgb(OCHRE), OCHRE_ALPHA, { filter: 'brush' })
  hillshade(L, F, INK, 0.05, 0, { filter: 'brush' })
  L.fill(F.lake, 0.5, 'rgb(224,224,214)', 1, { stroke: { color: INK, width: 0.9, alpha: 0.9 } })
  L.line(F.land, 0, INK, 1.7, 0.9, undefined, { filter: 'brush' })
}

/**
 * 山体的底色：按山脚处的群系与海拔，照底图的叠法算出那里的纸色，再压深一点（山体是纸，不比纸亮；略深才压得住后面的笔）
 */
export function groundTone(T: Terrain, x: number, y: number): string {
  const { W, H, S, biome } = T.input
  const gx = Math.min(W - 1, Math.max(0, Math.round(x / S - 0.5)))
  const gy = Math.min(H - 1, Math.max(0, Math.round(y / S - 0.5)))
  const e = T.elevAt(x, y)
  const tint = TINT[biome[gy * W + gx]] ?? LAND
  const c = LAND.map((v, i) => v + (tint[i] - v) * BIOME_ALPHA)
  for (const lv of OCHRE_LEVELS) if (e > lv) for (let i = 0; i < 3; i++) c[i] += (OCHRE[i] - c[i]) * OCHRE_ALPHA
  // 再压深：约等于底图上晕渲的阴影最深处（hillshade 0.05 的墨）——山体不比它四周任何一处的纸亮
  return `rgb(${c.map((v) => Math.round(v * 0.955)).join(',')})`
}

/**
 * 山水式的平铺笔触：舆图里平地大多不着笔，只给两类地面一点记号——
 * 沼泽是两三道长短不一的淡墨横笔（偶有一两根芦苇），沙地（热荒漠、冷荒漠、盐滩）是稀疏的淡墨点，热荒漠偶有一道沙脊的弧。
 * 草原、灌丛、苔原留白：这些群系在底图上已有设色，再撒草丛的短笔会和点叶、墨点树抢，平地留白才衬得出山与林
 */
export function shanshuiFlat(ctx: CanvasRenderingContext2D, f: Fields, o: GlyphColors, k: number, wet: (i: number) => boolean) {
  const { world, S, W, H } = f
  const e = world.elevation
  const bio = world.biome
  const pen = ctx as unknown as Pen
  const pale = mixColor(o.ink, o.paper, 0.45)
  // 沼泽
  pen.beginPath()
  const reeds: P[] = []
  for (let y = 2; y < H - 2; y += 3) {
    for (let x = 2 + (y % 2) * 2; x < W - 2; x += 4) {
      if (bio[y * W + x] !== Biome.Wetland || hash(x * 3, y * 7) > 0.45) continue
      const px = (x + (hash(x + 7, y) - 0.5) * 2.4) * S
      const py = (y + (hash(x, y + 7) - 0.5) * 2.4) * S
      const n = 2 + (hash(x, y * 3) > 0.6 ? 1 : 0)
      for (let j = 0; j < n; j++) {
        const len = (3.2 + hash(x * 5 + j, y) * 3.2) * (1 - j * 0.22) * k
        const ox = px + (hash(x + j, y * 5) - 0.5) * 2 * k
        const oy = py + j * 1.5 * k
        addTaper(pen, [[ox - len, oy], [ox, oy - 0.15 * k], [ox + len, oy + 0.1 * k]], (u) => (0.2 + 0.55 * Math.sin(Math.PI * Math.min(1, u * 1.2))) * k)
      }
      if (hash(x * 9, y) < 0.35) reeds.push([px + (hash(x, y * 9) - 0.5) * 3 * k, py - 0.3 * k])
    }
  }
  pen.fillStyle = pale
  pen.globalAlpha = 0.85
  pen.fill()
  pen.beginPath()
  for (const [rx, ry] of reeds) {
    for (const a of [-0.25, 0.12]) addTaper(pen, [[rx + a * 2 * k, ry], [rx + a * 5 * k, ry - 3.4 * k]], (u) => (0.5 - 0.4 * u) * k)
  }
  pen.fillStyle = pale
  pen.fill()
  // 沙地的点
  pen.beginPath()
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const b = bio[i]
      const p = b === Biome.HotDesert ? 0.16 : b === Biome.ColdDesert ? 0.1 : b === Biome.SaltFlat ? 0.07 : 0
      if (!p || e[i] <= 0.01 || wet(i)) continue
      // 疏密成片
      const q = p * (0.4 + 1.4 * fnoise(x * S, y * S, 40 * k))
      if (hash(x * 3, y * 5) > q) continue
      const r = (0.32 + hash(x, y * 3) * 0.3) * k
      addDab(pen, (x + hash(x + 1, y * 2) - 0.5) * S, (y + hash(x * 2, y + 1) - 0.5) * S, r * 2.4, r * 1.6, hash(x, y) * 3)
    }
  }
  pen.fillStyle = pale
  pen.globalAlpha = 0.7
  pen.fill()
  // 热荒漠的沙脊：一道很长、很淡、中间略粗的弧
  pen.beginPath()
  for (let y = 4; y < H - 4; y += 7) {
    for (let x = 4 + (y % 14 ? 4 : 0); x < W - 4; x += 9) {
      if (bio[y * W + x] !== Biome.HotDesert || hash(x * 7, y * 3) > 0.4) continue
      const px = (x + (hash(x + 3, y) - 0.5) * 3) * S
      const py = (y + (hash(x, y + 3) - 0.5) * 3) * S
      const s = (6 + hash(x, y) * 5) * k
      const lean = (hash(x * 5, y) - 0.5) * 0.4
      addTaper(pen, [[px - s, py + s * (0.12 + lean * 0.3)], [px - s * 0.2, py - s * 0.22], [px + s * 0.5, py - s * 0.1], [px + s, py + s * (0.1 - lean * 0.3)]], (u) => (0.15 + 0.6 * Math.sin(Math.PI * u)) * k)
    }
  }
  pen.fillStyle = pale
  pen.globalAlpha = 0.55
  pen.fill()
  pen.globalAlpha = 1
}

/**
 * 山水风格：以现有的水墨风格为底（沿用它的图框、图名、注记字体与政区配色），换上宣纸底图与连嶂、点叶、墨点树、山水式的平铺笔触。
 * base 由调用方给（render 层不引用插件的内容）
 */
export function shanshuiTheme(base: Theme): Theme {
  return {
    ...base,
    id: 'shanshui',
    name: '山水',
    desc: '连嶂 · 点叶 · 墨点树',
    paper: SILK,
    ink: '#2b2a27',
    vector: () => Promise.resolve(shanshuiVector),
    river: { color: 'rgba(52, 66, 74, 0.8)', width: 0.85, minFlow: 2.2, fitCoast: true },
    roads: { color: 'rgba(43, 42, 39, 0.7)', width: 0.95, dash: [3, 2.5], sea: 'rgba(43, 42, 39, 0.4)', seaDash: [2, 4] },
    glyphs: SHANSHUI_GLYPHS,
    glyphDraw: kitDrawer({ mountain: makeLianzhang({ ground: groundTone }), forest: dianye, tree: inkTrees }, { flat: shanshuiFlat }),
    aged: false,
    // 注记的晕底用不透明的纸色：山脉名压在皴笔与山脊上也读得出；山脉名用正墨
    labels: { ...base.labels, range: '#24231f', halo: 'rgba(232, 225, 205, 0.92)' },
  }
}
