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
 * userData.text 是文字面片（调用方让它后仰正对镜头）；尺寸线留在组里，始终按真实高度。
 * 引线分成竖直段与水平段两部分，出现动画见 revealAnnotation
 */
export function annotation(spec: AnnotationSpec, color: string, subColor: string, lineMat: LineMaterial) {
  const g = new THREE.Group()
  const tag = new THREE.Group()
  const { mesh, w } = textPlane(spec.title, spec.sub, color, subColor)
  const pad = 0.3
  const L = w + pad * 2
  const h = spec.lift
  // 竖直引线与起点的小横刻；顶端（head）是水平线、端头短刻与文字
  const vert = segments([0, 0, 0, 0, h, 0, -0.2, 0, 0, 0.2, 0, 0], lineMat)
  const head = new THREE.Group()
  head.position.y = h
  const horiz = segments([0, 0, 0, L, 0, 0, L, -0.25, 0, L, 0.25, 0], lineMat)
  mesh.position.set(pad, 0.1, 0)
  head.add(horiz, mesh)
  tag.add(vert, head)
  g.add(tag)
  let dim: LineSegments2 | null = null
  if (spec.dimension) {
    // 高程尺寸线：在左侧偏出一点，两端短刻；顶端一条延长线接回峰顶，两端各一对短斜线作箭头
    const d = spec.dimension
    const x = -0.45
    const pts = [x, 0, 0, x, -d, 0]
    pts.push(x - 0.12, 0, 0, x + 0.12, 0, 0, x - 0.12, -d, 0, x + 0.12, -d, 0)
    pts.push(x - 0.2, 0, 0, 0, 0, 0)
    pts.push(x, 0, 0, x - 0.08, -0.22, 0, x, 0, 0, x + 0.08, -0.22, 0)
    pts.push(x, -d, 0, x - 0.08, -d + 0.22, 0, x, -d, 0, x + 0.08, -d + 0.22, 0)
    dim = segments(pts, lineMat)
    g.add(dim)
  }
  g.userData.tag = tag
  g.userData.text = mesh
  g.userData.reveal = { vert, head, horiz, text: mesh, dim }
  return g
}

/**
 * 标注的出现进度（0~1）：前 35% 竖直引线自地面升起（山峰的尺寸线同时自峰顶向下画出），
 * 其后水平线自左向右伸出，文字随之横向刷开（面片与贴图一起截取，不压扁）。1 为完整显示
 */
export function revealAnnotation(g: THREE.Object3D, p: number) {
  const r = g.userData.reveal as { vert: LineSegments2; head: THREE.Group; horiz: LineSegments2; text: THREE.Mesh; dim: LineSegments2 | null }
  const v = Math.min(1, Math.max(0, p / 0.35))
  const w = 1 - (1 - Math.min(1, Math.max(0, (p - 0.35) / 0.65))) ** 3
  for (const l of [r.vert, r.dim]) {
    if (!l) continue
    l.visible = v > 0
    l.scale.y = Math.max(v, 1e-4)
  }
  r.head.visible = w > 0
  r.horiz.scale.x = Math.max(w, 1e-4)
  r.text.scale.x = Math.max(w, 1e-4)
  const map = (r.text.material as THREE.MeshBasicMaterial).map
  if (map) map.repeat.x = w
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
