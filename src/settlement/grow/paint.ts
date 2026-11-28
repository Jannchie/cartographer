import { boot, eager, type LayerSetup, type PluginManifest } from '../../kernel'
import { SETTLE_THEMES } from '../../packs/cartography/settlement/themes'
import type { CultureDef } from '../culture'
import { registerCultures } from '../register'
import { buildSettlementVector, settlePageScale } from '../../render/settlementMap'
import { SettleThemes } from '../themes'
import type { GrowState } from './api'
import type { GrowDrawOpts, GrowPicture } from './paint-api'
import { toSettlement } from './draw'

// 生长引擎的画图入口（只在浏览器、离线脚本里用）：启动画图要的最少插件，再把生长状态交给聚落图的渲染。
// 不走 src/packs/boot.ts（那会载入全部文明与世界层）：只登记要用的文明和皮肤，插件 id 仍用 classic、cartography。

/** 各文明的定义按需载入（只载入要用的那一种） */
const CULTURES: Record<string, () => Promise<CultureDef>> = {
  western: () => import('../../packs/classic/western').then((m) => m.western),
  eastern: () => import('../../packs/classic/eastern').then((m) => m.eastern),
  wa: () => import('../../packs/classic/wa').then((m) => m.wa),
  islamic: () => import('../../packs/classic/islamic').then((m) => m.islamic),
}

const label = (s: string) => ({ zh: s, en: s, ja: s })
let booted: { cultures: string[]; styles: string[]; ready: Promise<void> } | null = null

export function bootPaint(o: { cultures?: string[]; styles?: string[] } = {}): Promise<void> {
  const want = { cultures: o.cultures ?? ['wa'], styles: o.styles ?? ['color'] }
  if (booted) {
    const missing = [...want.cultures.filter((c) => !booted!.cultures.includes(c)), ...want.styles.filter((s) => !booted!.styles.includes(s))]
    if (missing.length) return Promise.reject(new Error(`画图的插件已经启动过，没有 ${missing.join('、')}（一个运行环境只能启动一次）`))
    return booted.ready
  }
  const ready = (async () => {
    const defs = await Promise.all(want.cultures.map((c) => {
      const load = CULTURES[c]
      if (!load) throw new Error(`没有这种文明：${c}`)
      return load()
    }))
    const themes = want.styles.map((id) => {
      const th = SETTLE_THEMES.find((t) => t.id === id)
      if (!th) throw new Error(`没有这种皮肤：${id}`)
      return th
    })
    const classic: LayerSetup = (host) => registerCultures(host, defs, { default: defs[0].id })
    const cartography: LayerSetup = (host) => themes.forEach((th, i) => host.add(SettleThemes, th.id, th, { default: i === 0 }))
    const manifests: PluginManifest[] = [
      { id: 'classic', name: label('classic'), desc: label('') },
      { id: 'cartography', name: label('cartography'), desc: label('') },
    ]
    await boot({ manifests, enabled: ['classic', 'cartography'], layers: { settlement: { classic: eager(classic), cartography: eager(cartography) } } })
  })()
  booted = { ...want, ready }
  return ready
}

export function drawGrow(state: GrowState, o: GrowDrawOpts, measurer: CanvasRenderingContext2D): GrowPicture {
  const st = toSettlement(state, o)
  const list = buildSettlementVector(st, o.style, { labels: false, contours: true }, measurer)
  return {
    S: settlePageScale(st),
    M: list.M,
    width: list.width,
    height: list.height,
    render: (ctx, scale, ox, oy) => list.render(ctx, scale, ox, oy, 'map'),
    toSVG: () => list.toSVG(),
  }
}
