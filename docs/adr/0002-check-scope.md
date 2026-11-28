# 0002 机器检查的覆盖范围

日期：2026-11-28　状态：已采纳

## 背景

ADR 0001 建立了分层检查并把确定性检查接入 CI。之后的治理中发现三处检查覆盖不到、规范因此漂移的情况：

- 确定性检查只扫描 `src/gen` 与 `src/settlement`，而插件的 world 层与 settlement 层（文明的构图、片区、命名）同样参与生成；`Math.random` 不在禁用之列。
- `tsconfig.json` 只包含 `src/` 与 `video/`，离线脚本不做类型检查。纳入时发现自检与截图脚本中已有随接口演进而失效的类型，以及对已删除字段 `Settlement.center` 的引用。
- 本机存储、IndexedDB 与后台线程的创建虽然都集中在少数模块中，但这只是习惯，没有约束。

## 决定

1. `check:dmath` 覆盖插件中除 town3d、paper、ui 层以外的代码，并禁用 `Math.random`。
2. `tsconfig.json` 纳入 `scripts/`；`pnpm build` 的类型检查随之覆盖离线脚本。
3. `check:arch` 增加"所属模块"一项：localStorage 与 sessionStorage 只在 `ui/app.ts` 与 `i18n.ts` 中直接使用，IndexedDB 只在 `app/library.ts` 与 `gen/cache.ts` 中使用，`new Worker` 只在线程客户端模块中使用。

## 后果

- 插件作者在生成代码中使用随引擎而变的数学函数会在 CI 中失败。
- 引擎接口改动时，依赖它的离线脚本须同步修改，否则构建失败。
- 新增一种浏览器存储或线程须修改 `scripts/check-arch.ts` 的 `OWNED_APIS`，并在 `docs/architecture.md` 中说明归属。
