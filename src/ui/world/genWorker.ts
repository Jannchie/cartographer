import { workerName } from '../../kernel'
import GenWorker from '../../worker?worker'
import { enabledPlugins } from '../plugins'

/**
 * 世界生成的线程。单独成一个小模块，由 main.ts 在启动插件之前导入：线程立刻创建，
 * 它载入脚本、启动插件与主线程的启动并行；world.ts 从这里取用。启用的插件写在线程的名字里（见内核的 bootWorker）。
 * 线程只建这一次：启用清单改了会重新载入页面
 */
export const genWorker = new GenWorker({ name: workerName(enabledPlugins()) })
