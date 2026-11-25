/**
 * 沙盘层的文化包入口：导入各内置文化包的沙盘套件注册（模块导入时静态注册，主线程与 Worker 各自生效）。
 * 只为副作用导入，由沙盘层的入口模块（render/town3d 的 massing.ts、townScene.ts）导入；
 * 沙盘层的其余模块只依赖注册表（render/town3d/kits.ts），不导入本模块。
 */
import './classic/town3d'
