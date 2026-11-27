// 编译期核对：实现满足 api.d.ts / paint-api.d.ts 里写给外部项目的签名（外部项目只看那两个文件，不看实现）。
// 不会被任何入口导入，只在 tsc --noEmit 时检查；签名对不上这里就编译不过。
import type * as Api from './api'
import * as Impl from './index'
import type * as PaintApi from './paint-api'
import * as PaintImpl from './paint'
import type * as NaturalApi from './natural-api'
import * as NaturalImpl from './natural'

type Fns<T> = { [K in keyof T as T[K] extends (...a: never[]) => unknown ? K : never]: T[K] }

export const growApiMatches: Fns<typeof Api> = Impl
export const paintApiMatches: Fns<typeof PaintApi> = PaintImpl
export const naturalApiMatches: Fns<typeof NaturalApi> = NaturalImpl
