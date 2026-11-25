import { cultureOf, planById } from './culture'
import { dice, hashAt, type Ctx } from './ctx'
import { area, centroid, type Poly } from './geom'
import { perHousehold, scaleOf, urbanT } from './scale'
import type { Building, BuildingKind, Culture, Household, Settlement, SettlementParams, WardType } from './types'
import { dwelling } from './undo'
import * as dmath from '../gen/dmath'

/**
 * 住户：每栋民居里住几户、每户几口人、以什么为生。
 *
 * 户数照旧（见 wards.ts 的 storeys：一两层的房子一户，多层楼房一层一户）；一户的人口随它住的面积与营生：
 * 家人之外，工匠家里有学徒、帮工，商家有伙计，富户有仆役——前工业时代的城里，大宅住二三十口，陋屋三四口。
 * 未成年人随户（户籍按户登记：军户、匠户、町人……），学徒、伙计算进户主的行当，仆役另算一类。
 *
 * 各文明的职业分法不同：中国是士农工商，日本是士農工商（武士在最上），欧洲是教士、贵族、市民、农民，
 * 伊斯兰城市是乌理玛、官宦、巴扎商人与工匠。每类下面再分细的行当。分法（Scheme）登记在文明的定义里（见 culture.ts）。
 */

type Tri = [zh: string, en: string, ja: string]

/** 大类：cls 定人口的构成（家人以外多出来的是学徒伙计，还是仆役） */
export interface Group {
  id: string
  name: Tri
  cls: 'elite' | 'trade' | 'craft' | 'farm' | 'labor' | 'clergy' | 'arms'
}
export interface Trade {
  id: string
  group: string
  name: Tri
}
export interface Scheme {
  groups: Group[]
  trades: Trade[]
  /** 片区（或 rural：零散农家、estate：大宅院）→ 各行当的比重 */
  mix: Partial<Record<WardType | 'rural' | 'estate', Record<string, number>>>
  /** 仆役、雇工归哪一类 */
  servants: string
  /** 城市的职业构成（各大类占人口的比例，仆役雇工一类是其余）：见 targetShares */
  profile: Record<string, number>
}

/** 文明定义里与人口有关的部分 */
export interface CulturePeople {
  scheme: Scheme
  /** 各种专门片区住满时每公顷住多少人（连仆役、学徒） */
  wardDensity: Record<'noble' | 'merchant' | 'craft' | 'slum', number>
  /** 平均一户几口相对每户人数（CultureTraits.perHousehold）的倍数：城区要多大按它把人口折成户数 */
  homeK: number
}

/** 写职业表用：一个行当 */
export const tradeDef = (group: string, id: string, zh: string, en: string, ja: string): Trade => ({ id, group, name: [zh, en, ja] })

const schemeOf = (c: Culture) => cultureOf(c).people.scheme

/** 职业名的三语写法（文化包注册时登记给界面，见 packs/） */
export const schemeStrings = (s: Scheme): Tri[] => [...s.groups, ...s.trades].map((x) => x.name)

/** 各职业表的行当 → 行当与所属大类（每户都要查：第一次用到时建好） */
const TRADE_OF = new Map<Scheme, Map<string, { trade: Trade; group: Group }>>()
function tradeOf(c: Culture, id: string) {
  const sc = schemeOf(c)
  let m = TRADE_OF.get(sc)
  if (!m) TRADE_OF.set(sc, (m = new Map(sc.trades.map((t) => [t.id, { trade: t, group: sc.groups.find((g) => g.id === t.group)! }]))))
  return m.get(id)
}

/** 定职业构成要看的参数 */
type ProfileParams = Pick<SettlementParams, 'culture' | 'population' | 'function' | 'capital' | 'plan'>

/** 片区类型折成行当比重的键：功能片区（市集、行会、交易所……）按相近的算 */
const MIX_KEY: Partial<Record<WardType, WardType>> = { plaza: 'market', exchange: 'merchant', guild: 'craft', warehouse: 'harbor', magic: 'temple', observatory: 'temple', park: 'common', cemetery: 'common', farm: 'suburb', wild: 'suburb' }

