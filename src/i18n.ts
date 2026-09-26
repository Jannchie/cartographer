/**
 * 界面与地图文字的多语言：中文、English、日本語。
 * 以中文原文为键（源码里写的就是中文），查英文 / 日文词典；缺词时回退到中文原文。
 * 切换语言时就地重刷已登记的元素，不刷新页面（编辑中的内容不会丢）。
 */
export type Lang = 'zh' | 'en' | 'ja'
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
]

function detect(): Lang {
  try {
    const saved = localStorage.getItem('lang')
    if (saved === 'zh' || saved === 'en' || saved === 'ja') return saved
  } catch {
    // 无痕模式等
  }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'zh').toLowerCase()
  return nav.startsWith('ja') ? 'ja' : nav.startsWith('zh') ? 'zh' : 'en'
}

export let lang: Lang = typeof window !== 'undefined' ? detect() : 'zh'

/** 翻译：key 为中文原文；{name} 形式的占位符用 vars 替换 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = lang === 'zh' ? key : ((lang === 'en' ? EN : JA)[key] ?? key)
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return s
}

type Binding = { el: HTMLElement; key: string; attr?: 'title' | 'placeholder' }
const bindings: Binding[] = []
const listeners: (() => void)[] = []

/** 设置元素文字（或属性）并登记，切换语言时自动重刷 */
export function tr<T extends HTMLElement>(el: T, key: string, attr?: 'title' | 'placeholder'): T {
  bindings.push({ el, key, attr })
  paint({ el, key, attr })
  return el
}

function paint(b: Binding) {
  if (b.attr) b.el.setAttribute(b.attr, t(b.key))
  else b.el.textContent = t(b.key)
}

/** 登记页面里带 data-i18n / data-i18n-title / data-i18n-placeholder 的静态元素（键就是写在 HTML 里的中文） */
export function bindStatic(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) tr(el, el.dataset.i18n || el.textContent!.trim())
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) tr(el, el.dataset.i18nTitle || el.title, 'title')
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) tr(el, el.dataset.i18nPlaceholder || el.getAttribute('placeholder')!, 'placeholder')
}

export function onLang(cb: () => void) {
  listeners.push(cb)
}

export function setLang(l: Lang) {
  if (l === lang) return
  lang = l
  try {
    localStorage.setItem('lang', l)
  } catch {
    // 忽略
  }
  // 离线脚本（Node）里没有真正的 DOM
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : l
    for (const b of bindings) if (b.el.isConnected) paint(b)
    document.title = t('Cartographer · 世界地图生成器')
  }
  for (const cb of listeners) cb()
}

// ———————————————————————— 地图上的名字 ————————————————————————

/** 地名按语言取：英文名 / 中文名 / 日文名（缺日文名时回退英文） */
export function placeName(l: { name: string; zh: string; ja?: string }, lg: Lang = lang): string {
  return lg === 'zh' ? l.zh || l.name : lg === 'ja' ? l.ja || l.name : l.name
}

export function worldTitle(w: { worldName: string; worldNameZh: string; worldNameJa?: string }, lg: Lang = lang): string {
  return lg === 'zh' ? w.worldNameZh : lg === 'ja' ? w.worldNameJa || w.worldName : w.worldName
}

/** 地图文字的 CJK 字体回退：中文 / 日文各用各的字形 */
export function cjkFont(lg: Lang, sans = false): string {
  if (lg === 'ja') return sans ? '"Noto Sans JP", "Noto Serif JP", sans-serif' : '"Noto Serif JP", serif'
  if (lg === 'zh') return sans ? '"Noto Sans SC", "Noto Serif SC", sans-serif' : '"Noto Serif SC", serif'
  return sans ? 'sans-serif' : 'serif'
}

// ———————————————————————— 词典 ————————————————————————

