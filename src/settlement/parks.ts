import { centroid, insetConvex, area, type P, type Poly } from './geom'
import { clipWater, mark, siteDice, type Ctx } from './ctx'
import { checkpoint, rollback } from './undo'
import type { Culture, Tier, Ward } from './types'
import { kit, type Design, type Kit, type Skel } from './garden/kit'
import { SKELETONS, lawnPark } from './garden/skeletons'

/**
 * 公园与园林：按"骨架 + 元素池"拼出来（见 garden/）。
 * - 骨架（skeletons.ts）是构图法：规则对称、自然山水、序列（参道）、成片（林、果园、白砂）
 * - 元素池（elements.ts）是能放的东西，各自标明槽位、文明、大小；骨架在每个槽位按园址抽一样
 * - 预设（这里）是历史上有的样式：一副骨架加一张权重偏好表（法式花坛园偏爱十字轴、刺绣花坛、橘园……），
 *   不是一段单独的代码；每个文明另有"自由组合"，只守骨架与元素池的规矩，拼出预设之外的园子
 * 一切抽签都按园址（siteDice，40 米粗格），城市长大、人口变了，同一处园子也还是同一个样子。
 */

interface Preset {
  id: string
  cult: Culture
  skel: Skel
  /** 园地面积范围（m²） */
  min: number
  max?: number
  /** 抽签权重（可按园子定，如临水的水渠园） */
  w: number | ((K: Kit) => number)
  /** 地面：公园的草地，或围墙里的园林 */
  ground: 'park' | 'garden'
  /** 有园墙的概率 */
  wall: number
  /** 元素的权重偏好（×），0 为不要 */
  bias: Record<string, number>
  /** 只在这几档规模里抽得到（缺省不限）：猎苑、离宫只在 grand，街心花园只在 small */
  tiers?: Tier[]
}

const nearWater = (K: Kit) => K.ctx.T.waterAt(centroid(K.g)) < 90

