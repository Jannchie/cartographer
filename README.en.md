<p align="center">
  <img src="docs/images/en/world-physical.webp" alt="World generated from seed aurelia, physical style" width="100%">
</p>

<h1 align="center">Cartographer</h1>

<p align="center">Generate a whole fictional world from one seed: continents shaped by plate tectonics, erosion, climate and rivers,<br>plus a street-level plan of every town on them.</p>

<p align="center"><a href="README.md">中文</a> · <b>English</b> · <a href="README.ja.md">日本語</a></p>

Give Cartographer a seed and it simulates colliding plates, fluvial erosion, monsoon rainfall and river networks to build a continent with a history, then draws it as a paper map or a 3D diorama. Pick any town on the world map to open its street plan: streets follow the terrain, and walls, palaces, shrines, markets, harbours and fields are laid out in the style of the town's culture.

Use it for novels, tabletop campaigns and game settings. The same seed always gives the same world. Town size is a slider, towns grow continuously, and existing buildings stay where they are as a town grows. Maps export to PNG and SVG, and all parameters live in the URL, so a shared link opens the same map.

```bash
pnpm install
pnpm dev        # open http://localhost:5190
```

Runs entirely in the browser; no backend or API key.

## World

<p align="center"><img src="docs/images/en/world-3d.webp" alt="3D diorama with clouds, relief shading and place names" width="100%"></p>

The terrain is built up stage by stage:

- **Plates and mountains**: warped Voronoi plates. Convergent boundaries raise ranges and island arcs, divergent ones open rifts and mid-ocean ridges; the sea floor gets shelves, trenches and hotspot island chains.
- **Erosion**: a stream-power uplift-versus-incision iteration on a coarse grid carves dendritic valleys, then full-resolution droplet erosion and thermal weathering add detail.
- **Climate and water**: temperature from latitude, elevation and continentality; moisture advected by wind belts gives wet windward slopes and rain shadows. Priority-Flood routing and a water balance produce draining lakes, endorheic lakes and salt flats.
- **Biomes and names**: Whittaker-style biomes. Each world invents a language to name continents, seas, ranges, lakes and cities, with matching Chinese, English and Japanese forms.

The 3D diorama has real-time shadows, volumetric clouds, water reflections, a flyover tour and film-style grading. Edit mode lets you raise or lower land, paint heat and rainfall, add or remove towns and draw continents; climate and rivers are recomputed afterwards.

Six paper-map styles, all with label placement, scale bar and frame. While browsing, the frame stays fixed and only the map zooms:

| Physical | Fantasy | Nautical |
| :-: | :-: | :-: |
| <img src="docs/images/en/world-physical.webp" width="260"> | <img src="docs/images/en/world-fantasy.webp" width="260"> | <img src="docs/images/en/world-nautical.webp" width="260"> |
| **Teyvat** | **Ink wash** | **Topographic** |
| <img src="docs/images/en/world-teyvat.webp" width="260"> | <img src="docs/images/en/world-ink.webp" width="260"> | <img src="docs/images/en/world-topo.webp" width="260"> |

## Settlements

Drag the population slider and the same town grows from a hamlet of dozens to a city of tens of thousands, or play the growth animation. Terrain is defined in world coordinates, so hills, rivers and coast stay put as the town grows.

| 120 people | 1,500 people |
| :-: | :-: |
| <img src="docs/images/en/growth-120.webp" width="420"> | <img src="docs/images/en/growth-1500.webp" width="420"> |
| **6,000 people** | **24,000 people** |
| <img src="docs/images/en/growth-6000.webp" width="420"> | <img src="docs/images/en/growth-24000.webp" width="420"> |

Four cultures, each with its own town plans, buildings and place names:

| Western · organic harbour town | Chinese · walled-ward capital |
| :-: | :-: |
| <img src="docs/images/en/settlement-western.webp" width="420"> | <img src="docs/images/en/settlement-eastern.webp" width="420"> |
| **Japanese · castle town** | **Islamic · medina** |
| <img src="docs/images/en/settlement-wa.webp" width="420"> | <img src="docs/images/en/settlement-islamic.webp" width="420"> |

