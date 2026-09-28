<p align="center"><img src="docs/images/banner.jpg" alt="Cartographer" width="100%"></p>

<p align="center">由单个种子生成完整的虚构世界：经板块造山、侵蚀、气候与水系推演形成的大陆，<br>以及大陆上各城镇的街区级平面图。</p>

<p align="center"><b><a href="https://jannchie.github.io/cartographer/">在线演示</a></b></p>

<p align="center"><a href="README.md">English</a> · <b>中文</b> · <a href="README.ja.md">日本語</a></p>

Cartographer 依次模拟板块碰撞、流水侵蚀、季风降水与河网汇流，生成成因可解释的大陆地形，并以纸质地图或 3D 沙盘呈现。选择世界地图上的任一城镇即可生成其街区平面图：街巷依地形布设，城墙、宫殿、寺社、市集、港口与农田按所属文明的形制配置。

适用于小说、桌面角色扮演游戏与游戏设定的地图制作。相同种子始终生成相同的世界；城镇规模可连续调节，扩张过程中既有建筑保持不变。地图可导出为 PNG 与 SVG，全部参数保存在 URL 中，共享链接即可复现同一张地图。

```bash
pnpm install
pnpm dev        # 打开 http://localhost:5190
```

## 世界

<p align="center"><img src="docs/images/zh/world-3d.webp" alt="3D 沙盘：云层、晕渲与地名" width="100%"></p>

地形按以下流程逐级生成：

- **板块与造山**：扭曲 Voronoi 模拟板块。汇聚边界隆起山脉和岛弧，离散边界拉出裂谷和洋中脊；海底有陆架、海沟和热点火山岛链。
- **侵蚀**：在粗网格上以流水功率定律迭代求解构造抬升与河流下切，形成树枝状谷地；再于全分辨率下叠加雨滴侵蚀与热力风化。
- **气候与水系**：气温由纬度、海拔与大陆度决定；水汽随风带输送，迎风坡降水充沛，背风坡形成雨影区。流向由 Priority-Flood 算法求得，并依水量平衡生成外流湖、内流湖与盐沼。
- **群系与命名**：依据 Whittaker 气温-降水图划分生物群系。每个世界生成一种独立的虚构语言，用于命名大陆、海洋、山脉、湖泊与城市，并提供中、英、日三种写法。

3D 沙盘支持实时阴影、体积云、水面反射、昼夜循环、自动巡览运镜与胶片调色。编辑模式支持以笔刷抬升或下沉地形、调整气温与降水、增删城镇及划分大洲，编辑完成后重新推演气候与水系。

纸质地图提供六种风格，均包含注记避让、比例尺与图框。浏览时图框固定，缩放仅作用于地图内容：

| 自然地理 | 奇幻羊皮 | 航海图 |
| :-: | :-: | :-: |
| <img src="docs/images/zh/world-physical.webp" width="260"> | <img src="docs/images/zh/world-fantasy.webp" width="260"> | <img src="docs/images/zh/world-nautical.webp" width="260"> |
| **提瓦特** | **水墨** | **等高线** |
| <img src="docs/images/zh/world-teyvat.webp" width="260"> | <img src="docs/images/zh/world-ink.webp" width="260"> | <img src="docs/images/zh/world-topo.webp" width="260"> |

## 聚落

人口滑块可将同一城镇从数十人的村落连续扩展至数万人的城市，也可播放扩张动画。地形以世界坐标定义，城镇扩张时山地、河流与海岸位置保持不变。

| 120 人 | 1,500 人 |
| :-: | :-: |
| <img src="docs/images/zh/growth-120.webp" width="420"> | <img src="docs/images/zh/growth-1500.webp" width="420"> |
| **6,000 人** | **24,000 人** |
| <img src="docs/images/zh/growth-6000.webp" width="420"> | <img src="docs/images/zh/growth-24000.webp" width="420"> |

四种文明各具独立的城市形制、建筑类型与地名体系，三种语言的地名一一对应：

| 西式 · 有机生长的港城 | 东方 · 里坊制都城 |
| :-: | :-: |
| <img src="docs/images/zh/settlement-western.webp" width="420"> | <img src="docs/images/zh/settlement-eastern.webp" width="420"> |
| **和风 · 城下町** | **伊斯兰 · 麦地那** |
| <img src="docs/images/zh/settlement-wa.webp" width="420"> | <img src="docs/images/zh/settlement-islamic.webp" width="420"> |
| **西式 · 罗马营寨城** | **西式 · 中世纪方格新城** |
| <img src="docs/images/zh/settlement-castrum.webp" width="420"> | <img src="docs/images/zh/settlement-bastide.webp" width="420"> |

