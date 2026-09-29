import { hashAt, type Ctx } from './ctx'
import { area, centroid, type Poly } from './geom'
import { perHousehold } from './scale'
import type { Building, Culture, Household, Settlement, WardType } from './types'
import { defineStrings } from '../i18n'

/**
 * 住户：每栋民居里住几户、每户几口人、以什么为生。
 *
 * 户数照旧（见 wards.ts 的 storeys：一两层的房子一户，多层楼房一层一户）；一户的人口随它住的面积与营生：
 * 家人之外，工匠家里有学徒、帮工，商家有伙计，富户有仆役——前工业时代的城里，大宅住二三十口，陋屋三四口。
 * 未成年人随户（户籍按户登记：军户、匠户、町人……），学徒、伙计算进户主的行当，仆役另算一类。
 *
 * 各文明的职业分法不同：中国是士农工商，日本是士農工商（武士在最上），欧洲是教士、贵族、市民、农民，
 * 伊斯兰城市是乌理玛、官宦、巴扎商人与工匠。每类下面再分细的行当。
 */

type Tri = [zh: string, en: string, ja: string]

/** 大类：cls 定人口的构成（家人以外多出来的是学徒伙计，还是仆役） */
interface Group {
  id: string
  name: Tri
  cls: 'elite' | 'trade' | 'craft' | 'farm' | 'labor' | 'clergy' | 'arms'
}
interface Trade {
  id: string
  group: string
  name: Tri
}
interface Scheme {
  groups: Group[]
  trades: Trade[]
  /** 片区（或 rural：零散农家、estate：大宅院）→ 各行当的比重 */
  mix: Partial<Record<WardType | 'rural' | 'estate', Record<string, number>>>
  /** 仆役、雇工归哪一类 */
  servants: string
}

const T = (group: string, id: string, zh: string, en: string, ja: string): Trade => ({ id, group, name: [zh, en, ja] })

const CHINESE: Scheme = {
  groups: [
    { id: 'shi', name: ['士', 'Scholar-officials', '士'], cls: 'elite' },
    { id: 'nong', name: ['农', 'Farmers', '農'], cls: 'farm' },
    { id: 'gong', name: ['工', 'Artisans', '工'], cls: 'craft' },
    { id: 'shang', name: ['商', 'Merchants', '商'], cls: 'trade' },
    { id: 'bing', name: ['兵', 'Soldiers', '兵'], cls: 'arms' },
    { id: 'seng', name: ['僧道', 'Monks and priests', '僧道'], cls: 'clergy' },
    { id: 'yi', name: ['杂役', 'Labourers and servants', '雑役'], cls: 'labor' },
  ],
  trades: [
    T('shi', 'official', '官吏', 'Official', '官吏'),
    T('shi', 'scholar', '士人', 'Scholar', '士人'),
    T('shi', 'clerk', '胥吏', 'Clerk', '胥吏'),
    T('nong', 'farmer', '农户', 'Farmer', '農家'),
    T('nong', 'gardener', '菜农', 'Market gardener', '菜農'),
    T('gong', 'carpenter', '木匠', 'Carpenter', '大工'),
    T('gong', 'smith', '铁匠', 'Smith', '鍛冶'),
    T('gong', 'weaver', '织工', 'Weaver', '織工'),
    T('gong', 'potter', '陶工', 'Potter', '陶工'),
    T('gong', 'dyer', '染匠', 'Dyer', '染物師'),
    T('shang', 'shopkeeper', '坐贾', 'Shopkeeper', '店主'),
    T('shang', 'trader', '行商', 'Travelling trader', '行商'),
    T('shang', 'broker', '牙人', 'Broker', '仲買人'),
    T('shang', 'innkeeper', '店家', 'Innkeeper', '宿屋'),
    T('bing', 'soldier', '军户', 'Soldier', '軍戸'),
    T('seng', 'monk', '僧', 'Monk', '僧'),
    T('seng', 'daoist', '道士', 'Daoist priest', '道士'),
    T('yi', 'porter', '脚夫', 'Porter', '人足'),
    T('yi', 'labourer', '佣工', 'Labourer', '日雇い'),
    T('yi', 'boatman', '船户', 'Boatman', '船頭'),
    T('yi', 'servant', '仆役', 'Servant', '下人'),
  ],
  mix: {
    common: { carpenter: 1, weaver: 1.2, smith: 0.6, dyer: 0.4, potter: 0.4, shopkeeper: 1, labourer: 1.4, porter: 0.8, gardener: 0.6, clerk: 0.3, soldier: 0.3 },
    craft: { carpenter: 1, weaver: 1.6, smith: 1, dyer: 0.8, potter: 0.8, labourer: 0.6 },
    merchant: { shopkeeper: 2, trader: 1, broker: 0.8, innkeeper: 0.4, clerk: 0.3, weaver: 0.3 },
    market: { shopkeeper: 2, trader: 1, broker: 0.6, innkeeper: 0.6, porter: 0.8 },
    noble: { official: 2, scholar: 1.2, clerk: 0.6, shopkeeper: 0.3 },
    slum: { labourer: 2, porter: 1.2, boatman: 0.4, weaver: 0.5, gardener: 0.4 },
    harbor: { boatman: 2, porter: 1.5, trader: 1, broker: 0.5, carpenter: 0.5 },
    temple: { monk: 1.5, daoist: 0.8, shopkeeper: 0.6, potter: 0.3 },
    castle: { official: 1, clerk: 1.2, soldier: 1 },
    barracks: { soldier: 3, smith: 0.3 },
    suburb: { farmer: 1.5, gardener: 1, labourer: 0.8, innkeeper: 0.3, carpenter: 0.4 },
    rural: { farmer: 5, gardener: 0.6, carpenter: 0.2, smith: 0.1 },
    estate: { official: 1.5, scholar: 1, broker: 0.4, trader: 0.4 },
  },
  servants: 'yi',
}

