# Videos

<p><b>English</b> · <a href="README.zh-CN.md">中文</a></p>

Programmatic videos built on the hologram view of Cartographer. Each video is a web page whose content depends only on the frame number; a recorder renders the page frame by frame in Chrome and encodes the result with ffmpeg.

| Path | Content |
| --- | --- |
| `record.ts` | Recorder for any video page: 3840 × 2160, frame rate and duration taken from the page |
| `shared/page.ts` | Page runtime: frame contract, fonts, overlay canvas, in-browser preview |
| `shared/hud.ts` | Interface motion: glitch reveal, information panels, status bar |
| `shared/motion.ts` | Easing and timing helpers |
| `expressway/` | *China Expressway Network 1988–2025* |

## Page contract

A video page lives at `video/<name>/index.html` and calls `runVideo` from `shared/page.ts`. The page exposes `window.__video`:

- `ready` becomes `true` once data and scene are prepared;
- `frame(i)` draws frame `i`. The result must depend on `i` alone, so that any frame can be rendered in any order.

The canvas is 1920 × 1080 CSS pixels: `#stage` holds the hologram scene and `#overlay` a 2D canvas drawn above it. During recording the device pixel ratio is 2, which yields 3840 × 2160 frames.

## Requirements

- Chrome (located automatically on Windows, macOS and Linux) and ffmpeg on `PATH`. NVENC is used when an NVIDIA encoder is available, otherwise libx264.
- HarmonyOS Sans SC installed locally (Regular, Medium and Bold). The recorder reads the font files from the Windows user font directory by default; pass `--fonts=<dir>` otherwise. Berkeley Mono is loaded from a CDN by the page.

## Usage

```bash
pnpm dev                                    # preview: http://localhost:5190/video/expressway/index.html?preview
pnpm video expressway out.mp4 --audio=bgm.wav
pnpm video expressway stills/ --stills=300,3000,5250    # selected frames as JPEG
```

The preview scales the 16:9 frame to the window and provides playback controls: Space plays or pauses, ←/→ seek by 5 seconds, `,` and `.` step by one frame. Playback follows wall-clock time and skips frames when rendering falls behind. `--query=<params>` appends page parameters when recording, for example `--query=theme=cyan`.

## China Expressway Network 1988–2025

A three-minute video of the national expressway network of mainland China growing year by year. Each road segment is drawn from one end to the other in the year it opened, while the overlay shows the official cumulative mileage and selected events placed at their locations on the map.

### Data

1. Build the China template: `pnpm china <source-dir>` (see `scripts/china-real.ts`).
2. Download the OpenStreetMap extract for China from Geofabrik (`china-latest.osm.pbf`) and extract motorways (requires `pyosmium`):

   ```bash
   python video/expressway/data/extract-osm.py china-latest.osm.pbf motorways.json
   ```

3. Download the segment data of Ma and Tang (2024) from [malin84/transportation_networks_of_china](https://github.com/malin84/transportation_networks_of_china).
4. Infer the opening date of every segment and write `public/china/roads.bin`:

   ```bash
   pnpm tsx video/expressway/data/build.ts motorways.json <ma-tang-dir>
   ```

Opening dates are taken, in order of preference, from OpenStreetMap tags, from the Ma–Tang dataset (matched within 3 km), from the nearest dated segment of the same route, and finally by estimation: the remaining segments are ordered by their distance from the opened network and assigned so that the cumulative length of each year matches the official mileage. Dates known only to the year are distributed within the year in the order in which segments connect to the network. The end card states the share of estimated segments.

### Soundtrack

The soundtrack is synthesised with NumPy and SciPy and aligned with the timeline:

```bash
pnpm tsx video/expressway/cues.ts > cues.json
python video/expressway/bgm.py cues.json bgm.wav
```

### Facts

Annual mileage follows the statistical bulletins of the Ministry of Transport and the *China Statistical Yearbook* of the National Bureau of Statistics (year-end values). Event captions were checked against official bulletins and contemporary reports; the sources are recorded in `expressway/timeline.ts`.

### Sources and licenses

| Data | Source | License |
| --- | --- | --- |
| Terrain | NOAA ETOPO 2022 | Public domain |
| Land, lakes, summits | Natural Earth | Public domain |
| Administrative divisions | DataV.GeoAtlas | Terms of the provider |
| Expressway geometry and dates | © OpenStreetMap contributors | ODbL 1.0 |
| Segment construction years | Ma and Tang (2024), *J. Int. Econ.* 148, 103873 | GPL-3.0 |
| Annual mileage | Ministry of Transport; National Bureau of Statistics | Official statistics |

The generated `public/china/` data are not distributed with this repository: `roads.bin` derives from ODbL and GPL-3.0 sources, and the administrative divisions are subject to the terms of their provider. Publication of a map of China within the People's Republic of China is subject to map review; a video intended for publication there should use a reviewed standard map for its boundaries.
