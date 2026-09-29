import { area, bboxOf, dist, pointInPoly, polylineDist, type P, type Poly } from './geom'
import { residentsOf, tradeInfo } from './people'
import type { Building, Culture, Field, Settlement, Ward, WardType } from './types'

/**
 * 悬停说明：地图上某一点具体是什么——哪种建筑（按文明、所在片区、住户推断用途）、田里种的什么、
 * 园林里的池与岛、哪条街、哪个地标。文字是中文键，界面按语言翻译（见 ui/i18n）。
 */
export interface Description {
  /** 标题（中文键；专名不翻译，放在 name 里） */
  title: string
  /** 专名（街名、地标名……），有的话代替标题显示 */
  name?: { zh: string; en: string; ja: string }
  /** 读数：[名称, 数值, 数值是否要翻译] */
  rows: [string, string, boolean][]
}

type Climate = { temp: number; rain: number }
const climateOf = (st: Settlement): Climate => st.params.climate ?? { temp: 12, rain: 800 }

const hit = (poly: Poly, q: P) => {
  const [x0, y0, x1, y1] = bboxOf(poly)
  return q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1 && pointInPoly(q, poly)
}

const ha = (a: number) => (a >= 10000 ? `${(a / 10000).toFixed(a >= 100000 ? 0 : 1)} ha` : `${Math.round(a)} m²`)

// —————————————————————— 建筑 ——————————————————————

/** 住宅按文明的叫法：城里、乡下 */
const HOME: Record<Culture, [string, string]> = {
  western: ['市民住宅', '农舍'],
  eastern: ['院落民居', '农家院落'],
  wa: ['町家', '农家'],
  islamic: ['内院住宅', '农舍'],
}
const TEMPLE: Record<Culture, string> = { western: '教堂', eastern: '寺观', wa: '寺社', islamic: '清真寺' }
const KEEP: Record<Culture, string> = { western: '城堡主楼', eastern: '楼阁', wa: '天守', islamic: '城堡主楼' }
const RURAL = new Set<WardType>(['farm', 'wild', 'suburb'])

/** 建筑的用途：由类型、所在片区与住户推断 */
function buildingRole(st: Settlement, b: Building, ward: Ward | undefined, inGrave: boolean): string {
  const c = st.params.culture
  const wt = ward?.type
  const a = area(b.poly)
  // 盖的时候写明了用途（祠、路边十字架、奥宫……）
  if (b.role) return b.role
  switch (b.kind) {
    case 'house':
      if (b.units === 0) return '厢房（附属）'
      return RURAL.has(wt as WardType) || !ward?.inner ? HOME[c][1] : HOME[c][0]
    case 'large':
      if (b.units === 0) {
        if (wt === 'market' || wt === 'plaza') return a > 150 ? '邸店（货栈）' : '铺面'
        if (wt === 'castle') return '殿阁'
        if (wt === 'temple') return '僧房、斋堂'
        return '附属建筑'
      }
      if (wt === 'noble') return c === 'wa' ? '武家屋敷' : c === 'eastern' ? '府第' : '府邸'
      if (wt === 'market' || wt === 'merchant') return c === 'eastern' ? '临街铺面楼' : '商人的楼房（楼下铺面）'
      if (wt === 'craft') return '作坊兼住宅'
      return c === 'western' ? '多层公寓楼' : '大宅'
    case 'shed':
      if (inGrave) return st.params.culture === 'eastern' ? '坟丘' : '墓'
      if (wt === 'market' || wt === 'plaza') return '摊位'
      if (RURAL.has(wt as WardType)) return '谷仓、棚舍'
      if (wt === 'harbor') return '仓棚'
      return '棚屋、仓房'
    case 'hall':
      if (wt === 'castle') return c === 'western' ? '厅堂、附属楼' : '殿'
      if (wt === 'temple') return '殿堂'
      if (wt === 'market' || wt === 'plaza') return c === 'western' ? '市政厅' : '市署'
      return '厅堂、会馆'
    case 'temple':
      return TEMPLE[c]
    case 'keep':
      return KEEP[c]
    case 'tower':
      if (wt === 'market' || wt === 'plaza') return c === 'western' ? '钟楼' : '市楼'
      return '塔楼'
    case 'civic':
      if (inGrave) return '墓碑'
      if (wt === 'market') return c === 'western' ? '市政厅' : '市署'
      return '官署、公共建筑'
    case 'pagoda':
      return c === 'western' || c === 'islamic' ? '凉亭' : '塔、亭'
    case 'magic':
      return '法师塔'
    case 'torii':
      return '鸟居'
  }
}

// —————————————————————— 农田 ——————————————————————

const FIELD_NAME: Record<Field['kind'], string> = {
  crop: '大田',
  paddy: '水田',
  orchard: '果园',
  vineyard: '葡萄园',
  garden: '菜园',
  pasture: '牧场',
  meadow: '草甸',
}

