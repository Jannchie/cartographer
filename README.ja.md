<p align="center"><img src="docs/images/logo.png" alt="Cartographer" width="96"></p>

<h1 align="center">Cartographer</h1>

<p align="center">単一のシードから架空の世界全体を生成する。プレート造山・侵食・気候・水系の推演により形成される大陸と、<br>大陸上の各集落の街区レベルの平面図。</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <b>日本語</b></p>

<p align="center">
  <img src="docs/images/ja/world-physical.webp" alt="シード aurelia から生成した世界、自然地理スタイル" width="100%">
</p>

Cartographer はプレートの衝突、河川侵食、モンスーン降水、河川網の形成を順に模擬し、成因と整合する大陸地形を生成して、紙の地図または 3D ジオラマとして描画する。世界地図上の町を選択すると、その街区図が生成される。街路は地形に沿って配置され、城壁・宮殿・寺社・市場・港湾・田畑は当該文明の形式に従って配置される。

小説、テーブルトーク RPG、ゲーム設定資料の地図作成を用途とする。同一のシードからは常に同一の世界が生成される。町の規模は連続的に調整でき、拡大の過程で既存の建物は位置を保つ。地図は PNG および SVG で出力できる。全パラメータは URL に保持されるため、共有したリンクから同一の地図を再現できる。

```bash
pnpm install
pnpm dev        # http://localhost:5190 を開く
```

## 世界

<p align="center"><img src="docs/images/ja/world-3d.webp" alt="3D ジオラマ：雲、陰影起伏、地名" width="100%"></p>

地形は以下の工程を順に経て生成される。

- **プレートと造山**：プレートを歪めたボロノイ領域で表現する。収束境界では山脈と島弧が隆起し、発散境界では地溝帯と中央海嶺が形成される。海底には大陸棚、海溝、ホットスポット由来の火山島列を含む。
- **侵食**：粗い格子上で河川流水力則に基づき構造隆起と河川下刻を反復計算して樹枝状の谷を形成し、全解像度で雨滴侵食と熱風化を加える。
- **気候と水系**：気温は緯度・標高・大陸度から算出する。水蒸気は風系によって輸送され、風上斜面は多雨、風下側は雨陰となる。流向は Priority-Flood 法で求め、水収支に基づき流出湖・内陸湖・塩湖を形成する。
- **植生帯と命名**：Whittaker の気温・降水図式に基づき植生帯を区分する。世界ごとに固有の架空言語を生成し、大陸・海・山脈・湖・都市を命名する。名称は中・英・日の三言語で対応する。

3D ジオラマはリアルタイムの影、ボリュームクラウド、水面反射、昼夜の循環、自動巡覧カメラ、フィルム調のカラーグレーディングに対応する。編集モードではブラシによる地形の隆起・沈降、気温・降水の調整、町の追加・削除、大陸の区分が可能であり、編集後に気候と水系が再計算される。

紙の地図は 6 種類のスタイルを備え、いずれも注記配置の調整、縮尺、図郭を含む。閲覧時は図郭が固定され、ズームは地図の内容にのみ作用する。

| 自然地理 | ファンタジー羊皮紙 | 海図 |
| :-: | :-: | :-: |
| <img src="docs/images/ja/world-physical.webp" width="260"> | <img src="docs/images/ja/world-fantasy.webp" width="260"> | <img src="docs/images/ja/world-nautical.webp" width="260"> |
| **テイワット** | **水墨** | **等高線** |
| <img src="docs/images/ja/world-teyvat.webp" width="260"> | <img src="docs/images/ja/world-ink.webp" width="260"> | <img src="docs/images/ja/world-topo.webp" width="260"> |

## 集落

人口スライダーにより、同一の町を数十人の集落から数万人の都市まで連続的に拡大できる。拡大の過程はアニメーションとして再生することもできる。地形は世界座標で定義されるため、町の拡大に伴って山地・河川・海岸の位置が変わることはない。

| 120 人 | 1,500 人 |
| :-: | :-: |
| <img src="docs/images/ja/growth-120.webp" width="420"> | <img src="docs/images/ja/growth-1500.webp" width="420"> |
| **6,000 人** | **24,000 人** |
| <img src="docs/images/ja/growth-6000.webp" width="420"> | <img src="docs/images/ja/growth-24000.webp" width="420"> |

4 つの文明はそれぞれ固有の都市形態・建築類型・命名体系を持ち、地名は三言語で対応する。

| 西洋 · 有機的に育った港町 | 中華 · 坊制の都城 |
| :-: | :-: |
| <img src="docs/images/ja/settlement-western.webp" width="420"> | <img src="docs/images/ja/settlement-eastern.webp" width="420"> |
| **和風 · 城下町** | **イスラーム · メディナ** |
| <img src="docs/images/ja/settlement-wa.webp" width="420"> | <img src="docs/images/ja/settlement-islamic.webp" width="420"> |
| **西洋 · ローマのカストルム** | **西洋 · 中世のバスティード** |
| <img src="docs/images/ja/settlement-castrum.webp" width="420"> | <img src="docs/images/ja/settlement-bastide.webp" width="420"> |

