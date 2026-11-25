import { tradeDef as T, type CulturePeople, type Scheme } from '../../../settlement/people'

/** 职业分法：士農工商（武士在最上） */
const SCHEME: Scheme = {
  groups: [
    { id: 'bushi', name: ['武士', 'Samurai', '武士'], cls: 'elite' },
    { id: 'no', name: ['农', 'Farmers', '農'], cls: 'farm' },
    { id: 'ko', name: ['工', 'Artisans', '工'], cls: 'craft' },
    { id: 'sho', name: ['商', 'Merchants', '商'], cls: 'trade' },
    { id: 'shaji', name: ['寺社', 'Clergy', '寺社'], cls: 'clergy' },
    { id: 'zatsu', name: ['杂业', 'Labourers and servants', '雑業'], cls: 'labor' },
  ],
  trades: [
    T('bushi', 'retainer', '藩士', 'Retainer', '藩士'),
    T('bushi', 'ashigaru', '足轻', 'Foot soldier', '足軽'),
    T('no', 'farmer', '百姓', 'Farmer', '百姓'),
    T('ko', 'carpenter', '大工', 'Carpenter', '大工'),
    T('ko', 'smith', '锻冶', 'Smith', '鍛冶'),
    T('ko', 'dyer', '染物', 'Dyer', '染物屋'),
    T('ko', 'cooper', '桶屋', 'Cooper', '桶屋'),
    T('sho', 'wholesaler', '问屋', 'Wholesaler', '問屋'),
    T('sho', 'shopkeeper', '小卖', 'Shopkeeper', '小売'),
    T('sho', 'innkeeper', '旅笼', 'Innkeeper', '旅籠'),
    T('sho', 'brewer', '酒屋', 'Sake brewer', '酒屋'),
    T('shaji', 'monk', '僧侣', 'Monk', '僧侶'),
    T('shaji', 'priest', '神职', 'Shinto priest', '神職'),
    T('zatsu', 'labourer', '日雇', 'Day labourer', '日雇い'),
    T('zatsu', 'boatman', '船头', 'Boatman', '船頭'),
    T('zatsu', 'servant', '奉公人', 'Servant', '奉公人'),
  ],
  mix: {
    common: { carpenter: 1, smith: 0.5, dyer: 0.5, cooper: 0.5, shopkeeper: 1.5, labourer: 1.4, farmer: 0.3 },
    craft: { carpenter: 1.2, smith: 1, dyer: 1, cooper: 0.8, labourer: 0.4 },
    merchant: { wholesaler: 1.2, shopkeeper: 2, brewer: 0.6, innkeeper: 0.4 },
    market: { shopkeeper: 2, wholesaler: 0.8, innkeeper: 0.6, labourer: 0.6 },
    noble: { retainer: 3, ashigaru: 0.8 },
    slum: { labourer: 2, boatman: 0.4, cooper: 0.3 },
    harbor: { boatman: 2, wholesaler: 1, labourer: 1.2, carpenter: 0.4 },
    temple: { monk: 1.5, priest: 1, shopkeeper: 0.5 },
    castle: { retainer: 2, ashigaru: 1 },
    barracks: { ashigaru: 3, retainer: 0.5 },
    suburb: { farmer: 1.5, labourer: 0.6, innkeeper: 0.4, shopkeeper: 0.4 },
    rural: { farmer: 5, carpenter: 0.15 },
    estate: { retainer: 2, wholesaler: 0.5 },
  },
  servants: 'zatsu',
  // 城下町以外的町（在町、港町、门前町）：武士很少；城下町另按武家地的比例（见 targetShares）
  profile: { bushi: 0.08, no: 0.06, ko: 0.22, sho: 0.24, shaji: 0.03 },
}

export const people: CulturePeople = {
  scheme: SCHEME,
  // 各种专门片区住满时每公顷住多少人（连仆役、学徒；在样例城里量出来的，样本少的取整、偏保守）
  wardDensity: { noble: 100, merchant: 210, craft: 95, slum: 100 },
  // 平均一户几口相对每户人数的倍数（各种大小、营生的户按一座城里常见的比例折算，实测值）
  homeK: 1.33,
}