const JAPANESE: Scheme = {
  groups: [
    { id: 'bushi', name: ['武士', 'Samurai', '武士'], cls: 'elite' },
    { id: 'no', name: ['农', 'Farmers', '農'], cls: 'farm' },
    { id: 'ko', name: ['工', 'Artisans', '工'], cls: 'craft' },
    { id: 'sho', name: ['商', 'Merchants', '商'], cls: 'trade' },
    { id: 'shaji', name: ['寺社', 'Clergy', '寺社'], cls: 'clergy' },
    { id: 'zatsu', name: ['杂业', 'Labourers and servants', '雑業'], cls: 'labor' },
  ],
  trades: [
    T('bushi', 'retainer', '藩士', 'Retainer', '藩士'),
    T('bushi', 'ashigaru', '足轻', 'Foot soldier', '足軽'),
    T('no', 'farmer', '百姓', 'Farmer', '百姓'),
    T('ko', 'carpenter', '大工', 'Carpenter', '大工'),
    T('ko', 'smith', '锻冶', 'Smith', '鍛冶'),
    T('ko', 'dyer', '染物', 'Dyer', '染物屋'),
    T('ko', 'cooper', '桶屋', 'Cooper', '桶屋'),
    T('sho', 'wholesaler', '问屋', 'Wholesaler', '問屋'),
    T('sho', 'shopkeeper', '小卖', 'Shopkeeper', '小売'),
    T('sho', 'innkeeper', '旅笼', 'Innkeeper', '旅籠'),
    T('sho', 'brewer', '酒屋', 'Sake brewer', '酒屋'),
    T('shaji', 'monk', '僧侣', 'Monk', '僧侶'),
    T('shaji', 'priest', '神职', 'Shinto priest', '神職'),
    T('zatsu', 'labourer', '日雇', 'Day labourer', '日雇い'),
    T('zatsu', 'boatman', '船头', 'Boatman', '船頭'),
    T('zatsu', 'servant', '奉公人', 'Servant', '奉公人'),
  ],
  mix: {
    common: { carpenter: 1, smith: 0.5, dyer: 0.5, cooper: 0.5, shopkeeper: 1.5, labourer: 1.4, farmer: 0.3 },
    craft: { carpenter: 1.2, smith: 1, dyer: 1, cooper: 0.8, labourer: 0.4 },
    merchant: { wholesaler: 1.2, shopkeeper: 2, brewer: 0.6, innkeeper: 0.4 },
    market: { shopkeeper: 2, wholesaler: 0.8, innkeeper: 0.6, labourer: 0.6 },
    noble: { retainer: 3, ashigaru: 0.8 },
    slum: { labourer: 2, boatman: 0.4, cooper: 0.3 },
    harbor: { boatman: 2, wholesaler: 1, labourer: 1.2, carpenter: 0.4 },
    temple: { monk: 1.5, priest: 1, shopkeeper: 0.5 },
    castle: { retainer: 2, ashigaru: 1 },
    barracks: { ashigaru: 3, retainer: 0.5 },
    suburb: { farmer: 1.5, labourer: 0.6, innkeeper: 0.4, shopkeeper: 0.4 },
    rural: { farmer: 5, carpenter: 0.15 },
    estate: { retainer: 2, wholesaler: 0.5 },
  },
  servants: 'zatsu',
}

