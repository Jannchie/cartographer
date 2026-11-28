import { Biome, type World } from '../../../gen/types'
import { ATLAS, atlasSea, hex, ramp, type RGB } from '../../../render/palette'
import type { AtlasOpts } from '../../../render/atlas/styles'
import { biomeField, biomeLayers, FOREST, hillshade, ripples, type Layers, type VectorFields } from '../../../render/atlas/svg/layers'
import { rgb } from '../../../render/palette'
import { FANTASY_COLORS, FANTASY_TINT, HYPSO, POLITICAL_LAND, POLITICAL_SEA, STRATEGY_SEA, STRATEGY_SHALLOW, TEYVAT, TEYVAT_STEP, TEYVAT_TINT, teyvatReach } from './pixel'

/**
 * 八种内置纸图风格的矢量底图（Theme.vector）：与 ./pixel.ts 的位图着色一一对应，用图层工具（render/atlas/svg/layers.ts）
 * 把同样的底色、色带、晕渲与线划画成矢量图层。政区地图集与战略图返回一个函数，留到政区着色之后再画晕渲、湖泊与海岸线。
 */

// —————————————————————————— 各风格的矢量底图 ——————————————————————————

export function physical(L: Layers, world: World, F: VectorFields, opts: AtlasOpts) {
  L.rect(rgb(atlasSea(0.1)))
  const levels = [0.2, 1, 2, 3.2, 4.2]
  for (const lv of levels) L.fill(F.depth, lv, rgb(atlasSea(lv + 0.3)))
  for (const lv of levels) L.line(F.depth, lv, 'rgb(88,106,120)', 0.8, 0.16)
  L.fill(F.ice, 0, 'rgb(236,240,239)')
  ripples(L, world, [2.25, 4.75, 8, 12.5], 'rgb(70,104,120)', [0.34, 0.22, 0.13, 0.07], 0.75)
  L.fill(F.land, 0, rgb(ATLAS[Biome.Grassland]))
  biomeLayers(L, world, ATLAS, 1)
  for (const [lv, op] of [[1.5, 0.15], [2.5, 0.18], [3.5, 0.2]] as const) L.fill(F.land, lv, 'rgb(216,204,186)', op)
  hillshade(L, F, 'rgb(45,38,30)', 0.11, 0.1)
  if (opts.contours) for (let lv = 0.5; lv < 9; lv += 0.5) L.line(F.land, lv, 'rgb(120,96,70)', 0.8, lv % 1 === 0 ? 0.22 : 0.12)
  L.fill(F.lake, 0.5, rgb(ATLAS[Biome.Lake]), 1, { stroke: { color: 'rgb(78,106,130)', width: 0.9, alpha: 0.8 } })
  L.line(F.land, 0, 'rgb(58,66,70)', 1.7, 0.92)
}

export function fantasy(L: Layers, world: World, F: VectorFields) {
  const C = FANTASY_COLORS
  const SEPIA = rgb(C.sepia)
  const N = world.W * world.H
  // 海：近纸色，近岸几层铜绿水彩叠出由浓到淡的晕
  L.rect(rgb(C.sea))
  for (const [d, a] of [[60, 0.05], [34, 0.1], [20, 0.14], [11, 0.16], [5, 0.16]] as const) L.fill(world.coastDist, -d, rgb(C.seaWash), a)
  L.fill(F.ice, 0, 'rgb(240,232,210)')
  ripples(L, world, [1.75, 3.5, 5.5, 8, 11], SEPIA, [0.36, 0.3, 0.23, 0.16, 0.1], 0.75)
  // 陆：群系淡彩 + 高地棕晕 + 沿岸赭石色带
  L.fill(F.land, 0, rgb(hex('#ecdcb3')))
  biomeLayers(L, world, FANTASY_TINT, 0.6)
  for (const lv of [1.3, 2.3]) L.fill(F.land, lv, rgb(C.mountainWash), 0.07)
  const band = new Float32Array(N)
  for (let i = 0; i < N; i++) band[i] = world.elevation[i] > 0 ? -world.coastDist[i] : -99
  for (const d of [4, 2.5, 1.2]) L.fill(band, -d, rgb(C.coastWash), 0.14)
  hillshade(L, F, SEPIA, 0.045, 0.07)
  L.fill(F.lake, 0.5, rgb(C.lake), 1, { stroke: { color: SEPIA, width: 1.4, alpha: 1 } })
  L.line(F.land, 0, SEPIA, 2.6, 0.95)
}

