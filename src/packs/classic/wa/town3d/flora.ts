/**
 * 和式的植被：各环境里的树种与权重、行道树、果园、灌木与篱。
 */
import type { FloraKit } from '../../../../render/town3d/kits'
import { gardenShrub } from '../../eastern/town3d/flora'

export const flora: FloraKit = {
  mix: {
    wild: [['camphor', 3], ['sugi', 3], ['pine', 2], ['sakura', 0.8], ['maple', 0.9], ['bamboo', 1.5], ['elm', 1.5]],
    upland: [['sugi', 6], ['fir', 1.5], ['pine', 2], ['camphor', 1], ['maple', 1.2]],
    field: [['camphor', 2], ['pine', 2], ['persimmon', 1.5], ['elm', 1.5]],
    water: [['willow', 4], ['sakura', 3], ['pine', 1], ['maple', 0.8]],
    cemetery: [['sugi', 3], ['pine', 2], ['sakura', 1], ['camphor', 1]],
    park: [['blackpine', 4], ['maple', 2.5], ['redmaple', 0.7], ['sakura', 3], ['bamboo', 1.2], ['sugi', 1], ['ume', 1]],
    yard: [['blackpine', 2], ['persimmon', 2], ['maple', 1.5], ['sakura', 1], ['bamboo', 1], ['ume', 1]],
    sacred: [['sugi', 5], ['camphor', 1.5], ['blackpine', 2], ['sakura', 2], ['maple', 2], ['ginkgo', 1]],
    court: [['blackpine', 5], ['sakura', 3], ['maple', 1.5], ['camphor', 1]],
  },
  avenue: ['blackpine', 'sakura', 'sugi', 'sakura'],
  orchard: ['ume', 'persimmon', 'peach', 'citrus'],
  narrow: 'sugi',
  temp: 14,
  seasons: true,
  pondside: (h) => (h < 0.5 ? 'sakura' : 'willow'),
  shrub: gardenShrub,
  bocage: false,
  kitchenHedge: true,
}
