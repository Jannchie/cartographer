/**
 * 插件内核：扩展点、注册表与插件的启动。
 *
 * - 扩展点（Slot）是一类可登记的内容（文明、沙盘套件、命名风格、世界观、纸图风格……），由拥有该内容类型的核心模块用 defineSlot 声明；
 *   条目的类型由泛型参数给出，登记与查询都按它检查。扩展点带一个三语的名称（label），界面提示某条内容不可用时用它。
 * - 一个扩展点可以有一个默认条目：登记时声明，核心要"没选过 / 选的不可用时用哪个"就取它，核心自己不写任何内容的 id。
 *   登记了默认条目的插件不可停用（requiredPlugins）。
 * - 插件随应用一起构建，由清单（PluginManifest）描述：清单只有 id、名称与依赖，不引用插件的代码。
 *   一个插件按运行环境分层（Layer），每层一个入口模块，启用时才载入；各层的入口另由入口表（LayerTable）给出，
 *   一个运行环境只把自己用到的层交给 boot：世界 Worker 只有 world 层，聚落 Worker 是 settlement 与 town3d 层，
 *   主线程是全部。这样世界 Worker 的构建里根本没有聚落与沙盘的代码。
 * - 启用哪些插件只决定哪些内容可用（出现在界面里、能被参数引用）。生成结果由参数引用的内容决定，
 *   与启用清单无关：生成器不得从"全部已登记的条目"里抽样。
 * - 不做热卸载：一个运行环境（主线程、Worker、脚本进程）只启动一次，启用清单改了就重新载入页面。
 *
 * 本模块不依赖仓库里的其他模块，主线程、Worker 与 Node 脚本通用。
 */

/** 三语的名称或说明（界面按当前语言取其中一项） */
export interface Label {
  zh: string
  en: string
  ja: string
}

/** 集合型扩展点：T 是条目的类型。name 是注册表的键，也用于报错；label 是这类内容的名称 */
export interface Slot<T> {
  readonly name: string
  readonly label: Label
  /** 只用于类型：让 Slot<A> 与 Slot<B> 不能互相赋值 */
  readonly __t?: (x: T) => T
}

export function defineSlot<T>(name: string, label: Label): Slot<T> {
  return { name, label }
}

/** 一个扩展点下已登记的条目（只读视图；条目按登记顺序排列） */
export interface Registry<T> {
  /** 这类内容的名称（扩展点的 label） */
  readonly label: Label
  ids(): string[]
  has(id: string): boolean
  /** 没有登记时抛错（所属的插件没有启用，或入口没有先启动插件） */
  get(id: string): T
  all(): T[]
  /** 登记这个条目的插件 id */
  owner(id: string): string | undefined
  /** 默认条目的 id；这个扩展点没有默认条目时抛错 */
  defaultId(): string
}

/**
 * 插件的层：按运行环境划分的入口。
 * world 世界生成（世界 Worker 只载入这一层）；settlement 聚落生成与聚落图；town3d 沙盘；
 * paper 世界纸图（主线程与离线脚本载入，Worker 不载入）；ui 只在主线程用的界面内容
 */
export type Layer = 'world' | 'settlement' | 'town3d' | 'paper' | 'ui'
/** 各层入口的执行顺序（同一个插件里） */
const LAYER_ORDER: readonly Layer[] = ['world', 'settlement', 'town3d', 'paper', 'ui']

/** 入口函数拿到的宿主：只负责登记。插件与应用一起编译，需要核心的其他功能时直接导入核心模块 */
export interface Host {
  /**
   * 往扩展点登记一个条目；同一个扩展点里 id 重复视为错误。
   * default：把它声明为这个扩展点的默认条目（一个扩展点只能有一个；声明了默认条目的插件不可停用）
   */
  add<T>(slot: Slot<T>, id: string, def: T, o?: { default?: boolean }): void
}

/** 一层的入口：同步执行，只做登记。需要异步载入的数据由条目自己在用到时加载 */
export type LayerSetup = (host: Host) => void

export interface PluginManifest {
  id: string
  /** 名称与说明 */
  name: Label
  desc: Label
  /** 依赖的插件：必须排在清单里更靠前的位置；依赖没有启用时本插件也不启用 */
  requires?: readonly string[]
  /** 只在开发构建里出现 */
  dev?: boolean
}

/** 一层的入口表：插件 id → 入口模块的加载函数（模块默认导出 LayerSetup），启用时才调用 */
export type LayerTable = Readonly<Record<string, () => Promise<{ default: LayerSetup }>>>

/** 入口表里不可停用的插件：入口模块静态导入（随所在的入口一起打包，不另发请求），包成加载函数的样子 */
export const eager = (setup: LayerSetup) => () => Promise.resolve({ default: setup })

interface Table {
  entries: Map<string, { def: unknown; plugin: string }>
  /** 默认条目的 id */
  default?: string
}

/** 扩展点名 → 条目表。表建好后不再替换，所以 registryOf 的返回值可以长期持有 */
const tables = new Map<string, Table>()
const tableOf = (name: string) => tables.get(name) ?? tables.set(name, { entries: new Map() }).get(name)!

