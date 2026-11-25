/**
 * 西式的植被：各环境里的树种与权重、行道树、果园、灌木与篱。
 */
import type { FloraKit } from '../../../../render/town3d/kits'

export const flora: FloraKit = {
  mix: {
    wild: [['oak', 5], ['linden', 2], ['elm', 3], ['birch', 1.2], ['spruce', 0.8], ['pine', 0.6], ['hawthorn', 0.5]],
    upland: [['spruce', 5], ['fir', 2.5], ['pine', 2], ['birch', 1.5], ['oak', 1]],
    field: [['oak', 6], ['elm', 2], ['linden', 1.5], ['hawthorn', 0.8]],
    water: [['willow', 4], ['elm', 3], ['oak', 1], ['birch', 1]],
    cemetery: [['yew', 4], ['cypress', 3], ['oak', 1]],
    park: [['oak', 2], ['linden', 2.5], ['plane', 1.5], ['hawthorn', 1.2], ['cypress', 0.8], ['elm', 1], ['yew', 0.6]],
    yard: [['apple', 3], ['pear', 1.5], ['hawthorn', 1.2], ['linden', 1.5], ['elm', 1]],
    sacred: [['yew', 2], ['linden', 3], ['oak', 2], ['cypress', 1]],
    court: [['oak', 2], ['linden', 2.5], ['cypress', 1.5], ['plane', 1.5], ['yew', 0.8]],
  },
  avenue: ['linden', 'lombardy', 'plane', 'linden'],
  orchard: ['apple', 'apple', 'pear', 'olive'],
  narrow: 'lombardy',
  temp: 10,
  seasons: false,
  pondside: () => 'willow',
  bocage: true,
  kitchenHedge: true,
}
