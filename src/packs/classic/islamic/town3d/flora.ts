/**
 * 伊斯兰的植被：各环境里的树种与权重、行道树、果园、灌木与篱。
 */
import type { FloraKit } from '../../../../render/town3d/kits'

export const flora: FloraKit = {
  mix: {
    wild: [['olive', 2], ['pine', 2], ['cypress', 1.5], ['holm', 2.5], ['palm', 1.2], ['fig', 0.6]],
    upland: [['pine', 3], ['cypress', 2], ['holm', 2.5], ['yew', 1]],
    field: [['olive', 3], ['palm', 2], ['fig', 1.5], ['holm', 1]],
    water: [['palm', 5], ['willow', 1], ['elm', 2], ['fig', 1]],
    cemetery: [['cypress', 6], ['olive', 1]],
    park: [['cypress', 3], ['citrus', 3], ['palm', 2], ['pomegranate', 1], ['plane', 1.5], ['elm', 1]],
    yard: [['citrus', 2], ['fig', 2], ['palm', 1.5], ['pomegranate', 1], ['olive', 1]],
    sacred: [['cypress', 3], ['plane', 2], ['palm', 2], ['citrus', 1]],
    court: [['cypress', 3], ['palm', 2.5], ['citrus', 2], ['plane', 1.5]],
  },
  avenue: ['palm', 'cypress', 'plane', 'palm'],
  orchard: ['citrus', 'olive', 'pomegranate', 'palm', 'fig'],
  narrow: 'cypress',
  temp: 20,
  seasons: false,
  shrub: (ctx, h) => (ctx === 'wild' || ctx === 'upland' || ctx === 'field' ? 'maquis' : h < 0.5 ? 'maquis' : 'shrub'),
  bocage: false,
  kitchenHedge: false,
}
