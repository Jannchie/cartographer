# 架构治理任务池

记录架构治理的进度、待办事项与待确认事项。完成的事项注明提交；决策另见 [`docs/adr/`](adr/)，现行规则见 [`docs/architecture.md`](architecture.md)。

验证方式：每批改动在提交前通过 `tsc`、`pnpm check:arch`、`pnpm check:dmath` 与 `pnpm build`，并在本地比对世界生成、纸图 SVG、聚落生成、聚落图与自然生长的输出哈希（比对脚本不进仓库）。

## 已完成

| 事项 | 说明 |
| --- | --- |
| 引擎层依赖方向 | 等值线移入 `gen/contour.ts`，聚落图渲染器移入 `render/settlementMap.ts`，键盘约定移入 `render/keys.ts`（ADR 0001） |
| 确定性写法 | 修正 13 处随引擎实现而变的数学写法；`check:dmath` 进入 CI |
| 架构检查 | `scripts/check-arch.ts`：分层、插件依赖、world 层封闭性、运行时无环、可达性；进入 CI |
| 运行时环 | `riverThreshold` 移入 `gen/hydrology.ts`，`signedCoastDist`、`slopeField` 移入 `gen/util.ts`；承载组合地标的片区移入 `settlement/landmarkWards.ts`；`roofFrame` 移入 `render/town3d/worksMesh.ts`。源码中不再有运行时导入环 |
| 成长史线程客户端 | `ui/grow/planWorker.ts` 删除；聚落与生长模块共用 `ui/settlement/historyWorker.ts` 的 `historyClient`，只在"上一份没算完"的策略上不同（`supersede`、`reject`）。世界生成线程补上 `onerror` |
| 撤销栈 | 世界编辑、世界区域、聚落区域、生长四处改用 `ui/undo.ts` 的 `UndoStack`。区域撤销记录在换世界、换城时清空（此前会把上一座城的区域写进当前城的存储） |
| 渲染层小项 | `RoadMask`、`RiverCarve` 共用 `render/aerial/maxMask.ts` 的 `MaxMask`；GLSL `hash12` 只留 `HASH12_GLSL` 一份；`rgb()` 颜色串只留 `render/palette.ts` 一份；`worksMesh` 的 `tube` 改名 `wallTube`，与 `mesh.ts` 的 `tube` 区分；删除从未调用、且释放不全的 `Scene3D.dispose` |
| 三维舞台的共用部件 | 世界沙盘与聚落沙盘的渲染器配置、画布随容器调整、移动中渲染缩放的自适应、性能读数浮层合并到 `render/aerial/stage.ts`；两者只保留各自的目标帧时与额外读数。聚落沙盘释放时一并移走性能浮层。键盘导航的平移、转向与俯仰合并为 `keyNavStep`，推拉仍由各场景按自己的缩放方式处理 |
| 所属模块检查 | `check:arch` 增加一项：本机存储、IndexedDB 与后台线程的创建只出现在各自的所属模块里 |
| 确定性检查的范围 | `check:dmath` 覆盖插件中参与生成的代码，并禁用 `Math.random` |
| 闭环化简 | `gen/util.ts` 的 `simplifyLine` 在首尾重合时把所有距离算作 0，闭环（例如被另一政区完全包围的飞地的边界）化简后只剩两个点、从纸图上消失；改为按到端点的距离取舍 |
| 界面小项 | 聚落生成失败的提示改为先翻译前缀（此前拼接后查不到词条，任何语言下都显示中文）；生长模块按 `app.module` 判断当前模块，不再自行解析地址 |

## 待办

按价值与风险排序。

### 界面层

- **状态文字的翻译**：加载层与状态栏有的存原文、有的存译文；存译文的在加载过程中切换语言不会重译。统一为"键 + 参数"需要改动加载层组件的接口。

### 渲染层

- **三维场景的其余重复**：两个场景的巡览接线与 P/T/N/Esc 快捷键仍各写一份；渲染循环一个持续出帧、一个按需出帧，合并成一个宿主类的收益有限。
- **哈希与值噪声**：渲染层有约 8 处本地实现，公式各不相同、决定画面纹理，只能换调用位置、不能改公式。

### 引擎层

- **四份 Douglas–Peucker**：`gen/contour.ts` 的 `simplify`（到弦所在直线、平方比较）、`gen/util.ts` 的 `simplifyLine`（到直线、绝对值）、`gen/earth/raster.ts` 的 `simplifyLine`（到线段）、`settlement/grow/place.ts` 的 `simplify`（到线段、点数组）。其中三份参与生成，合并会在门槛附近改变取舍，须先确认生成结果的变化可以接受。

## 已评估、不做

- **本地存储的 JSON 解析**：5 处自行解析 JSON 的读取各自带不同的校验（版本号、数组、调色板 id、按原文缓存），抽出公共函数每处只省两三行。
- **地址参数编解码**：世界、聚落、生长三份编解码各含领域专属的字段、钳制与枚举，通用部分每份不足十行；统一布尔值的写法会改变已分享链接的格式。
- **旧存档的文明判断**（`ui/settlement/settlement.ts` 中 `saved.culture === 'eastern'`）：规整度参数引入之前存下的参数的迁移，引用的是历史数据中的 id，保留。

## 插件化缺口

- **园林传统**：`settlement/garden/kit.ts` 的 `GardenTradition` 是四种传统的封闭集合，园林引擎（`garden/elements.ts`、`skeletons.ts`、`parks.ts`）按传统 id 分支。新的世界观插件无法加入自己的园林传统。改为由文明提供园林参数（亭的形制、路宽、岛的数量等）需要逐项梳理分支，并保证现有文明的生成结果不变。

## 待确认

- **实验符号套**（`src/render/atlas/symbols/`，约 5000 行）：山、森林、散树的多种画法，尚未接入任何纸图风格，也没有入口导入。需要决定接入（做成纸图风格引用的扩展点）还是删除。
