// 自然生长对外的接口（实现在 natural.ts；check-api.ts 在编译期核对）。
// 它要 cartographer 整套一次成形的生成器，所以单独一个入口：要先启动插件（文明等内容由插件登记），不像 api.d.ts 那几样不启动插件也能跑。
// 载入这个入口之后，api.d.ts 里的 place、画图入口的 drawGrow 才认带 plan 的状态。
import type { GrowParams, GrowState } from './api'

/**
 * 自然生长的开局：这片地按 horizon 人的规模规划（和聚落地图里同一个种子、人口取 horizon 的那座城是同一份规划），从还没有人的时候起。
 * 画幅由规划的规模定（p.size 不用）。之后照常用 place：住处等用途一块地是规划里一户人家的位置，田是认领已经开出来的田块；
 * 规划的规模住满以后 place 返回 null
 */
export declare function seedNatural(p: GrowParams, horizon: number): GrowState
/**
 * 手动铺了路、摆了地块之后把规划的地块理一遍：被压住的住户、田挪到近处（没有 plan 的状态原样返回）。
 * 不调也行——下一次 place 开头会做同样的事，只是在那之前状态里还留着压在手动东西底下的规划地块
 */
export declare function settleNatural(state: GrowState): GrowState
/**
 * 规划认的手动的路换成现在的这些（别的不动；本来就一样时原样返回）。place 摆新地块时自己会换；
 * 先调它可以拿到换上之后的状态，提前把那份规划算好
 */
export declare function withGuides(state: GrowState): GrowState