- **西式**：有机街巷、城堡与幕墙、大教堂、广场、三圃制条田；另有罗马营寨城与中世纪方格新城两种规划形制。
- **东方**：坐北朝南的方城、里坊与十字街、东西两市、宫城坐北居中、四合院；坟地散布在城外的坡地上。
- **和风**：城下町（天守、武家地、町人地、寺町、枡形），或仿平安京的条坊制（大内里、十六町、罗城门）。
- **伊斯兰**：大清真寺与集市居于城市中心，内院住宅沿尽端巷分布，配有浴场与商队客栈，王宫沿中轴线串联院落。

### 地标

宫殿、寺院、教堂、城堡、清真寺与公园由「骨架规则 + 元素池」组合生成：先依各传统的构图原则确定布局（中轴对称的院落序列、伽蓝配置、教堂的中殿与耳堂、池泉回游式园林等），再由种子从元素池中选取构件。同一文明下的宫城极少雷同，城镇扩张时既有地标保持原状。

| 宫城 | 大教堂与回廊院 | 千本鸟居 |
| :-: | :-: | :-: |
| <img src="docs/images/common/landmark-palace.webp" width="280"> | <img src="docs/images/common/landmark-cathedral.webp" width="280"> | <img src="docs/images/common/landmark-senbon.webp" width="280"> |
| **海上鸟居** | **山上修道院** | **文人园林** |
| <img src="docs/images/common/landmark-umi.webp" width="280"> | <img src="docs/images/common/landmark-abbey.webp" width="280"> | <img src="docs/images/common/park-eastern.webp" width="280"> |
| **枯山水** | **规则式花坛园** | **四分园** |
| <img src="docs/images/common/park-wa.webp" width="280"> | <img src="docs/images/common/park-western.webp" width="280"> | <img src="docs/images/common/park-islamic.webp" width="280"> |

- **尺度**：地标分为四级，从路旁小祠、堂区教堂，到占据整个片区的寺院，再到跨越多个片区的大社与同心圆城堡。小型地标散布于街坊与乡间，大型地标较为稀少。
- **名所**：千本鸟居、海上鸟居、奥宫石阶、山寺、修道院与岩上城堡等名所，仅在地形条件满足时以较低概率出现。
- **布局合理性**：每座城门均有道路连通，桥梁垂直跨越河道，城墙以内为菜园、以外为大田，墓地位于城外坡地。

### 皮肤与视图

同一城镇可切换八种地图皮肤：

| 羊皮纸 | 彩绘 | 版画 | 蓝图 |
| :-: | :-: | :-: | :-: |
| <img src="docs/images/zh/skin-parchment.webp" width="200"> | <img src="docs/images/zh/skin-color.webp" width="200"> | <img src="docs/images/zh/skin-ink.webp" width="200"> | <img src="docs/images/zh/skin-blueprint.webp" width="200"> |
| **切绘图** | **图底铜版** | **方志舆图** | **测绘图** |
| <img src="docs/images/zh/skin-kiriezu.webp" width="200"> | <img src="docs/images/zh/skin-nolli.webp" width="200"> | <img src="docs/images/zh/skin-fangzhi.webp" width="200"> | <img src="docs/images/zh/skin-survey.webp" width="200"> |

区划视图按用地性质为片区着色，并列出各类用地的面积占比：

<p align="center"><img src="docs/images/zh/zoning.webp" alt="区划视图" width="80%"></p>

- **悬停说明**：根据鼠标停留位置显示对应要素的详细信息，例如「町家 · 1 层 · 1 户」「大田 · 小麦、黑麦、燕麦（三圃轮作）」「九曲桥」。
- **与世界地图同步**：在「世界地点」中选择城镇后，其名称、规模、河流来向、海岸、山地与气候与世界地图上的对应地点同步。
- **随机化**：可仅更换种子并保留其余配置，也可固定当前地形、仅重新生成城镇。

## 离线渲染

可在 Node 环境中直接渲染，用于参数调试与批量输出：

```bash
pnpm atlas:png aurelia physical,ink out/                          # 世界纸图
pnpm settlement:png edo city color out/ culture=wa plan=jokamachi  # 聚落地图，key=value 覆盖参数
pnpm showcase                                                      # 重新生成本文的配图（中英日三套）
```

另有 `preview:png`（生物群系预览及各生成阶段耗时）与 `shade:png`（仅含地形晕渲的底图）。
