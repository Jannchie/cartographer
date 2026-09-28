<p align="center"><img src="docs/images/logo.png" alt="Cartographer" width="96"></p>

<h1 align="center">Cartographer</h1>

<p align="center">ひとつのシードから架空の世界をまるごと生成します。プレート造山・侵食・気候・水系が形づくる大陸と、<br>そこにあるすべての町の街区レベルの平面図です。</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <b>日本語</b></p>

<p align="center">
  <img src="docs/images/ja/world-physical.webp" alt="シード aurelia から生成した世界、自然地理スタイル" width="100%">
</p>

シードを入力すると、Cartographer はプレートの衝突、河川侵食、モンスーンの降水、河川の合流をシミュレートし、成り立ちのある大陸をつくって紙の地図や 3D ジオラマとして描きます。世界地図上の町を選ぶと、その街区図が開きます。街路は地形に沿って伸び、城壁・宮殿・寺社・市場・港・田畑が、その文明の様式で配置されます。

小説、TRPG、ゲームの設定資料の地図づくりに向いています。同じシードからは常に同じ世界が生成されます。町の規模はスライダーで変えられ、町は連続的に成長し、既存の建物は動きません。地図は PNG と SVG に書き出せます。パラメータは URL に入っているので、リンクを共有すれば相手にも同じ地図が表示されます。

```bash
pnpm install
pnpm dev        # http://localhost:5190 を開く
```

ブラウザだけで動作し、バックエンドや API キーは不要です。

## 世界

<p align="center"><img src="docs/images/ja/world-3d.webp" alt="3D ジオラマ：雲、陰影起伏、地名" width="100%"></p>

地形は生成の工程を順に重ねて形づくります。

- **プレートと造山**：歪めたボロノイでプレートを表現します。収束境界では山脈と島弧が隆起し、発散境界では地溝帯と中央海嶺ができます。海底には大陸棚、海溝、ホットスポットの火山島列があります。
- **侵食**：粗いグリッドで河川の流水力則による「隆起と下刻」を反復して樹枝状の谷を刻み、全解像度で雨滴侵食と熱風化を加えます。
- **気候と水系**：気温は緯度・標高・大陸度で決まります。水蒸気は風系に運ばれ、風上側の斜面は多雨、風下側は雨陰になります。Priority-Flood で流向を求め、水収支から流出湖・内陸湖・塩湖をつくります。
- **植生帯と命名**：Whittaker 図式で植生帯を分けます。世界ごとに言語を一つ生成し、大陸・海・山脈・湖・都市に名前を付けます。名前は中・英・日の三言語で対応しています。

3D ジオラマにはリアルタイムの影、ボリュームクラウド、水面反射、自動巡覧カメラ、フィルム調のカラーグレーディングがあります。編集モードでは地形の隆起・沈降、気温・降水の塗り分け、町の追加・削除、大陸の区分けができ、編集後に気候と水系が再計算されます。

紙の地図は 6 スタイルで、どれも注記の配置調整、縮尺、図郭を備えます。閲覧中は図郭が固定され、ズームで動くのは地図だけです。

| 自然地理 | ファンタジー羊皮紙 | 海図 |
| :-: | :-: | :-: |
| <img src="docs/images/ja/world-physical.webp" width="260"> | <img src="docs/images/ja/world-fantasy.webp" width="260"> | <img src="docs/images/ja/world-nautical.webp" width="260"> |
| **テイワット** | **水墨** | **等高線** |
| <img src="docs/images/ja/world-teyvat.webp" width="260"> | <img src="docs/images/ja/world-ink.webp" width="260"> | <img src="docs/images/ja/world-topo.webp" width="260"> |

## 集落

人口スライダーを動かすと、同じ町が数十人の集落から数万人の都市へ育ちます。成長アニメーションも再生できます。地形は世界座標で定義されているので、町が育っても山・川・海岸は動きません。

| 120 人 | 1,500 人 |
| :-: | :-: |
| <img src="docs/images/ja/growth-120.webp" width="420"> | <img src="docs/images/ja/growth-1500.webp" width="420"> |
| **6,000 人** | **24,000 人** |
| <img src="docs/images/ja/growth-6000.webp" width="420"> | <img src="docs/images/ja/growth-24000.webp" width="420"> |

4 つの文明それぞれに独自の都市形態・建物・地名があり、三言語の地名が対応しています。

| 西洋 · 有機的に育った港町 | 中華 · 坊制の都城 |
| :-: | :-: |
| <img src="docs/images/ja/settlement-western.webp" width="420"> | <img src="docs/images/ja/settlement-eastern.webp" width="420"> |
| **和風 · 城下町** | **イスラーム · メディナ** |
| <img src="docs/images/ja/settlement-wa.webp" width="420"> | <img src="docs/images/ja/settlement-islamic.webp" width="420"> |

