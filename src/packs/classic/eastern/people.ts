import { tradeDef as T, type CulturePeople, type Scheme } from '../../../settlement/people'

/** 职业分法：士农工商 */
const SCHEME: Scheme = {
  groups: [
    { id: 'shi', name: ['士', 'Scholar-officials', '士'], cls: 'elite' },
    { id: 'nong', name: ['农', 'Farmers', '農'], cls: 'farm' },
    { id: 'gong', name: ['工', 'Artisans', '工'], cls: 'craft' },
    { id: 'shang', name: ['商', 'Merchants', '商'], cls: 'trade' },
    { id: 'bing', name: ['兵', 'Soldiers', '兵'], cls: 'arms' },
    { id: 'seng', name: ['僧道', 'Monks and priests', '僧道'], cls: 'clergy' },
    { id: 'yi', name: ['杂役', 'Labourers and servants', '雑役'], cls: 'labor' },
  ],
  trades: [
    T('shi', 'official', '官吏', 'Official', '官吏'),
    T('shi', 'scholar', '士人', 'Scholar', '士人'),
    T('shi', 'clerk', '胥吏', 'Clerk', '胥吏'),
    T('nong', 'farmer', '农户', 'Farmer', '農家'),
    T('nong', 'gardener', '菜农', 'Market gardener', '菜農'),
    T('gong', 'carpenter', '木匠', 'Carpenter', '大工'),
    T('gong', 'smith', '铁匠', 'Smith', '鍛冶'),
    T('gong', 'weaver', '织工', 'Weaver', '織工'),
    T('gong', 'potter', '陶工', 'Potter', '陶工'),
    T('gong', 'dyer', '染匠', 'Dyer', '染物師'),
    T('shang', 'shopkeeper', '坐贾', 'Shopkeeper', '店主'),
    T('shang', 'trader', '行商', 'Travelling trader', '行商'),
    T('shang', 'broker', '牙人', 'Broker', '仲買人'),
    T('shang', 'innkeeper', '店家', 'Innkeeper', '宿屋'),
    T('bing', 'soldier', '军户', 'Soldier', '軍戸'),
    T('seng', 'monk', '僧', 'Monk', '僧'),
    T('seng', 'daoist', '道士', 'Daoist priest', '道士'),
    T('yi', 'porter', '脚夫', 'Porter', '人足'),
    T('yi', 'labourer', '佣工', 'Labourer', '日雇い'),
    T('yi', 'boatman', '船户', 'Boatman', '船頭'),
    T('yi', 'servant', '仆役', 'Servant', '下人'),
  ],
  mix: {
    common: { carpenter: 1, weaver: 1.2, smith: 0.6, dyer: 0.4, potter: 0.4, shopkeeper: 1, labourer: 1.4, porter: 0.8, gardener: 0.6, clerk: 0.3, soldier: 0.3 },
    craft: { carpenter: 1, weaver: 1.6, smith: 1, dyer: 0.8, potter: 0.8, labourer: 0.6 },
    merchant: { shopkeeper: 2, trader: 1, broker: 0.8, innkeeper: 0.4, clerk: 0.3, weaver: 0.3 },
    market: { shopkeeper: 2, trader: 1, broker: 0.6, innkeeper: 0.6, porter: 0.8 },
    noble: { official: 2, scholar: 1.2, clerk: 0.6, shopkeeper: 0.3 },
    slum: { labourer: 2, porter: 1.2, boatman: 0.4, weaver: 0.5, gardener: 0.4 },
    harbor: { boatman: 2, porter: 1.5, trader: 1, broker: 0.5, carpenter: 0.5 },
    temple: { monk: 1.5, daoist: 0.8, shopkeeper: 0.6, potter: 0.3 },
    castle: { official: 1, clerk: 1.2, soldier: 1 },
    barracks: { soldier: 3, smith: 0.3 },
    suburb: { farmer: 1.5, gardener: 1, labourer: 0.8, innkeeper: 0.3, carpenter: 0.4 },
    rural: { farmer: 5, gardener: 0.6, carpenter: 0.2, smith: 0.1 },
    // 疏档的大宅院：殷实人家，士绅、富商、牙人、在城里住的地主都有
    estate: { official: 0.5, scholar: 0.8, trader: 0.8, broker: 0.5, shopkeeper: 0.6, farmer: 0.5 },
  },
  servants: 'yi',
  // 宋明的府州县城：官吏、士绅连同胥吏约占一成以内，驻军卫所数个百分点，城里也住着不少种城郊田地的农户
  profile: { shi: 0.04, nong: 0.1, gong: 0.22, shang: 0.2, bing: 0.06, seng: 0.02 },
}

export const people: CulturePeople = {
  scheme: SCHEME,
  // 各种专门片区住满时每公顷住多少人（连仆役、学徒；在样例城里量出来的，样本少的取整、偏保守）
  wardDensity: { noble: 185, merchant: 290, craft: 125, slum: 215 },
  // 平均一户几口相对每户人数的倍数（各种大小、营生的户按一座城里常见的比例折算，实测值）
  homeK: 1.6,
}
