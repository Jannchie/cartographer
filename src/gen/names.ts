import { RNG } from './rng'

/**
 * 每个世界随机生成一门"语言"：固定的辅音/元音库存、音节结构与常用词尾，
 * 于是同一世界里的地名听起来像出自同一种语言。
 */
export class Language {
  private C: string[]
  private V: string[]
  private L: string[]
  private F: string[]
  private structs: string[]
  private endings: string[]
  private used = new Set<string>()
  private minSyl: number
  private maxSyl: number

  constructor(private rng: RNG) {
    const consonantSets = [
      'ptkmnslrvdg',
      'ptkbdgmnlrsz',
      'kgtdmnrlsh',
      'mnptkslrwy',
      'bdfgklmnprstvz',
      'thkrlmnsvd',
      'ptkqmnlrsx',
    ]
    const vowelSets = ['aeiou', 'aiu', 'aeiouy', 'aeio', 'aaeiou', 'eiou']
    const liquids = ['lr', 'l', 'r', 'lrw', 'rn']
    const finals = ['mnrs', 'nl', 'nrth', 'sk', 'mnd', 'nrl', 'st']
    this.C = [...rng.pick(consonantSets)]
    this.V = [...rng.pick(vowelSets)]
    this.L = [...rng.pick(liquids)]
    this.F = [...rng.pick(finals)]
    // 双字母组合让名字更有质感
    const digraphs = ['th', 'sh', 'ch', 'ph', 'gh', 'kh', 'zh', 'rh']
    for (let i = 0; i < 2; i++) if (rng.next() < 0.5) this.C.push(rng.pick(digraphs))
    const structSets = [
      ['CV', 'CVC', 'CV', 'V'],
      ['CVC', 'CV', 'CVV'],
      ['CV', 'CLV', 'CVC'],
      ['CV', 'CVF', 'V', 'CV'],
      ['CVC', 'VC', 'CV'],
    ]
    this.structs = rng.pick(structSets)
    const endSets = [
      ['ia', 'or', 'an', 'eth', 'is'],
      ['heim', 'dal', 'gard', 'mark', 'vik'],
      ['ora', 'ano', 'ella', 'ino', 'esa'],
      ['ul', 'ar', 'oth', 'um', 'ak'],
      ['ai', 'en', 'ou', 'yn', 'ea'],
      ['ton', 'ford', 'wick', 'mere', 'by'],
    ]
    this.endings = rng.pick(endSets)
    this.minSyl = rng.int(1, 2)
    this.maxSyl = this.minSyl + rng.int(1, 2)
  }

  private syllable(): string {
    const st = this.rng.pick(this.structs)
    let s = ''
    for (const ch of st) {
      if (ch === 'C') s += this.rng.pick(this.C)
      else if (ch === 'V') s += this.rng.pick(this.V)
      else if (ch === 'L') s += this.rng.pick(this.L)
      else if (ch === 'F') s += this.rng.pick(this.F)
    }
    return s
  }

  word(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      const n = this.rng.int(this.minSyl, this.maxSyl)
      let w = ''
      for (let i = 0; i < n; i++) w += this.syllable()
      if (this.rng.next() < 0.35) w += this.rng.pick(this.endings)
      // 去掉难读的三连辅音和重复字母
      w = w.replace(/([^aeiouy])\1+/g, '$1').replace(/([aeiouy])\1\1+/g, '$1$1')
      if (/[^aeiouy]{3,}/.test(w)) continue
      if (w.length < 3 || w.length > 11) continue
      if (this.used.has(w)) continue
      this.used.add(w)
      return w[0].toUpperCase() + w.slice(1)
    }
    return 'Nameless'
  }
}
