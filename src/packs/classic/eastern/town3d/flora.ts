/**
 * 东方的植被：各环境里的树种与权重、行道树、果园、灌木与篱。
 */
import type { FloraKit } from '../../../../render/town3d/kits'

/** 园林、寺社、院子里的灌木多是杜鹃，别处是普通灌木（和式也用） */
export const gardenShrub: NonNullable<FloraKit['shrub']> = (ctx, h) => (ctx === 'park' || ctx === 'sacred' || ctx === 'court' ? (h < 0.6 ? 'azalea' : 'shrub') : 'shrub')

export const flora: FloraKit = {
  mix: {
    wild: [['sophora', 3], ['camphor', 2.5], ['elm', 3], ['pine', 2.2], ['bamboo', 1.6], ['sugi', 0.8], ['maple', 0.5]],
    upland: [['pine', 5], ['sugi', 3], ['camphor', 1.5], ['bamboo', 1.2], ['maple', 0.8], ['cypress', 1]],
    field: [['elm', 3], ['sophora', 3], ['willow', 1], ['camphor', 1]],
    water: [['willow', 7], ['elm', 1], ['bamboo', 1], ['peach', 0.8]],
    cemetery: [['cypress', 5], ['pine', 3]],
    park: [['pine', 3], ['willow', 1.5], ['ume', 1.5], ['maple', 1.2], ['bamboo', 2], ['ginkgo', 1.5], ['sophora', 2], ['cypress', 1]],
    yard: [['sophora', 3], ['pomegranate', 1.5], ['persimmon', 1.5], ['bamboo', 1], ['ume', 1], ['elm', 1]],
    sacred: [['pine', 3], ['cypress', 3], ['ginkgo', 3], ['sophora', 1]],
    court: [['pine', 3], ['cypress', 3], ['sophora', 2], ['ume', 1], ['ginkgo', 1]],
  },
  avenue: ['sophora', 'willow', 'elm', 'sophora'],
  orchard: ['peach', 'pear', 'persimmon', 'citrus'],
  narrow: 'cypress',
  temp: 14,
  seasons: true,
  pondside: () => 'willow',
  shrub: gardenShrub,
  bocage: false,
  kitchenHedge: false,
}
