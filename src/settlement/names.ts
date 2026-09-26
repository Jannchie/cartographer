import { Language } from '../gen/names'
import { RNG, hashString } from '../gen/rng'
import type { Culture, SettlementSize, WardType } from './types'

// 西式地名的音译用字
const TRANS = [...'阿贝卡德艾菲格赫伊洛米诺奥佩罗斯泰维温希亚泽林顿特尔莱伦萨布克拉玛纳瑟索图瓦哈达芬莫里']
// 东式地名用字（吉祥、方位、山水）
const AUSP = [...'安仁崇义永宁平康兴道光德善和怀远长乐宣阳通济延寿丰乐昌明太清嘉会修文敦化常静昭文怀德归义靖恭升平晋昌']
const NATURE = [...'青苍碧金玉云松柏竹梅桃杏柳桐枫溪泉涧月星霞岚峰岩潭']

const WEST_SAINTS = ['圣安德', '圣玛丽', '圣乔治', '圣彼得', '圣米迦勒', '圣卢卡', '圣艾格', '圣伯纳']
const WEST_STREET = ['王冠', '磨坊', '面包师', '铁匠', '织工', '皮匠', '酒馆', '钟楼', '主教', '渔夫', '石桥', '橡树', '玫瑰', '市场', '羊毛', '银匠', '圣灵', '马厩', '烛匠', '桶匠']
const WEST_DISTRICT: Partial<Record<WardType, string[]>> = {
  market: ['集市区', '商会区', '行会区'],
  merchant: ['商人区', '金匠区', '钱庄区'],
  craft: ['工匠区', '铁匠区', '织工区', '制革区', '陶匠区'],
  common: ['老城', '新城', '北区', '南区', '东区', '西区', '河畔区', '钟楼区'],
  slum: ['贫民窟', '泥巷区', '乞丐区'],
  noble: ['贵族区', '领主区', '白石区'],
  harbor: ['码头区', '船坞区', '港口区'],
  temple: ['教堂区', '修道院区'],
  magic: ['秘法区', '法师区', '星象区'],
  suburb: ['外城', '城郊'],
}
const EAST_DISTRICT: Partial<Record<WardType, string[]>> = {
  market: ['东市', '西市', '南市', '北市'],
  harbor: ['码头', '船坞', '渔港'],
  temple: ['寺前坊'],
  magic: ['仙门', '灵境'],
  suburb: ['关厢', '城郊'],
}

export class SettleNamer {
  private used = new Set<string>()
  private lang: Language
  private rng: RNG
  constructor(
    seed: string,
    readonly culture: Culture,
  ) {
    this.rng = new RNG(hashString(seed + '|names'))
    this.lang = new Language(new RNG(hashString(seed + '|lang')))
  }

  private uniq(make: () => string): string {
    return this.tryUniq(make) ?? make()
  }

  /** 候选用尽时返回 undefined（用于可以不命名的场合） */
  private tryUniq(make: () => string): string | undefined {
    for (let t = 0; t < 30; t++) {
      const n = make()
      if (!this.used.has(n)) {
        this.used.add(n)
        return n
      }
    }
    return undefined
  }

  private trans(n: number) {
    let s = ''
    for (let i = 0; i < n; i++) s += this.rng.pick(TRANS)
    return s
  }

  /** 聚落名：原文名 + 中文名 */
  town(size: SettlementSize, coast: boolean, river: boolean): { name: string; zh: string } {
    const r = this.rng
    const name = this.lang.word()
    if (this.culture === 'eastern') {
      const suf = { hamlet: ['村', '庄', '屯'], village: ['村', '镇', '集'], town: ['镇', '县', '城'], city: ['城', '州', '府'] }[size]
      const pre = coast && r.next() < 0.4 ? '海' : river && r.next() < 0.3 ? r.pick(['河', '渡', '津']) : ''
      return { name, zh: this.uniq(() => (pre || r.pick(AUSP)) + r.pick([...AUSP, ...NATURE]) + r.pick(suf)) }
    }
    const suf = { hamlet: ['村', '庄'], village: ['村', '镇'], town: ['镇', '堡'], city: ['城', '堡'] }[size]
    const extra = coast && r.next() < 0.5 ? '港' : river && r.next() < 0.3 ? '桥' : r.pick(suf)
    return { name, zh: this.uniq(() => this.trans(r.int(2, 3)) + extra) }
  }

  river() {
    const r = this.rng
    if (this.culture === 'eastern') return this.uniq(() => r.pick(NATURE) + r.pick(['河', '水', '江', '溪']))
    return this.uniq(() => this.trans(r.int(2, 3)) + '河')
  }