const WESTERN: Scheme = {
  groups: [
    { id: 'clergy', name: ['教士', 'Clergy', '聖職者'], cls: 'clergy' },
    { id: 'nobility', name: ['贵族', 'Nobility', '貴族'], cls: 'elite' },
    { id: 'merchants', name: ['商人', 'Merchants', '商人'], cls: 'trade' },
    { id: 'crafts', name: ['工匠', 'Craftsmen', '職人'], cls: 'craft' },
    { id: 'peasants', name: ['农民', 'Peasants', '農民'], cls: 'farm' },
    { id: 'soldiers', name: ['兵士', 'Soldiers', '兵士'], cls: 'arms' },
    { id: 'labour', name: ['雇工与仆役', 'Labourers and servants', '雇人と奉公人'], cls: 'labor' },
  ],
  trades: [
    T('clergy', 'priest', '神父', 'Priest', '司祭'),
    T('clergy', 'friar', '修士', 'Friar', '修道士'),
    T('nobility', 'lord', '领主', 'Lord', '領主'),
    T('nobility', 'knight', '骑士', 'Knight', '騎士'),
    T('merchants', 'merchant', '批发商', 'Merchant', '卸商'),
    T('merchants', 'shopkeeper', '店主', 'Shopkeeper', '店主'),
    T('merchants', 'innkeeper', '旅店主', 'Innkeeper', '宿屋の主人'),
    T('crafts', 'weaver', '织工', 'Weaver', '織工'),
    T('crafts', 'smith', '铁匠', 'Smith', '鍛冶屋'),
    T('crafts', 'baker', '面包师', 'Baker', 'パン屋'),
    T('crafts', 'butcher', '屠户', 'Butcher', '肉屋'),
    T('crafts', 'carpenter', '木匠', 'Carpenter', '大工'),
    T('crafts', 'tanner', '皮匠', 'Tanner', '皮革職人'),
    T('crafts', 'mason', '石匠', 'Mason', '石工'),
    T('peasants', 'peasant', '农夫', 'Peasant', '農夫'),
    T('peasants', 'gardener', '园丁', 'Gardener', '園丁'),
    T('soldiers', 'soldier', '士兵', 'Soldier', '兵士'),
    T('labour', 'labourer', '短工', 'Labourer', '日雇い'),
    T('labour', 'carter', '车夫', 'Carter', '荷車引き'),
    T('labour', 'boatman', '船夫', 'Boatman', '船頭'),
    T('labour', 'servant', '仆人', 'Servant', '召使い'),
  ],
  mix: {
    common: { weaver: 1, baker: 0.6, butcher: 0.4, carpenter: 0.8, mason: 0.4, shopkeeper: 0.8, labourer: 1.4, carter: 0.5, peasant: 0.4 },
    craft: { weaver: 1.4, smith: 1, tanner: 0.8, carpenter: 0.8, mason: 0.6, baker: 0.4, labourer: 0.5 },
    merchant: { merchant: 1.6, shopkeeper: 1.5, innkeeper: 0.4, weaver: 0.3 },
    market: { shopkeeper: 2, merchant: 0.8, innkeeper: 0.6, baker: 0.5, butcher: 0.5, carter: 0.5 },
    noble: { lord: 1, knight: 1.2, merchant: 0.4 },
    slum: { labourer: 2, carter: 0.8, tanner: 0.6, weaver: 0.5 },
    harbor: { boatman: 2, labourer: 1.4, merchant: 1, carpenter: 0.6 },
    temple: { priest: 1, friar: 1, shopkeeper: 0.4 },
    castle: { knight: 1, soldier: 2, lord: 0.3 },
    barracks: { soldier: 3, smith: 0.3 },
    suburb: { peasant: 1.5, gardener: 0.8, innkeeper: 0.4, labourer: 0.8, smith: 0.3 },
    rural: { peasant: 5, gardener: 0.5, smith: 0.15, carpenter: 0.15 },
    estate: { lord: 1, knight: 1 },
  },
  servants: 'labour',
}

