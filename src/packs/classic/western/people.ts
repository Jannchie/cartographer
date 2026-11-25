import { tradeDef as T, type CulturePeople, type Scheme } from '../../../settlement/people'

/** 职业分法：教士、贵族、市民、农民 */
const SCHEME: Scheme = {
  groups: [
    { id: 'clergy', name: ['教士', 'Clergy', '聖職者'], cls: 'clergy' },
    { id: 'nobility', name: ['贵族', 'Nobility', '貴族'], cls: 'elite' },
    { id: 'merchants', name: ['商人', 'Merchants', '商人'], cls: 'trade' },
    { id: 'crafts', name: ['工匠', 'Craftsmen', '職人'], cls: 'craft' },
    { id: 'peasants', name: ['农民', 'Peasants', '農民'], cls: 'farm' },
    { id: 'soldiers', name: ['兵士', 'Soldiers', '兵士'], cls: 'arms' },
    { id: 'labour', name: ['雇工与仆役', 'Labourers and servants', '雇人と奉公人'], cls: 'labor' },
  ],
  trades: [
    T('clergy', 'priest', '神父', 'Priest', '司祭'),
    T('clergy', 'friar', '修士', 'Friar', '修道士'),
    T('nobility', 'lord', '领主', 'Lord', '領主'),
    T('nobility', 'knight', '骑士', 'Knight', '騎士'),
    T('merchants', 'merchant', '批发商', 'Merchant', '卸商'),
    T('merchants', 'shopkeeper', '店主', 'Shopkeeper', '店主'),
    T('merchants', 'innkeeper', '旅店主', 'Innkeeper', '宿屋の主人'),
    T('crafts', 'weaver', '织工', 'Weaver', '織工'),
    T('crafts', 'smith', '铁匠', 'Smith', '鍛冶屋'),
    T('crafts', 'baker', '面包师', 'Baker', 'パン屋'),
    T('crafts', 'butcher', '屠户', 'Butcher', '肉屋'),
    T('crafts', 'carpenter', '木匠', 'Carpenter', '大工'),
    T('crafts', 'tanner', '皮匠', 'Tanner', '皮革職人'),
    T('crafts', 'mason', '石匠', 'Mason', '石工'),
    T('peasants', 'peasant', '农夫', 'Peasant', '農夫'),
    T('peasants', 'gardener', '园丁', 'Gardener', '園丁'),
    T('soldiers', 'soldier', '士兵', 'Soldier', '兵士'),
    T('labour', 'labourer', '短工', 'Labourer', '日雇い'),
    T('labour', 'carter', '车夫', 'Carter', '荷車引き'),
    T('labour', 'boatman', '船夫', 'Boatman', '船頭'),
    T('labour', 'servant', '仆人', 'Servant', '召使い'),
  ],
  mix: {
    common: { weaver: 1, baker: 0.6, butcher: 0.4, carpenter: 0.8, mason: 0.4, shopkeeper: 0.8, labourer: 1.4, carter: 0.5, peasant: 0.4 },
    craft: { weaver: 1.4, smith: 1, tanner: 0.8, carpenter: 0.8, mason: 0.6, baker: 0.4, labourer: 0.5 },
    merchant: { merchant: 1.6, shopkeeper: 1.5, innkeeper: 0.4, weaver: 0.3 },
    market: { shopkeeper: 2, merchant: 0.8, innkeeper: 0.6, baker: 0.5, butcher: 0.5, carter: 0.5 },
    noble: { lord: 1, knight: 1.2, merchant: 0.4 },
    slum: { labourer: 2, carter: 0.8, tanner: 0.6, weaver: 0.5 },
    harbor: { boatman: 2, labourer: 1.4, merchant: 1, carpenter: 0.6 },
    temple: { priest: 1, friar: 1, shopkeeper: 0.4 },
    castle: { knight: 1, soldier: 2, lord: 0.3 },
    barracks: { soldier: 3, smith: 0.3 },
    suburb: { peasant: 1.5, gardener: 0.8, innkeeper: 0.4, labourer: 0.8, smith: 0.3 },
    rural: { peasant: 5, gardener: 0.5, smith: 0.15, carpenter: 0.15 },
    estate: { lord: 1, knight: 1 },
  },
  servants: 'labour',
  // 中世纪晚期的城市（纽伦堡 1449 年、佛罗伦萨 1427 年地籍册一类的统计）：手工业者四成上下，
  // 商人一成多，教士、贵族与城市显贵合计几个百分点，城里种地的"耕作市民"不到一成，其余是雇工、仆役与贫民
  profile: { clergy: 0.025, nobility: 0.015, merchants: 0.12, crafts: 0.42, peasants: 0.08, soldiers: 0.01 },
}

export const people: CulturePeople = {
  scheme: SCHEME,
  // 各种专门片区住满时每公顷住多少人（连仆役、学徒；在样例城里量出来的，样本少的取整、偏保守）
  wardDensity: { noble: 100, merchant: 400, craft: 160, slum: 250 },
  // 平均一户几口相对每户人数的倍数（各种大小、营生的户按一座城里常见的比例折算，实测值）
  homeK: 1.4,
}
