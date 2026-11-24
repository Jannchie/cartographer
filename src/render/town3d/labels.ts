import * as THREE from 'three'
import type { MapLabel } from '../../settlement/types'
import { lang } from '../../i18n'
import type { HeightField } from './heightField'

/**
 * 沙盘的注记（DOM 层）：片区名与大地标名。
 *
 * - 位置：片区名浮在片区上空（高过一般的屋顶），地标名立在地标的顶上（高度取自表面高度场），下面一道引线指着它。
 * - 显隐随镜头：远看只标片区，拉近到看得清单体时标地标；贴到街巷里时片区名退场（它指的是一片，而不是眼前这几栋）。
 * - 遮挡：注记的锚点被建筑、山体挡住时不标——隔着一排房子浮在别人屋顶上的名字会让人认错。
 * - 避让：按权重从大到小贪心排布，已经显示着的优先（镜头移动时不来回跳）。
 */

interface Item {
  el: HTMLDivElement
  /** 注记在沙盘上的位置（世界坐标的 x、z）与地面高度 */
  x: number
  z: number
  ground: number
  pos: THREE.Vector3
  w: number
  h: number
  weight: number
  district: boolean
  shown: boolean
}

/** 片区名离地的高度、地标名高出地标顶的高度（米） */
const DISTRICT_LIFT = 26
const LANDMARK_LIFT = 5
/** 地标名在镜头距离（米）小于这个值时才标；片区名在镜头距离小于这个值时退场 */
const LANDMARK_WITHIN = 1500
const DISTRICT_BEYOND = 170

export class TownLabels {
  private layer: HTMLDivElement
  private items: Item[] = []
  private order: Item[] = []
  private boxes: number[] = []
  private view = new THREE.Matrix4()
  private dirty = true
  private on = true
  private tmp = new THREE.Vector3()
  private dir = new THREE.Vector3()

  constructor(private container: HTMLElement) {
    this.layer = document.createElement('div')
    this.layer.className = 'labels3d'
    container.appendChild(this.layer)
  }

  /**
   * 换一批注记。place 把聚落米坐标换成世界坐标并给出地面高度；K：世界单位 / 米
   */
  set(labels: MapLabel[], place: (x: number, z: number) => { x: number; y: number; z: number }) {
    this.layer.innerHTML = ''
    this.items = []
    const keep = labels.filter((l) => l.kind === 'district' || l.kind === 'landmark').sort((a, b) => b.weight - a.weight)
    for (const l of keep.slice(0, 80)) {
      const el = document.createElement('div')
      el.className = `l3 l3-${l.kind}`
      el.textContent = l.text[lang]
      const p = place(l.p[0], l.p[1])
      this.layer.appendChild(el)
      this.items.push({ el, x: p.x, z: p.z, ground: p.y, pos: new THREE.Vector3(p.x, p.y, p.z), w: 0, h: 0, weight: l.weight, district: l.kind === 'district', shown: false })
    }
    for (const l of this.items) {
      l.w = l.el.offsetWidth
      l.h = l.el.offsetHeight
    }
    this.dirty = true
  }

  /** 注记的高度：片区名离地一段，地标名立在表面高度场里那一处的最高点上（高度场重新烘焙后再调一次） */
  anchor(field: HeightField, K: number) {
    for (const l of this.items) {
      l.pos.y = l.district ? l.ground + DISTRICT_LIFT * K : Math.max(l.ground + 6 * K, field.ready ? field.peak(l.x, l.z, 7 * K) : l.ground + 14 * K) + LANDMARK_LIFT * K
    }
    this.dirty = true
  }

  setVisible(on: boolean) {
    this.on = on
    this.layer.style.display = on ? '' : 'none'
    this.dirty = true
  }

  invalidate() {
    this.dirty = true
  }

  /** 按镜头重新排布（镜头没动且内容没变时什么也不做）。dist：镜头到视点的距离（世界单位） */
  update(camera: THREE.PerspectiveCamera, dist: number, field: HeightField, K: number) {
    if (!this.on || !this.items.length) return
    if (!this.dirty && this.view.equals(camera.matrixWorld)) return
    this.dirty = false
    this.view.copy(camera.matrixWorld)
    const wpx = this.container.clientWidth
    const hpx = this.container.clientHeight
    const boxes = this.boxes
    boxes.length = 0
    const meters = dist / K
    // 已经显示着的排在前面（同权重时不被新冒出来的挤掉），其余按权重
    const order = this.order
    order.length = 0
    for (const l of this.items) order.push(l)
    order.sort((a, b) => b.weight + (b.shown ? 0.35 : 0) - (a.weight + (a.shown ? 0.35 : 0)))
    const cam = camera.position
    for (const l of order) {
      const hide = () => {
        if (l.shown) l.el.style.opacity = '0'
        l.shown = false
      }
      if (l.district ? meters < DISTRICT_BEYOND : meters > LANDMARK_WITHIN) {
        hide()
        continue
      }
      this.tmp.copy(l.pos).project(camera)
      if (this.tmp.z >= 1 || Math.abs(this.tmp.x) > 1.02 || Math.abs(this.tmp.y) > 1.02) {
        hide()
        continue
      }
      const x = (this.tmp.x * 0.5 + 0.5) * wpx
      const y = (-this.tmp.y * 0.5 + 0.5) * hpx
      const b0 = x - l.w / 2 - 5
      const b1 = y - l.h - 3
      const b2 = x + l.w / 2 + 5
      const b3 = y + 3
      let hit = false
      for (let q = 0; q < boxes.length; q += 4) {
        if (b0 < boxes[q + 2] && b2 > boxes[q] && b1 < boxes[q + 3] && b3 > boxes[q + 1]) {
          hit = true
          break
        }
      }
      if (hit) {
        hide()
        continue
      }
      // 遮挡：自镜头到锚点的视线在表面高度场上有交点（留出锚点附近的一小段：锚点本来就贴着屋顶）
      if (field.ready) {
        this.dir.copy(l.pos).sub(cam)
        const len = this.dir.length()
        this.dir.divideScalar(len)
        if (field.raycast(cam, this.dir, len - 4 * K, 2.5) >= 0) {
          hide()
          continue
        }
      }
      boxes.push(b0, b1, b2, b3)
      if (!l.shown) l.el.style.opacity = '1'
      l.shown = true
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`
    }
  }

  dispose() {
    this.layer.remove()
    this.items = []
  }
}