- **西洋**：有機的な街路、城と幕壁、大聖堂、広場、三圃制の条田。ローマのカストルムや中世のバスティードも選べます。
- **中華**：南面する方形の城、坊と十字街、東西の市、北に宮城、四合院。墓所は城外の斜面に点在します。
- **和風**：城下町（天守、武家地、町人地、寺町、枡形）、または平安京に倣った条坊制（大内裏、一坊十六町、羅城門）。
- **イスラーム**：中心に大モスクとスーク、袋小路に面した中庭住宅、ハンマームと隊商宿、中軸に中庭を連ねる宮殿。

### ランドマーク

宮殿・寺社・聖堂・城・モスク・公園は「骨格ルール＋要素プール」の組み合わせで生成します。まず伝統ごとの構成原理（中軸に並ぶ中庭の連なり、伽藍配置、聖堂の身廊と翼廊、池泉回遊……）で骨格を決め、シードに従って要素プールから部品を選びます。同じ文明でも同じ宮城はほとんどできず、町が育っても既存のランドマークはそのままです。

| 宮城 | 大聖堂と回廊 | 千本鳥居 |
| :-: | :-: | :-: |
| <img src="docs/images/common/landmark-palace.webp" width="280"> | <img src="docs/images/common/landmark-cathedral.webp" width="280"> | <img src="docs/images/common/landmark-senbon.webp" width="280"> |
| **海上鳥居** | **丘の上の修道院** | **文人庭園** |
| <img src="docs/images/common/landmark-umi.webp" width="280"> | <img src="docs/images/common/landmark-abbey.webp" width="280"> | <img src="docs/images/common/park-eastern.webp" width="280"> |
| **枯山水** | **整形式花壇** | **チャハール・バーグ** |
| <img src="docs/images/common/park-wa.webp" width="280"> | <img src="docs/images/common/park-western.webp" width="280"> | <img src="docs/images/common/park-islamic.webp" width="280"> |

- **規模**：路傍の祠や教区教会から、街区ひとつを占める寺院、複数の街区を束ねた大社や同心円城郭まで 4 段階あります。小さなものは町なかや郊外に散らばり、大きなものはまれです。
- **名所**：千本鳥居、海上鳥居、長い石段の奥宮、山寺、修道院、岩山の城などは、地形が合うときだけ時おり現れます。
- **もっともらしさ**：城門には必ず道が通じ、橋は川をまっすぐ渡り、城壁の内側は菜園、外側は畑です。墓所は城外の斜面にあります。

### スキンと表示

どの町も 8 種類のスキンで描けます。

| 羊皮紙 | 彩色 | 銅版画 | 青図 |
| :-: | :-: | :-: | :-: |
| <img src="docs/images/ja/skin-parchment.webp" width="200"> | <img src="docs/images/ja/skin-color.webp" width="200"> | <img src="docs/images/ja/skin-ink.webp" width="200"> | <img src="docs/images/ja/skin-blueprint.webp" width="200"> |
| **切絵図** | **ノリ図** | **方志輿図** | **測量図** |
| <img src="docs/images/ja/skin-kiriezu.webp" width="200"> | <img src="docs/images/ja/skin-nolli.webp" width="200"> | <img src="docs/images/ja/skin-fangzhi.webp" width="200"> | <img src="docs/images/ja/skin-survey.webp" width="200"> |

区画表示では街区を用途別に塗り分け、用途ごとの面積比を示します。

<p align="center"><img src="docs/images/ja/zoning.webp" alt="区画表示" width="80%"></p>

- **ホバー情報**：地図上を指すと、それが何かを表示します。例：「町家 · 1 階 · 1 戸」「畑 · 小麦・ライ麦・燕麦（三圃制）」「九曲橋」。
- **世界地図から引き継ぎ**：「世界の地点」で町を選ぶと、名前・規模・川の流れる向き・海岸・山地・気候を世界地図から引き継ぎます。
- **ランダム**：シードだけを変えて他の設定を保つことも、今の地形を固定して町だけを変えることもできます。

## オフライン描画

Node から直接描画でき、パラメータ調整や一括出力に使えます。

```bash
pnpm atlas:png aurelia physical,ink out/                          # 世界の紙地図
pnpm settlement:png edo city color out/ culture=wa plan=jokamachi  # 集落図。key=value でパラメータを上書き
pnpm showcase                                                      # この README の画像を再生成（中・英・日）
```

ほかに `preview:png`（植生帯プレビューと工程ごとの所要時間）と `shade:png`（地形の陰影起伏のみ）があります。
