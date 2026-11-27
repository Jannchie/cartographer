// 生长引擎对外的接口（类型与函数签名）。实现在同目录的 index.ts；check-api.ts 在编译期核对实现与这里一致。
// 外部项目（编译选项可能比本仓库严，比如开了 noUncheckedIndexedAccess）经 package.json 的 exports 只看到这个文件，
// 不去类型检查实现与它引用的生成代码。这里不 import 任何东西。

/** 一个点（米，画幅左上角为原点，y 向下） */
export type GrowP = [number, number]

/** 地形参数：取 cartographer 聚落参数里的同名字段；方向为 null 表示按种子随机（JSON 里存不了 NaN） */
export interface GrowTerrain {
  /** 文明 id（western / eastern / wa / islamic）：地形的随机数跟着种子与文明，画图时按它配色 */
  culture: string
  river: boolean
  coast: boolean
  hills: boolean
  /** 地形起伏 0 ~ 1 */
  relief: number
  coastDir: number | null
  riverDir: number | null
  hillDir: number | null
  /** 固定地形的种子（空串或不填：跟着种子与文明） */
  terrainSeed?: string
}

export interface GrowParams extends GrowTerrain {
  seed: string
  /** 画幅（米，取整到 20 的倍数） */
  size: [number, number]
}

/** highway 对外的路；street 村里的主街（延长对外的路时沿用原来的种类）；lane 岔出来的巷子 */
export type GrowRoadKind = 'highway' | 'street' | 'lane'

export interface GrowRoad {
  id: number
  kind: GrowRoadKind
  /** 中线 */
  pts: GrowP[]
  /** 第几步生出来的（seedState 是第 0 步） */
  born: number
}

/** building 在建；built 盖好了；vacant 退掉了、空着（地块的形状留着，以后同样大小的需求可以接着用） */
export type GrowLotState = 'building' | 'built' | 'vacant'

export interface GrowLot {
  id: number
  /** 用途：center 村心、home 住处、shop 铺子作坊、public 公家、yard 料场工棚、field 田；别的字当住处一类处理 */
  use: string
  owner?: string
  /** 四个角：临街的两个角在前（poly[0] → poly[1] 是临街的一边），poly[3] − poly[0] 是进深方向 */
  poly: GrowP[]
  /** 临哪条路（接在别的地块背后、旁边的，记前面那块临的路） */
  road: number
  state: GrowLotState
  born: number
  /** 占几个单位（一个单位 = 20 × 20 米） */
  area: number
  /** 自然生长的聚落里按规划长出来的地块才有（手动摆的没有）：这块地对着规划里的哪一栋房子、哪一块田（poly 是它的轮廓，不一定是四个角） */
  ref?: number
}

/** 分区（规划）：这片地打算给什么用（use 与地块的用途同一套字），不立刻盖东西 */
export interface GrowZone {
  id: number
  use: string
  poly: GrowP[]
  born: number
}

/** 地形笔刷：raise 抬高、lower 压低、flat 平整（压到起笔处的高程）、water 挖成水面、land 填成陆地 */
export type GrowBrush = 'raise' | 'lower' | 'flat' | 'water' | 'land'

/** 手动改地形的一笔：沿 pts（只有一个点时是一个圆）半径 r 米以内按笔刷改。地形 = 按参数生成的地形依次叠上每一笔 */
export interface GrowStroke {
  tool: GrowBrush
  /** 笔刷半径（米） */
  r: number
  pts: GrowP[]
}

/**
 * 手动操作被拒绝的原因：edge 出画幅、lot 压到地块、road 压到路、water 离水太近或跨水、sea 下海、bridge 桥太长、
 * slope 太陡、far 离路太远、short 太短
 */
export type GrowFault = 'edge' | 'lot' | 'road' | 'water' | 'sea' | 'bridge' | 'slope' | 'far' | 'short'

export interface GrowState {
  v: number
  seed: string
  terrain: GrowTerrain
  size: [number, number]
  /** 村心 */
  center: GrowP
  roads: GrowRoad[]
  lots: GrowLot[]
  zones: GrowZone[]
  /** 手动改地形的笔画（没改过时没有这一项） */
  strokes?: GrowStroke[]
  /**
   * 自然生长（见 natural-api.d.ts）：聚落沿着一次成形的生成器按 horizon 人规划好的成长史长，pop 是走到的时刻（按人口计）。
   * 有这一项时 place 摆的位置由规划定（地块带 ref，路的 id 在一百万以上）。手动铺的路、手动摆的地块照常和它混在同一份状态里，
   * 手动的优先：规划里落在手动的东西上的房子、田让开，贴着手动的路并排走的规划的路不要；规划的路不能拆。
   * 手动改了地形，规划按改过的地形重算；手动的路变了，下一次 place 摆新地块时规划把它们当骨架重算
   */
  plan?: {
    horizon: number
    pop: number
    /** 规划认作骨架的手动的路（中线与路面宽）：摆新地块时换成那时的手动的路，规划跟着重算 */
    guides?: { line: GrowP[]; width: number }[]
  }
  nextId: number
  /** 已经走了几步（每次 place 加一） */
  step: number
}

export interface PlaceReq {
  use: string
  /** 一块地几个单位（一个单位 20 × 20 米；面宽按单位数加长，进深不变） */
  area: number
  owner?: string
  /** 要几块（同一个 owner 的一片）：一块一块地摆，后面的挨着前面的 */
  count?: number
  /** 新地块的状态（默认 built） */
  state?: 'building' | 'built'
}

