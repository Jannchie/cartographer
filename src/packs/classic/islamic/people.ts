import { tradeDef as T, type CulturePeople, type Scheme } from '../../../settlement/people'

/** 职业分法：乌理玛、官宦、巴扎商人与工匠 */
const SCHEME: Scheme = {
  groups: [
    { id: 'ulama', name: ['乌理玛', 'Ulama', 'ウラマー'], cls: 'clergy' },
    { id: 'ayan', name: ['官宦显贵', 'Notables and officials', '名士と官吏'], cls: 'elite' },
    { id: 'tujjar', name: ['商人', 'Merchants', '商人'], cls: 'trade' },
    { id: 'sunna', name: ['工匠', 'Artisans', '職人'], cls: 'craft' },
    { id: 'fallah', name: ['农民', 'Farmers', '農民'], cls: 'farm' },
    { id: 'jund', name: ['兵士', 'Soldiers', '兵士'], cls: 'arms' },
    { id: 'amma', name: ['雇工与仆役', 'Labourers and servants', '雇人と奉公人'], cls: 'labor' },
  ],
  trades: [
    T('ulama', 'imam', '伊玛目', 'Imam', 'イマーム'),
    T('ulama', 'qadi', '卡迪', 'Qadi', 'カーディー'),
    T('ayan', 'amir', '埃米尔', 'Amir', 'アミール'),
    T('ayan', 'katib', '书记官', 'Scribe', '書記'),
    T('tujjar', 'tajir', '大商人', 'Merchant', '大商人'),
    T('tujjar', 'bazaari', '巴扎店主', 'Bazaar trader', 'バザール商人'),
    T('tujjar', 'caravaneer', '驼队商', 'Caravan trader', '隊商'),
    T('sunna', 'weaver', '织工', 'Weaver', '織工'),
    T('sunna', 'coppersmith', '铜匠', 'Coppersmith', '銅細工師'),
    T('sunna', 'tanner', '皮匠', 'Tanner', '皮革職人'),
    T('sunna', 'potter', '陶工', 'Potter', '陶工'),
    T('sunna', 'baker', '面包师', 'Baker', 'パン屋'),
    T('fallah', 'farmer', '农夫', 'Farmer', '農夫'),
    T('fallah', 'gardener', '园丁', 'Gardener', '園丁'),
    T('jund', 'soldier', '士兵', 'Soldier', '兵士'),
    T('amma', 'porter', '脚夫', 'Porter', '荷担ぎ'),
    T('amma', 'water', '送水人', 'Water carrier', '水売り'),
    T('amma', 'labourer', '短工', 'Labourer', '日雇い'),
    T('amma', 'servant', '仆人', 'Servant', '召使い'),
  ],
  mix: {
    common: { weaver: 1, potter: 0.5, baker: 0.6, coppersmith: 0.4, bazaari: 0.8, labourer: 1.2, water: 0.4, porter: 0.6, gardener: 0.4 },
    craft: { weaver: 1.2, coppersmith: 1, tanner: 0.8, potter: 0.8, labourer: 0.4 },
    merchant: { tajir: 1.5, bazaari: 1.5, caravaneer: 0.6, katib: 0.2 },
    market: { bazaari: 2.5, tajir: 0.6, porter: 1, baker: 0.4 },
    noble: { amir: 1, katib: 1, qadi: 0.5, tajir: 0.4 },
    slum: { labourer: 2, porter: 1.2, water: 0.8, tanner: 0.5 },
    harbor: { porter: 1.5, labourer: 1, tajir: 1, caravaneer: 0.3 },
    temple: { imam: 1.5, qadi: 0.5, bazaari: 0.5 },
    castle: { amir: 0.5, katib: 1, soldier: 2 },
    barracks: { soldier: 3 },
    suburb: { farmer: 1.2, gardener: 1, labourer: 0.8, caravaneer: 0.3 },
    rural: { farmer: 5, gardener: 0.8 },
    estate: { amir: 1, tajir: 1 },
  },
  servants: 'amma',
  // 马穆鲁克、奥斯曼时期的开罗、大马士革、阿勒颇：行会工匠三四成，商人一成多，乌理玛与官宦军人合计一成上下
  profile: { ulama: 0.03, ayan: 0.025, tujjar: 0.12, sunna: 0.38, fallah: 0.07, jund: 0.05 },
}

export const people: CulturePeople = {
  scheme: SCHEME,
  // 各种专门片区住满时每公顷住多少人（连仆役、学徒；在样例城里量出来的，样本少的取整、偏保守）
  wardDensity: { noble: 250, merchant: 500, craft: 250, slum: 350 },
  // 平均一户几口相对每户人数的倍数（各种大小、营生的户按一座城里常见的比例折算，实测值）
  homeK: 1.45,
}
