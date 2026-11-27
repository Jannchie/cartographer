// 聚落的生长引擎（第一版）：给定任意时刻的布局，决定下一块地摆在哪、路往哪儿延——像一个自己会玩的模拟城市。
// 一次成形的 generateSettlement 预先知道目标人口、中间状态过不了 JSON；这里反过来，从一片空地起一块一块地加，
// 状态（GrowState）就是全部：能过 JSON，地形不存、按参数重算（缓存不改变结果）。纯函数，Node 里能跑，不碰 DOM、不启动插件。
// 画图另在 paint.ts（要启动插件，只在浏览器、离线脚本里用）。对外的类型与签名在 api.d.ts / paint-api.d.ts。
//
// 三种来源改的是同一份状态，可以混着用（模拟城市那样：玩家手动铺路、划区，也可以交给它自己长）：
//   手动铺路   addRoad / removeRoad（plan.ts：端点接到已有的路上；跨水、压到地块拒绝并说明原因；路上还有临街地块不让拆）
//   规划分区   zone / unzone（plan.ts：只记下「这片地打算给什么用」，不立刻盖）
//   手动摆放   probeLot / placeAt / removeLot（manual.ts：位置由指针定，沿路吸附；blankState 从什么都没有的空地起）
//   手动改地形 paintTerrain（manual.ts、relief.ts：笔画记进 state.strokes，地形 = 生成的地形叠上每一笔）
//   自动生长   place（选址时相符的分区大幅加分、别的用途的分区不进；延路也往相符的分区里延）
//
//   seedState(params)          一片空地 + 一两条对外的路（从村心按地形寻路到画幅边）+ 村心（一块 center 地）
//   place(state, req, salt)    摆下 req.count 块地（不改传入的 state，返回新的）；找不到返回 null
//   release(state, id)         退掉一块：形状留着、变成 vacant，以后同样大小的需求可以接着用
//   setState(state, id, s)     在建 → 盖好
//   route(state, from, to)     沿路网走的折线（只给画图看，规则见 route.ts 顶上）
//   所有操作都不改传入的 state，返回新的。同样的 state + req + salt → 逐位同样的结果：数学只用 dmath，不取随机序列，打破平局用 hash(位置, salt)
//
// 手动规划的规则见 plan.ts 顶上。
// 选址（一句一条）：
//   - 一块地 = 20 × 20 米（area 个单位就是面宽 × area），朝着路，退后路边 1.5 米。
//   - 沿每条路两侧每隔 4 米试一处；田、料场还可以接在同类地块的背后、两旁；空着的同样大小的地可以接着用。
//   - 压到路、压到别的地、压到给岔路留的路口、离水不到 3 米、坡度超过 0.2、出画幅的，不要。
//   - 住处、铺子、公家、村心按离村心多远算分（越近越好）；田、料场要在「住处那一圈」之外（圈 = 住处一类的地按三倍面积摊成圆，至少 100 米），
//     落进圈里每米罚几分，圈外越近越好（权重小）。
//   - 同一个 owner 的离已有的越远越差（挨着的不罚）；一片里的后几块挨着前几块。
//   - 地块中心落在用途相符的分区里减 300 分（比离村心几百米还要紧）；落在别的用途的分区里不要；没有相符的分区就照上面的打分。
//   - 坡越陡越差；最后加一点位置哈希（不超过 3 分），打破平局。
//   - 不用验地就算得出的分是下界：候选按它排好依次验地，下界不比手里最好的低就停（所以几千个候选只验几十个）。
// 延路（一句一条）：
//   - 沿每条路每隔 100 米（第一个在 50 米处）两侧各留一个 7 米宽、60 米深的路口，不是对外的路的尽头往前也留一条路面宽的空当，
//     别的地不能占（田接在临街地块背后往外长，不留的话会把以后的路堵死）；岔路只从路口岔出去，所以不会到处乱岔。
//   - 方案有两种：尽头的路顺着原方向（或左右拐 0.4 弧度）延 50 米；从路口往外岔 50 米（多一个尽头，加 25 分）。
//   - 先试直的；直的下水就按地形寻路（routeOnTerrain）绕开；绕不开、跨水、出画幅、压到地块、离别的路不到 44 米（会平行重复）的，不要。
//   - 新路每米 1.5 分，加上沿新路摆下最好的那块的分；比现有最好的空位还好（或者根本没有空位）才延。按粗估的分细算前 12 个方案。
//     有相符的分区、而现有最好的空位不在分区里时也试着延（粗估时看新路中段和远端落不落在分区里，往分区里通的排在前面）。
//   - 对外的路叫 highway，从它岔出去的叫 street，再往下的叫 lane；延长沿用原来的种类。对外的路不延（它已经到了画幅边）。
// 没有什么（以后细化）：
//   - 走向场：路和地块现在只看自己临的那条路的方向；以后用 tensor.ts 那样的走向场（等高线、河岸、村心的环向）定岔路与地块的朝向。
//   - 片区骨架：没有片区（住、商、工、田的分区只是打分里的远近）；以后先长出片区边界，再在片区里摆地。
//   - 桥：延路一律不跨水（对外的路下水时画一座桥，只是画）；以后按河宽、两岸的需求架桥。
//   - 路网成环（尽头接上附近的路）、路的分级加宽、地块合并与拆分、退掉的路。
//   - 无尽幻想里让领头人「修路 / 划区」（cartographer 里的界面是村落生长模块，见 src/ui/grow）。
//   - 分区的细节：密度、只许某些人用、分区边界自动长出路。拆路时接在它上面的路不管（会断开）。

// 这里只导出 api.d.ts 里有的东西（外部项目只看得到那些）；本仓库的脚本要用的内部常量、函数直接从 ./core、./draw 引。
export type {
  GrowBrush, GrowFault, GrowLot, GrowLotState, GrowP, GrowParams, GrowRoad, GrowRoadKind, GrowState, GrowStroke, GrowTerrain, GrowZone, LotProbe, PlaceReq, PlaceResult,
} from './api'
export { GROW_VERSION, growHash, lotAtPoint, lotCenter, release, setState } from './core'
export { blankState, place, seedState } from './place'
export { addRoad, removeRoad, unzone, zone, zoneAtPoint } from './plan'
export { paintTerrain, placeAt, probeLot, removeLot } from './manual'
export { route } from './route'