export function nautical(L: Layers, world: World, F: VectorFields) {
  const N = world.W * world.H
  L.rect('rgb(244,241,232)')
  // 浅海分层：越浅越蓝
  const shallow = new Float32Array(N)
  for (let i = 0; i < N; i++) shallow[i] = world.elevation[i] <= 0 ? world.elevation[i] : -9
  for (const [lv, c] of [[-0.2, '#e3eff2'], [-0.05, '#cde4ee'], [-0.02, '#b3d6e6'], [-0.01, '#9fcbe0']] as const) L.fill(shallow, lv, c)
  for (const lv of [0.01, 0.02]) L.line(F.depth, lv, 'rgb(60,120,170)', 0.7, 0.55, [4, 4])
  for (const lv of [0.05, 0.2, 1]) L.line(F.depth, lv, 'rgb(60,120,170)', 0.8, 0.5)
  L.fill(F.ice, 0, 'rgb(250,250,250)')
  L.fill(F.land, 0, 'rgb(235,220,180)')
  // 海岸内侧加深的色带
  const band = new Float32Array(N)
  for (let i = 0; i < N; i++) band[i] = world.elevation[i] > 0 ? -world.coastDist[i] : -99
  for (const d of [3, 1.5]) L.fill(band, -d, 'rgb(214,190,140)', 0.35)
  hillshade(L, F, 'rgb(60,50,40)', 0.06, 0.06)
  L.fill(F.lake, 0.5, '#c7e0ea', 1, { stroke: { color: 'rgb(40,60,80)', width: 0.9, alpha: 1 } })
  L.line(F.land, 0, 'rgb(30,30,30)', 1.9, 0.92)
}

export function teyvat(L: Layers, world: World, F: VectorFields, S: number) {
  const C = TEYVAT
  const N = world.W * world.H
  const cd = world.coastDist
  // 虚空 → 探索区域（圆润的一整团，外侧泛青色辉光）→ 近岸渐亮的青绿水
  const reach = teyvatReach(world)
  const inner = new Float32Array(N)
  for (let i = 0; i < N; i++) inner[i] = -reach[i]
  // 虚空里零星的星点：可平铺的小图案
  const k = S / 2
  const T = 180 * k
  const stars = Array.from({ length: 14 }, (_, i) => [((i * 97 + 31) % 180) * k, ((i * 61 + 17) % 180) * k, (0.4 + ((i * 7) % 5) * 0.15) * k])
  L.list.patterns.set('stars', {
    w: T,
    h: T,
    svg: stars.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${rgb(C.star)}" fill-opacity="0.55"/>`).join(''),
    tile: () => {
      const c = document.createElement('canvas')
      c.width = c.height = Math.round(T * 2)
      const g = c.getContext('2d')!
      g.scale(2, 2)
      g.fillStyle = rgb(C.star)
      g.globalAlpha = 0.55
      for (const [x, y, r] of stars) {
        g.beginPath()
        g.arc(x, y, r, 0, Math.PI * 2)
        g.fill()
      }
      return c
    },
  })
  L.rect('url(#stars)')
  for (const [d, a] of [[6, 0.1], [3, 0.16]] as const) L.fill(inner, -d, rgb(C.sea), a, { tol: 0.6, minArea: 4 })
  // 边界亮线复用这一层追踪出的轮廓
  const region = L.fill(inner, 0, rgb(C.deep), 1, { tol: 0.6, minArea: 4 })
  for (const d of [18, 13, 9, 6]) L.fill(cd, -d, rgb(C.sea), 0.22)
  for (const d of [4, 2.5, 1.5]) L.fill(cd, -d, rgb(C.shallow), 0.22)
  L.fill(F.ice, 0, rgb(C.ice))
  L.list.path('map', region, { stroke: { color: rgb(C.edge), alpha: 0.9, width: 1.6, cap: 'round', join: 'round' } })
  // 陆：群系平涂 + 台地（越高越偏土黄）+ 崖线
  L.fill(F.land, 0, rgb(TEYVAT_TINT[Biome.Grassland]))
  biomeLayers(L, world, TEYVAT_TINT, 1)
  for (let lv = TEYVAT_STEP; lv < 2.6; lv += TEYVAT_STEP) L.fill(F.land, lv, rgb(C.plateau), 0.05, { tol: 0.45, minArea: 2 })
  L.fill(F.land, 2.9, rgb(C.rock), 0.7)
  L.fill(F.snow, 0.5, rgb(C.snow))
  // 卡通分层的明暗
  L.fill(F.dark, 0.08, rgb(C.toonDark), 0.1, { tol: 0.5, minArea: 3 })
  L.fill(F.dark, 0.2, rgb(C.toonDark), 0.12, { tol: 0.5, minArea: 3 })
  L.fill(F.light, 0.04, rgb(C.toonLight), 0.08, { tol: 0.5, minArea: 3 })
  // 崖线：只有陡处的台地边缘明显（坡度调制透明度在矢量里做不到，改用较淡的线 + 只画较高的台阶）
  for (let lv = TEYVAT_STEP * 2; lv < 4; lv += TEYVAT_STEP) L.line(F.land, lv, rgb(C.cliff), 1, 0.35, undefined, { tol: 0.45 })
  L.fill(F.lake, 0.5, rgb(C.lake), 1, { stroke: { color: rgb(C.coast), width: 0.9, alpha: 0.8 } })
  L.line(F.land, 0, rgb(C.coast), 1.4, 0.7)
}

