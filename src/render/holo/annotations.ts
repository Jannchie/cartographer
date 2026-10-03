import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { cjkFont, lang } from '../../i18n'
import { canvasTexture, textMaterial } from './labels'

/**
 * 图纸式标注：立在台面上的引线与文字，像在三维空间里画的工程图。
 * 每条标注是一个绕竖轴转向镜头的组（原点在被标注的地面点上）：
 * 竖直引线 → 折向右侧的水平线（端头一道短刻）→ 文字压在水平线上方。
 * 山峰另有一道从海平面到峰顶的高程尺寸线（两端短刻、顶端引出延长线）。
 */

const TITLE_PX = 56
const SUB_PX = 24
/** 字高（场景单位）：标题一行 */
const TITLE_H = 1.05

/** 标注文字：标题（加宽无衬线，拉丁字母大写）+ 一行等宽小字，左对齐、无底板 */
function annotationTexture(title: string, sub: string, color: string, subColor: string) {
  const cjk = lang !== 'en'
  const cv = document.createElement('canvas')
  const g = cv.getContext('2d')!
  const text = cjk ? title : title.toUpperCase()
  const setFont = (kind: 'title' | 'sub') => {
    const t = kind === 'title'
    g.font = t ? `600 ${TITLE_PX}px "Archivo", ${cjk ? cjkFont(lang, true) : 'sans-serif'}` : `400 ${SUB_PX}px "Berkeley Mono", monospace`
    g.fontStretch = t ? 'expanded' : 'normal'
    g.letterSpacing = t ? `${TITLE_PX * 0.08}px` : `${SUB_PX * 0.06}px`
  }
  setFont('title')
  const tw = g.measureText(text).width
  setFont('sub')
  const sw = g.measureText(sub).width
  const W = Math.ceil(Math.max(tw, sw) + 8)
  const H = Math.ceil(TITLE_PX * 1.15 + SUB_PX * 1.5)
  cv.width = W
  cv.height = H
  g.textBaseline = 'alphabetic'
  setFont('title')
  g.fillStyle = color
  g.fillText(text, 2, TITLE_PX * 0.95)
  setFont('sub')
  g.fillStyle = subColor
  g.fillText(sub, 3, TITLE_PX * 1.15 + SUB_PX * 1.05)
  const k = TITLE_H / TITLE_PX
  return { tex: canvasTexture(cv), w: W * k, h: H * k }
}

/** 文字面片：左下角在原点（压在引线的水平段上） */
function textPlane(title: string, sub: string, color: string, subColor: string) {
  const { tex, w, h } = annotationTexture(title, sub, color, subColor)
  const geo = new THREE.PlaneGeometry(w, h).translate(w / 2, h / 2, 0)
  const m = new THREE.Mesh(geo, textMaterial(tex, 0.9, { depthTest: false }))
  m.renderOrder = 20
  return { mesh: m, w, h }
}

export interface AnnotationSpec {
  title: string
  sub: string
  /** 引线竖直段的高度 */
  lift: number
  /** 高程尺寸线：从组原点往下这么高（山峰：组原点在峰顶，尺寸线量到海平面） */
  dimension?: number
}

/**
 * 一条标注的组（局部坐标：x 向右、y 向上；调用方让组整体绕 y 轴转向镜头）。
 * userData.tag 是引线与文字（调用方按镜头距离缩放，保持屏幕上大小相近），
 * userData.text 是文字面片（调用方让它后仰正对镜头）；尺寸线留在组里，始终按真实高度
 */
export function annotation(spec: AnnotationSpec, color: string, subColor: string, lineMat: LineMaterial) {
  const g = new THREE.Group()
  const tag = new THREE.Group()
  const { mesh, w } = textPlane(spec.title, spec.sub, color, subColor)
  const pad = 0.3
  const L = w + pad * 2
  const h = spec.lift
  // 竖直引线与折线，端头短刻与起点的小横刻
  const lead = [0, 0, 0, 0, h, 0, 0, h, 0, L, h, 0, L, h - 0.25, 0, L, h + 0.25, 0, -0.2, 0, 0, 0.2, 0, 0]
  mesh.position.set(pad, h + 0.1, 0)
  tag.add(segments(lead, lineMat), mesh)
  g.add(tag)
  if (spec.dimension) {
    // 高程尺寸线：在左侧偏出一点，两端短刻；顶端一条延长线接回峰顶，两端各一对短斜线作箭头
    const d = spec.dimension
    const x = -0.45
    const dim = [x, 0, 0, x, -d, 0]
    dim.push(x - 0.12, 0, 0, x + 0.12, 0, 0, x - 0.12, -d, 0, x + 0.12, -d, 0)
    dim.push(x - 0.2, 0, 0, 0, 0, 0)
    dim.push(x, 0, 0, x - 0.08, -0.22, 0, x, 0, 0, x + 0.08, -0.22, 0)
    dim.push(x, -d, 0, x - 0.08, -d + 0.22, 0, x, -d, 0, x + 0.08, -d + 0.22, 0)
    g.add(segments(dim, lineMat))
  }
  g.userData.tag = tag
  g.userData.text = mesh
  return g
}

/** 一组线段（每 6 个数一段），可带每端的顶点色 */
export function segments(pos: number[] | Float32Array, mat: LineMaterial, colors?: number[]) {
  const geo = new LineSegmentsGeometry()
  geo.setPositions(pos)
  if (colors) geo.setColors(colors)
  const l = new LineSegments2(geo, mat)
  l.frustumCulled = false
  return l
}

/** 地面上的标记：十字准线加一个小方框（平放在台面，写进 out，世界坐标） */
export function groundMark(x: number, y: number, z: number, out: number[]) {
  const r = 0.6
  const q = 0.2
  out.push(x - r, y, z, x - q, y, z, x + q, y, z, x + r, y, z)
  out.push(x, y, z - r, x, y, z - q, x, y, z + q, x, y, z + r)
  out.push(x - q, y, z - q, x + q, y, z - q, x + q, y, z - q, x + q, y, z + q)
  out.push(x + q, y, z + q, x - q, y, z + q, x - q, y, z + q, x - q, y, z - q)
}
