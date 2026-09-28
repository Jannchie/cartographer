import { FEATURE, FUNCTIONS, type FeatureId } from '../../settlement/features'
import { PLAN_INFO } from '../../settlement/plans'
import { CULTURES } from '../../settlement/culture'
import { SETTLE_THEMES, type SettleStyleId } from '../../settlement/themes'
import { DEFAULT_SETTLEMENT, type SettlementParams } from '../../settlement/types'

/**
 * 聚落参数 ⇄ URL 查询串（#/settlement?seed=...）。
 * 种子总是写上；其余只写与 DEFAULT_SETTLEMENT 不同的参数：
 * 布尔写 1 / 0，方向（弧度）为 NaN（随机）时不写，
 * 手动的要素数量写成 n.<要素>=数量，继承自世界的气候写 temp / rain / biome，地图风格写 style。
 * 规模档位 size 由人口推出，不写。
 */
const SKIP = new Set<keyof SettlementParams>(['size', 'counts', 'climate'])
const ENUMS: Partial<Record<keyof SettlementParams, readonly unknown[]>> = {
  culture: CULTURES,
  magic: [0, 1, 2],
  walls: ['auto', 'none', 'palisade', 'stone'],
  function: FUNCTIONS.map((f) => f.id),
  plan: PLAN_INFO.map((f) => f.id),
}
const DEF = DEFAULT_SETTLEMENT as unknown as Record<string, unknown>

/** 数值保留到四位小数（气候两位）：写进地址的值与生成用的值完全一致，刷新得到同一座聚落 */
export function roundParams(p: SettlementParams) {
  const r = (v: number, d = 4) => (Number.isFinite(v) ? +v.toFixed(d) : v)
  for (const k of ['population', 'regularity', 'radial', 'spread', 'relief', 'farmland', 'coastDir', 'riverDir', 'hillDir'] as const) p[k] = r(p[k])
  if (p.planStrength !== undefined) p.planStrength = r(p.planStrength)
  if (p.climate) p.climate = { temp: r(p.climate.temp, 2), rain: r(p.climate.rain, 2), biome: p.climate.biome }
}

export function encodeSettlement(p: SettlementParams, style: SettleStyleId) {
  const q = new URLSearchParams()
  const P = p as unknown as Record<string, unknown>
  for (const k of Object.keys(DEFAULT_SETTLEMENT) as (keyof SettlementParams)[]) {
    if (SKIP.has(k)) continue
    const v = P[k]
    if (k !== 'seed' && Object.is(v, DEF[k])) continue
    if (typeof v === 'number') {
      if (!Number.isNaN(v)) q.set(k, String(v))
    } else if (typeof v === 'boolean') q.set(k, v ? '1' : '0')
    else if (typeof v === 'string') q.set(k, v)
  }
  // 继承自世界的名字（不在默认参数里）
  if (p.name) q.set('name', p.name)
  if (p.nameZh) q.set('nameZh', p.nameZh)
  if (p.nameJa) q.set('nameJa', p.nameJa)
  if (p.climate) {
    q.set('temp', String(p.climate.temp))
    q.set('rain', String(p.climate.rain))
    q.set('biome', String(p.climate.biome))
  }
  for (const [id, n] of Object.entries(p.counts)) if (n !== null && n !== undefined) q.set(`n.${id}`, String(n))
  if (style !== 'parchment') q.set('style', style)
  return q
}

/** 解析查询串：只返回合法的参数，缺的由调用方用默认值补 */
export function decodeSettlement(q: URLSearchParams): { params: Partial<SettlementParams>; style?: SettleStyleId } {
  const out: Record<string, unknown> = {}
  const counts: Partial<Record<FeatureId, number>> = {}
  let style: SettleStyleId | undefined
  for (const [k, v] of q) {
    if (k.startsWith('n.')) {
      const id = k.slice(2)
      const n = Math.round(Number(v))
      if (id in FEATURE && v !== '' && Number.isFinite(n) && n >= 0) counts[id as FeatureId] = n
      continue
    }
    if (k === 'style') {
      if (SETTLE_THEMES.some((th) => th.id === v)) style = v as SettleStyleId
      continue
    }
    if (k === 'name' || k === 'nameZh' || k === 'nameJa') {
      if (v) out[k] = v
      continue
    }
    if (!(k in DEF) || SKIP.has(k as keyof SettlementParams)) continue
    const d = DEF[k]
    let x: unknown = v
    if (typeof d === 'number') {
      x = Number(v)
      if (v === '' || !Number.isFinite(x)) continue
    } else if (typeof d === 'boolean') x = v === '1' || v === 'true'
    const allowed = ENUMS[k as keyof SettlementParams]
    if (allowed && !allowed.includes(x)) continue
    out[k] = x
  }
  const temp = Number(q.get('temp'))
  const rain = Number(q.get('rain'))
  const biome = Number(q.get('biome'))
  if (q.has('temp') && q.has('rain') && q.has('biome') && [temp, rain, biome].every(Number.isFinite)) out.climate = { temp, rain, biome }
  if (typeof out.seed === 'string') out.seed = out.seed.trim() || undefined
  if (out.seed === undefined) delete out.seed
  if (typeof out.population === 'number') out.population = Math.max(1, Math.round(out.population))
  out.counts = counts
  return { params: out as Partial<SettlementParams>, style }
}