export function ink(L: Layers, world: World, F: VectorFields, S: number) {
  const k = S / 2
  const RICE = hex('#ede6d3')
  const INK = 'rgb(43,42,39)'
  L.rect(rgb(RICE))
  // 鱼鳞水波：图案填满海面
  const pw = 36 * k
  const ph = 9 * k
  const wave = `M0 ${4.5 * k} Q${9 * k} ${1.5 * k} ${18 * k} ${4.5 * k} T${36 * k} ${4.5 * k}`
  L.list.patterns.set('waves', {
    w: pw,
    h: ph,
    svg: `<path d="${wave}" fill="none" stroke="rgb(110,120,120)" stroke-width="${0.7 * k}" stroke-opacity="0.18"/>`,
    tile: () => {
      const c = document.createElement('canvas')
      c.width = Math.round(pw * 4)
      c.height = Math.round(ph * 4)
      const g = c.getContext('2d')!
      g.scale(4, 4)
      g.strokeStyle = 'rgba(110,120,120,0.18)'
      g.lineWidth = 0.7 * k
      g.stroke(new Path2D(wave))
      return c
    },
  })
  L.fill(F.depth, 0, 'url(#waves)')
  for (const d of [16, 8, 3]) L.fill(world.coastDist, -d, 'rgb(150,160,158)', 0.1)
  L.fill(F.ice, 0, 'rgb(245,243,236)')
  L.fill(F.land, 0, rgb(RICE))
  const tint: Record<number, RGB> = {}
  for (let b = 0; b <= 17; b++) tint[b] = RICE
  for (const b of FOREST) tint[b] = hex('#a9b89c')
  tint[Biome.Grassland] = hex('#cfcfab')
  tint[Biome.Savanna] = hex('#d6caa0')
  tint[Biome.HotDesert] = hex('#dcc79e')
  tint[Biome.ColdDesert] = hex('#d5c8ab')
  tint[Biome.Shrubland] = hex('#d2c7a3')
  tint[Biome.Wetland] = hex('#b7c1ad')
  biomeLayers(L, world, tint, 0.42)
  for (const lv of [1.8, 2.8]) L.fill(F.land, lv, 'rgb(110,140,138)', 0.14)
  // 皴擦：分级墨色 + 湍流位移，让边缘像干笔
  for (const lv of [1.5, 2.5, 3.5]) L.fill(F.land, lv, INK, 0.05, { filter: 'brush' })
  hillshade(L, F, INK, 0.13, 0, { filter: 'brush' })
  L.fill(F.snow, 0, rgb(RICE), 0.6)
  L.fill(F.lake, 0.5, 'rgb(218,216,204)', 1, { stroke: { color: INK, width: 1.1, alpha: 1 } })
  L.line(F.land, 0, INK, 2.2, 0.9, undefined, { filter: 'brush' })
}