export interface PlaceResult {
  state: GrowState
  /** 这次摆下的全部地块（按摆的先后） */
  lots: GrowLot[]
  /** 这次新开或延长了的路（延长的是同一 id 的新版本） */
  roads: GrowRoad[]
}

/** 生长状态的版本（GrowState.v）：选址规则改了、旧状态接不上时加一；调用方可以拿它认出旧存档里的状态，丢掉重摆 */
export declare const GROW_VERSION: number

/** 一片空地 + 一两条对外的路 + 村心（一块 center 地） */
export declare function seedState(p: GrowParams): GrowState
/** 只有一片空地（没有路、没有村心；center 暂取画幅中间）：从零开始手动铺路、摆地块；铺了路以后 place 才找得到地方 */
export declare function blankState(p: GrowParams): GrowState
/** 找一处摆下；不修改传入的 state，返回新的。找不到（连延路也不行）返回 null */
export declare function place(state: GrowState, req: PlaceReq, salt: number): PlaceResult | null
/** 退掉一块地：变成 vacant、去掉 owner（返回新的 state） */
export declare function release(state: GrowState, lotId: number): GrowState
/** 改一块地的状态：在建 → 盖好（返回新的 state；没有这块、已经是这个状态时原样返回） */
export declare function setState(state: GrowState, lotId: number, s: 'building' | 'built'): GrowState
/**
 * 手动铺一条路：端点离已有的路不到几米就接上去；跨水、压到地块、出画幅、太短的拒绝，error 说明原因、fault 是原因的代号。
 * opts.bridge：可以跨过河、湖（画图时那一段是桥；两头要在岸上，一座桥不能太长，海不能跨）
 */
export declare function addRoad(
  state: GrowState,
  pts: GrowP[],
  kind: GrowRoadKind,
  opts?: { bridge?: boolean },
): { state: GrowState; road: GrowRoad } | { error: string; fault: GrowFault }
/** 拆掉一条路：路上还有临街的地块（在用的）就拒绝（opts.lots：连同这些地块一起拆）；临着它的空地一并去掉 */
export declare function removeRoad(state: GrowState, roadId: number, opts?: { lots?: boolean }): { state: GrowState } | { error: string }

/** 手动摆放时试出来的位置：poly 是地块的四个角，road 是临的路；fault 给了就是摆不下的原因 */
export interface LotProbe {
  poly: GrowP[]
  road: number
  fault?: GrowFault
}
/**
 * 在 p 附近试一块地（不改状态；指针悬停时的预览）：沿最近的路吸附到临街的位置，田、料场还可以接在同类地块的背后、两旁。
 * 附近有摆得下的位置就给最近的那个；都摆不下给最近的那个和原因；附近没有路返回 null
 */
export declare function probeLot(state: GrowState, use: string, area: number, p: GrowP): LotProbe | null
/**
 * 手动在 p 附近摆一块地（位置同 probeLot）：马上盖好（req.state 可以改）。和 place 不同，不给以后的岔路留路口、压到的空地直接去掉。
 * use 是 center 时村心（state.center）挪到这块地上
 */
export declare function placeAt(
  state: GrowState,
  req: { use: string; area?: number; owner?: string; state?: 'building' | 'built' },
  p: GrowP,
): { state: GrowState; lot: GrowLot } | { error: string; fault: GrowFault }
/** 拆掉一块地：整块去掉（release 是空出来、形状留着） */
export declare function removeLot(state: GrowState, lotId: number): GrowState
/**
 * 把一笔记进状态（半径、坐标取整），别的不动：paintTerrain 的头一步。
 * 可以先拿它得到改完地形的状态（比如先在别处把它的规划算好），再调 paintTerrain
 */
export declare function withStroke(state: GrowState, stroke: GrowStroke): GrowState
/** 在地形上画一笔（返回新的 state）；水漫到的手动地块一并去掉，flooded 是去掉了几块。自然生长的聚落里规划的地块按新地形的规划重新落 */
export declare function paintTerrain(state: GrowState, stroke: GrowStroke): { state: GrowState; flooded: number }
/** 划一片分区（至少三个点、在画幅里） */
export declare function zone(state: GrowState, poly: GrowP[], use: string): { state: GrowState; zone: GrowZone } | { error: string }
/** 取消一片分区（已经盖在里面的不动） */
export declare function unzone(state: GrowState, zoneId: number): GrowState
/** 点在哪一片分区里（后划的在上面） */
export declare function zoneAtPoint(state: GrowState, p: GrowP): GrowZone | undefined
/** 一个字符串的 32 位哈希（给调用方算 salt 用；与 cartographer 的 hashString 相同） */
export declare function growHash(s: string): number
/** 地块的中心点 */
export declare function lotCenter(lot: GrowLot): GrowP
/** 点落在哪块地上（不算 vacant 的） */
export declare function lotAtPoint(state: GrowState, p: GrowP): GrowLot | undefined
/**
 * 沿路网从 from 走到 to 的折线（只给画图看）：先垂直走到最近的那段路上，沿路网按长度走最短的一条，到离 to 最近的那段路上，再走到 to。
 * 两点不到一块地宽、同一块地上、没有路、路网不连通时直接直线 [from, to]。路网图按 state.roads 记着，不每次重建
 */
export declare function route(state: GrowState, from: GrowP, to: GrowP): GrowP[]