const PRESETS: Preset[] = [
  // —— 西式 ——
  {
    // 规则式花坛园（凡尔赛、海伦豪森式的 parterre）
    id: 'parterre', cult: 'western', skel: 'axial', min: 2400, w: 3, ground: 'park', wall: 0,
    bias: { cross: 6, parallel: 0.2, alley: 4, tapis: 2, canal: 0.5, basin: 4, octPool: 1, orangery: 4, belvedere: 3, exedra: 2, endStatue: 2, allee: 4, hedge: 3, ringwalk: 0.3, cutBeds: 4, broderie: 4, nested: 3, splitBeds: 1, maze: 1, bosquet: 1, lawnRound: 0.2, lawnSpecimen: 0.2, topiary: 3, statuePairs: 2, limeRows: 1, bandstand: 0.2 },
  },
  {
    // 林荫散步园（伦敦的 mall、巴黎的林荫广场）
    id: 'promenade', cult: 'western', skel: 'axial', min: 1200, w: 2, ground: 'park', wall: 0,
    bias: { cross: 4, parallel: 4, single: 0.5, mall: 8, alley: 1, tapis: 1, canal: 0, bandstand: 5, basin: 2, statueRound: 2, doubleRows: 5, limeRows: 4, ringwalk: 8, allee: 1, lawnRound: 5, lawnSpecimen: 4, bosquet: 1, cutBeds: 0.3, broderie: 0.2, endStatue: 5, orangery: 0.2 },
  },
  {
    // 荷兰式水渠园：一条长渠、两侧的草坪与果树，渠端一座观景亭
    id: 'dutch', cult: 'western', skel: 'axial', min: 1800, w: 1, ground: 'park', wall: 0.4,
    bias: { single: 8, canal: 10, endPool: 2, belvedere: 3, gatehouse: 3, topiary: 3, limeRows: 2, lawnSpecimen: 2, orchardGrid: 3, nested: 1, hedge: 3 },
  },
  {
    // 英式风景园（斯托、斯陶黑德式）
    id: 'landscape', cult: 'western', skel: 'natural', min: 4500, w: 3, ground: 'park', wall: 0,
    bias: { lake: 3, serpentine: 4, 'water-none': 0.3, isleClump: 3, isleFolly: 2, arched: 3, isleBridge: 2, 'crossing-none': 2, follyShore: 4, boathouse: 2, willows: 2, gazebo: 2, specimen: 2, belt: 8, clumps: 8, willowRing: 3, manor: 1.5, 'hall-none': 3, follyMound: 3, grotto: 2 },
  },
  {
    // 镇上的公地（village green / common）
    id: 'green', cult: 'western', skel: 'field', min: 300, max: 9000, w: 1.5, ground: 'park', wall: 0,
    bias: { meadow: 6, planeShade: 1, orchard: 0.3, star: 5, meander: 1, crossPaths: 0.5, wellHub: 3, marketCross: 3, basin: 0.3, duckPond: 5, 'edge-none': 4 },
  },
  {
    // 纪念大道：林荫道或方尖碑夹着的大道，尽头一座纪念堂、礼拜堂或纪念柱
    id: 'memorial', cult: 'western', skel: 'procession', min: 2500, w: 0.8, ground: 'park', wall: 0,
    bias: { archGate: 3, lychgate: 1, avenue: 4, obeliskPairs: 3, mausoleum: 3, chapel: 2, monument: 2, belt: 3, clumps: 2 },
  },
  {
    // 街心花园（伦敦的 garden square）：铁栏杆围着的草坪、环路与十字路、当中一座水盆或雕像
    id: 'square', cult: 'western', skel: 'field', min: 300, max: 6000, w: 4, ground: 'park', wall: 0.7, tiers: ['small'],
    bias: { meadow: 8, planeShade: 3, ringPath: 6, crossPaths: 4, star: 1, basin: 4, marketCross: 2, wellHub: 1, 'edge-none': 2 },
  },
  {
    // 猎苑（王家的鹿苑、chase）：一圈园墙里的大片密林与林间空地，骑道放射，当中一座狩猎行宫
    id: 'deerpark', cult: 'western', skel: 'field', min: 9000, w: 10, ground: 'park', wall: 1, tiers: ['grand'],
    bias: { huntwood: 1000, star: 8, lodge: 30, duckPond: 2, 'pond-none': 1, belt: 0.5, 'edge-none': 2 },
  },
  // —— 东方 ——
  {
    // 离宫苑囿（圆明园、颐和园式）：大湖、湖心岛上的水殿，长堤与桥
    id: 'rikyu', cult: 'eastern', skel: 'natural', min: 8000, w: 12, ground: 'garden', wall: 1, tiers: ['grand'],
    bias: { lake: 8, twin: 1, pondlet: 0, islePalace: 40, causeway: 5, isleBridge: 5, arched: 3, ting: 3, shuixie: 4, mainHall: 3, willowRing: 5, pagodaTower: 3, gallery: 2 },
  },
  {
    // 皇家猎苑（上林苑、南苑）
    id: 'hunt', cult: 'eastern', skel: 'field', min: 12000, w: 4, ground: 'park', wall: 1, tiers: ['grand'],
    bias: { huntwood: 1000, star: 6, lodge: 30, pavilionHub: 1, cornerPond: 3 },
  },
  {
    // 文人园林（拙政园、网师园式）
    id: 'scholar', cult: 'eastern', skel: 'natural', min: 1100, max: 16000, w: 3, ground: 'garden', wall: 1,
    bias: { lake: 4, twin: 2, pondlet: 1, serpentine: 0.3, zigzag: 6, arched: 1, causeway: 0.2, mainHall: 8, shuixie: 4, ting: 4, platform: 2, revetment: 2, rockGroup: 3, stele: 1, rockery: 5, study: 4, pagodaTower: 0.3, gallery: 5, bambooWall: 3, willowRing: 3, rockShore: 3, islePavilion: 2, isleRocks: 2 },
  },
  {
    // 湖山园（西湖、北海式的大园）
    id: 'lakepark', cult: 'eastern', skel: 'natural', min: 4500, w: 3, ground: 'park', wall: 0,
    bias: { lake: 6, twin: 2, pondlet: 0, islePavilion: 5, causeway: 4, isleBridge: 4, arched: 2, pagodaTower: 6, willowRing: 6, ting: 4, willows: 2, mainHall: 1, 'hall-none': 2, gallery: 0, mixedwood: 2 },
  },
  {
    // 梅园 / 竹园 / 松园
    id: 'grove', cult: 'eastern', skel: 'field', min: 300, w: 2, ground: 'park', wall: 0.6,
    bias: { plumGrid: 3, bamboo: 2, pineWood: 2, cherry: 0.5, orchard: 0.3, meander: 5, star: 1, pavilionHub: 5, cornerPond: 3 },
  },
  {
    // 神道与祠：牌坊、石像生夹道，尽头是祠堂或陵
    id: 'spiritway', cult: 'eastern', skel: 'procession', min: 2000, w: 1.2, ground: 'park', wall: 0.3,
    bias: { paifang: 5, stoneBeasts: 5, cedarRows: 3, ancestral: 4, tumulus: 3, mixedwood: 2, pines: 2 },
  },
  // —— 和风 ——
  {
    // 回游式池泉庭园（六义园、后乐园式）
    id: 'kaiyu', cult: 'wa', skel: 'natural', min: 2200, w: 3, ground: 'garden', wall: 1,
    bias: { lake: 5, twin: 2, pondlet: 1, islePine: 5, isleRocks: 2, isleLantern: 2, islePavilion: 1, isleBridge: 4, stepping: 2, arched: 2, zigzag: 0.5, shoin: 2, teahouse: 5, azumaya: 4, yukimi: 3, lanternNode: 3, revetment: 4, tsukiyama: 5, smallShrine: 1, rockShore: 5, pineShore: 3, mixedwood: 4, pines: 4 },
  },
  {
    // 枯山水（龙安寺、大仙院式）
    id: 'karesansui', cult: 'wa', skel: 'field', min: 400, w: 2, ground: 'garden', wall: 0,
    bias: { raked: 1000 },
  },
  {
    // 镇守之森：参道、鸟居、社殿
    id: 'chinju', cult: 'wa', skel: 'procession', min: 1500, w: 2, ground: 'park', wall: 0,
    bias: { torii: 10, lanternPairs: 6, cedarRows: 3, toriiTunnel: 1, shrine: 10, sacredwood: 12, mixedwood: 1, 'edge-none': 0 },
  },
  {
    // 名所：樱、梅、枫的林子，曲径、茶屋或灯笼
    id: 'meisho', cult: 'wa', skel: 'field', min: 300, w: 1, ground: 'park', wall: 0,
    bias: { cherry: 4, plumGrid: 3, maple: 3, bamboo: 1, pineWood: 2, moss: 1, raked: 0, meander: 4, ringPath: 2, pavilionHub: 3, lanternHub: 3, cornerPond: 2 },
  },
  {
    // 离宫（桂离宫、修学院离宫式）：大池、雁行的御殿、茶屋与岛
    id: 'rikyu', cult: 'wa', skel: 'natural', min: 8000, w: 12, ground: 'garden', wall: 1, tiers: ['grand'],
    bias: { lake: 6, twin: 2, goten: 40, teahouse: 6, azumaya: 4, isleBridge: 4, stepping: 3, arched: 2, islePine: 4, tsukiyama: 3, pineShore: 3, rockShore: 3, mixedwood: 3, pines: 3 },
  },
  // —— 伊斯兰 ——
  {
    // 王家的园（bagh）：大四分园，交点的水池凉亭，轴端的宫殿凉亭
    id: 'royalbagh', cult: 'islamic', skel: 'axial', min: 6000, w: 12, ground: 'garden', wall: 1, tiers: ['grand'],
    bias: { cross: 10, canal: 8, poolKiosk: 10, kushk: 8, endPool: 3, octPool: 2, cypressRows: 4, cypressPlane: 3, orchardGrid: 4, splitBeds: 2, 'edge-none': 3 },
  },
  {
    // 四分园（chahar bagh：伊斯法罕、阿格拉的花园）
    id: 'chaharbagh', cult: 'islamic', skel: 'axial', min: 800, w: 3, ground: 'garden', wall: 1,
    bias: { cross: 10, canal: 8, rill: 3, poolKiosk: 4, octPool: 3, tomb: 3, basin: 1, splitBeds: 3, orchardGrid: 3, basins: 3, flowerRows: 1, cypressRows: 4, cypressPlane: 2, endPool: 4, kushk: 1, 'edge-none': 4 },
  },
  {
    // 水渠园（赫内拉利费、菲恩园、河边的 bagh）：一条长渠，临水时凉亭朝水
    id: 'canal', cult: 'islamic', skel: 'axial', min: 1400, w: (K) => (nearWater(K) ? 4 : 1.5), ground: 'garden', wall: 1,
    bias: { single: 12, canal: 10, rill: 2, kushk: 10, gatehouse: 3, cypressPlane: 4, cypressRows: 2, orchardGrid: 5, flowerRows: 3, splitBeds: 1, 'edge-none': 4 },
  },
  {
    // 游憩园（奥斯曼的 mesire、城边的 bagh）
    id: 'mesire', cult: 'islamic', skel: 'field', min: 900, w: 2, ground: 'park', wall: 0,
    bias: { planeShade: 4, orchard: 2, rosebeds: 2, star: 3, crossPaths: 2, meander: 1, ringPath: 1, octPool: 4, hauz: 3, basin: 1, kushkHub: 1.5, cypressRing: 3, 'edge-none': 1, cornerPond: 0.5 },
  },
  {
    // 陵园（türbe 与它的园子）
    id: 'turbe', cult: 'islamic', skel: 'procession', min: 1500, w: 1, ground: 'garden', wall: 0.7,
    bias: { portal: 5, cypressFlank: 5, turbe: 8, monument: 0.5, planes: 2 },
  },
]