const ISLAMIC: Scheme = {
  groups: [
    { id: 'ulama', name: ['乌理玛', 'Ulama', 'ウラマー'], cls: 'clergy' },
    { id: 'ayan', name: ['官宦显贵', 'Notables and officials', '名士と官吏'], cls: 'elite' },
    { id: 'tujjar', name: ['商人', 'Merchants', '商人'], cls: 'trade' },
    { id: 'sunna', name: ['工匠', 'Artisans', '職人'], cls: 'craft' },
    { id: 'fallah', name: ['农民', 'Farmers', '農民'], cls: 'farm' },
    { id: 'jund', name: ['兵士', 'Soldiers', '兵士'], cls: 'arms' },
    { id: 'amma', name: ['雇工与仆役', 'Labourers and servants', '雇人と奉公人'], cls: 'labor' },
  ],
  trades: [
    T('ulama', 'imam', '伊玛目', 'Imam', 'イマーム'),
    T('ulama', 'qadi', '卡迪', 'Qadi', 'カーディー'),
    T('ayan', 'amir', '埃米尔', 'Amir', 'アミール'),
    T('ayan', 'katib', '书记官', 'Scribe', '書記'),
    T('tujjar', 'tajir', '大商人', 'Merchant', '大商人'),
    T('tujjar', 'bazaari', '巴扎店主', 'Bazaar trader', 'バザール商人'),
    T('tujjar', 'caravaneer', '驼队商', 'Caravan trader', '隊商'),
    T('sunna', 'weaver', '织工', 'Weaver', '織工'),
    T('sunna', 'coppersmith', '铜匠', 'Coppersmith', '銅細工師'),
    T('sunna', 'tanner', '皮匠', 'Tanner', '皮革職人'),
    T('sunna', 'potter', '陶工', 'Potter', '陶工'),
    T('sunna', 'baker', '面包师', 'Baker', 'パン屋'),
    T('fallah', 'farmer', '农夫', 'Farmer', '農夫'),
    T('fallah', 'gardener', '园丁', 'Gardener', '園丁'),
    T('jund', 'soldier', '士兵', 'Soldier', '兵士'),
    T('amma', 'porter', '脚夫', 'Porter', '荷担ぎ'),
    T('amma', 'water', '送水人', 'Water carrier', '水売り'),
    T('amma', 'labourer', '短工', 'Labourer', '日雇い'),
    T('amma', 'servant', '仆人', 'Servant', '召使い'),
  ],
  mix: {
    common: { weaver: 1, potter: 0.5, baker: 0.6, coppersmith: 0.4, bazaari: 0.8, labourer: 1.2, water: 0.4, porter: 0.6, gardener: 0.4 },
    craft: { weaver: 1.2, coppersmith: 1, tanner: 0.8, potter: 0.8, labourer: 0.4 },
    merchant: { tajir: 1.5, bazaari: 1.5, caravaneer: 0.6, katib: 0.2 },
    market: { bazaari: 2.5, tajir: 0.6, porter: 1, baker: 0.4 },
    noble: { amir: 1, katib: 1, qadi: 0.5, tajir: 0.4 },
    slum: { labourer: 2, porter: 1.2, water: 0.8, tanner: 0.5 },
    harbor: { porter: 1.5, labourer: 1, tajir: 1, caravaneer: 0.3 },
    temple: { imam: 1.5, qadi: 0.5, bazaari: 0.5 },
    castle: { amir: 0.5, katib: 1, soldier: 2 },
    barracks: { soldier: 3 },
    suburb: { farmer: 1.2, gardener: 1, labourer: 0.8, caravaneer: 0.3 },
    rural: { farmer: 5, gardener: 0.8 },
    estate: { amir: 1, tajir: 1 },
  },
  servants: 'amma',
}

const SCHEMES: Record<Culture, Scheme> = { eastern: CHINESE, wa: JAPANESE, western: WESTERN, islamic: ISLAMIC }

