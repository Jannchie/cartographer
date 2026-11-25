import type { CultureRegion, CultureSpec, SettingDef } from '../../../gen/setting'
import { Biome } from '../../../gen/types'

/**
 * 世界观 isekai（由 ../world.ts 登记）：日式异世界。世界的地名是人类的片假名地名；
 * 文化区按地理分给五个种族——人类、精灵、矮人、兽人（獣人）、魔族，种族定下那片文化的命名风格与制度。
 * 城镇文明目前只有人类一种（./settlement.ts），各种族的城都按它建。
 * 这里的阈值与先后都是生成结果的一部分，改动会让旧种子的种族分布改变。
 */

export type Race = 'human' | 'elf' | 'dwarf' | 'beastfolk' | 'demon'

/** 各种族的文化的三项属性 */
const RACES: Record<Race, CultureSpec> = {
  human: { naming: 'isekai.human', polity: 'isekai.kingdom', town: 'isekai.human' },
  elf: { naming: 'isekai.elf', polity: 'isekai.tribal', town: 'isekai.human' },
  dwarf: { naming: 'isekai.dwarf', polity: 'isekai.tribal', town: 'isekai.human' },
  beastfolk: { naming: 'isekai.beastfolk', polity: 'isekai.tribal', town: 'isekai.human' },
  demon: { naming: 'isekai.demon', polity: 'isekai.demon', town: 'isekai.human' },
}

const FOREST: number[] = [Biome.Taiga, Biome.TemperateForest, Biome.TemperateRainforest, Biome.TropicalSeasonalForest, Biome.TropicalRainforest]
/** 寒冷与荒芜：冰原、苔原、高山、沙漠、盐沼 */
const BLEAK: number[] = [Biome.IceCap, Biome.Tundra, Biome.Alpine, Biome.ColdDesert, Biome.HotDesert, Biome.SaltFlat]
const STEPPE: number[] = [Biome.Grassland, Biome.Savanna]

/** 这些群系在文化区里的占比 */
const share = (r: CultureRegion, ids: number[]) => ids.reduce((s, b) => s + r.biomes[b], 0) / Math.max(1, r.cells)

/** 候选里得分最高的那个文化区（并列取靠前的）；没有候选时是 undefined */
function top(list: CultureRegion[], score: (r: CultureRegion) => number): CultureRegion | undefined {
  let best: CultureRegion | undefined
  for (const r of list) if (!best || score(r) > score(best)) best = r
  return best
}

/**
 * 各文化区的种族（确定的规则，不用随机数）：
 * 1. 0 号文化（最大城所在的那片）是人类；
 * 2. 只在有城镇的文化区里分配别的种族：没有城镇的文化立不起国家，地图上看不出它；
 * 3. 文化区达到 3 个时，其余文化区里"边远程度 × 0.5 + 寒冷荒芜占比 × 0.5"最高的是魔族，有且只有一个
 *   （其余文化区都没有城镇时仍挑一个，只是立不起魔王领）；
 * 4. 余下的文化区里，森林占比最高且超过 35% 的是精灵，高地占比最高且超过 25% 的是矮人，
 *    草原与稀树草原占比最高、超过 30% 且多于森林的是兽人；每个种族至多一个文化区，按这个先后挑；
 * 5. 都不满足的是人类（不同的人类文化区是不同的王国群）。
 */
export function assignRaces(regions: readonly CultureRegion[]): Race[] {
  const race: Race[] = regions.map(() => 'human')
  const open = () => regions.filter((r) => r.index > 0 && race[r.index] === 'human')
  const settled = () => open().filter((r) => r.towns > 0)
  if (regions.length >= 3) {
    const d = top(settled().length ? settled() : open(), (r) => r.remoteness * 0.5 + share(r, BLEAK) * 0.5)
    if (d) race[d.index] = 'demon'
  }
  const claim = (who: Race, score: (r: CultureRegion) => number, min: number) => {
    const r = top(settled(), score)
    if (r && score(r) > min) race[r.index] = who
  }
  claim('elf', (r) => share(r, FOREST), 0.35)
  claim('dwarf', (r) => r.highCells / Math.max(1, r.cells), 0.25)
  claim('beastfolk', (r) => (share(r, STEPPE) > share(r, FOREST) ? share(r, STEPPE) : 0), 0.3)
  return race
}

export const isekai: SettingDef = {
  id: 'isekai',
  name: '异世界',
  desc: '日式异世界：片假名地名的人类王国，森林里的精灵、山地的矮人、草原上的兽人，还有边远之地的魔王领',
  // 世界的地名只有人类的一种；各种族的命名风格不在池子里，由下面的整体规则分配
  naming: ['isekai.human'],
  // 整体规则覆盖不到的场合（没有政区层的世界、旧存档）才查这张表与下面的 townCulture
  polity: Object.fromEntries(Object.values(RACES).map((s) => [s.naming, s.polity])),
  townCulture: () => RACES.human.town,
  cultures: (regions) => assignRaces(regions).map((r) => RACES[r]),
}