/** 田里种的（养的）：按文明与气候 */
function cropOf(kind: Field['kind'], c: Culture, cl: Climate): string {
  const warm = cl.temp > 16
  const dry = cl.rain < 600
  switch (kind) {
    case 'crop':
      if (c === 'eastern') return dry ? '粟、黍' : warm ? '麦、豆' : '粟、麦'
      if (c === 'wa') return '麦、大豆'
      if (c === 'islamic') return dry ? '大麦、小麦（引水灌溉）' : '小麦、大麦'
      return warm ? '小麦、大麦' : '小麦、黑麦、燕麦（三圃轮作）'
    case 'paddy':
      return '稻'
    case 'orchard':
      if (c === 'eastern') return warm ? '柑橘、荔枝' : '桃、梨、枣'
      if (c === 'wa') return '柿、梅'
      if (c === 'islamic') return warm ? '枣椰、石榴、杏' : '杏、石榴、核桃'
      return warm ? '橄榄、无花果' : '苹果、梨'
    case 'vineyard':
      return '葡萄'
    case 'garden':
      if (c === 'eastern') return '白菜、葱、萝卜'
      if (c === 'wa') return '萝卜、茄子、葱'
      if (c === 'islamic') return '豆、洋葱、瓜'
      return '卷心菜、豆、洋葱'
    case 'pasture':
      if (c === 'islamic') return '羊'
      if (c === 'wa') return '马、牛'
      return '牛、羊'
    case 'meadow':
      return '割草晒干草'
  }
}

// —————————————————————— 园林与别的 ——————————————————————

const GREEN_NAME = { park: '公园', garden: '园圃', cemetery: '墓地', courtyard: '庭院' } as const
const PART_NAME = { pond: '池水', isle: '池中岛', bed: '花坛', gravel: '白砂（枯山水）', rock: '置石' } as const
const ROAD_NAME = { highway: '官道', main: '大街', street: '街', lane: '巷', path: '小径', stair: '石阶' } as const

/**
 * 某一点（米）是什么：建筑 > 园林小品 > 地标 > 园林与墓地 > 农田 > 广场 > 道路；都没有返回 null。
 * ward 是这一点所在的片区（调用方已经找过）。
 */
export function describeAt(st: Settlement, q: P, ward: Ward | undefined): Description | null {
  const c = st.params.culture
  const grave = st.greens.find((g) => g.kind === 'cemetery' && hit(g.poly, q))
  const b = st.buildings.find((b) => hit(b.poly, q))
  if (b) {
    const rows: [string, string, boolean][] = []
    if (b.floors) rows.push(['层数', String(b.floors), false])
    if (b.units) {
      rows.push(['住户', String(b.units), false])
      // 口数连未成年人、学徒伙计、仆役；各户的营生（多户的楼房列出不同的几种）
      rows.push(['居住人数', String(Math.round(residentsOf(b, c))), false])
      for (const trade of new Set((b.households ?? []).map((h) => tradeInfo(c, h.trade)?.name).filter((x): x is string => !!x))) rows.push(['职业', trade, true])
    }
    rows.push(['占地', ha(area(b.poly)), false])
    return { title: buildingRole(st, b, ward, !!grave), rows }
  }
  const part = (st.parkParts ?? []).find((p) => hit(p.poly, q))
  if (part) return { title: PART_NAME[part.kind], rows: [['面积', ha(area(part.poly)), false]] }
  const lm = st.landmarks.find((l) => l.name && dist(l.p, q) < 6)
  if (lm?.name) return { title: '地标', name: lm.name, rows: [] }
  const green = st.greens.find((g) => g.kind !== 'courtyard' && hit(g.poly, q))
  if (green) {
    const title = green.kind === 'cemetery' && c === 'eastern' && !ward?.inner ? '坟地（家族祖坟）' : GREEN_NAME[green.kind]
    return { title, rows: [['面积', ha(area(green.poly)), false]] }
  }
  const f = st.fields.find((f) => hit(f.poly, q))
  if (f) {
    return {
      title: FIELD_NAME[f.kind],
      rows: [
        [f.kind === 'pasture' ? '放养' : '种植', cropOf(f.kind, c, climateOf(st)), true],
        ['面积', ha(area(f.poly)), false],
      ],
    }
  }
  if (st.plazas.some((p) => hit(p, q))) return { title: ward?.type === 'market' ? '市集' : '广场', rows: [] }
  let best: { d: number; r: (typeof st.roads)[number] } | null = null
  for (const r of st.roads) {
    const d = polylineDist(q, r.line) - r.width / 2
    if (d < 1 && (!best || d < best.d)) best = { d, r }
  }
  if (best) {
    const r = best.r
    return { title: ROAD_NAME[r.kind], name: r.name, rows: [['路宽', `${r.width.toFixed(1)} m`, false]] }
  }
  return null
}