/** 已启动的插件（清单顺序）；null 为还没有启动 */
let active: string[] | null = null

/** 一个扩展点的注册表。可以在启动之前取得并保存：内容在启动时填入 */
export function registryOf<T>(slot: Slot<T>): Registry<T> {
  const table = tableOf(slot.name)
  const { entries } = table
  return {
    label: slot.label,
    ids: () => [...entries.keys()],
    has: (id) => entries.has(id),
    get(id) {
      const e = entries.get(id)
      if (!e) throw new Error(`扩展点 ${slot.name} 里没有 "${id}"：它所属的插件没有启用，或入口没有先启动插件（见 src/packs/boot.ts）`)
      return e.def as T
    },
    all: () => [...entries.values()].map((e) => e.def as T),
    owner: (id) => entries.get(id)?.plugin,
    defaultId() {
      if (table.default === undefined) throw new Error(`扩展点 ${slot.name} 没有默认条目：登记它的插件没有启用，或入口没有先启动插件`)
      return table.default
    },
  }
}

/**
 * 按停用清单算出启用的插件（清单顺序）：依赖没有启用的插件不启用，记在 blocked 里（missing 是缺的依赖）。
 * 哪些插件不可停用要等启动之后才知道（requiredPlugins），所以停用清单由写入它的一方保证里面没有不可停用的插件
 */
export function resolveEnabled(all: readonly PluginManifest[], off: readonly string[]): { enabled: string[]; blocked: { id: string; missing: string[] }[] } {
  const enabled: string[] = []
  const blocked: { id: string; missing: string[] }[] = []
  for (const m of all) {
    if (off.includes(m.id)) continue
    const missing = (m.requires ?? []).filter((d) => !enabled.includes(d))
    if (missing.length) blocked.push({ id: m.id, missing })
    else enabled.push(m.id)
  }
  return { enabled, blocked }
}

/**
 * 启动插件：载入 enabled（resolveEnabled 的结果）里各插件在 layers 各层的入口并执行（layers 只给这个运行环境用到的层）。
 * 先并行载入全部入口模块，再按"清单顺序 × 层的固定顺序"逐个执行，登记顺序与模块到达的先后无关。
 * 一个运行环境只能启动一次。
 */
export async function boot(o: { manifests: readonly PluginManifest[]; enabled: readonly string[]; layers: Partial<Record<Layer, LayerTable>> }): Promise<void> {
  if (active) throw new Error('插件已经启动：启用清单改变后需要重新载入，不能再次启动')
  const list = o.manifests.filter((m) => o.enabled.includes(m.id))
  // 先占位：载入入口期间再次调用同样视为重复启动
  active = list.map((m) => m.id)
  const jobs = list.flatMap((m) => LAYER_ORDER.flatMap((l) => (o.layers[l]?.[m.id] ? [{ plugin: m.id, load: o.layers[l]![m.id] }] : [])))
  try {
    const setups = await Promise.all(jobs.map((j) => j.load()))
    jobs.forEach((j, k) => {
      setups[k].default({
        add(slot, id, def, opt) {
          const table = tableOf(slot.name)
          const had = table.entries.get(id)
          if (had) throw new Error(`扩展点 ${slot.name} 里的 "${id}" 重复登记（插件 ${had.plugin} 与 ${j.plugin}）`)
          table.entries.set(id, { def, plugin: j.plugin })
          if (opt?.default) {
            if (table.default !== undefined) throw new Error(`扩展点 ${slot.name} 有两个默认条目："${table.default}" 与 "${id}"`)
            table.default = id
          }
        },
      })
    })
  } catch (err) {
    // 入口载入或执行失败：不留下登记了一半的注册表
    for (const t of tables.values()) {
      t.entries.clear()
      t.default = undefined
    }
    active = null
    throw err
  }
}

/** 已启动的插件 id（清单顺序）；还没有启动时为空 */
export const activePlugins = (): readonly string[] => active ?? []

/** 不可停用的插件：登记了某个扩展点的默认条目的那些（启动之后才知道） */
export function requiredPlugins(): string[] {
  const out = new Set<string>()
  for (const t of tables.values()) if (t.default !== undefined) out.add(t.entries.get(t.default)!.plugin)
  return [...out]
}

/**
 * Worker 的启动：启用清单由创建它的线程写在 Worker 的名字里（workerName），Worker 在模块顶层调用 bootWorker，
 * 每个请求先等它返回的 Promise。于是不需要另发一条初始化消息，也没有"还没收到清单"的状态
 */
export const workerName = (enabled: readonly string[]) => JSON.stringify(enabled)
export function bootWorker(manifests: readonly PluginManifest[], layers: Partial<Record<Layer, LayerTable>>): Promise<void> {
  const ready = boot({ manifests, enabled: JSON.parse((self as unknown as { name: string }).name) as string[], layers })
  // 失败由各个请求在等它时报告，这里只是不让它成为未处理的拒绝
  ready.catch(() => {})
  return ready
}
