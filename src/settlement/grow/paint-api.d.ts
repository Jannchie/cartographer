// 生长引擎的画图入口对外的接口（实现在 paint.ts；check-api.ts 在编译期核对）。只在浏览器、离线脚本里用：要先 bootPaint。
import type { GrowState } from './api'

export interface GrowDrawOpts {
  /** 皮肤 id（color、kiriezu、parchment……）：要在 bootPaint 的 styles 里 */
  style: string
  /** 田的种类：paddy 水田、crop 旱地……（默认 crop） */
  fieldKind?: 'crop' | 'pasture' | 'orchard' | 'paddy' | 'vineyard' | 'garden' | 'meadow'
}

/** 画好的一张图（矢量显示列表）：页面坐标 = M + 米 × S */
export interface GrowPicture {
  /** 页面像素 / 米 */
  S: number
  /** 地图左上角在页面上的偏移（页面像素） */
  M: number
  /** 整页的宽、高（页面像素） */
  width: number
  height: number
  /** 只画地图（不画图框、标题）：scale 页面像素 → 画布像素，(ox, oy) 页面原点在画布上的位置 */
  render(ctx: CanvasRenderingContext2D, scale: number, ox: number, oy: number): void
  /** 整页的 SVG（带图框） */
  toSVG(): string
}

/**
 * 启动画图要的最少插件：给出的文明（默认 wa）和皮肤（默认 color）。一个运行环境只启动一次；
 * 再调用时给出的都已启动过就直接返回，有没启动过的就报错。Node 里要先伪造 document（见 scripts/lib/canvas.ts）
 */
export declare function bootPaint(o?: { cultures?: string[]; styles?: string[] }): Promise<void>
/** 把生长状态画成一张图（measurer 用来量字宽） */
export declare function drawGrow(state: GrowState, o: GrowDrawOpts, measurer: CanvasRenderingContext2D): GrowPicture
