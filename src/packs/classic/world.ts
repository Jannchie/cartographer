import { TownCultureRules, type TownCultureRule } from '../../gen/townCulture'
import type { LayerSetup } from '../../kernel'

/**
 * 内置插件 classic 的 world 层入口。本模块（以及以后的 ./world/ 目录）是世界生成的 Worker 载入的全部插件代码，
 * 不导入聚落层；它的内容计入世界缓存的版本号（见 vite.config.ts 的 gen-hash）。
 *
 * 世界上的文化建哪种文明的城：汉字地名的文化建东方的城，日本地名的建和风的城；
 * 其余的看地理——炎热干旱的地方占到四成五以上建伊斯兰式的城（只换形制，名字仍按自己的命名世界观），否则是西式。
 */
const townCulture: TownCultureRule = ({ naming, aridCells, cells }) => (naming === 'eastern' || naming === 'wa' ? naming : aridCells > cells * 0.45 ? 'islamic' : 'western')

const setup: LayerSetup = (host) => {
  host.add(TownCultureRules, 'classic', townCulture)
}
export default setup
