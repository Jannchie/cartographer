/**
 * 离线脚本的入口（副作用模块）：导入它即启动全部插件。模块顶层等待启动完成，
 * 导入它的脚本开始执行时注册表已经填好。应用本身不导入本模块（见 main.ts 与两个 Worker）。
 */
import { bootAll } from './boot'

await bootAll()
