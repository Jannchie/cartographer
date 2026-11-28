/**
 * 【实验】符号套原型：山、森林、散树的多种画法，供比较挑选，尚未接入任何纸图风格。
 *
 * 现有的奇幻羊皮符号在 ../glyphs.ts，这里不改它。本目录的结构：
 * - terrain.ts   地物结构分析（山链、丘陵、林地、散树），与画法无关；
 * - brush.ts     笔画工具（有粗细的一笔、墨点、圆团……），只用 Pen 接口；
 * - mountains.ts / forests.ts / trees.ts   各类的画法（SymbolStyle），每种画法自己处理不同规模；
 * - 本文件       画法的接口与把一套画法（SymbolKit）画到纸图上的驱动。
 *
 * 定稿后的方向：SymbolKit 做成扩展点（纸图风格按 id 引用），见任务报告里的接入方案。
 */
import type { Fields } from '../fields'
import { GlyphBatch, type Pen } from '../glyphBatch'
import { flatMarks, type GlyphColors } from '../glyphs'
import { riverThreshold } from '../../../gen/hydrology'
import { analyzeTerrain, type Terrain, type TerrainInput } from './terrain'

export type { Terrain, TerrainInput }

/** 画法往外交笔画的口子 */
export interface SymbolOut {
  /** 平铺在最底层的笔（不参与遮挡），按交出的先后画 */
  under(draw: (pen: Pen) => void): void
  /** 参与遮挡的符号：按底边纵坐标 y 从后（北）往前（南）画，前面的盖住后面的 */
  item(y: number, draw: (pen: Pen) => void): void
}

/** 一类地物的一种画法 */
export interface SymbolStyle {
  id: string
  /** 中文名 */
  name: string
  /** 设计意图 */
  desc: string
  draw(T: Terrain, o: GlyphColors, out: SymbolOut): void
}

/** 一套画法：山（含丘陵）、森林、散树各取一种；缺的那类不画 */
export interface SymbolKit {
  mountain?: SymbolStyle
  forest?: SymbolStyle
  tree?: SymbolStyle
}

/** 只留下与 bounds（像素，x0 y0 x1 y1）相交的地物：比较图只画一小块时用 */
function cropTerrain(T: Terrain, b: [number, number, number, number]): Terrain {
  const pad = 60 * T.k
  const inb = (x: number, y: number) => x > b[0] - pad && x < b[2] + pad && y > b[1] - pad && y < b[3] + pad
  return {
    ...T,
    peaks: T.peaks.filter((p) => inb(p.x, p.y)),
    chains: T.chains.filter((c) => c.nodes.some((p) => inb(p.x, p.y))),
    hills: T.hills.filter((p) => inb(p.x, p.y)),
    spots: T.spots.filter((p) => inb(p.x, p.y)),
    trees: T.trees.filter((p) => inb(p.x, p.y)),
    rings: T.rings.filter((r) => r.pts.some((p) => inb(p[0], p[1]))),
  }
}

/** 把一套画法画到 ctx 上（地图像素坐标） */
export function drawKit(ctx: CanvasRenderingContext2D, T: Terrain, o: GlyphColors, kit: SymbolKit, bounds?: [number, number, number, number]) {
  if (bounds) T = cropTerrain(T, bounds)
  const under: ((pen: Pen) => void)[] = []
  const items: { y: number; n: number; draw: (pen: Pen) => void }[] = []
  const out: SymbolOut = {
    under: (draw) => under.push(draw),
    item: (y, draw) => items.push({ y, n: items.length, draw }),
  }
  kit.mountain?.draw(T, o, out)
  kit.forest?.draw(T, o, out)
  kit.tree?.draw(T, o, out)
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const flat = new GlyphBatch(ctx)
  for (const draw of under) {
    flat.begin()
    draw(flat)
  }
  flat.flush(ctx, Infinity)
  items.sort((a, b) => a.y - b.y || a.n - b.n)
  const pen = new GlyphBatch(ctx)
  for (const it of items) {
    pen.begin()
    it.draw(pen)
  }
  pen.flush(ctx, 64 * T.k)
  ctx.restore()
}

const terrainCache = new WeakMap<object, Terrain>()
/** 世界的地物结构（按世界缓存；换缩放比时重算） */
export function terrainOf(f: Fields): Terrain {
  let T = terrainCache.get(f.world)
  if (!T || T.input.S !== f.S) {
    const { W, H, elevation, biome, flow } = f.world
    T = analyzeTerrain({ W, H, S: f.S, elevation, biome, flow })
    terrainCache.set(f.world, T)
  }
  return T
}

/**
 * 纸图上的符号层：草丛、沙丘、沼泽这些平铺笔触沿用现有画法，山、森林、散树换成 kit。
 * 返回值与 drawGlyphs 同形，可填进 Theme.glyphDraw（实验用的口子）
 */
export function kitDrawer(
  kit: SymbolKit,
  opts: {
    /** 草丛、沙丘、沼泽这些平铺笔触：不给或 true 用现有画法，false 不画，给函数就用它（参数同 flatMarks） */
    flat?: boolean | typeof flatMarks
  } = {},
) {
  return (ctx: CanvasRenderingContext2D, f: Fields, o: GlyphColors) => {
    if (opts.flat !== false) {
      const k = f.S / 2
      const thr = riverThreshold(f.W) * 0.5
      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ;(typeof opts.flat === 'function' ? opts.flat : flatMarks)(ctx, f, o, k, (i) => f.world.flow[i] > thr)
      ctx.restore()
    }
    drawKit(ctx, terrainOf(f), o, kit)
  }
}
