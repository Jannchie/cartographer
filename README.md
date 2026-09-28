<p align="center">
  <img src="docs/images/world-physical.webp" alt="种子 aurelia 生成的世界，自然地理风格" width="100%">
</p>

<h1 align="center">Cartographer</h1>

<p align="center">从一个种子生成整个虚构世界：板块造山、侵蚀、气候与水系塑成的大陆，<br>以及大陆上每一座城镇的街区级平面图。</p>

输入一个种子，Cartographer 先模拟板块碰撞、流水侵蚀、季风降水和河流汇聚，得到一片有来龙去脉的大陆，再把它画成纸质地图或 3D 沙盘。在世界地图上任选一座城镇，就能展开它的街区平面图：街巷沿地形生长，城墙、宫殿、寺社、市集、港口、农田逐一落地，形制随文明而变。

它适合给小说、跑团、游戏设定配地图：同一个种子永远生成同一个世界，城市规模可以调，城区会连续地长大，已有的建筑不跟着变。地图可以导出 PNG 和 SVG，参数都写在链接里，把链接发出去，别人打开看到的就是同一张图。

```bash
pnpm install
pnpm dev        # 打开 http://localhost:5190
```

纯前端运行，不需要后端和 API key。

## 世界

<p align="center"><img src="docs/images/world-3d.webp" alt="3D 沙盘：云层、晕渲与地名" width="100%"></p>

地形不是噪声拼出来的，而是按生成流程一步步塑造出来的：

- **板块与造山**：扭曲 Voronoi 模拟板块。汇聚边界隆起山脉和岛弧，离散边界拉出裂谷和洋中脊；海底有陆架、海沟和热点火山岛链。
- **侵蚀**：先在粗网格上用流水功率定律做"构造抬升与流水下切"的迭代，刻出树枝状的山谷；再在全分辨率上叠加雨滴侵蚀和热力风化。
- **气候与水系**：气温由纬度、海拔和大陆度决定；水汽随风带推进，迎风坡多雨，背风坡形成雨影。用 Priority-Flood 求流向，按水量平衡形成外流湖、内流湖和盐沼。
- **群系与命名**：按 Whittaker 气温-降水图分出群系。每个世界随机生成一门语言，用来给大陆、海洋、山脉、湖泊和城市起名，同时提供中、英、日三种写法。

3D 沙盘带实时阴影、体积云、水面反射和巡览运镜，也可以调胶片滤镜。编辑模式下，可以用画笔抬升或下沉地形、调冷暖和干湿、增删城镇、划分大洲，改完会重新推演气候与水系。

纸质地图有六种风格，都带注记避让、比例尺和图框：

| 自然地理 | 奇幻羊皮 | 航海图 |
| :-: | :-: | :-: |
| <img src="docs/images/world-physical.webp" width="260"> | <img src="docs/images/world-fantasy.webp" width="260"> | <img src="docs/images/world-nautical.webp" width="260"> |
| **提瓦特** | **水墨** | **等高线** |
| <img src="docs/images/world-teyvat.webp" width="260"> | <img src="docs/images/world-ink.webp" width="260"> | <img src="docs/images/world-topo.webp" width="260"> |

## 聚落

同一座城在人口滑块上可以从几十人一路长到几万人，也可以播放成长动画。地形按世界坐标定义，城长大时山、河、海岸都不挪。

| 120 人 | 1,500 人 | 6,000 人 | 24,000 人 |
| :-: | :-: | :-: | :-: |
| <img src="docs/images/growth-120.webp" width="200"> | <img src="docs/images/growth-1500.webp" width="200"> | <img src="docs/images/growth-6000.webp" width="200"> | <img src="docs/images/growth-24000.webp" width="200"> |

四种文明各有自己的形制、建筑和地名，三种语言的地名互相对应：

| 西式 · 有机生长的港城 | 东方 · 里坊制都城 |
| :-: | :-: |
| <img src="docs/images/settlement-western.webp" width="420"> | <img src="docs/images/settlement-eastern.webp" width="420"> |
| **和风 · 城下町** | **伊斯兰 · 麦地那** |
| <img src="docs/images/settlement-wa.webp" width="420"> | <img src="docs/images/settlement-islamic.webp" width="420"> |

