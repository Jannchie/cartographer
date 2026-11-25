/**
 * 沙盘的文明套件注册表：文明 id → 这种文明在沙盘上的做法（建筑体块、城防、院墙、桥、码头与船、小品、植被）。
 * 沙盘层的各模块只读套件的字段、调用套件的钩子，不判断文明 id；新增一种文明 = 注册一套 TownKit。
 *
 * 本模块只做注册与查询，不导入任何具体文明的代码。内置文明的套件在 src/packs/ 下，
 * 由沙盘层的入口模块（massing.ts、townScene.ts）经 src/packs/town3d 在模块导入时静态注册，
 * 主线程与 Worker 各自生效。与聚落层的文明定义（src/settlement/culture.ts）分开：聚落生成不引入渲染代码。
 */
import type { Group } from './groups'
import type { Site } from './kit'
import type { RGB } from './mesh'
import type { Ctx } from './shared'
import type { ShipEnv } from './harbor'
import type { TreeHabitat, TreeKind, TreeMix } from './vegetation'
import type { StoneWall, WCtx, WallLook } from './works'
import type { ArchShape, Ax } from './worksMesh'

/** 棚屋、仓房的做法 */
export type ShedLook =
  | {
      /** 土坯墙、平屋顶 */
      adobe: true
    }
  | {
      adobe?: false
      /** 进深够大的一部分盖成白壁瓦顶、厚墙的土藏 */
      kura?: boolean
      /** 屋面材质（MAT）：色调参数大于 split 时用 hi，否则用 lo */
      roof: { split: number; hi: number; lo: number }
      /** 瓦顶（MAT.tileEast）的瓦色 */
      tile: readonly RGB[]
      /** 两坡顶的坡度 */
      pitch: number
    }

/** 墓 */
export interface GraveKit {
  /** 墓地里按"小棚"给出的墓（buildings.ts）；不给时是一方墓台与立在一头的碑，石色取 stone（不给用通用的石色） */
  marker?(c: Ctx, s: Site): void
  stone?: RGB
  /** 墓地片区里的一座墓（props.ts）：f 为墓的框，g 为地面高度，len / wid 为墓地的长宽 */
  plot(c: WCtx, f: Ax, g: number, len: number, wid: number): void
}

/** 城防 */
export interface WallKit {
  /** 石墙的形制：k 为按墙厚定的高度系数，s 为按墙厚定的尺度系数（木栅各文明相同，见 works.ts） */
  stone(k: number, s: number): StoneWall
  /** 墙上屋顶（敌楼、橹、望楼）的屋面材质（MAT）；山面材质不给时用墙面的材质 */
  roofFace: number
  gableFace?: number
  /** 石墙上的塔楼：f 的 u 朝城外、v 沿墙，原点在墙中线上；g 为塔心的地面高度，lo 为塔脚埋到的高度 */
  tower(c: WCtx, look: WallLook, f: Ax, R: number, roofed: boolean, g: number, lo: number): void
  /** 石墙的城门：f 的原点为门心，u 朝城外、v 沿墙；g 为门心的地面高度，yb 为台脚埋到的高度 */
  gate(c: WCtx, look: WallLook, f: Ax, g: number, yb: number): void
}

/** 院墙 */
export interface FenceKit {
  /**
   * 院墙的种类：tiled 为瓦顶的墙（带小门楼），tall 为抹灰的高墙（尖拱门洞）；
   * 不给时按所在片区：园子是铁栏杆，乡下是树篱或石墙，城里是石墙
   */
  kind?: 'tiled' | 'tall'
  /** 很小的院子只做一道矮石沿：石色 */
  kerb: RGB
  /** 瓦顶墙的细部（kind 为 tiled 时必填） */
  tiled?: {
    /** 墙高：[大院子, 小院子] */
    hgt: [number, number]
    /** 墙身的颜色；不给时按位置在两种灰里取 */
    body?: RGB
    /** 门楼的柱色、门扇色与门楼顶的坡度 */
    post: RGB
    leaf: RGB
    pitch: number
  }
}

/** 桥：木桥，或石拱桥（石色、材质、拱形、栏杆形式、矢高与跨度之比及其上限） */
export type BridgeKit =
  | { timber: true }
  | { timber?: false; col: RGB; face: number; arch: ArchShape; rail: 'parapet' | 'balustrade'; riseK: number; riseMax: number }

