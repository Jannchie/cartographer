import * as THREE from 'three'
import { cjkFont, lang } from '../../i18n'

/**
 * 平铺在台面上的地名：文字画进画布贴图，贴在一块水平的面片上（随透视缩短，像投影在桌面上的字）。
 * 拉丁字母用加宽的 Archivo，全大写加字距；中日文用无衬线黑体。
 */

export type LabelStyle = 'continent' | 'sea' | 'land' | 'city' | 'capital'

const isCjk = () => lang !== 'en'

interface Spec {
  weight: number
  italic: boolean
  upper: boolean
  /** 字距（em） */
  track: number
}
const SPEC: Record<LabelStyle, Spec> = {
  continent: { weight: 600, italic: false, upper: true, track: 0.6 },
  sea: { weight: 400, italic: true, upper: false, track: 0.12 },
  land: { weight: 600, italic: false, upper: true, track: 0.3 },
  city: { weight: 500, italic: false, upper: false, track: 0.06 },
  capital: { weight: 700, italic: false, upper: false, track: 0.06 },
}

const PX = 64

function fontOf(style: LabelStyle, px: number) {
  const s = SPEC[style]
  const fam = isCjk() ? `"Archivo", ${cjkFont(lang, true)}` : `"Archivo", sans-serif`
  return `${s.italic && !isCjk() ? 'italic ' : ''}${s.weight} ${px}px ${fam}`
}

/** 画好的画布 → 贴图 */
export function canvasTexture(cv: HTMLCanvasElement) {
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** 文字面片的材质：加法混合、不写深度，tint 为整体亮度 */
export function textMaterial(tex: THREE.Texture, tint: number, opts: THREE.MeshBasicMaterialParameters = {}) {
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: new THREE.Color(tint, tint, tint),
    ...opts,
  })
}

/** 画布上的一行字（含字距），返回贴图与宽高比；发光交给后期泛光 */
export function textTexture(text: string, style: LabelStyle, color: string) {
  const s = SPEC[style]
  const t = s.upper && !isCjk() ? text.toUpperCase() : text
  const track = isCjk() ? Math.min(s.track, 0.25) : s.track
  const cv = document.createElement('canvas')
  const g = cv.getContext('2d')!
  const setFont = () => {
    g.font = fontOf(style, PX)
    g.fontStretch = 'expanded'
    g.letterSpacing = `${track * PX}px`
  }
  setFont()
  const W = Math.ceil(g.measureText(t).width + PX * 0.8)
  const H = Math.round(PX * 1.45)
  cv.width = W
  cv.height = H
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  setFont()
  g.fillStyle = color
  g.fillText(t, W / 2 + (track * PX) / 2, PX * 0.72)
  return { tex: canvasTexture(cv), aspect: W / H, glyphH: PX / H }
}

/** 平铺地名：size 为字高（场景单位），面片中心在原点 */
export function flatLabel(text: string, style: LabelStyle, color: string, size: number) {
  const { tex, aspect, glyphH } = textTexture(text, style, color)
  const h = size / glyphH
  const geo = new THREE.PlaneGeometry(h * aspect, h).rotateX(-Math.PI / 2)
  const m = new THREE.Mesh(geo, textMaterial(tex, 0.62, { depthTest: false }))
  m.renderOrder = 10
  return { mesh: m, w: h * aspect, h }
}

/** 释放组里的几何、材质与贴图并清空（换世界、换语言时整体重建；共用的材质重复释放无害） */
export function disposeGroup(g: THREE.Object3D) {
  g.traverse((c) => {
    const m = c as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
    const mat = m.material as THREE.Material & { map?: THREE.Texture | null }
    if (mat) {
      mat.map?.dispose()
      mat.dispose()
    }
  })
  g.clear()
}
