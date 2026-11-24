// 更新日志：GitHub Release 说明的来源（scripts/release-notes.ts 从这里生成）。
// 最新的版本放最前面；第一条的 version 必须与 package.json 一致，三种语言的条数一致（发布说明脚本检查，构建时也会跑一遍）。
import type { Lang } from './i18n'

export interface Release {
  version: string
  /** YYYY-MM-DD */
  date: string
  notes: Record<Lang, string[]>
}

export const CHANGELOG: Release[] = [
  {
    version: '0.2.0',
    date: '2026-11-24',
    notes: {
      zh: [
        '聚落沙盘的布局：城墙贴合建成区修筑，田地留在墙外；城心的民居沿街连排、共用山墙并留出后院；建筑、道路、城墙、树木之间不再互相穿插，也不再伸出沙盘边缘',
        '建筑按文明与部件建模：西式教堂有西塔与尖顶、中殿高侧窗、侧廊与后殿，东方殿堂有台基、斗拱、翼角与重檐，和式有天守、本殿与五重塔，伊斯兰清真寺有礼拜殿、穹顶、伊旺与宣礼塔；民居有老虎窗、木构架、临街铺面与烟囱',
        '城防与构筑物：城门有贯通的门洞，城墙有步道与女墙，塔楼按文明区分；石拱桥、木桥与神桥，栈桥与各文明的船；补上井、喷泉、雕像、风车、水车、灯塔、墓地与市集摊棚等小品',
        '植被：14 种树形，有树干与成团的树冠，按文明、气候与环境选取树种；另有灌木、芦苇、绿篱与葡萄园藤架；远近之间平滑切换细节，夜里树冠不再是纯黑的剪影',
        '地面与水：野地、田垄、果园、水田、石板街与广场铺装都有各自的质感；岸线精确，水面按深浅着色并反射天光，海边有涌浪；中景的地面清晰度提高',
        '光照与镜头：自动对焦到画面所指的表面，低角度时地平线以上是展厅背景而不是一片黑；三级阴影、环境光遮蔽与夜间的街灯和城门火把；镜头不会穿进建筑、地形与树冠；按 T 开始自动运镜',
        '首次进入沙盘时先显示整座城，建筑的细部稍后补上，不再长时间等待',
        '手机与窄屏：侧栏改为底部抽屉，地图支持双指缩放',
      ],
      ja: [
        '集落ジオラマの配置：城壁は市街地に沿って築かれ、農地は城壁の外に置かれるようになりました。中心部の民家は通りに沿って軒を連ね、妻壁を共有して裏庭を残します。建物・道路・城壁・樹木が互いにめり込んだり、ジオラマの縁からはみ出したりしなくなりました',
        '建物を文明と部位ごとにモデル化しました：西洋の教会は西塔と尖塔、身廊の高窓、側廊と後陣を備え、東洋の殿堂は基壇・斗栱・反り上がった軒先・重層の屋根を、和風は天守・本殿・五重塔を、イスラームのモスクは礼拝堂・ドーム・イーワーン・ミナレットを備えます。民家にはドーマー窓、木骨組、通りに面した店先、煙突があります',
        '城郭と構造物：城門は門道が通り抜け、城壁には歩廊と胸壁があり、塔は文明ごとに形が異なります。石造アーチ橋・木橋・神橋、桟橋と文明ごとの船を加え、井戸・噴水・彫像・風車・水車・灯台・墓地・市の露店などの小物も追加しました',
        '植生：幹と房状の樹冠を持つ 14 種類の樹形を、文明・気候・周囲の環境に応じて使い分けます。低木・葦・生垣・ブドウ棚も加わりました。遠近の詳細度は滑らかに切り替わり、夜の樹冠が真っ黒な影絵にならなくなりました',
        '地面と水：野原・畝・果樹園・水田・石畳の街路・広場の舗装がそれぞれの質感を持つようになりました。岸線は正確になり、水面は深さに応じて色づき空を映し、海辺には波が寄せます。中景の地面の解像感も上がりました',
        '照明とカメラ：画面で指した面に自動でピントが合い、低い視点では地平線の上が真っ黒ではなく展示室の背景になります。3 段階の影、環境遮蔽、夜の街灯と城門のかがり火を加えました。カメラは建物・地形・樹冠の中に入り込みません。T キーで自動カメラワークを開始します',
        '初めてジオラマを開いたときはまず街全体を表示し、建物の細部はあとから反映されるため、長く待たされなくなりました',
        'スマートフォンと狭い画面：サイドバーが下部のシートになり、地図をピンチで拡大縮小できるようになりました',
      ],
      en: [
        'Settlement diorama layout: city walls now follow the built-up town with farmland left outside; houses in the core form continuous street fronts with shared gable walls and back yards; buildings, roads, walls and trees no longer intersect each other or extend past the edge of the diorama',
        'Buildings modeled by culture and part: Western churches with a west tower and spire, clerestory nave, aisles and apse; East Asian halls with terraces, bracket sets, upturned eaves and double roofs; Japanese castle keeps, shrine halls and five-story pagodas; Islamic mosques with prayer halls, domes, iwans and minarets; houses with dormers, timber framing, shopfronts and chimneys',
        'Fortifications and structures: gates with passable archways, walls with wall-walks and parapets, and towers shaped by culture; stone arch, timber and sacred bridges, piers and boats for each culture; wells, fountains, statues, windmills, water wheels, lighthouses, cemeteries and market stalls',
        'Vegetation: 14 tree forms with trunks and clustered crowns, chosen by culture, climate and surroundings; shrubs, reeds, hedges and vineyard trellises; smooth transitions between levels of detail, and crowns no longer turn into black silhouettes at night',
        'Ground and water: meadows, furrowed fields, orchards, paddies, paved streets and plazas each have their own texture; shorelines are exact, water is tinted by depth and reflects the sky, and the coast has surf; the ground is sharper at mid range',
        'Lighting and camera: automatic focus on the surface under the pointer, and a gallery backdrop instead of black above the horizon at low angles; three shadow cascades, ambient occlusion, and street lamps and gate torches at night; the camera no longer passes into buildings, terrain or tree crowns; press T to start an automatic camera tour',
        'On first entering the diorama the whole town appears right away and building detail follows shortly after, instead of a long wait',
        'Phones and narrow screens: the sidebar becomes a bottom sheet, and maps support pinch zoom',
      ],
    },
  },
]
