# 架构

本文描述代码库的分层、各模块的职责与公开接口、状态的归属，以及由 `pnpm check:arch`（`scripts/check-arch.ts`）执行的架构约束。约束的改动须同时修改本文与检查脚本。架构决策的来由见 [`docs/adr/`](adr/)，待办的治理事项见 [`docs/backlog.md`](backlog.md)。

## 1. 分层

模块按路径归入以下各层。箭头表示允许的导入方向（类型导入同样计入）；同层之内可以互相导入。

| 层 | 路径 | 职责 | 可导入 |
| --- | --- | --- | --- |
| kernel | `src/kernel/` | 插件内核：扩展点、注册表、插件启动 | — |
| base | `src/i18n.ts`、`src/changelog.ts` | 三语词典与语言切换、更新日志 | kernel |
| gen | `src/gen/` | 世界生成引擎，以及全仓共用的栅格与数值基础（`util`、`dmath`、`rng`、`noise`、`contour`） | kernel |
| settlement | `src/settlement/` | 聚落生成引擎：成长史、规划、片区、城墙、道路、生长引擎（`grow/`） | kernel、base、gen |
| render | `src/render/` | 渲染：世界纸图（`atlas/`）、鸟瞰（`aerial/`）、全息（`holo/`）、聚落图（`settlementMap.ts`）、聚落沙盘（`town3d/`），以及三维视图的键盘约定（`keys.ts`） | kernel、base、gen、settlement |
| editor | `src/editor/` | 世界编辑器（地形笔刷、草图、编辑图层） | kernel、base、gen、render |
| app | `src/app/` | 世界库（IndexedDB）与工程文件的读写 | kernel、base、gen |
| plugin-world | `src/packs/<插件>/world.ts`、`src/packs/<插件>/world/` | 插件的 world 层：命名风格、制度、世界观 | kernel、gen |
| plugin | `src/packs/<插件>/` 的其余文件 | 插件的 settlement、town3d、paper、ui 层：文明、沙盘套件、纸图风格、聚落图主题、界面译文 | kernel、base、gen、settlement、render、plugin-world |
| packs | `src/packs/*.ts` | 插件清单（`manifest.ts`）、各层的入口表、启动（`boot.ts`、`all.ts`） | kernel、plugin、plugin-world |
| ui | `src/ui/` | Vue 界面：外壳、三个模块（世界、聚落、生长）、组件库（`kit/`） | 除 plugin 与 plugin-world 以外的各层 |
| entry | 见下 | 组合根，不受分层限制 | 全部 |

组合根（entry）：

- `src/main.ts`：应用入口，启动插件后挂载界面；
- `src/worker.ts`：世界生成 Worker，只载入插件的 world 层；
- `src/ui/settlement/history.worker.ts`：聚落成长史 Worker，载入 settlement 与 town3d 层；
- `src/settlement/grow/paint.ts`：生长引擎对外的画图入口（`package.json` 的 `cartographer/grow/paint`），按需启动最少的插件；
- `src/settlement/grow/check-api.ts`：对外接口签名的编译期核对。

其他约束：

- **插件之间**：插件只能导入自己与清单（`src/packs/manifest.ts`）中 `requires` 列出的插件。
- **world 层的封闭性**：插件的 world 层只能导入 world 层、生成器与内核。世界缓存的版本号（`vite.config.ts` 的 `gen-hash`）只按这些文件计算；world 层若导入其他代码，那些代码改动后浏览器里缓存的旧世界不会失效。
- **运行时无环**：运行时的导入不成环；只含类型导入的环（含 `import('…').Name` 形式的内联类型）不计。
- **可达**：`src/` 下每个文件都须能从某个入口（组合根、`package.json` 的 `exports`、`scripts/`、`video/`）沿导入走到。尚未接入的实验代码登记在 `UNREACHABLE_OK`。
- **所属模块**：本机存储（localStorage、sessionStorage）只在 `ui/app.ts` 与 `i18n.ts` 中直接读写，其他模块经 `storeGet`、`storeSet`、`stored`、`storedJson`；IndexedDB 只在世界库（`app/library.ts`）与世界缓存（`gen/cache.ts`）中使用；后台线程只由各自的客户端模块创建（`ui/settlement/historyWorker.ts`、`ui/world/genWorker.ts`）。
- **确定性**：`src/gen`、`src/settlement` 与插件中参与生成的部分（world 层与 settlement 层）不使用随引擎实现而变的数学函数与写法（`Math.sin`、`Math.pow`、`**`、随机比较函数的 `sort` 等，改用 `src/gen/dmath.ts`），也不使用 `Math.random`（改用 `src/gen/rng.ts`）；由 `pnpm check:dmath` 检查。