- **Western**: organic lanes, castle and curtain wall, cathedral, market square, three-field strips; optional Roman castrum or medieval bastide grid.
- **Chinese**: south-facing walled grid, walled wards with cross streets, East and West Markets, palace at the north, courtyard houses; family tombs on the hillsides outside town.
- **Japanese**: castle town (keep, samurai and merchant quarters, temple row, masugata gates), or a Heian-kyō style jōbō grid (Greater Palace, sixteen chō per ward, Rajōmon).
- **Islamic**: great mosque and souq at the centre, courtyard houses on dead-end lanes, hammams and caravanserais, a palace of courts along an axis.

### Landmarks

Palaces, temples, churches, castles, mosques and parks are composed from skeleton rules and element pools. Each tradition's layout grammar sets the plan (an axial sequence of courts, a temple compound arrangement, a church's nave and transept, a pond-and-stroll garden…), and the seed picks the parts. Two palaces of the same culture are rarely alike, and existing landmarks keep their form as the town grows.

| Palace city | Cathedral and cloister | Senbon torii |
| :-: | :-: | :-: |
| <img src="docs/images/common/landmark-palace.webp" width="280"> | <img src="docs/images/common/landmark-cathedral.webp" width="280"> | <img src="docs/images/common/landmark-senbon.webp" width="280"> |
| **Torii in the sea** | **Hilltop abbey** | **Scholar's garden** |
| <img src="docs/images/common/landmark-umi.webp" width="280"> | <img src="docs/images/common/landmark-abbey.webp" width="280"> | <img src="docs/images/common/park-eastern.webp" width="280"> |
| **Karesansui** | **Parterre** | **Chahar bagh** |
| <img src="docs/images/common/park-wa.webp" width="280"> | <img src="docs/images/common/park-western.webp" width="280"> | <img src="docs/images/common/park-islamic.webp" width="280"> |

- **Scale**: four tiers, from wayside shrines and parish churches, through temples filling a whole ward, to grand shrines and concentric castles spanning several wards. Small ones are scattered through town and countryside; large ones are rare.
- **Famous sites**: senbon torii tunnels, torii standing in the sea, mountaintop inner shrines with long stairs, mountain temples, abbeys and crag castles appear occasionally, only where the terrain suits them.
- **Plausible details**: every gate has a road, bridges cross rivers square-on, kitchen gardens grow inside the walls and grain fields outside, and graves lie on slopes outside town.

### Skins and views

Eight skins for any town:

| Parchment | Colour | Engraving | Blueprint |
| :-: | :-: | :-: | :-: |
| <img src="docs/images/en/skin-parchment.webp" width="200"> | <img src="docs/images/en/skin-color.webp" width="200"> | <img src="docs/images/en/skin-ink.webp" width="200"> | <img src="docs/images/en/skin-blueprint.webp" width="200"> |
| **Kiriezu** | **Nolli plan** | **Gazetteer** | **Survey** |
| <img src="docs/images/en/skin-kiriezu.webp" width="200"> | <img src="docs/images/en/skin-nolli.webp" width="200"> | <img src="docs/images/en/skin-fangzhi.webp" width="200"> | <img src="docs/images/en/skin-survey.webp" width="200"> |

The zoning view colours wards by land use and lists each class's share of the urban area:

<p align="center"><img src="docs/images/en/zoning.webp" alt="Zoning view" width="80%"></p>

- **Hover details**: point at anything to see what it is, e.g. "Townhouse · 4 storeys · 3 households", "Field · wheat, rye, oats (three-field rotation)", "Zigzag bridge".
- **Inherit from the world**: pick a town in "World place" to bring over its name, size, river direction, coast, hills and climate.
- **Randomise**: reroll only the seed and keep other settings, or keep the current terrain and reroll the town on it.

## Offline rendering

Render from Node for tuning and batch output:

```bash
pnpm atlas:png aurelia physical,ink out/                          # world paper maps
pnpm settlement:png edo city color out/ culture=wa plan=jokamachi  # settlement map; key=value overrides params
pnpm showcase                                                      # regenerate the images in this README (zh/en/ja)
```

Also `preview:png` (biome preview with per-stage timing) and `shade:png` (relief shading only).
