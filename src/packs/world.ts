/**
 * 世界层入口：世界上的文化建哪种文明的城（规则的类型见 gen/townCulture.ts）。
 * 目前一个世界只用内置文化包的规则。只引入文化包的 world.ts，不引入聚落的生成器：
 * 世界生成的 Worker 只载入这一条规则。
 */
export { townCulture } from './classic/world'
