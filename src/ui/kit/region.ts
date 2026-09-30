/** 区域编辑叠加层（RegionOverlay.vue）要的最少字段：顶点与注记位置直接在对象上改 */
export interface EditRegion {
  id: string
  /** 外轮廓（区域坐标：世界地图是格，聚落是米） */
  poly: [number, number][]
  /** 注记位置（区域坐标） */
  at: [number, number]
}
