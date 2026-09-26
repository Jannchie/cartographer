import type { Label } from './types'

type Kind = Label['kind'] | 'realm' | 'world'

/**
 * 日文地名：奇幻作品日文版的惯例——专名按读音转写成片假名，再接地理通名
 * （山脈、海、湖、砂漠……）。英文名里的通名（Sea of / Lake / Mountains 等）先剥掉，只转写词根。
 */
const SUFFIX: Partial<Record<Kind, string>> = {
  ocean: '大洋',
  sea: '海',
  range: '山脈',
  basin: '盆地',
  desert: '砂漠',
  forest: 'の森',
  lake: '湖',
  island: '島',
}

/** 从英文名里取出专名词根 */
function root(kind: Kind, name: string): { base: string; suffix: string } {
  let s = name.trim()
  let suffix = SUFFIX[kind] ?? ''
  const strip = (re: RegExp) => {
    const m = s.match(re)
    if (m) s = (m[1] ?? '').trim()
    return !!m
  }
  if (kind === 'ocean' || kind === 'sea') strip(/^Sea of (.+)$/i) || strip(/^(.+?) (Ocean|Sea)$/i)
  else if (kind === 'range') {
    if (!strip(/^(.+?) Mountains$/i) && strip(/^The (.+?)s$/i)) suffix = '山脈'
  } else if (kind === 'basin') strip(/^(.+?) Basin$/i)
  else if (kind === 'desert') strip(/^(.+?) Desert$/i)
  else if (kind === 'forest') {
    if (!strip(/^(.+?) Forest$/i)) strip(/^(.+?)wood$/i)
  } else if (kind === 'lake') {
    if (strip(/^Salt Lake (.+)$/i)) suffix = '塩湖'
    else strip(/^Lake (.+)$/i)
  } else if (kind === 'island') suffix = ''
  return { base: s, suffix }
}

/** 片假名表：子音 × 母音 */
const KANA: Record<string, string[]> = {
  '': ['ア', 'イ', 'ウ', 'エ', 'オ'],
  k: ['カ', 'キ', 'ク', 'ケ', 'コ'],
  g: ['ガ', 'ギ', 'グ', 'ゲ', 'ゴ'],
  s: ['サ', 'シ', 'ス', 'セ', 'ソ'],
  z: ['ザ', 'ジ', 'ズ', 'ゼ', 'ゾ'],
  t: ['タ', 'ティ', 'トゥ', 'テ', 'ト'],
  d: ['ダ', 'ディ', 'ドゥ', 'デ', 'ド'],
  n: ['ナ', 'ニ', 'ヌ', 'ネ', 'ノ'],
  h: ['ハ', 'ヒ', 'フ', 'ヘ', 'ホ'],
  b: ['バ', 'ビ', 'ブ', 'ベ', 'ボ'],
  p: ['パ', 'ピ', 'プ', 'ペ', 'ポ'],
  m: ['マ', 'ミ', 'ム', 'メ', 'モ'],
  y: ['ヤ', 'イ', 'ユ', 'イェ', 'ヨ'],
  r: ['ラ', 'リ', 'ル', 'レ', 'ロ'],
  w: ['ワ', 'ウィ', 'ウ', 'ウェ', 'ウォ'],
  f: ['ファ', 'フィ', 'フ', 'フェ', 'フォ'],
  v: ['ヴァ', 'ヴィ', 'ヴ', 'ヴェ', 'ヴォ'],
  sh: ['シャ', 'シ', 'シュ', 'シェ', 'ショ'],
  ch: ['チャ', 'チ', 'チュ', 'チェ', 'チョ'],
  j: ['ジャ', 'ジ', 'ジュ', 'ジェ', 'ジョ'],
  ts: ['ツァ', 'ツィ', 'ツ', 'ツェ', 'ツォ'],
}
/** 音节末尾（后面没有母音）的子音 */
const CODA: Record<string, string> = {
  k: 'ク', g: 'グ', s: 'ス', z: 'ズ', t: 'ト', d: 'ド', h: '', b: 'ブ', p: 'プ',
  r: 'ル', f: 'フ', v: 'ヴ', sh: 'シュ', ch: 'チ', j: 'ジ', ts: 'ツ', w: 'ウ', y: 'イ',
}
const VOWEL: Record<string, number> = { a: 0, i: 1, u: 2, e: 3, o: 4, y: 1 }

/** 拉丁字母拼写 → 片假名 */
export function katakana(word: string): string {
  const s = word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '')
    // 拼写规整：l→r、c→k/s、q→k、x→ks、th→s、ph→f、ck→k
    .replace(/th/g, 's')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'kw')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/l/g, 'r')
  let out = ''
  let i = 0
  let lastVowel = -1
  while (i < s.length) {
    // 子音（两字母的优先）
    let cons = ''
    for (const d of ['sh', 'ch', 'ts']) if (s.startsWith(d, i)) cons = d
    if (!cons && !(s[i] in VOWEL && !(s[i] === 'y' && s[i + 1] in VOWEL))) cons = s[i]
    const j = i + cons.length
    const v = s[j]
    // 双写子音：促音
    if (cons && cons.length === 1 && s[j] === cons && cons !== 'n' && cons !== 'm' && cons !== 'r') {
      out += 'ッ'
      i = j
      continue
    }
    if (v !== undefined && v in VOWEL && !(cons === '' && v === 'y' && s[j + 1] in VOWEL)) {
      const vi = VOWEL[v]
      const row = KANA[cons] ?? KANA['']
      const kana = row[vi]
      // 同一母音连续出现拉长
      out += cons === '' && vi === lastVowel ? 'ー' : kana
      lastVowel = vi
      i = j + 1
      continue
    }
    // 没有母音跟着：鼻音 → ン，其余子音补上母音
    if (cons === 'n' || cons === 'm') out += cons === 'm' && !'bpm'.includes(s[j] ?? '') ? 'ム' : 'ン'
    else if (cons in CODA) out += CODA[cons]
    else if (cons) out += KANA[cons]?.[2] ?? ''
    lastVowel = -1
    i = j
  }
  return out
}

/** 日文地名：同一世界内不重名（重名时在后面加「第二」这类区分太生硬，改为接一个长音） */
export class JaNamer {
  private used = new Set<string>()

  name(kind: Kind, en: string): string {
    const { base, suffix } = root(kind, en)
    const words = base.split(/\s+/).filter(Boolean)
    let n = words.map(katakana).join('・') + suffix
    while (this.used.has(n)) n = n.replace(/(.)$/, '$1ー')
    this.used.add(n)
    return n
  }
}