/** 码头与船 */
export interface HarborKit {
  /** 石砌岸壁的石色；不给时码头是木桩上的栈台 */
  quay?: RGB
  /** 船壳的底色 */
  tar: RGB
  /** 小艇：blunt 为方头平底的舢板；awning 为船中带一段席篷（否则是一对桨） */
  skiff: { blunt: boolean; awning: boolean }
  /** 大船张着帆的比例 */
  sail: number
  /** 大船（船长 8.2 米以上）的船型 */
  ship(c: WCtx, e: ShipEnv): void
}

/** 小品 */
export interface PropsKit {
  /** 井、雕像这类地标小品的朝向在直角之外再带一点随机偏转 */
  skew: boolean
  /** 市集摊棚的棚顶为木板或草顶：颜色与材质；不给时是条纹篷布（前柱更高，前檐垂一道布边） */
  stallRoof?: { col: RGB; face: number }
  /** 灯塔：塔身的颜色与材质、灯室顶的颜色 */
  lighthouse: { col: RGB; face: number; cap: RGB }
  /** 井：square 为四块板围成的方井栏（否则是圆井栏），井栏的颜色与材质，井架小顶的颜色与材质 */
  well: { square: boolean; col: RGB; face: number; roof: RGB; roofFace: number }
  /** 喷泉的水池：边数、池沿高、石色、池沿顶面的颜色、中柱顶上有没有喷口；不给时是大理石的圆池带喷口 */
  fountain?: { sides: number; kerb: number; stone: RGB; rim: RGB; jet: boolean }
  /** 雕像的位置上立什么（石灯笼、石碑）；不给时是台座上的铜像 */
  statue?(c: WCtx, f: Ax, g: number): void
  /** 置石：高度 = 半径 × (base + 位置哈希 × vary)，石色；不给时是矮而稳的灰石 */
  rock?: { base: number; vary: number; col: RGB }
  /** 草垛：垛脚半径、垛身高、垛顶高（均为垛半径的倍数）；不给时是高而尖的圆垛 */
  haystack?: { foot: number; body: number; top: number }
}

/** 植被 */
export interface FloraKit {
  /** 各环境里的树种与权重（野地的权重再乘上各树种的成片噪声） */
  mix: Record<TreeHabitat, TreeMix>
  /** 行道树（整条路一个树种）、果园（整块田一个树种）的候选，窄处（贴着房子、树冠放不开）换用的树种 */
  avenue: TreeKind[]
  orchard: TreeKind[]
  narrow: TreeKind
  /** 没有世界气候时的年均温（°C） */
  temp: number
  /** 按种子定春、夏、秋的季相（花色与秋色）；否则常夏 */
  seasons: boolean
  /** 园林里靠水处栽的树（h 为位置哈希）；不给时照所在环境的树种表抽 */
  pondside?(h: number): TreeKind
  /** 树旁灌木的种类（h 为位置哈希）；不给时一律是普通灌木 */
  shrub?(ctx: TreeHabitat, h: number): TreeKind
  /** 牧场四周围树篱 */
  bocage: boolean
  /** 城边的菜园围矮篱 */
  kitchenHedge: boolean
}

/** 一种文明在沙盘上的全套做法 */
export interface TownKit {
  /** 层高（米）：民居按"层数 × 层高"起墙，着色器按它分层排窗 */
  storey: number
  /** 立面细部的着色器族编号（buildingShader.ts 的 BLD_CULTURE：0 西式、1 东方、2 和式、3 伊斯兰），按编号编译着色器 */
  facade: number
  /** 一栋建筑的体块（棚屋、法师塔由 buildings.ts 统一处理，不经这里）；g 为它所在的组合地标（没有为 null） */
  building(c: Ctx, s: Site, g: Group | null): void
  shed: ShedLook
  grave: GraveKit
  wall: WallKit
  fence: FenceKit
  bridge: BridgeKit
  harbor: HarborKit
  props: PropsKit
  flora: FloraKit
}

const kits = new Map<string, TownKit>()

/** 注册一种文明的沙盘套件（同一 id 后注册的覆盖先注册的） */
export function registerTownKit(culture: string, kit: TownKit) {
  kits.set(culture, kit)
}

/** 某种文明的沙盘套件；没有注册时抛出 */
export function townKit(culture: string): TownKit {
  const kit = kits.get(culture)
  if (!kit) throw new Error(`文明 "${culture}" 没有注册沙盘套件（registerTownKit）：入口模块需要导入 src/packs/town3d`)
  return kit
}
