import type { TownCultureRule } from '../../gen/townCulture'

/**
 * 世界上的文化建哪种文明的城：汉字地名的文化建东方的城，日本地名的建和风的城；
 * 其余的看地理——炎热干旱的地方占到四成五以上建伊斯兰式的城（只换形制，名字仍按自己的命名世界观），否则是西式。
 * 本模块不导入聚落层的代码：世界生成的 Worker 只载入这一条规则。
 */
export const townCulture: TownCultureRule = ({ naming, aridCells, cells }) => (naming === 'eastern' || naming === 'wa' ? naming : aridCells > cells * 0.45 ? 'islamic' : 'western')
