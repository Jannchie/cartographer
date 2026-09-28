<p align="center"><img src="docs/images/banner.jpg" alt="Cartographer" width="100%"></p>

<p align="center">Procedural generation of a complete fictional world from a single seed: continents formed by plate tectonics, erosion, climate and drainage,<br>and a street-level plan for each settlement on them.</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a></p>

Cartographer simulates plate collision, fluvial erosion, monsoon precipitation and river-network formation in sequence, producing terrain whose features follow from the processes that formed them, and renders the result as a paper map or a 3D diorama. Selecting a town on the world map generates its street plan: streets are laid out along the terrain, and walls, palaces, shrines, markets, harbours and fields are arranged according to the conventions of the town's culture.

Intended for maps in fiction, tabletop role-playing and game settings. A given seed always produces the same world. Town size is continuously adjustable, and existing buildings remain in place as a town expands. Maps export to PNG and SVG; all parameters are encoded in the URL, so a shared link reproduces the same map.

```bash
pnpm install
pnpm dev        # open http://localhost:5190
```

## World

<p align="center"><img src="docs/images/en/world-3d.webp" alt="3D diorama with clouds, relief shading and place names" width="100%"></p>

Terrain is generated in the following stages:

- **Plates and orogeny**: plates are modelled as warped Voronoi cells. Convergent boundaries raise mountain ranges and island arcs; divergent boundaries form rifts and mid-ocean ridges. The sea floor includes continental shelves, trenches and hotspot island chains.
- **Erosion**: a stream-power model iterates tectonic uplift against fluvial incision on a coarse grid to form dendritic valleys; droplet erosion and thermal weathering are then applied at full resolution.
- **Climate and hydrology**: temperature is derived from latitude, elevation and continentality. Moisture advected by the wind belts produces wet windward slopes and rain shadows. Flow directions are computed with Priority-Flood, and a water balance determines exorheic lakes, endorheic lakes and salt flats.
- **Biomes and naming**: biomes are classified on a Whittaker temperature–precipitation diagram. Each world has its own generated language for naming continents, seas, ranges, lakes and cities, with corresponding Chinese, English and Japanese forms.

The 3D diorama supports real-time shadows, volumetric clouds, water reflections, a day–night cycle, an automated flyover and film-style colour grading. Edit mode provides brushes for raising and lowering terrain and adjusting temperature and precipitation, as well as adding or removing towns and defining continents; climate and hydrology are recomputed after each edit.

Six paper-map styles are available, each with label placement, scale bar and frame. While browsing, the frame remains fixed and zooming applies only to the map content:

| Physical | Fantasy | Nautical |
| :-: | :-: | :-: |
| <img src="docs/images/en/world-physical.webp" width="260"> | <img src="docs/images/en/world-fantasy.webp" width="260"> | <img src="docs/images/en/world-nautical.webp" width="260"> |
| **Teyvat** | **Ink wash** | **Topographic** |
| <img src="docs/images/en/world-teyvat.webp" width="260"> | <img src="docs/images/en/world-ink.webp" width="260"> | <img src="docs/images/en/world-topo.webp" width="260"> |

## Settlements

The population slider expands the same town continuously from a hamlet of a few dozen people to a city of tens of thousands; the expansion can also be played as an animation. Terrain is defined in world coordinates, so hills, rivers and coastline remain fixed as the town grows.

| 120 people | 1,500 people |
| :-: | :-: |
| <img src="docs/images/en/growth-120.webp" width="420"> | <img src="docs/images/en/growth-1500.webp" width="420"> |
| **6,000 people** | **24,000 people** |
| <img src="docs/images/en/growth-6000.webp" width="420"> | <img src="docs/images/en/growth-24000.webp" width="420"> |

Four cultures, each with distinct town plans, building types and naming conventions; place names correspond across the three languages:

| Western · organic harbour town | Chinese · walled-ward capital |
| :-: | :-: |
| <img src="docs/images/en/settlement-western.webp" width="420"> | <img src="docs/images/en/settlement-eastern.webp" width="420"> |
| **Japanese · castle town** | **Islamic · medina** |
| <img src="docs/images/en/settlement-wa.webp" width="420"> | <img src="docs/images/en/settlement-islamic.webp" width="420"> |
| **Western · Roman castrum** | **Western · medieval bastide** |
| <img src="docs/images/en/settlement-castrum.webp" width="420"> | <img src="docs/images/en/settlement-bastide.webp" width="420"> |

