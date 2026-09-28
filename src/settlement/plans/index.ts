import { bastide } from './bastide'
import { castrum } from './castrum'
import { jokamachi } from './jokamachi'
import { lifang } from './lifang'
import { medina } from './medina'
import type { Culture } from '../types'
import type { CityPlan, PlanId } from './types'

/** 城市形制注册表（有机生长不在表里） */
export const PLANS: Record<Exclude<PlanId, 'organic'>, CityPlan> = { lifang, castrum, bastide, medina, jokamachi }

/** 界面用：形制的名称与说明 */
export const PLAN_INFO: { id: PlanId; name: string; desc: string; by?: Partial<Record<Culture, { name: string; desc: string }>> }[] = [
  { id: 'organic', name: '有机生长', desc: '沿干道、河流自然长成的街巷' },
  {
    id: 'lifang',
    name: '里坊制',
    desc: '方正的外郭、坊墙围合的里坊、北居中的宫城与东西两市',
    by: { wa: { name: '条坊制', desc: '平安京式：棋盘的条坊、每坊十六町、北居中的大内里与东西两市，只在南面有罗城门' } },
  },
  { id: 'castrum', name: '罗马营寨城', desc: '南北大街与东西大街十字相交，路口旁是广场与神庙，方整的街区，墙内一圈顺城街' },
  { id: 'bastide', name: '方格新城', desc: '中世纪新建的方格城镇，中心是带拱廊的市场广场' },
  { id: 'medina', name: '麦地那', desc: '大清真寺与集市居中，几条穿城的主街，其余是尽端巷与内院住宅' },
  { id: 'jokamachi', name: '城下町', desc: '城堡居中、护城河环绕，武家地、町人地、寺町按身份分层，路口错开的枡形' },
]
/** 形制在这个文明里的叫法（日本的里坊叫条坊） */
export const planLabel = (f: (typeof PLAN_INFO)[number], c: Culture) => f.by?.[c] ?? f
