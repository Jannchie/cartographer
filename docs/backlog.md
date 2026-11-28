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

## 待办

按价值与风险排序。

### 界面层

- **本地存储**：`storeGet`、`storeSet`、`storedJson` 之外，另有 5 处自行解析 JSON、两套写入防抖。
- **状态文字的翻译**：加载层与状态栏有的存原文、有的存译文，有的存拼接后的字符串（`'生成失败：' + msg`），切换语言后不重译。
- **地址参数编解码**：世界与聚落按默认值的类型通用编解码，生长模块逐字段手写。

### 渲染层

- **三维场景骨架**：`render/scene3d.ts` 与 `render/town3d/townScene.ts` 的渲染器创建、尺寸调整、性能浮层、画质切换基本相同，可抽出共用的舞台宿主；两者的帧率自适应目标不同（显示器刷新间隔、固定 60 帧），合并时须保留。
- **哈希与值噪声**：渲染层有约 8 处本地实现，公式各不相同、决定画面纹理，只能换调用位置、不能改公式。

### 引擎层

- **两份 Douglas–Peucker**：`gen/contour.ts` 的 `simplify` 与 `gen/util.ts` 的 `simplifyLine` 在门槛与距离比较上略有不同，合并会改变输出，须逐处核对。

## 待确认

- **实验符号套**（`src/render/atlas/symbols/`，约 5000 行）：山、森林、散树的多种画法，尚未接入任何纸图风格，也没有入口导入。需要决定接入（做成纸图风格引用的扩展点）还是删除。