- **Western**: organic lanes, castle and curtain wall, cathedral, market square and three-field strips; the Roman castrum and the medieval bastide are available as planned layouts.
- **Chinese**: a south-facing walled grid of walled wards with cross streets, East and West Markets, a palace at the north and courtyard houses; family tombs are placed on the hillsides outside the walls.
- **Japanese**: castle town (keep, samurai and merchant quarters, temple row, masugata gates), or a Heian-kyō style jōbō grid (Greater Palace, sixteen chō per ward, Rajōmon).
- **Islamic**: a great mosque and souq at the centre, courtyard houses along dead-end lanes, hammams and caravanserais, and a palace composed of courts along an axis.

### Landmarks

Palaces, temples, churches, castles, mosques and parks are composed from skeleton rules and element pools. The layout grammar of each tradition determines the plan (an axial sequence of courts, a temple compound arrangement, the nave and transept of a church, a pond-and-stroll garden, and so on), and the seed selects the components. Palaces of the same culture rarely coincide, and existing landmarks retain their form as the town expands.

| Palace city | Cathedral and cloister | Senbon torii |
| :-: | :-: | :-: |
| <img src="docs/images/common/landmark-palace.webp" width="280"> | <img src="docs/images/common/landmark-cathedral.webp" width="280"> | <img src="docs/images/common/landmark-senbon.webp" width="280"> |
| **Torii in the sea** | **Hilltop abbey** | **Scholar's garden** |
| <img src="docs/images/common/landmark-umi.webp" width="280"> | <img src="docs/images/common/landmark-abbey.webp" width="280"> | <img src="docs/images/common/park-eastern.webp" width="280"> |
| **Karesansui** | **Parterre** | **Chahar bagh** |
| <img src="docs/images/common/park-wa.webp" width="280"> | <img src="docs/images/common/park-western.webp" width="280"> | <img src="docs/images/common/park-islamic.webp" width="280"> |

- **Scale**: landmarks fall into four tiers, from wayside shrines and parish churches, through temples occupying an entire ward, to grand shrines and concentric castles spanning several wards. Small landmarks are distributed through the town and countryside; large ones are rare.
- **Notable sites**: senbon torii tunnels, torii standing in the sea, mountaintop inner shrines with long stairways, mountain temples, abbeys and crag castles appear with low probability, and only where the terrain permits.
- **Layout consistency**: every gate is served by a road, bridges cross rivers perpendicularly, kitchen gardens lie inside the walls and grain fields outside, and burial grounds occupy slopes beyond the town.

### Skins and views

Each town can be rendered in eight skins:

| Parchment | Colour | Engraving | Blueprint |
| :-: | :-: | :-: | :-: |
| <img src="docs/images/en/skin-parchment.webp" width="200"> | <img src="docs/images/en/skin-color.webp" width="200"> | <img src="docs/images/en/skin-ink.webp" width="200"> | <img src="docs/images/en/skin-blueprint.webp" width="200"> |
| **Kiriezu** | **Nolli plan** | **Gazetteer** | **Survey** |
| <img src="docs/images/en/skin-kiriezu.webp" width="200"> | <img src="docs/images/en/skin-nolli.webp" width="200"> | <img src="docs/images/en/skin-fangzhi.webp" width="200"> | <img src="docs/images/en/skin-survey.webp" width="200"> |

The zoning view colours wards by land use and lists the share of the urban area for each class:

<p align="center"><img src="docs/images/en/zoning.webp" alt="Zoning view" width="80%"></p>

- **Hover details**: detailed information on the feature under the cursor, e.g. "Townhouse · 4 storeys · 3 households", "Field · wheat, rye, oats (three-field rotation)", "Zigzag bridge".
- **World synchronisation**: when a town is selected under "World place", its name, size, river direction, coast, hills and climate are synchronised with the corresponding location on the world map.
- **Randomisation**: either the seed alone is replaced and other settings are retained, or the current terrain is fixed and only the town is regenerated.

## Offline rendering

Maps can be rendered directly in Node for parameter tuning and batch output:

```bash
pnpm atlas:png aurelia physical,ink out/                          # world paper maps
pnpm settlement:png edo city color out/ culture=wa plan=jokamachi  # settlement map; key=value overrides params
pnpm showcase                                                      # regenerate the images in this README (zh/en/ja)
```

Additional scripts: `preview:png` (biome preview with timing for each generation stage) and `shade:png` (a base map containing only terrain relief shading).