/** 家人以外、一户里多出来的人（学徒伙计 / 仆役）按大类的比例：富户仆役多，工匠学徒多 */
const EXTRA: Record<Group['cls'], { k: number; servants: number }> = {
  elite: { k: 1.6, servants: 0.6 },
  trade: { k: 1.35, servants: 0.4 },
  craft: { k: 1.25, servants: 0.15 },
  clergy: { k: 1.1, servants: 0.3 },
  arms: { k: 1, servants: 0 },
  farm: { k: 1.1, servants: 0.2 },
  labor: { k: 0.85, servants: 0 },
}

/** 一户分到的建筑面积（平方米）与口数：约 HOME_AREA 平方米住下一户普通人家（五六口），大宅、窄屋按面积的 0.6 次方增减 */
const HOME_AREA = 70

/**
 * 盖下一栋民居时定它的各户：units 户，每户按位置哈希抽行当（按所在片区的比重），口数按每户分到的面积与行当。
 * 城外村子、宫殿里不算城里人口的（units 为 0）没有住户
 */
export function householdsOf(ctx: Ctx, poly: Poly, units: number, floors: number): Household[] {
  if (units <= 0) return []
  const sc = schemeOf(ctx.p.culture)
  const key: WardType | 'rural' | 'estate' = ctx.estate ? 'estate' : !ctx.wardTown ? 'rural' : (MIX_KEY[ctx.wardType] ?? ctx.wardType)
  const mix = Object.entries(sc.mix[key] ?? sc.mix.common!)
  const ids = mix.map(([id]) => id)
  const weights = mix.map(([, w]) => w)
  const D = dice(ctx, centroid(poly), 'people')
  const base = perHousehold(ctx.p.culture)
  // 三层以上的楼房底层是铺面，楼上一层一户；一两层的独栋整栋一户
  const living = area(poly) * (floors >= 3 ? floors - 1 : floors)
  const per = living / units
  const out: Household[] = []
  for (let u = 0; u < units; u++) {
    const trade = D.pick('trade', ids, weights, u)
    const cls = tradeOf(ctx.p.culture, trade)!.group.cls
    // 东方的大宅：一家人住好几座屋，只有记户的那座算人口，口数按整座宅院（多六成）
    const size = Math.min(4.5, Math.max(0.55, dmath.pow(per / HOME_AREA, 0.6))) * EXTRA[cls].k * (ctx.estate ? 1.6 : 1)
    const people = Math.max(2, Math.round(base * size * (0.85 + 0.3 * D.h('size', u))))
    out.push(MIXED.has(key) ? { trade, people, mixed: true } : { trade, people })
  }
  return out
}

/** 混住的片区：什么营生的人家都有，全城的职业构成按目标校准时只调这些户 */
const MIXED = new Set<string>(['common', 'market', 'harbor', 'suburb', 'rural', 'estate'])

/**
 * 集体户：寺院的僧房、兵营的营房、城堡的厅堂按面积住人（僧众、驻军与官员）。城外村子、宫殿（不算城里人口）不住
 */
const INSTITUTION: Partial<Record<WardType, { cls: Group['cls'][]; m2: number }>> = {
  temple: { cls: ['clergy'], m2: 18 },
  barracks: { cls: ['arms'], m2: 9 },
  castle: { cls: ['arms', 'elite'], m2: 14 },
}
const INST_KINDS = new Set<BuildingKind>(['hall', 'large', 'civic', 'keep', 'house'])
export function institutionOf(ctx: Ctx, poly: Poly, kind: BuildingKind, floors: number): Household[] {
  const inst = INSTITUTION[ctx.wardType]
  if (!inst || ctx.uncounted || !INST_KINDS.has(kind)) return []
  const sc = schemeOf(ctx.p.culture)
  const trades = sc.trades.filter((t) => inst.cls.includes(tradeOf(ctx.p.culture, t.id)!.group.cls))
  if (!trades.length) return []
  const c = centroid(poly)
  const trade = trades[Math.floor(hashAt(ctx, c, 'people.inst') * trades.length)].id
  const people = Math.min(300, Math.round((area(poly) * Math.max(1, floors)) / inst.m2))
  return people >= 2 ? [{ trade, people, inst: true }] : []
}

/**
 * 一栋建筑住的人口：记了各户的（民居、寺院与兵营的集体户）按各户加总；没记的民居（别处直接摆的）按户数乘每户人数，
 * 别的建筑不住人
 */