const EN: Record<string, string> = {
  // 页面
  'Cartographer · 世界地图生成器': 'Cartographer · World Map Generator',
  '为你的世界观绘制地图：从整片大陆的山川气候，到一座城镇的街巷。': 'Maps for your worlds — from the mountains and climates of whole continents to the streets of a single town.',
  世界地图: 'World map',
  '板块造山、侵蚀水系、气候与群系。3D 沙盘、六种纸图风格，并可在编辑视图里改地形、气候、大洲与地点。':
    'Plate tectonics, erosion and rivers, climate and biomes. A 3D sandbox, six paper-map styles, and an editor for terrain, climate, continents and places.',
  聚落地图: 'Settlement map',
  开发中: 'In progress',
  '为一座城市、镇子或村庄生成街区级平面图：城墙、街道、街区、地块与地标，可继承世界地图上的地形。':
    'Street-level plans of a city, town or village: walls, streets, wards, plots and landmarks, optionally inheriting terrain from the world map.',
  '从小村到大城的街区级平面图：城墙城门、街巷街坊、房屋院落、河桥港口与农田；西式或东方，写实或奇幻。可继承世界地图上某座城镇的环境。':
    'Street-level plans from hamlets to great cities: walls and gates, streets and wards, houses and courtyards, bridges, harbours and fields; Western or Eastern, realistic or fantastical. Can inherit the surroundings of a town on the world map.',
  '打开项目文件…': 'Open project…',
  回到首页: 'Back to home',
  打开项目文件: 'Open a project file',
  打开: 'Open',
  '保存种子、参数与全部编辑': 'Save seed, parameters and all edits',
  保存: 'Save',
  输入种子: 'Seed',
  同一种子总是生成同一个世界: 'The same seed always makes the same world',
  '随机种子并生成（R）': 'Random seed and generate (R)',
  随机: 'Random',
  生成世界: 'Generate',
  按新参数生成: 'Generate with new settings',
  高级参数: 'Advanced',
  恢复默认参数: 'Reset to defaults',
  沙盘: 'Sandbox',
  编辑: 'Edit',
  底图: 'Base map',
  随画笔切换: 'Follow brush',
  地貌: 'Relief',
  '海拔 · 等高线': 'Elevation · contours',
  气温: 'Temperature',
  降水: 'Rainfall',
  大洲: 'Continents',
  '在窄于「地峡宽度」的地方把陆地切开，每块大陆核心各成一洲': 'Split land where it is narrower than the isthmus width; each core becomes a continent',
  自动划分大洲: 'Auto-divide continents',
  原名: 'Name',
  中文名: 'Chinese name',
  日文名: 'Japanese name',
  删除这个大洲: 'Delete this continent',
  显示地名: 'Show names',
  '撤销（Ctrl+Z）': 'Undo (Ctrl+Z)',
  撤销: 'Undo',
  清除全部编辑: 'Clear all edits',
  清除编辑: 'Clear edits',
  地点: 'Place',
  类型: 'Type',
  '删除（Delete）': 'Delete (Delete)',
  删除地点: 'Delete place',
  纸图风格: 'Paper style',
  导出当前视图的图片: 'Export an image of the current view',
  '导出 PNG': 'Export PNG',
  '纸图的矢量版本，可无损放大': 'Vector version of the paper map, zooms losslessly',
  '导出 SVG': 'Export SVG',
  '3D 沙盘': '3D sandbox',
  纸图: 'Paper map',
  正在塑造世界: 'Shaping the world',
  '为一座城市、镇子或村庄生成街区级的平面图：城墙与城门、街道与街区、地块与房屋、广场与地标。':
    'Street-level plans of a city, town or village: walls and gates, streets and wards, plots and houses, squares and landmarks.',
  '正在开发中。完成后可以单独使用，也可以从世界地图上选一个地点，继承那里的地形、河流与海岸。':
    'Work in progress. It will work on its own, or start from a place on the world map and inherit its terrain, rivers and coast.',
  语言: 'Language',
  // 参数
  分辨率: 'Resolution',
  命名: 'Naming',
  西幻: 'Western fantasy',
  史诗: 'Epic',
  东方: 'Eastern',
  和风: 'Japanese',
  '地名的世界观：同一个地名在中英日三种语言里意思一致': 'Naming culture of the world. A place name means the same thing in Chinese, English and Japanese',
  快: 'fast',
  标准: 'standard',
  精细: 'fine',
  陆地比例: 'Land ratio',
  板块数量: 'Plates',
  造山强度: 'Mountains',
  海岸破碎: 'Coast roughness',
  侵蚀风化: 'Erosion',
  降水倍率: 'Rainfall',
  气温偏移: 'Temperature',
  北缘纬度: 'North edge',
  南缘纬度: 'South edge',
  大陆: 'Continent',
  群岛: 'Archipelago',
  泛大陆: 'Pangaea',
  冰原: 'Ice age',
  沙海: 'Dune sea',
  // 3D
  云层: 'Clouds',
  空气感: 'Haze',
  道路: 'Roads',
  展台: 'Stage',
  地名: 'Names',
  垂直夸张: 'Vertical scale',
  移轴景深: 'Tilt-shift',
  关: 'off',
  太阳方位: 'Sun azimuth',
  太阳高度: 'Sun altitude',
  // 纸图
  注记: 'Labels',
  等高线: 'Contours',
  经纬网: 'Graticule',
  自然地理: 'Physical',
  '分层设色 · 晕渲': 'Hypsometric tints · hillshade',
  奇幻羊皮: 'Fantasy parchment',
  '手绘山形 · 树林符号': 'Hand-drawn mountains · tree glyphs',
  航海图: 'Nautical chart',
  '测深 · 恒向线': 'Soundings · rhumb lines',
  提瓦特: 'Teyvat',
  '原神风 · 平涂台地 · 星空边界': 'Genshin-style · flat terraces · starry edge',
  水墨: 'Ink wash',
  '青绿山水 · 中文注记': 'Blue-green landscape · brush lettering',
  '现代地形图': 'Modern topographic',
  // 提示
  '拖动旋转 · 右键平移 · 滚轮缩放 · R 随机 · P 性能': 'Drag to orbit · right-drag to pan · wheel to zoom · R random · P perf',
  '拖动旋转 · 右键平移 · 滚轮缩放 · P 性能': 'Drag to orbit · right-drag to pan · wheel to zoom · P perf',
  '拖动平移 · 滚轮缩放 · 双击复位 · R 随机': 'Drag to pan · wheel to zoom · double-click to reset · R random',
  '左键绘制 / 选取 · 右键或 Shift 拖动平移 · 滚轮缩放 · Alt+滚轮 画笔大小 · Ctrl+Z 撤销':
    'Left-click to paint / select · right or Shift-drag to pan · wheel to zoom · Alt+wheel brush size · Ctrl+Z undo',
  '换种子会生成一个全新的世界，当前的编辑将被清除。继续吗？': 'A new seed makes a completely new world and clears your edits. Continue?',
  '清除全部编辑，恢复为程序生成的原样？': 'Clear all edits and go back to the generated world?',
  '演算中…': 'Computing…',
  '演算中 · {stage}': 'Computing · {stage}',
  '生成失败：': 'Generation failed: ',
  '绘制失败：': 'Rendering failed: ',
  '无法打开：': 'Cannot open: ',
  '不是 Cartographer 项目文件': 'Not a Cartographer project file',
  '矢量绘制{style}': 'Drawing {style}',
  '矢量化：追踪等值线与区域轮廓': 'Vectorising: tracing contours and region outlines',
  // 统计与探针
  陆地: 'Land',
  最高峰: 'Highest',
  最深处: 'Deepest',
  河流: 'Rivers',
  湖泊: 'Lakes',
  跨度: 'Span',
  缓存: 'cached',
  纬度: 'Latitude',
  海拔: 'Elevation',
  水深: 'Depth',
  湖面: 'Lake level',
  年均温: 'Mean temp.',
  年降水: 'Rainfall',
  径流: 'Runoff',
  // 编辑工具
  选取: 'Select',
  '选取、拖动地点；空白处拖动平移': 'Select and drag places; drag empty space to pan',
  新增地点: 'Add place',
  点击地图添加城镇: 'Click the map to add a town',
  抬升: 'Raise',
  '抬高地形：海里画出陆地、平原上堆出山': 'Raise terrain: draw land out of the sea, pile mountains on plains',
  下沉: 'Lower',
  '压低地形：挖出海湾、湖盆': 'Lower terrain: dig bays and lake basins',
  抹平: 'Smooth',
  让地形变平缓: 'Soften the terrain',
  升温: 'Warm',
  提高气温: 'Raise temperature',
  降温: 'Cool',
  降低气温: 'Lower temperature',
  增雨: 'Wetter',
  增加降水: 'More rainfall',
  减雨: 'Drier',
  减少降水: 'Less rainfall',
  '点选陆块建立大洲，或选中已有大洲': 'Click land to make a continent, or pick an existing one',
  划入: 'Add',
  画笔把陆地划入选中的大洲: 'Paint land into the selected continent',
  移出: 'Remove',
  画笔把陆地移出选中的大洲: 'Paint land out of the selected continent',
  画笔大小: 'Brush size',
  画笔强度: 'Brush strength',
  地峡宽度: 'Isthmus width',
  '{n} 格': '{n} cells',
  新大洲: 'New Continent',
  新地点: 'New Town',
  // 地点类型
  首都: 'Capital',
  城镇: 'Town',
  岛屿: 'Island',
  大洋: 'Ocean',
  海: 'Sea',
  山脉: 'Mountains',
  盆地: 'Basin',
  沙漠: 'Desert',
  森林: 'Forest',
  // 群系
  海洋: 'Ocean',
  苔原: 'Tundra',
  针叶林: 'Boreal forest',
  温带阔叶林: 'Temperate forest',
  温带雨林: 'Temperate rainforest',
  草原: 'Grassland',
  灌丛: 'Shrubland',
  寒漠: 'Cold desert',
  热沙漠: 'Hot desert',
  稀树草原: 'Savanna',
  热带季雨林: 'Tropical seasonal forest',
  热带雨林: 'Tropical rainforest',
  高山裸岩: 'Alpine rock',
  海滩: 'Beach',
  湿地: 'Wetland',
  盐沼: 'Salt flat',
  // 生成进度
  板块运动与造山: 'Plate motion and mountain building',
  填平噪声洼地: 'Filling noise depressions',
  构造抬升与流水下切: 'Uplift and fluvial incision',
  '流水下切 · 树枝状水系': 'Fluvial incision · dendritic drainage',
  雨滴冲刷与沉积: 'Raindrop erosion and deposition',
  热力风化: 'Thermal weathering',
  沿用已演算的地形: 'Reusing computed terrain',
  海岸线与大陆架: 'Coastlines and shelves',
  大气环流与降水: 'Atmospheric circulation and rainfall',
  '汇流、湖泊与内流盆地': 'Drainage, lakes and endorheic basins',
  生物群系: 'Biomes',
  命名与标注: 'Naming and labelling',
  道路与航线: 'Roads and sea routes',
  完成: 'Done',
  读取缓存: 'Loading from cache',
  绘制地表: 'Painting the surface',
  // 纸图上的文字
  公里: 'km',
  '海拔（米）': 'Elevation (m)',
  '此乃{name}之地': 'Here be the lands of {name}',
  海图: 'CHART OF THE COASTS OF',
  '测深以米计 · 以平均海面为基准': 'Soundings in metres · reduced to mean sea level',
  '种子「{seed}」测绘': 'Surveyed under seed “{seed}”',
  '地形测量图 · 等高距 100 米': 'Topographic survey · contour interval 100 m',
  '已知世界自然地理图 · 种子「{seed}」': 'A physical map of the known world · seed “{seed}”',
  '种子 · {seed}': 'SEED · {seed}',
  '{name}舆地全图': 'The Whole Map of {name}',
  '种子 {seed}': 'seed {seed}',
  '{km} 公里 · 种子 {seed}': '{km} km · seed {seed}',
}

