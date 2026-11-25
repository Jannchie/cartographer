import type { SacredNames, SettleNamer } from '../../settlement/names'
import type { Tri } from '../../settlement/types'
import { EAST_SACRED } from './eastern/naming'
import { ISLAMIC_SACRED } from './islamic/naming'
import { WA_SACRED } from './wa/naming'
import { WEST_SACRED } from './western/naming'

const only = (t: SacredNames, kinds: string[]): SacredNames => Object.fromEntries(kinds.map((k) => [k, t[k]]))

/**
 * 规模档与名所的专名在本包里的缺省叫法：某个文明对一种名所没有自己的讲究时，按这种名所原属的文明起名
 *（西式的城里盖了山寺，名字按东方的规矩；东方的城里有了修道院，按西式的）。
 * 神社一类原属和风，寺、塔、土地庙原属东方，里巴特、街区清真寺原属伊斯兰，其余原属西式。
 */
const SHARED: SacredNames = {
  ...only(WA_SACRED, ['taisha', 'inari', 'okumiya', 'umi', 'shinkyo']),
  ...only(EAST_SACRED, ['villageShrine', 'yamadera', 'pagoda', 'grandTemple', 'tudi']),
  ...WEST_SACRED,
  ...only(ISLAMIC_SACRED, ['ribat', 'masjid']),
}

/** 一个文明的名所起名：先用它自己的叫法（own），没有再用本包的缺省 */
export const sacredNamer =
  (own: SacredNames) =>
  (n: SettleNamer, kind: string): Tri => {
    const make = own[kind] ?? SHARED[kind]
    if (!make) throw new Error(`名所的专名没有约定：${kind}`)
    return make(n)
  }