- **西洋**：有機的な街路、城と幕壁、大聖堂、広場、三圃制の条田。計画都市の形式としてローマのカストルムと中世のバスティードを備える。
- **中華**：南面する方形の城、坊と十字街、東西の市、北に位置する宮城、四合院。墓所は城外の斜面に分布する。
- **和風**：城下町（天守、武家地、町人地、寺町、枡形）、または平安京に倣った条坊制（大内裏、一坊十六町、羅城門）。
- **イスラーム**：中心に大モスクとスーク、袋小路に面した中庭住宅、ハンマームと隊商宿、中軸線上に中庭を連ねる宮殿。

### ランドマーク

宮殿・寺社・聖堂・城・モスク・公園は「骨格ルール＋要素プール」の組み合わせで生成する。各伝統の構成原理（中軸上に連なる中庭、伽藍配置、聖堂の身廊と翼廊、池泉回遊式庭園など）により骨格を定め、シードに従って要素プールから構成要素を選択する。同一文明内でも宮城が重複することはまれであり、町の拡大後も既存のランドマークは形状を保つ。

| 宮城 | 大聖堂と回廊 | 千本鳥居 |
| :-: | :-: | :-: |
| <img src="docs/images/common/landmark-palace.webp" width="280"> | <img src="docs/images/common/landmark-cathedral.webp" width="280"> | <img src="docs/images/common/landmark-senbon.webp" width="280"> |
| **海上鳥居** | **丘の上の修道院** | **文人庭園** |
| <img src="docs/images/common/landmark-umi.webp" width="280"> | <img src="docs/images/common/landmark-abbey.webp" width="280"> | <img src="docs/images/common/park-eastern.webp" width="280"> |
| **枯山水** | **整形式花壇** | **チャハール・バーグ** |
| <img src="docs/images/common/park-wa.webp" width="280"> | <img src="docs/images/common/park-western.webp" width="280"> | <img src="docs/images/common/park-islamic.webp" width="280"> |

- **規模**：路傍の祠や教区教会から、街区全体を占める寺院、複数の街区にまたがる大社や同心円城郭まで 4 段階に区分される。小規模なものは市街地と郊外に分布し、大規模なものは少ない。
- **名所**：千本鳥居、海上鳥居、長い石段を伴う奥宮、山寺、修道院、岩山の城などは、地形条件を満たす場合に限り低い確率で出現する。
- **配置の整合性**：すべての城門に道路が接続し、橋は河道に対して直交する。城壁の内側は菜園、外側は畑とし、墓所は城外の斜面に置かれる。

### スキンと表示

いずれの町も 8 種類のスキンで描画できる。

| 羊皮紙 | 彩色 | 銅版画 | 青図 |
| :-: | :-: | :-: | :-: |
| <img src="docs/images/ja/skin-parchment.webp" width="200"> | <img src="docs/images/ja/skin-color.webp" width="200"> | <img src="docs/images/ja/skin-ink.webp" width="200"> | <img src="docs/images/ja/skin-blueprint.webp" width="200"> |
| **切絵図** | **ノリ図** | **方志輿図** | **測量図** |
| <img src="docs/images/ja/skin-kiriezu.webp" width="200"> | <img src="docs/images/ja/skin-nolli.webp" width="200"> | <img src="docs/images/ja/skin-fangzhi.webp" width="200"> | <img src="docs/images/ja/skin-survey.webp" width="200"> |

区画表示では街区を用途別に彩色し、用途ごとの面積比を示す。

<p align="center"><img src="docs/images/ja/zoning.webp" alt="区画表示" width="80%"></p>

- **ホバー情報**：カーソル位置にある要素の詳細情報を表示する。例：「町家 · 1 階 · 1 戸」「畑 · 小麦・ライ麦・燕麦（三圃制）」「九曲橋」。
- **世界地図との同期**：「世界の地点」で町を選択すると、名称・規模・河川の流入方向・海岸・山地・気候が世界地図上の対応地点と同期する。
- **ランダム化**：シードのみを変更して他の設定を保持する方式と、現在の地形を固定して町のみを再生成する方式を選択できる。

## オフライン描画

Node 環境で直接描画でき、パラメータ調整や一括出力に用いる。

```bash
pnpm atlas:png aurelia physical,ink out/                          # 世界の紙地図
pnpm settlement:png edo city color out/ culture=wa plan=jokamachi  # 集落図。key=value でパラメータを上書き
pnpm showcase                                                      # この README の画像を再生成（中・英・日）
```

このほか `preview:png`（植生帯のプレビューと生成工程ごとの所要時間）と `shade:png`（地形の陰影起伏のみを含む基図）を備える。