export function residentsOf(b: Building, culture: Culture) {
  if (b.households) return b.households.reduce((s, h) => s + h.people, 0)
  return dwelling(b) ? (b.units ?? 1) * perHousehold(culture) : 0
}

/**
 * 一座城的职业构成目标（各大类占人口的比例）：村子以农为主，随城镇化（urbanT）连续过渡到这个文明的城市构成；
 * 都城官宦、驻军多，商贸城商人多，手工业城工匠多，要塞驻军多；和风的城下町约一半是武士（江户时代的金泽、仙台、
 * 江户本身都在四五成）。仆役雇工一类是其余
 */
export function targetShares(p: ProfileParams): Map<string, number> {
  const sc = schemeOf(p.culture)
  const RURAL: Record<Group['cls'], number> = { farm: 0.82, craft: 0.06, trade: 0.02, clergy: 0.01, elite: 0.01, arms: 0, labor: 0 }
  const u = urbanT(p.population)
  const out = new Map<string, number>()
  const elite = planById(p.plan)?.eliteShare
  for (const g of sc.groups) {
    if (g.id === sc.servants) continue
    let s = sc.profile[g.id] ?? 0
    const c = g.cls
    if (p.capital && c === 'elite') s *= 2.5
    if (p.capital && c === 'arms') s *= 1.6
    if (p.function === 'trade' && c === 'trade') s += 0.08
    if (p.function === 'craft' && c === 'craft') s += 0.08
    if (p.function === 'fortress' && c === 'arms') s += 0.15
    // 形制自己定的上层占比（城下町约一半是武士）
    if (elite !== undefined && c === 'elite') s = elite
    out.set(g.id, RURAL[c] * (1 - u) + s * u)
  }
  // 各类加起来超过九成时按比例收（仆役雇工至少留一成）
  const sum = [...out.values()].reduce((a, b) => a + b, 0)
  if (sum > 0.9) for (const [k, v] of out) out.set(k, (v * 0.9) / sum)
  out.set(sc.servants, 1 - Math.min(0.9, sum))
  return out
}

/**
 * 专门片区住着这一类人口的几成（其余散住在普通民居片区里：小吏、小商贩、散工……）；兵营住驻军的七成（其余在城堡）
 */
const DEDICATED: Record<'noble' | 'merchant' | 'craft' | 'slum' | 'barracks', { cls: Group['cls']; live: number }> = {
  noble: { cls: 'elite', live: 0.7 },
  merchant: { cls: 'trade', live: 0.5 },
  craft: { cls: 'craft', live: 0.45 },
  slum: { cls: 'labor', live: 0.25 },
  barracks: { cls: 'arms', live: 0.7 },
}
/**
 * 按职业构成要几块某种专门片区：这一类的人口 × 住在专门片区的比例 ÷ 一块这种片区住满的人数
 *（片区面积 × 实测的每公顷人数；兵营按营房约占三成地、每人九平方米）。返回小数，调用方取整
 */
export function wardsFor(p: ProfileParams, type: keyof typeof DEDICATED) {
  const sc = schemeOf(p.culture)
  const d = DEDICATED[type]
  const tg = targetShares(p)
  let share = 0
  for (const g of sc.groups) if (g.cls === d.cls) share += tg.get(g.id) ?? 0
  const patch = scaleOf(p.population).cfg.patch
  const m2 = patch * patch * 0.87
  const cap = type === 'barracks' ? (m2 * 0.3) / 9 : (m2 / 10000) * cultureOf(p.culture).people.wardDensity[type]
  return (share * p.population * d.live) / cap
}

/** 一户在统计里怎么分：家人（连未成年人）与学徒伙计随户主的行当，多出来的人里按大类的比例是仆役 */
function split(culture: Culture, h: Household) {
  const t = tradeOf(culture, h.trade)
  if (!t) return null
  const tr = t.trade
  if (h.inst) return { tr, own: h.people, servants: 0 }
  const family = Math.min(h.people, Math.round(perHousehold(culture)))
  const servants = Math.round((h.people - family) * EXTRA[t.group.cls].servants)
  return { tr, own: h.people - servants, servants }
}

/**
 * 按目标构成校准：片区的块数是整数、各片区里的营生按位置抽，全城加起来与目标总有出入。
 * 只改混住片区（见 MIXED）里的户：比目标多的大类让出几户，改成比目标少的大类里最常见的行当，直到各类贴近目标。
 * 专门的片区（贵族、商人、工匠、贫民、寺院、兵营）不动：比例差得多说明片区块数不对，要在片区数量上改（见 features.ts）
 */