// 职业名的英文、日文（界面的 t() 按中文键翻译）
defineStrings(Object.values(SCHEMES).flatMap((s) => [...s.groups, ...s.trades].map((x) => x.name)))

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
  const sc = SCHEMES[ctx.p.culture]
  const key: WardType | 'rural' | 'estate' = ctx.estate ? 'estate' : !ctx.wardTown ? 'rural' : (MIX_KEY[ctx.wardType] ?? ctx.wardType)
  const mix = Object.entries(sc.mix[key] ?? sc.mix.common!)
  const total = mix.reduce((s, [, w]) => s + w, 0)
  const c = centroid(poly)
  const base = perHousehold(ctx.p.culture)
  // 三层以上的楼房底层是铺面，楼上一层一户；一两层的独栋整栋一户
  const living = area(poly) * (floors >= 3 ? floors - 1 : floors)
  const per = living / units
  const out: Household[] = []
  for (let u = 0; u < units; u++) {
    let r = hashAt(ctx, c, 'people.trade', u) * total
    let trade = mix[0][0]
    for (const [id, w] of mix) if ((r -= w) < 0) {
      trade = id
      break
    }
    const cls = sc.groups.find((g) => g.id === sc.trades.find((t) => t.id === trade)!.group)!.cls
    // 东方的大宅：一家人住好几座屋，只有记户的那座算人口，口数按整座宅院（多六成）
    const size = Math.min(4.5, Math.max(0.55, (per / HOME_AREA) ** 0.6)) * EXTRA[cls].k * (ctx.estate ? 1.6 : 1)
    out.push({ trade, people: Math.max(2, Math.round(base * size * (0.85 + 0.3 * hashAt(ctx, c, 'people.size', u)))) })
  }
  return out
}

/** 一栋民居住的人口：记了各户的按各户加总，没记的（旧数据、别处直接摆的）按户数乘每户人数 */
export function residentsOf(b: Building, culture: Culture) {
  if (b.households) return b.households.reduce((s, h) => s + h.people, 0)
  return (b.units ?? 1) * perHousehold(culture)
}

/**
 * 平均一户几口（各种大小、营生的户按一座城里常见的比例折算，实测值）：城区要多大按它把人口折成户数
 */
const HOME_K: Record<Culture, number> = { western: 1.4, eastern: 1.6, wa: 1.33, islamic: 1.45 }
export const perHome = (culture: Culture) => perHousehold(culture) * HOME_K[culture]

export const dwelling = (b: Pick<Building, 'kind'>) => b.kind === 'house' || b.kind === 'large'

/** 行当的名字（中文键，界面按语言翻译）与所属大类 */
export function tradeInfo(culture: Culture, id: string) {
  const sc = SCHEMES[culture]
  const t = sc.trades.find((x) => x.id === id)
  const g = t && sc.groups.find((x) => x.id === t.group)
  return t && g ? { name: t.name[0], group: g.name[0] } : null
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
  const sc = SCHEMES[c]
  const base = perHousehold(c)
  const groups = new Map<string, PeopleStat>(sc.groups.map((g) => [g.id, { name: g.name[0], households: 0, people: 0, trades: [] }]))
  const trade = (gid: string, name: string) => {
    const g = groups.get(gid)!
    let t = g.trades.find((x) => x.name === name)
    if (!t) g.trades.push((t = { name, households: 0, people: 0 }))
    return { g, t }
  }
  const servantName = sc.trades.find((t) => t.group === sc.servants && t.id === 'servant')!.name[0]
  for (const b of st.buildings) {
    if (!dwelling(b) || !b.households) continue
    for (const h of b.households) {
      const tr = sc.trades.find((x) => x.id === h.trade)
      if (!tr) continue
      const cls = sc.groups.find((g) => g.id === tr.group)!.cls
      const family = Math.min(h.people, Math.round(base))
      const servants = Math.round((h.people - family) * EXTRA[cls].servants)
      const own = trade(tr.group, tr.name[0])
      own.g.households++
      own.t.households++
      own.g.people += h.people - servants
      own.t.people += h.people - servants
      if (servants) {
        const s = trade(sc.servants, servantName)
        s.g.people += servants
        s.t.people += servants
      }
    }
  }
  return [...groups.values()].filter((g) => g.people > 0).map((g) => ({ ...g, trades: g.trades.sort((a, b) => b.people - a.people) }))
}
