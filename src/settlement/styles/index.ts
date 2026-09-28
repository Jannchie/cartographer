import type { CultureStyle } from '../culture'
import type { Culture } from '../types'
import { eastern } from './eastern'
import { islamic } from './islamic'
import { wa } from './wa'

/** 各文明自己的盖法（西方用 features.ts 的通用填法） */
export const STYLES: Record<Culture, CultureStyle> = { western: {}, eastern, wa, islamic }