export function topo(L: Layers, world: World, F: VectorFields) {
  L.rect('#d6e8ef')
  for (const lv of [0.2, 1, 2, 3, 4]) L.line(F.depth, lv, 'rgb(80,140,185)', 0.8, 0.45)
  L.fill(F.ice, 0, 'rgb(248,250,252)')
  L.fill(F.land, 0, rgb(ramp(HYPSO, 0.1)))
  for (let lv = 0.25; lv < 6.5; lv += 0.25) L.fill(F.land, lv, rgb(ramp(HYPSO, lv + 0.12)), 1, { tol: 0.4, minArea: 2 })
  L.fill(biomeField(world, 'forest', (b) => FOREST.has(b)), 0.5, 'rgb(196,222,180)', 0.7, { tol: 0.4, minArea: 3 })
  L.fill(F.snow, 1, 'rgb(248,250,252)')
  hillshade(L, F, 'rgb(40,40,40)', 0.07, 0.1)
  for (let lv = 0.1; lv < 9; lv += 0.1) {
    const major = Math.abs(lv / 0.5 - Math.round(lv / 0.5)) < 1e-6
    L.line(F.land, lv, 'rgb(165,105,60)', major ? 1.1 : 0.55, major ? 0.7 : 0.38, undefined, { tol: 0.45 })
  }
  L.fill(F.lake, 0.5, '#cfe4ee', 1, { stroke: { color: 'rgb(60,120,170)', width: 0.9, alpha: 1 } })
  L.line(F.land, 0, 'rgb(50,110,160)', 1.4, 0.95)
}

/** 政区地图集：浅蓝海、近白陆地，色块之上再叠淡晕渲、湖泊与海岸线 */
export function politicalAtlas(L: Layers, world: World, F: VectorFields) {
  L.rect(rgb(POLITICAL_SEA))
  L.fill(F.depth, 2.5, 'rgb(186,210,221)', 0.35, { tol: 0.6, minArea: 6 })
  L.fill(F.ice, 0, 'rgb(240,244,245)')
  ripples(L, world, [1.25, 2.75, 4.75], 'rgb(80,120,140)', [0.3, 0.18, 0.09], 0.7)
  L.fill(F.land, 0, rgb(POLITICAL_LAND))
  return () => {
    hillshade(L, F, 'rgb(40,32,36)', 0.075, 0.12)
    L.fill(F.lake, 0.5, rgb(POLITICAL_SEA), 1, { stroke: { color: 'rgb(70,100,120)', width: 0.8, alpha: 0.8 } })
    L.line(F.land, 0, 'rgb(60,80,95)', 1.3, 0.85)
  }
}

/** 战略图：深青色的海、近岸渐浅；陆地是群系底色加浓重晕渲，纹章色压在中间 */
export function strategy(L: Layers, world: World, F: VectorFields) {
  L.rect(rgb(STRATEGY_SEA))
  for (const [d, a] of [[40, 0.18], [22, 0.22], [12, 0.28], [5, 0.34]] as const) L.fill(world.coastDist, -d, rgb(STRATEGY_SHALLOW), a)
  L.fill(F.ice, 0, 'rgb(214,226,232)')
  ripples(L, world, [1.5, 3.5], 'rgb(190,215,225)', [0.22, 0.1], 0.7)
  L.fill(F.land, 0, rgb(ATLAS[Biome.Grassland]))
  biomeLayers(L, world, ATLAS, 1)
  return () => {
    hillshade(L, F, 'rgb(18,12,8)', 0.2, 0.16)
    for (const [lv, op] of [[2.5, 0.25], [3.5, 0.35]] as const) L.fill(F.land, lv, 'rgb(236,232,222)', op)
    L.fill(F.lake, 0.5, rgb(STRATEGY_SHALLOW), 1, { stroke: { color: 'rgb(16,24,30)', width: 1, alpha: 0.9 } })
    L.line(F.land, 0, 'rgb(12,20,26)', 1.7, 0.95)
  }
}