- **西式**：有机街巷、城堡与幕墙、大教堂、广场、三圃制条田；可选罗马营寨城和中世纪方格新城。
- **东方**：坐北朝南的方城、里坊与十字街、东西两市、宫城坐北居中、四合院；坟地散布在城外的坡地上。
- **和风**：城下町（天守、武家地、町人地、寺町、枡形），或仿平安京的条坊制（大内里、十六町、罗城门）。
- **伊斯兰**：大清真寺与集市居中，内院住宅与尽端巷，浴场、商队客栈，王宫沿中轴排列院落。

### 地标

宫殿、寺院、教堂、城堡、清真寺、公园都不是固定模板，而是由"骨架规则 + 元素池"组合出来的：先按传统定下构图原则（中轴对称的院落序列、伽蓝配置、教堂的中殿与耳堂、池泉回游……），再按种子从元素池里挑部件。同一文明下几乎没有两座一样的宫城，城长大时已有的地标也保持原样。

| 宫城 | 大教堂与回廊院 | 千本鸟居 |
| :-: | :-: | :-: |
| <img src="docs/images/landmark-palace.webp" width="280"> | <img src="docs/images/landmark-cathedral.webp" width="280"> | <img src="docs/images/landmark-senbon.webp" width="280"> |
| **海上鸟居** | **山上修道院** | **文人园林** |
| <img src="docs/images/landmark-umi.webp" width="280"> | <img src="docs/images/landmark-abbey.webp" width="280"> | <img src="docs/images/park-eastern.webp" width="280"> |
| **枯山水** | **规则式花坛园** | **四分园** |
| <img src="docs/images/park-wa.webp" width="280"> | <img src="docs/images/park-western.webp" width="280"> | <img src="docs/images/park-islamic.webp" width="280"> |

- **尺度**：地标分四档，从路边小祠、堂区教堂，到占一整个片区的寺院，再到合并几个片区的大社和同心城。小的散布在街坊和乡间，大的少见。
- **名所**：千本鸟居、海上鸟居、奥宫石阶、山寺、修道院、岩上城堡这类名所，只在地形合适时偶尔出现。
- **合乎常识**：城门都有路接进来，桥垂直跨河，墙内种菜园、墙外种大田，坟地在城外的坡上。

### 皮肤与视图

同一座城可以换八种皮肤：

| 羊皮纸 | 彩绘 | 版画 | 蓝图 |
| :-: | :-: | :-: | :-: |
| <img src="docs/images/skin-parchment.webp" width="200"> | <img src="docs/images/skin-color.webp" width="200"> | <img src="docs/images/skin-ink.webp" width="200"> | <img src="docs/images/skin-blueprint.webp" width="200"> |
| **切绘图** | **图底铜版** | **方志舆图** | **测绘图** |
| <img src="docs/images/skin-kiriezu.webp" width="200"> | <img src="docs/images/skin-nolli.webp" width="200"> | <img src="docs/images/skin-fangzhi.webp" width="200"> | <img src="docs/images/skin-survey.webp" width="200"> |

切换到区划视图，片区按用地性质着色，并附上各类用地的面积占比：

<p align="center"><img src="docs/images/zoning.webp" alt="区划视图" width="80%"></p>

- **悬停说明**：鼠标停在地图上，会显示指着的是什么，比如"町家 · 1 层 · 1 户"、"大田 · 小麦、黑麦、燕麦（三圃轮作）"、"九曲桥"。
- **从世界地图继承**：在"世界地点"里选一座城，它的名字、规模、河流来向、海岸、山地和气候都从世界地图带过来。
- **随机**：随机时可以只换种子、保留其他配置，也可以固定当前地形、只换上面的城。

## 离线渲染

Node 下可以直接出图，方便调参和批量生成：

```bash
pnpm atlas:png aurelia physical,ink out/                          # 世界纸图
pnpm settlement:png edo city color out/ culture=wa plan=jokamachi  # 聚落地图，key=value 覆盖参数
pnpm showcase                                                      # 重新生成本文的配图
```

另有 `preview:png`（群系预览与各阶段耗时）和 `shade:png`（纯地形晕渲）。