/** 各文明的自由组合：只守骨架与元素池的规矩（空的偏好表），拼出预设之外的园子 */
const FREE: Record<Culture, [Skel, number, number][]> = {
  // [骨架, 最小面积, 权重]
  western: [['axial', 1600, 0.8], ['natural', 3000, 0.8], ['field', 400, 0.5], ['procession', 2000, 0.3]],
  eastern: [['natural', 1500, 1.2], ['field', 400, 0.6], ['procession', 2000, 0.3]],
  wa: [['natural', 1800, 1.2], ['field', 400, 0.6], ['procession', 1500, 0.3]],
  islamic: [['axial', 1000, 1.2], ['field', 900, 0.6], ['procession', 1500, 0.3]],
}
const walledFree = (c: Culture, s: Skel) => (s === 'axial' ? (c === 'islamic' ? 1 : 0.2) : s === 'natural' ? (c === 'western' ? 0 : 0.7) : 0.2)

const CANDIDATES: Preset[] = [
  ...PRESETS,
  ...Object.entries(FREE).flatMap(([cult, xs]) =>
    xs.map(([skel, min, w]): Preset => ({ id: `free-${skel}`, cult: cult as Culture, skel, min, w, ground: skel === 'natural' && cult !== 'western' ? 'garden' : 'park', wall: walledFree(cult as Culture, skel), bias: {} })),
  ),
]