export function calibrateTrades(buildings: Building[], p: ProfileParams) {
  const sc = schemeOf(p.culture)
  const target = targetShares(p)
  const have = new Map<string, number>(sc.groups.map((g) => [g.id, 0]))
  const mixed: Household[] = []
  let total = 0
  for (const b of buildings)
    for (const h of b.households ?? []) {
      const s = split(p.culture, h)
      if (!s) continue
      have.set(s.tr.group, have.get(s.tr.group)! + s.own)
      have.set(sc.servants, have.get(sc.servants)! + s.servants)
      total += h.people
      if (h.mixed) mixed.push(h)
    }
  if (!total) return
  const gap = (g: string) => (target.get(g) ?? 0) * total - have.get(g)!
  // 每类改成它最常见的行当（普通片区里的比重最大的一种，没有就取这一类的第一种）
  const typical = new Map<string, string>()
  for (const g of sc.groups) {
    const inCommon = Object.entries(sc.mix.common ?? {}).filter(([id]) => tradeOf(p.culture, id)?.group === g)
    typical.set(g.id, inCommon.sort((a, b) => b[1] - a[1])[0]?.[0] ?? sc.trades.find((t) => t.group === g.id)!.id)
  }
  // 按口数与行当定的次序（确定性，与建筑的先后无关）
  mixed.sort((a, b) => a.people - b.people || (a.trade < b.trade ? -1 : a.trade > b.trade ? 1 : 0))
  for (const h of mixed) {
    const s = split(p.culture, h)!
    if (gap(s.tr.group) > -s.own / 2) continue
    let to: string | null = null
    for (const g of sc.groups) if (g.id !== s.tr.group && gap(g.id) > s.own / 2 && (!to || gap(g.id) > gap(to))) to = g.id
    if (!to) continue
    h.trade = typical.get(to)!
    have.set(s.tr.group, have.get(s.tr.group)! - s.own)
    have.set(to, have.get(to)! + s.own)
  }
}

/**
 * 平均一户几口（各种大小、营生的户按一座城里常见的比例折算，实测值）：城区要多大按它把人口折成户数
 */
export const perHome = (culture: Culture) => perHousehold(culture) * cultureOf(culture).people.homeK

/** 行当的名字（中文键，界面按语言翻译）与所属大类 */
export function tradeInfo(culture: Culture, id: string) {
  const t = tradeOf(culture, id)
  return t ? { name: t.trade.name[0], group: t.group.name[0] } : null
}

export interface PeopleStat {
  /** 大类的中文名（界面翻译） */
  name: string
  households: number
  people: number
  trades: { name: string; households: number; people: number }[]
}

/**
 * 按职业统计：每户的家人（连未成年人）随户主的行当；学徒、伙计也算进户主的行当，仆役另归杂役一类。
 * 家人按每户人数（perHousehold）算，多出来的按大类的比例分给学徒伙计与仆役
 */
export function peopleStats(st: Settlement): PeopleStat[] {
  const c = st.params.culture
  const sc = schemeOf(c)
  const groups = new Map<string, PeopleStat>(sc.groups.map((g) => [g.id, { name: g.name[0], households: 0, people: 0, trades: [] }]))
  const trade = (gid: string, name: string) => {
    const g = groups.get(gid)!
    let t = g.trades.find((x) => x.name === name)
    if (!t) g.trades.push((t = { name, households: 0, people: 0 }))
    return { g, t }
  }
  const servantName = sc.trades.find((t) => t.group === sc.servants && t.id === 'servant')!.name[0]
  for (const b of st.buildings) {
    for (const h of b.households ?? []) {
      const s = split(c, h)
      if (!s) continue
      const { tr, servants } = s
      const own = trade(tr.group, tr.name[0])
      own.g.households++
      own.t.households++
      own.g.people += s.own
      own.t.people += s.own
      if (servants) {
        const s = trade(sc.servants, servantName)
        s.g.people += servants
        s.t.people += servants
      }
    }
  }
  return [...groups.values()].filter((g) => g.people > 0).map((g) => ({ ...g, trades: g.trades.sort((a, b) => b.people - a.people) }))
}
