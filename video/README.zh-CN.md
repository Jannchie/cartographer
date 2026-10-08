# 视频

<p><a href="README.md">English</a> · <b>中文</b></p>

基于 Cartographer 全息视图的程序化视频。每个视频是一个网页，画面内容只取决于帧号；录制脚本在 Chrome 中逐帧渲染页面，并以 ffmpeg 编码。

| 路径 | 内容 |
| --- | --- |
| `record.ts` | 通用录制脚本：3840 × 2160，帧率与时长取自页面 |
| `shared/page.ts` | 页面运行时：逐帧约定、字体、叠加层画布、浏览器内预览 |
| `shared/hud.ts` | 界面动效：故障闪现、信息栏、状态栏 |
| `shared/motion.ts` | 缓动与时间工具 |
| `expressway/` | 《中国高速公路网 1988–2025》 |

## 页面约定

视频页面位于 `video/<名称>/index.html`，调用 `shared/page.ts` 的 `runVideo`，并暴露 `window.__video`：

- `ready`：数据与场景准备完成后为 `true`；
- `frame(i)`：绘制第 `i` 帧。结果只能取决于 `i`，以保证任意帧可按任意顺序渲染。

画面为 1920 × 1080 CSS 像素：`#stage` 承载全息场景，`#overlay` 为其上的 2D 画布。录制时设备像素比为 2，输出 3840 × 2160 的画面。

## 运行环境

- Chrome（在 Windows、macOS 与 Linux 上自动查找），以及 `PATH` 中的 ffmpeg。有 NVIDIA 编码器时使用 NVENC，否则使用 libx264。
- 本机安装鸿蒙字体 HarmonyOS Sans SC（Regular、Medium、Bold）。录制脚本默认从 Windows 用户字体目录读取字体文件，其他位置以 `--fonts=<目录>` 指定。Berkeley Mono 由页面从 CDN 加载。

## 用法

```bash
pnpm dev                                    # 预览：http://localhost:5190/video/expressway/index.html?preview
pnpm video expressway out.mp4 --audio=bgm.wav
pnpm video expressway stills/ --stills=300,3000,5250    # 指定帧输出为 JPEG
```

预览将 16:9 画面缩放至窗口大小并提供播放控制：空格播放或暂停，←/→ 前后跳转 5 秒，`,` 与 `.` 逐帧移动。播放按实际时间推进，渲染跟不上时跳帧。录制时以 `--query=<参数>` 附加页面参数，例如 `--query=theme=cyan`。

## 中国高速公路网 1988–2025

三分钟的视频，按年份呈现中国大陆高速公路网的建成过程。每条路段在开通的年份从一端绘制到另一端，叠加层同步显示官方累计里程，并在事件发生地标出重要事件。

### 数据

1. 生成「中国」模板的数据：`pnpm china <原始数据目录>`（见 `scripts/china-real.ts`）。
2. 从 Geofabrik 下载中国的 OpenStreetMap 数据包（`china-latest.osm.pbf`），提取高速公路（需要 `pyosmium`）：

   ```bash
   python video/expressway/data/extract-osm.py china-latest.osm.pbf motorways.json
   ```

3. 从 [malin84/transportation_networks_of_china](https://github.com/malin84/transportation_networks_of_china) 下载 Ma 与 Tang（2024）的路段数据。
4. 推断各路段的开通时间，生成 `public/china/roads.bin`：

   ```bash
   pnpm tsx video/expressway/data/build.ts motorways.json <Ma–Tang 数据目录>
   ```

开通时间依次取自：OpenStreetMap 的标注；Ma–Tang 数据集（3 公里内匹配）；同一线路上最近的已知路段；其余路段按与已开通路网的距离排序后估算，使各年累计里程与官方统计一致。仅知年份的路段在年内按接入路网的先后排列。片尾注明估算路段所占的比例。

### 配乐

配乐以 NumPy 与 SciPy 合成，与时间轴对齐：

```bash
pnpm tsx video/expressway/cues.ts > cues.json
python video/expressway/bgm.py cues.json bgm.wav
```

### 事实依据

年度里程采用交通运输部历年统计公报与国家统计局《中国统计年鉴》的年底值。事件字幕已对照官方公报与当时的报道逐条核实，出处记录于 `expressway/timeline.ts`。

### 来源与许可

| 数据 | 来源 | 许可 |
| --- | --- | --- |
| 地形 | NOAA ETOPO 2022 | 公有领域 |
| 陆地、湖泊、山峰 | Natural Earth | 公有领域 |
| 行政区划 | DataV.GeoAtlas | 提供方条款 |
| 高速公路线形与开通日期 | © OpenStreetMap 贡献者 | ODbL 1.0 |
| 路段建设年份 | Ma 与 Tang（2024），*J. Int. Econ.* 148, 103873 | GPL-3.0 |
| 年度里程 | 交通运输部；国家统计局 | 官方统计 |

生成的 `public/china/` 数据不随仓库分发：`roads.bin` 源自 ODbL 与 GPL-3.0 数据，行政区划受其提供方条款约束。在中华人民共和国境内公开登载中国地图须经地图审核；面向境内发布的视频，界线应采用经审核的标准地图。