/** 园林抽签的记录（量多样性用）：设了就在每座园子盖好时回调 */
let trace: ((c: P, sig: string[]) => void) | null = null
export const traceParks = (f: typeof trace) => (trace = f)

/** 公园片区：按文明与园地大小抽一个预设（或自由组合），放不下就换一个，都不行是草坪公园 */
export function park(ctx: Ctx, ward: Ward, block: Poly) {
  // 园地让开水面、道路与城墙
  const w = clipWater(ctx, insetConvex(block, 2), 2)
  const g = w && ctx.corridors.clip(w)
  if (!g || g.length < 3 || area(g) < 60) return
  const V = siteDice(ctx, centroid(g), 'park')
  const A = area(g)
  const tier = ctx.tier
  const K0 = kit(ctx, g, { id: '', skel: 'field', ground: 'park', wall: false, bias: {}, tier })
  let pool = CANDIDATES.filter((v) => v.cult === ctx.p.culture && A >= v.min && A <= (v.max ?? Infinity) && (!v.tiers || v.tiers.includes(tier)))
  for (let k = 0; ; k++) {
    // 按园址抽签；抽中的放不下就从候选里去掉再抽
    const v = pool.length ? V.pick('preset', pool, pool.map((x) => (typeof x.w === 'number' ? x.w : x.w(K0))), k) : null
    const D: Design = v ? { id: v.id, skel: v.skel, ground: v.ground, wall: V.chance('wall', v.wall, k), bias: v.bias, tier } : { id: 'lawn', skel: 'field', ground: 'park', wall: false, bias: {}, tier }
    const K = kit(ctx, g, D)
    // 放不下的设计整个撤回（骨架都先量好再动手，这里是兜底：连房子、置石的占地一起撤）
    const cp = checkpoint(ctx)
    ctx.out.greens.push({ poly: g, kind: D.ground })
    if (v ? SKELETONS[v.skel](K) : lawnPark(K)) {
      // 大园囿、离宫有自己的名字，按大地标标注；街心花园只起个小名
      // 别的预设盖成的大园（grand）是大公园；离宫只给真有宫殿的（岛上的水殿、雁行的御殿、王家的园）
      const palace = K.sig.some((x) => x === 'island=islePalace' || x === 'hall=goten') || v?.id === 'royalbagh'
      const special = v && (v.id === 'deerpark' || v.id === 'hunt' ? 'huntPark' : palace ? 'rikyu' : v.id === 'square' ? 'square' : tier === 'grand' ? 'greatPark' : null)
      if (K.seat && special) ctx.out.landmarks.push({ p: K.seat, name: ctx.namer.sacred(special, `${Math.round(K.seat[0])},${Math.round(K.seat[1])}`), kind: 'shrine', major: tier === 'grand' })
      else if (K.seat && tier !== 'small' && V.chance('name', 0.6)) mark(ctx, K.seat, 'shrine', 'park')
      trace?.(centroid(g), [`${D.id}:${D.skel}:${tier}:${Math.round(A)}`, ...K.sig])
      break
    }
    rollback(ctx, cp)
    pool = pool.filter((x) => x !== v)
  }
  void ward
}