const JA: Record<string, string> = {
  'Cartographer · 世界地图生成器': 'Cartographer · 世界地図ジェネレーター',
  '为你的世界观绘制地图：从整片大陆的山川气候，到一座城镇的街巷。': 'あなたの世界の地図を。大陸の山河と気候から、ひとつの町の路地まで。',
  世界地图: '世界地図',
  '板块造山、侵蚀水系、气候与群系。3D 沙盘、六种纸图风格，并可在编辑视图里改地形、气候、大洲与地点。':
    'プレート造山、侵食と水系、気候とバイオーム。3D ジオラマ、6 種類の紙地図スタイル、地形・気候・大陸・地名を編集できるエディター。',
  聚落地图: '集落地図',
  开发中: '開発中',
  '为一座城市、镇子或村庄生成街区级平面图：城墙、街道、街区、地块与地标，可继承世界地图上的地形。':
    '都市・町・村の街区レベルの平面図を生成：城壁、街路、街区、区画、ランドマーク。世界地図の地形を引き継げます。',
  '从小村到大城的街区级平面图：城墙城门、街巷街坊、房屋院落、河桥港口与农田；西式或东方，写实或奇幻。可继承世界地图上某座城镇的环境。':
    '小さな村から大都市までの街区レベルの平面図：城壁と城門、街路と街区、家屋と中庭、橋・港・農地。西洋風でも東洋風でも、写実的でも幻想的でも。世界地図上の町の環境を引き継げます。',
  '打开项目文件…': 'プロジェクトを開く…',
  回到首页: 'ホームへ戻る',
  打开项目文件: 'プロジェクトファイルを開く',
  打开: '開く',
  '保存种子、参数与全部编辑': 'シード・パラメータ・すべての編集を保存',
  保存: '保存',
  输入种子: 'シード',
  同一种子总是生成同一个世界: '同じシードからは常に同じ世界が生まれます',
  '随机种子并生成（R）': 'ランダムなシードで生成（R）',
  随机: 'ランダム',
  生成世界: '世界を生成',
  按新参数生成: '新しい設定で生成',
  高级参数: '詳細設定',
  恢复默认参数: '初期値に戻す',
  沙盘: 'ジオラマ',
  编辑: '編集',
  底图: 'ベースマップ',
  随画笔切换: 'ブラシに合わせる',
  地貌: '地形',
  '海拔 · 等高线': '標高 · 等高線',
  气温: '気温',
  降水: '降水',
  大洲: '大陸',
  '在窄于「地峡宽度」的地方把陆地切开，每块大陆核心各成一洲': '「地峡の幅」より狭い所で陸地を分け、それぞれの中核を一つの大陸にします',
  自动划分大洲: '大陸を自動分割',
  原名: '原名',
  中文名: '中国語名',
  日文名: '日本語名',
  删除这个大洲: 'この大陸を削除',
  显示地名: '地名を表示',
  '撤销（Ctrl+Z）': '元に戻す（Ctrl+Z）',
  撤销: '元に戻す',
  清除全部编辑: 'すべての編集を消去',
  清除编辑: '編集を消去',
  地点: '地点',
  类型: '種類',
  '删除（Delete）': '削除（Delete）',
  删除地点: '地点を削除',
  纸图风格: '紙地図のスタイル',
  导出当前视图的图片: '現在のビューを画像で書き出す',
  '导出 PNG': 'PNG を書き出す',
  '纸图的矢量版本，可无损放大': '紙地図のベクター版（劣化なしで拡大可）',
  '导出 SVG': 'SVG を書き出す',
  '3D 沙盘': '3D ジオラマ',
  纸图: '紙地図',
  正在塑造世界: '世界を形づくっています',
  '为一座城市、镇子或村庄生成街区级的平面图：城墙与城门、街道与街区、地块与房屋、广场与地标。':
    '都市・町・村の街区レベルの平面図：城壁と城門、街路と街区、区画と家屋、広場とランドマーク。',
  '正在开发中。完成后可以单独使用，也可以从世界地图上选一个地点，继承那里的地形、河流与海岸。':
    '開発中です。単体でも使え、世界地図の地点を選んで地形・川・海岸を引き継ぐこともできる予定です。',
  语言: '言語',
  分辨率: '解像度',
  命名: '命名',
  西幻: '西洋ファンタジー',
  史诗: '叙事詩',
  东方: '中華風',
  和风: '和風',
  '地名的世界观：同一个地名在中英日三种语言里意思一致': '地名の世界観：同じ地名は中英日のどの言語でも同じ意味になります',
  快: '高速',
  标准: '標準',
  精细: '高精細',
  陆地比例: '陸地の割合',
  板块数量: 'プレート数',
  造山强度: '造山の強さ',
  海岸破碎: '海岸の複雑さ',
  侵蚀风化: '侵食と風化',
  降水倍率: '降水量',
  气温偏移: '気温補正',
  北缘纬度: '北端の緯度',
  南缘纬度: '南端の緯度',
  大陆: '大陸',
  群岛: '群島',
  泛大陆: '超大陸',
  冰原: '氷原',
  沙海: '砂の海',
  云层: '雲',
  空气感: '空気遠近',
  道路: '道路',
  展台: '展示台',
  地名: '地名',
  垂直夸张: '高さの強調',
  移轴景深: 'ティルトシフト',
  关: 'オフ',
  太阳方位: '太陽の方位',
  太阳高度: '太陽の高度',
  注记: '注記',
  等高线: '等高線',
  经纬网: '経緯線',
  自然地理: '自然地理',
  '分层设色 · 晕渲': '段彩 · 陰影',
  奇幻羊皮: 'ファンタジー羊皮紙',
  '手绘山形 · 树林符号': '手描きの山 · 森の記号',
  航海图: '海図',
  '测深 · 恒向线': '水深 · 航程線',
  提瓦特: 'テイワット',
  '原神风 · 平涂台地 · 星空边界': '原神風 · ベタ塗りの台地 · 星空の境界',
  水墨: '水墨',
  '青绿山水 · 中文注记': '青緑山水 · 毛筆の注記',
  '现代地形图': '現代の地形図',
  '拖动旋转 · 右键平移 · 滚轮缩放 · R 随机 · P 性能': 'ドラッグで回転 · 右ドラッグで移動 · ホイールでズーム · R ランダム · P 性能',
  '拖动旋转 · 右键平移 · 滚轮缩放 · P 性能': 'ドラッグで回転 · 右ドラッグで移動 · ホイールでズーム · P 性能',
  '拖动平移 · 滚轮缩放 · 双击复位 · R 随机': 'ドラッグで移動 · ホイールでズーム · ダブルクリックでリセット · R ランダム',
  '左键绘制 / 选取 · 右键或 Shift 拖动平移 · 滚轮缩放 · Alt+滚轮 画笔大小 · Ctrl+Z 撤销':
    '左クリックで描画 / 選択 · 右か Shift ドラッグで移動 · ホイールでズーム · Alt+ホイールでブラシサイズ · Ctrl+Z 元に戻す',
  '换种子会生成一个全新的世界，当前的编辑将被清除。继续吗？': 'シードを変えるとまったく新しい世界になり、編集は消去されます。続けますか？',
  '清除全部编辑，恢复为程序生成的原样？': 'すべての編集を消去して、生成されたままの状態に戻しますか？',
  '演算中…': '計算中…',
  '演算中 · {stage}': '計算中 · {stage}',
  '生成失败：': '生成に失敗しました：',
  '绘制失败：': '描画に失敗しました：',
  '无法打开：': '開けません：',
  '不是 Cartographer 项目文件': 'Cartographer のプロジェクトファイルではありません',
  '矢量绘制{style}': '{style}を描画中',
  '矢量化：追踪等值线与区域轮廓': 'ベクター化：等値線と領域の輪郭を追跡中',
  陆地: '陸地',
  最高峰: '最高峰',
  最深处: '最深部',
  河流: '河川',
  湖泊: '湖沼',
  跨度: '幅',
  缓存: 'キャッシュ',
  纬度: '緯度',
  海拔: '標高',
  水深: '水深',
  湖面: '湖面',
  年均温: '年平均気温',
  年降水: '年降水量',
  径流: '流量',
  选取: '選択',
  '选取、拖动地点；空白处拖动平移': '地点を選択・移動。空白部分のドラッグで移動',
  新增地点: '地点を追加',
  点击地图添加城镇: '地図をクリックして町を追加',
  抬升: '隆起',
  '抬高地形：海里画出陆地、平原上堆出山': '地形を持ち上げる：海に陸地を、平野に山を',
  下沉: '沈降',
  '压低地形：挖出海湾、湖盆': '地形を下げる：湾や湖盆を掘る',
  抹平: 'なだらか',
  让地形变平缓: '地形をなだらかにする',
  升温: '温暖化',
  提高气温: '気温を上げる',
  降温: '寒冷化',
  降低气温: '気温を下げる',
  增雨: '湿潤',
  增加降水: '降水を増やす',
  减雨: '乾燥',
  减少降水: '降水を減らす',
  '点选陆块建立大洲，或选中已有大洲': '陸地をクリックして大陸を作成、または既存の大陸を選択',
  划入: '加える',
  画笔把陆地划入选中的大洲: 'ブラシで陸地を選択中の大陸に加える',
  移出: '外す',
  画笔把陆地移出选中的大洲: 'ブラシで陸地を選択中の大陸から外す',
  画笔大小: 'ブラシの大きさ',
  画笔强度: 'ブラシの強さ',
  地峡宽度: '地峡の幅',
  '{n} 格': '{n} マス',
  新大洲: '新しい大陸',
  新地点: '新しい町',
  首都: '首都',
  城镇: '町',
  岛屿: '島',
  大洋: '大洋',
  海: '海',
  山脉: '山脈',
  盆地: '盆地',
  沙漠: '砂漠',
  森林: '森林',
  海洋: '海洋',
  苔原: 'ツンドラ',
  针叶林: '針葉樹林',
  温带阔叶林: '温帯広葉樹林',
  温带雨林: '温帯雨林',
  草原: '草原',
  灌丛: '低木林',
  寒漠: '寒冷砂漠',
  热沙漠: '熱帯砂漠',
  稀树草原: 'サバンナ',
  热带季雨林: '熱帯季節林',
  热带雨林: '熱帯雨林',
  高山裸岩: '高山の裸岩',
  海滩: '砂浜',
  湿地: '湿地',
  盐沼: '塩原',
  板块运动与造山: 'プレート運動と造山',
  填平噪声洼地: 'ノイズの窪地を埋める',
  构造抬升与流水下切: '隆起と河川の下刻',
  '流水下切 · 树枝状水系': '河川の下刻 · 樹枝状の水系',
  雨滴冲刷与沉积: '雨滴の侵食と堆積',
  热力风化: '熱による風化',
  沿用已演算的地形: '計算済みの地形を再利用',
  海岸线与大陆架: '海岸線と大陸棚',
  大气环流与降水: '大気の循環と降水',
  '汇流、湖泊与内流盆地': '集水・湖沼・内陸盆地',
  生物群系: 'バイオーム',
  命名与标注: '命名と注記',
  道路与航线: '道路と航路',
  完成: '完了',
  读取缓存: 'キャッシュから読み込み',
  绘制地表: '地表を描画',
  公里: 'km',
  '海拔（米）': '標高（m）',
  '此乃{name}之地': '{name}の地',
  海图: '沿岸海図',
  '测深以米计 · 以平均海面为基准': '水深はメートル · 平均海面基準',
  '种子「{seed}」测绘': 'シード「{seed}」による測量',
  '地形测量图 · 等高距 100 米': '地形図 · 等高線間隔 100 m',
  '已知世界自然地理图 · 种子「{seed}」': '既知世界の自然地理図 · シード「{seed}」',
  '种子 · {seed}': 'シード · {seed}',
  '{name}舆地全图': '{name}全図',
  '种子 {seed}': 'シード {seed}',
  '{km} 公里 · 种子 {seed}': '{km} km · シード {seed}',
}