  sea() {
    const r = this.rng
    if (this.culture === 'eastern') return this.uniq(() => r.pick(NATURE) + r.pick(['海', '湾']))
    return this.uniq(() => this.trans(2) + r.pick(['湾', '海']))
  }

  hill() {
    const r = this.rng
    if (this.culture === 'eastern') return this.uniq(() => r.pick(NATURE) + r.pick(['山', '岭', '峰']))
    return this.uniq(() => this.trans(2) + r.pick(['丘', '岭', '山']))
  }

  district(type: WardType): string | undefined {
    const r = this.rng
    if (this.culture === 'eastern') {
      const pool = EAST_DISTRICT[type]
      if (pool) return this.tryUniq(() => r.pick(pool))
      // 里坊：两字吉祥名 + 坊
      return this.uniq(() => r.pick(AUSP) + r.pick(AUSP) + '坊')
    }
    const pool = WEST_DISTRICT[type]
    if (!pool) return undefined
    return this.tryUniq(() => r.pick(pool))
  }

  street(kind: 'main' | 'street' | 'lane'): string {
    const r = this.rng
    if (this.culture === 'eastern') {
      const suf = kind === 'main' ? ['大街', '大道'] : kind === 'street' ? ['街', '街'] : ['巷', '胡同']
      return this.uniq(() => r.pick([...AUSP, ...NATURE]) + (r.next() < 0.5 ? r.pick(AUSP) : '') + r.pick(suf))
    }
    const suf = kind === 'main' ? ['大街', '大道'] : kind === 'street' ? ['街'] : ['巷']
    return this.uniq(() => r.pick(WEST_STREET) + r.pick(suf))
  }

  gate(dirAngle: number): string {
    // dirAngle：城门朝外的方向（屏幕坐标，0 为东，π/2 为南）
    const idx = Math.round(((dirAngle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2)) % 4
    if (this.culture === 'eastern') {
      const names = [
        ['东门', '朝阳门', '东华门', '迎春门'],
        ['南门', '永定门', '正阳门', '朱雀门'],
        ['西门', '西华门', '宣武门', '金光门'],
        ['北门', '安定门', '玄武门', '德胜门'],
      ][idx]
      return this.uniq(() => this.rng.pick(names))
    }
    const names = [
      ['东门', '日出门', '国王门'],
      ['南门', '河门', '王后门'],
      ['西门', '日落门', '狮门'],
      ['北门', '霜门', '塔门'],
    ][idx]
    return this.uniq(() => this.rng.pick(names))
  }

  landmark(kind: 'castle' | 'temple' | 'chapel' | 'market' | 'harbor' | 'magic' | 'shrine' | 'ferry' | 'park' | 'cemetery', magic: number): string {
    const r = this.rng
    if (this.culture === 'eastern') {
      const pool: Record<typeof kind, string[]> = {
        castle: ['府衙', '县衙', '都督府', '王府', '宫城'],
        temple: [r.pick(AUSP) + r.pick(AUSP) + '寺', r.pick(NATURE) + r.pick(AUSP) + '观', '文庙', '城隍庙'],
        chapel: ['祠堂', '宗祠', '土地庙'],
        market: ['市楼', '鼓楼', '钟楼'],
        harbor: ['码头', '市舶司'],
        magic: magic >= 2 ? [r.pick(NATURE) + '霄宗', r.pick(NATURE) + '云仙门', '天衍阁'] : [r.pick(NATURE) + '云观', '藏经阁', '炼丹房'],
        shrine: ['土地庙', '山神庙', '龙王庙'],
        ferry: [r.pick(NATURE) + '渡'],
        park: [r.pick(NATURE) + '园', r.pick(AUSP) + '园'],
        cemetery: ['义冢'],
      }
      return this.uniq(() => r.pick(pool[kind]))
    }
    const pool: Record<typeof kind, string[]> = {
      castle: ['城堡', '领主堡', '要塞', '王宫'],
      temple: [r.pick(WEST_SAINTS) + '大教堂', r.pick(WEST_SAINTS) + '教堂', '修道院'],
      chapel: [r.pick(WEST_SAINTS) + '礼拜堂', r.pick(WEST_SAINTS) + '小教堂'],
      market: ['市政厅', '行会大厅', '谷物交易所'],
      harbor: ['港务所', '灯塔'],
      magic: magic >= 2 ? ['大法师塔', '星辉学院', '奥术议会'] : ['法师塔', '炼金工坊', '观星塔'],
      shrine: ['路边神龛', '圣泉'],
      ferry: [this.trans(2) + '渡口'],
      park: ['王家花园', '公地', '绿苑'],
      cemetery: ['墓园'],
    }
    return this.uniq(() => r.pick(pool[kind]))
  }
}