两项检查都在 CI（`.github/workflows/pages.yml`）中运行。类型检查（`pnpm build` 中的 `tsc --noEmit`）覆盖 `src/`、`video/` 与 `scripts/`。

## 2. 模块与公开接口

### 2.1 插件内核与插件

内核（`src/kernel/index.ts`）只提供扩展点（`defineSlot`）、注册表（`registryOf`）与启动（`boot`、`bootWorker`）。扩展点由拥有该内容类型的核心模块声明：

| 扩展点 | 声明处 | 内容 |
| --- | --- | --- |
| 命名风格、世界观、制度 | `gen/naming.ts`、`gen/setting.ts`、`gen/polity.ts` | world 层 |
| 文明 | `settlement/culture.ts` | settlement 层 |
| 聚落图主题 | `settlement/themes.ts` | settlement 层 |
| 沙盘套件 | `render/town3d/kits.ts` | town3d 层 |
| 纸图风格 | `render/atlas/styles.ts` | paper 层 |

生成结果只取决于参数引用的内容，与启用清单无关；生成器不得从"全部已登记的条目"中抽样。新增一类可插拔内容时，在拥有它的核心模块里声明扩展点，内容放进插件，不在核心里按 id 分支。

### 2.2 世界生成（gen）

入口为 `generateWorld`（`gen/world.ts`），参数类型与默认值在 `gen/types.ts`（`WorldParams`、`DEFAULT_PARAMS`、`normalizeParams`）。真实地球与区域图走 `gen/earth/`，数据须事先由 `loadEarthGrid`、`loadEarthFeatures` 载入。生成在 Worker 中进行（`src/worker.ts`），结果按 `gen-hash` 缓存（`gen/cache.ts`）。

### 2.3 聚落生成（settlement）

入口为 `generateSettlement` 与 `generateHistory`（`settlement/generate.ts`），参数类型在 `settlement/types.ts`（`SettlementParams`、`DEFAULT_SETTLEMENT`）。生长引擎（`settlement/grow/`）对外的接口以声明文件为准：`api.d.ts`、`natural-api.d.ts`、`paint-api.d.ts`，实现与声明由 `check-api.ts` 在编译期核对。

### 2.4 渲染（render）

- 世界纸图：`render/atlas/`，矢量显示列表（`svg/displayList.ts`）同时用于画布与 SVG 导出；纸图风格经扩展点登记。
- 聚落图：`render/settlementMap.ts` 的 `buildSettlementVector`，同样输出显示列表。
- 三维：`render/scene3d.ts`（世界鸟瞰）、`render/town3d/townScene.ts`（聚落沙盘）、`render/holo/`（全息）。

### 2.5 界面（ui）

每个模块一个目录（`ui/world/`、`ui/settlement/`、`ui/grow/`），模块的状态是该目录主文件导出的 `reactive` 单例（`ws`、`ss`、`gs`），外壳状态是 `ui/app.ts` 的 `app`。组件库在 `ui/kit/`。

## 3. 状态与数据的归属

| 状态 | 权威来源 | 持久化 |
| --- | --- | --- |
| 已登记的插件内容 | 内核的注册表 | 不持久化；启用清单在 localStorage `plugins.off`（`ui/plugins.ts`） |
| 当前语言 | `src/i18n.ts` 的 `lang` | localStorage `lang` |
| 当前模块与地址 | `ui/app.ts` 的 `app` 与路由表 | 地址栏 hash |
| 世界参数与编辑 | `ui/world/world.ts` 的 `ws` | 地址栏、IndexedDB 世界缓存（`gen/cache.ts`）、世界库（`app/library.ts`） |
| 聚落参数 | `ui/settlement/settlement.ts` 的 `ss` | 地址栏、localStorage |
| 生长状态 | `ui/grow/grow.ts` 的 `gs` | localStorage `growSave` |
| 界面偏好 | 各模块 | localStorage，统一经 `ui/app.ts` 的 `storeGet`、`storeSet`、`stored`、`storedJson` |

## 4. 修改指引

- 新增一种文明、命名风格、纸图风格或聚落图主题：只改插件目录与对应的入口表，不改核心。
- 新增一个插件：在 `src/packs/` 下建目录，列进清单与各层入口表；world 层代码只放在插件目录的 `world.ts` 与 `world/`。
- 改动生成算法：世界缓存随 `gen-hash` 自动失效；保持确定性（`pnpm check:dmath`）。
- 改动分层或新增组合根：同时修改本文第 1 节与 `scripts/check-arch.ts`。
