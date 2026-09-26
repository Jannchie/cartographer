import { RNG, hashString } from './rng'
import type { Label } from './types'

// 取名用字：山川、方位、色彩、古地名常用字
const POOL = [...'青苍玄赤碧金朔岚澜岐雍凉幽冀扬荆豫梁蜀越吴楚燕赵秦晋齐鲁云龙凤鹤松霜雪月星辰阳安平宁定康永昌兴丰泰华洛渭泾沅湘沧澄清明灵翠琅邺襄临淮峨岷昆仑祁连贺兰长白衡嵩恒岱庐紫丹玉瑶琼碣崖溪泉浦汀渚鸣栖望归远怀武威朔方玄武白鹿苍梧']
const HEAD_ONLY = [...'东西南北上下大小']

type Kind = Label['kind'] | 'realm' | 'world'

const SUFFIX: Record<Kind, string[]> = {
  continent: ['洲'],
  island: ['岛', '屿', '洲'],
  ocean: ['洋'],
  sea: ['海'],
  range: ['山', '岭', '山脉'],
  basin: ['盆地', '原'],
  desert: ['大漠', '沙海', '漠'],
  forest: ['林', '林海'],
  lake: ['湖', '泽', '池'],
  city: ['城', '州', '县', '镇', '关', '渡', ''],
  capital: ['京', '都', '城'],
  realm: ['国', '王国', '帝国', '公国'],
  world: [''],
}

/** 中文地名：同一世界内不重名，按种子确定 */
export class ZhNamer {
  private used = new Set<string>()
  constructor(private seed: string) {}

  /** suffix 指定时覆盖默认后缀（如国名随政体而定） */
  name(kind: Kind, key: string, suffix?: string): string {
    const rng = new RNG(hashString(`${this.seed}|${kind}|${key}`))
    for (let t = 0; t < 40; t++) {
      const suf = suffix ?? rng.pick(SUFFIX[kind])
      const len = suf.length >= 2 || kind === 'city' ? rng.int(1, 2) : 2
      let base = ''
      while (base.length < len) {
        const c = rng.pick(POOL)
        if (!base.includes(c)) base += c
      }
      if (rng.next() < 0.12 && kind !== 'world' && base.length === 1) base = rng.pick(HEAD_ONLY) + base
      // 城市若无后缀，至少两个字
      if (kind === 'city' && suf === '' && base.length < 2) base += rng.pick(POOL)
      const n = base + suf
      if (this.used.has(n)) continue
      this.used.add(n)
      return n
    }
    return key
  }
}
