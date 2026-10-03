import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { reliefKm, type World } from '../../gen/types'
import { hashString } from '../../gen/rng'
import { smoothstep } from '../../gen/util'
import { latitudeOf } from '../../gen/climate'
import { lonScale } from '../atlas/furniture'
import { cjkFont, lang, placeName, worldTitle } from '../../i18n'
import { holoFields, type HoloFields } from './fields'
import { createFloorMaterial, createTerrainMaterial, FinishShader } from './materials'
import { canvasTexture, disposeGroup, flatLabel, textMaterial, textTexture, type LabelStyle } from './labels'
import { annotation, groundMark, segments } from './annotations'
import { HoloHud } from './hud'
import { holoPalette, type HoloPalette } from './palettes'

export interface HoloOptions {
  /** 配色方案（见 palettes.ts） */
  palette: string
  /** 垂直夸张 */
  exaggeration: number
  labels: boolean
  /** 屏幕四周的读数界面 */
  hud: boolean
  /** 线框盒立面的高度（最高峰处，场景单位） */
  sectionHeight: number
}

const SX = 100
/** 陆块整体抬起的高度 */
const LIFT = 0.32
/** 图框离地图边缘的距离 */
const MARGIN = 2.2
/** 线框盒顶面高出立面最高峰的距离 */
const SECTION_PAD = 1.5
/** 开场铺开的时长（秒） */
const REVEAL_S = 1.8
/** 图纸式引线标注的城市数（按重要度）与山峰数（按陆块面积取各自的最高峰） */
const ANNO_CITIES = 8
const ANNO_PEAKS = 3
/** 引线标注按原大显示时的镜头距离（更近时等比缩小） */
const ANNO_DIST = 110
/** 地形网格每行最多的分段：更密看不出差别，只多顶点 */
const MAX_SEG = 768

const linear = (hex: string) => new THREE.Color(hex)
/** 纬度、经度读数：12.3°N */
const fmtDeg = (v: number, digits: number, pos: string, neg: string) => `${Math.abs(v).toFixed(digits)}°${v >= 0 ? pos : neg}`
/**
 * 水平网格（y = 0，x 向右、z 向下，uv 的 v 自上而下从 1 到 0，与转平的 PlaneGeometry 一致）。
 * 直接写类型化数组：PlaneGeometry 加 rotateX 在几十万顶点时要几百毫秒，且地形着色器用不到法线
 */
function gridGeometry(w: number, d: number, sx: number, sz: number) {
  const nx = sx + 1
  const nz = sz + 1
  const pos = new Float32Array(nx * nz * 3)
  const uv = new Float32Array(nx * nz * 2)
  for (let j = 0, k = 0; j < nz; j++) {
    const v = j / sz
    const z = (v - 0.5) * d
    for (let i = 0; i < nx; i++, k++) {
      const u = i / sx
      pos[k * 3] = (u - 0.5) * w
      pos[k * 3 + 2] = z
      uv[k * 2] = u
      uv[k * 2 + 1] = 1 - v
    }
  }
  const idx = new Uint32Array(sx * sz * 6)
  for (let j = 0, k = 0; j < sz; j++)
    for (let i = 0; i < sx; i++) {
      const a = j * nx + i
      const b = a + nx
      idx[k++] = a
      idx[k++] = b
      idx[k++] = a + 1
      idx[k++] = b
      idx[k++] = b + 1
      idx[k++] = a + 1
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return g
}

/** 由字符串得到稳定的十六进制编号 */
const uidOf = (s: string) => `0x${(hashString(s) % 0xfffff).toString(16).padStart(5, '0')}`

/**
 * 全息投影沙盘：深色投影台上发光的地形片，像素块填色、海岸辉光与双线，
 * 平铺在台面上的地名，大城与高峰的图纸式引线标注（引线、折线、尺寸线），外加一圈读数界面。
 * 悬停高亮陆块（连通的陆地），点击锁定为目标。
 * 按需渲染：镜头、悬停、锁定、开场动画或选项变化时才画一帧，静止时不占 GPU。
 */
export class HoloScene {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  private composer: EffectComposer
  private finish: ShaderPass
  private opts: HoloOptions
  private pal: HoloPalette
  private hud: HoloHud

  private terrain = createTerrainMaterial()
  private floor = createFloorMaterial()
  private terrainMesh: THREE.Mesh | null = null
  private skirt: THREE.Mesh
  private frameGroup = new THREE.Group()
  /** 线框盒：四面立面与浮在上方的顶面 */
  private sectionGroup = new THREE.Group()
  private lineGroup = new THREE.Group()
  private labelGroup = new THREE.Group()
  private annoGroup = new THREE.Group()
  /** 海岸线几何与每个端点所属的陆块（锁定时只重新上色） */
  private coastLines: { inner: LineSegments2; outer: LineSegments2; segMass: Int32Array } | null = null
  /** 引线标注里绕竖轴转向镜头的组 */
  private billboards: THREE.Group[] = []
  /** 浮在线框盒上方的标题立牌（属于 frameGroup） */
  private header: THREE.Mesh | null = null
  /** 平铺地名与它们所在的格（垂直夸张变化时重算高度） */
  private placed: { obj: THREE.Object3D; cx: number; cy: number; dy: number }[] = []

  private world: World | null = null
  private f: HoloFields | null = null
  private heightTex: THREE.DataTexture | null = null
  private dataTex: THREE.DataTexture | null = null
  /** 每格的陆块编号（海上取最近的陆块，+1 后拆成两个字节；0 为无） */
  private idTex: THREE.DataTexture | null = null
  private SZ = 62.5
  private selected = -1
  private hovered = -1
  private revealAt = 0
  private labelJob = 0
  private clock = new THREE.Clock()
  private raf = 0
  private ro: ResizeObserver
  private down: { x: number; y: number } | null = null
  private pointer: { x: number; y: number } | null = null
  /** 光标移动过、还没重新拾取 */
  private pointerMoved = false
  /** 下一帧需要重画 */
  private dirty = true
  /** 开场动画是否已播完（播完后再画一帧定格） */
  private revealDone = true
  private pickRay = new THREE.Raycaster()
  active = true

  constructor(
    private container: HTMLElement,
    opts: HoloOptions,
  ) {
    this.opts = { ...opts }
    this.pal = holoPalette(opts.palette)
    this.renderer = new THREE.WebGLRenderer({ antialias: false })
    this.renderer.toneMapping = THREE.NoToneMapping
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 3000)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.44
    this.controls.minDistance = 6
    this.controls.maxDistance = 320
    this.controls.screenSpacePanning = false
    this.controls.zoomToCursor = true

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
    this.composer = new EffectComposer(this.renderer, rt)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.12, 0.25, 1.0))
    this.finish = new ShaderPass(FinishShader)
    this.composer.addPass(this.finish)
    this.composer.addPass(new OutputPass())

    // 投影台地板与地图下方的台座
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(SX * 8, SX * 8).rotateX(-Math.PI / 2), this.floor.mat)
    floor.position.y = -0.3
    this.skirt = new THREE.Mesh(new THREE.BoxGeometry(1, 0.28, 1), new THREE.MeshBasicMaterial({ color: 0x000000 }))
    this.skirt.position.y = -0.15
    this.scene.add(floor, this.skirt, this.frameGroup, this.sectionGroup, this.lineGroup, this.labelGroup, this.annoGroup)

    this.hud = new HoloHud(container)
    this.applyPalette()
    this.hud.visible = this.opts.hud

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()

    const el = this.renderer.domElement
    el.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }))
    el.addEventListener('pointerup', (e) => {
      const d = this.down
      this.down = null
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return
      const m = this.massAt(e.clientX, e.clientY)
      this.select(m === this.selected ? -1 : m)
    })
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return
      this.pointer = { x: e.clientX, y: e.clientY }
      this.pointerMoved = true
    })
    el.addEventListener('pointerleave', () => {
      this.pointer = null
      this.hover(-1)
      this.hud.setDestination(null, null)
    })

    // 阻尼中的镜头由 controls.update() 的返回值发现；拖动开始的那一下由 change 事件标脏
    this.controls.addEventListener('change', () => (this.dirty = true))
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      if (!this.active) return
      this.tick()
    }
    this.raf = requestAnimationFrame(loop)
  }

  // —— 世界 ——
  setWorld(world: World) {
    this.world = world
    const f = holoFields(world)
    this.f = f
    const { W, H } = world
    this.SZ = (SX * (H - 1)) / (W - 1)
    const SZ = this.SZ

    this.heightTex?.dispose()
    this.heightTex = new THREE.DataTexture(f.ground, W, H, THREE.RedFormat, THREE.FloatType)
    this.heightTex.magFilter = this.heightTex.minFilter = THREE.LinearFilter
    this.heightTex.needsUpdate = true
    this.dataTex?.dispose()
    const data = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) data[i] = Math.round(f.landBlur[i] * 255)
    this.dataTex = new THREE.DataTexture(data, W, H, THREE.RedFormat)
    this.dataTex.magFilter = this.dataTex.minFilter = THREE.LinearFilter
    this.dataTex.unpackAlignment = 1
    this.dataTex.needsUpdate = true
    // 悬停、锁定只改着色器里的编号，不重传贴图
    this.idTex?.dispose()
    const ids = new Uint8Array(W * H * 2)
    for (let i = 0; i < W * H; i++) {
      // 编号超出两个字节的小岛不参与高亮
      const v = f.near[i] + 1 > 0xffff ? 0 : f.near[i] + 1
      ids[i * 2] = v & 255
      ids[i * 2 + 1] = v >> 8
    }
    this.idTex = new THREE.DataTexture(ids, W, H, THREE.RGFormat)
    this.idTex.magFilter = this.idTex.minFilter = THREE.NearestFilter
    this.idTex.unpackAlignment = 1
    this.idTex.needsUpdate = true

    const u = this.terrain.uniforms
    u.uHeight.value = this.heightTex
    u.uData.value = this.dataTex
    u.uIds.value = this.idTex
    u.uGrid.value.set(W, H)
    u.uSize.value.set(SX, SZ)
    u.uRelief.value = this.relief()
    u.uLift.value = LIFT

    // 网格只取决于尺寸：尺寸不变（同分辨率换种子）时沿用
    const segX = Math.min(W - 1, MAX_SEG)
    const segZ = Math.max(2, Math.round((segX * (H - 1)) / (W - 1)))
    const key = `${segX}x${segZ}:${SZ}`
    if (!this.terrainMesh || this.terrainMesh.userData.key !== key) {
      if (this.terrainMesh) {
        this.terrainMesh.geometry.dispose()
        this.scene.remove(this.terrainMesh)
      }
      this.terrainMesh = new THREE.Mesh(gridGeometry(SX, SZ, segX, segZ), this.terrain.mat)
      this.terrainMesh.userData.key = key
      this.terrainMesh.frustumCulled = false
      this.scene.add(this.terrainMesh)
    }
    this.skirt.scale.set(SX, 1, SZ)
    this.floor.uniforms.uHalf.value.set(SX / 2 + MARGIN, SZ / 2 + MARGIN)

    this.selected = -1
    this.hovered = -1
    this.updateMasks()

    this.buildFrame()
    this.buildSection()
    this.buildLines()
    this.buildLabels()
    this.buildAnnotations()
    this.hud.build(world.params.seed, worldTitle(world).toUpperCase(), world.W * world.kmPerCell)
    this.updateTarget()
    this.resetView()
    this.revealAt = this.clock.getElapsedTime()
    this.revealDone = false
    this.dirty = true
  }

  /** 地面没变、只换了世界对象（例如重新生成时只改了命名）：沿用地形，地名由 refreshLabels 重排 */
  setNames(world: World) {
    this.world = world
  }

  /** 只换了地名：重排注记与界面 */
  refreshLabels() {
    if (!this.world) return
    // 立牌上有世界名
    this.buildHeader()
    this.buildLabels()
    this.buildAnnotations()
    this.hud.build(this.world.params.seed, worldTitle(this.world).toUpperCase(), this.world.W * this.world.kmPerCell)
    this.updateTarget()
    this.dirty = true
  }

  setOptions(patch: Partial<HoloOptions>) {
    const prev = this.opts
    this.opts = { ...prev, ...patch }
    if (patch.palette !== undefined && patch.palette !== prev.palette) {
      this.pal = holoPalette(patch.palette)
      this.applyPalette()
      if (this.world) {
        this.buildFrame()
        this.buildSection()
        this.recolorLines()
        this.buildLabels()
        this.buildAnnotations()
      }
    }
    if (patch.exaggeration !== undefined && patch.exaggeration !== prev.exaggeration && this.world) {
      this.terrain.uniforms.uRelief.value = this.relief()
      this.buildLines()
      this.buildAnnotations()
      for (const p of this.placed) p.obj.position.y = this.heightAt(p.cx, p.cy) + p.dy
    }
    if (patch.sectionHeight !== undefined && patch.sectionHeight !== prev.sectionHeight && this.world) {
      this.buildSection()
      // 标题立牌浮在盒顶上方，跟着升降
      this.placeHeader()
    }
    if (patch.labels !== undefined) this.labelGroup.visible = this.opts.labels
    if (patch.hud !== undefined) this.hud.visible = this.opts.hud
    this.dirty = true
  }

  resetView() {
    this.controls.target.set(0, 0, this.SZ * 0.04)
    this.camera.position.set(0, SX * 0.78, SX * 0.98)
    this.controls.update()
    this.dirty = true
  }

  snapshot(): string {
    this.render()
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    for (const g of [this.frameGroup, this.sectionGroup, this.lineGroup, this.labelGroup, this.annoGroup]) disposeGroup(g)
    this.terrainMesh?.geometry.dispose()
    this.heightTex?.dispose()
    this.dataTex?.dispose()
    this.idTex?.dispose()
    this.composer.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.hud.dispose()
  }

  /** 线框盒顶面的高度 */
  private sectionTop() {
    return this.opts.sectionHeight + SECTION_PAD
  }

  // —— 换算 ——
  private relief() {
    const w = this.world
    return w ? (SX / (w.W * reliefKm(w))) * this.opts.exaggeration : 1
  }
  private toX(cx: number) {
    return (cx / (this.world!.W - 1) - 0.5) * SX
  }
  private toZ(cy: number) {
    return (cy / (this.world!.H - 1) - 0.5) * this.SZ
  }
  /** 格坐标处的海拔（双线性，湖泊为浅坑） */
  private groundAt(cx: number, cy: number) {
    const f = this.f!
    const { W, H } = f
    const x = Math.min(W - 1, Math.max(0, cx))
    const y = Math.min(H - 1, Math.max(0, cy))
    const x0 = Math.min(W - 2, Math.floor(x))
    const y0 = Math.min(H - 2, Math.floor(y))
    const tx = x - x0
    const ty = y - y0
    const g = f.ground
    const i = y0 * W + x0
    return (g[i] * (1 - tx) + g[i + 1] * tx) * (1 - ty) + (g[i + W] * (1 - tx) + g[i + W + 1] * tx) * ty
  }
  /** 格坐标处的台面高度（与地形着色器的 groundH 一致） */
  private heightAt(cx: number, cy: number) {
    const e = this.groundAt(cx, cy)
    return smoothstep(-0.004, 0.004, e) * LIFT + Math.max(e, 0) * this.terrain.uniforms.uRelief.value
  }

  // —— 配色 ——
  private applyPalette() {
    const p = this.pal
    const u = this.terrain.uniforms
    u.uLand.value.copy(linear(p.land))
    u.uAccent.value.copy(linear(p.accent))
    u.uSea.value.copy(linear(p.sea))
    u.uLine.value.copy(linear(p.grid))
    u.uFill.value.set(p.fill[0], p.fill[1])
    u.uGlow.value = p.glow
    this.floor.uniforms.uLine.value.copy(linear(p.grid))
    this.floor.uniforms.uBg.value.copy(linear(p.bg))
    ;(this.skirt.material as THREE.MeshBasicMaterial).color.copy(linear(p.sea)).multiplyScalar(0.5)
    this.scene.background = linear(p.bg)
    this.finish.uniforms.uBg.value.copy(linear(p.bg))
    this.hud.setPalette(p)
    this.dirty = true
  }

  // —— 锁定与悬停 ——
  private updateMasks() {
    const u = this.terrain.uniforms
    u.uSel.value = this.selected + 1
    u.uHov.value = this.hovered + 1
    this.dirty = true
  }

  private select(r: number) {
    if (r === this.selected) return
    this.selected = r
    this.updateMasks()
    this.recolorLines()
    this.updateTarget()
  }

  private hover(r: number) {
    if (r === this.hovered) return
    this.hovered = r
    this.updateMasks()
    this.updateTarget()
    this.renderer.domElement.style.cursor = r >= 0 ? 'pointer' : ''
  }

  /** 陆块的名字：落在其中、重要度最高的大陆或岛屿地名 */
  private massName(id: number) {
    const w = this.world!
    const f = this.f!
    let best: World['labels'][number] | null = null
    for (const l of w.labels) {
      if (l.kind !== 'continent' && l.kind !== 'island') continue
      const i = Math.round(l.y) * f.W + Math.round(l.x)
      if (f.near[i] === id && w.elevation[i] > 0 && (!best || l.weight > best.weight)) best = l
    }
    return best ? placeName(best) : `LANDMASS ${String(id + 1).padStart(3, '0')}`
  }

  private updateTarget() {
    const w = this.world
    const f = this.f
    const id = this.hovered >= 0 ? this.hovered : this.selected
    const m = f && id >= 0 ? f.masses[id] : null
    if (!w || !m) return this.hud.setTarget(null)
    const km2 = m.cells * w.kmPerCell * w.kmPerCell
    const c = this.latLon(m.x, m.y)
    const rows: [string, string][] = [
      ['AREA', `${Math.round(km2).toLocaleString('en-US')} KM²`],
      ['PEAK', `${Math.round(m.peak * 1000).toLocaleString('en-US')} M`],
      ['LAT', c.lat.toFixed(2)],
      ['LON', c.lon.toFixed(2)],
      ['STATUS', id === this.selected ? 'TRACKING' : 'SCANNING'],
    ]
    const name = this.massName(id)
    this.hud.setTarget({ name, uid: uidOf(`${w.params.seed}:${id}`), rows, pinned: id === this.selected })
  }

  private latLon(cx: number, cy: number) {
    const w = this.world!
    const lat = latitudeOf(w.params, cy, w.H)
    const lon = (cx - w.W / 2) * lonScale(w)
    return { lat, lon }
  }

  // —— 拾取：沿视线步进求与台面的交点 ——
  private groundPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.world) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.pickRay.setFromCamera(ndc, this.camera)
    const { origin: o, direction: d } = this.pickRay.ray
    if (d.y >= -1e-4) return null
    const top = LIFT + 9 * this.terrain.uniforms.uRelief.value
    const t0 = o.y > top ? (top - o.y) / d.y : 0
    const t1 = (0 - o.y) / d.y
    const p = new THREE.Vector3()
    const hAt = (q: THREE.Vector3) => this.heightAt((q.x / SX + 0.5) * (this.world!.W - 1), (q.z / this.SZ + 0.5) * (this.world!.H - 1))
    const N = 160
    let prev = t0
    for (let k = 1; k <= N; k++) {
      const t = t0 + ((t1 - t0) * k) / N
      p.copy(o).addScaledVector(d, t)
      if (p.y <= hAt(p)) {
        let lo = prev
        let hi = t
        for (let j = 0; j < 8; j++) {
          const m = (lo + hi) / 2
          p.copy(o).addScaledVector(d, m)
          if (p.y <= hAt(p)) hi = m
          else lo = m
        }
        return p.copy(o).addScaledVector(d, hi)
      }
      prev = t
    }
    return p.copy(o).addScaledVector(d, t1)
  }

  /** 屏幕点 → 格 */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const p = this.groundPoint(clientX, clientY)
    const w = this.world
    if (!p || !w) return null
    const x = Math.round((p.x / SX + 0.5) * (w.W - 1))
    const y = Math.round((p.z / this.SZ + 0.5) * (w.H - 1))
    if (x < 0 || y < 0 || x >= w.W || y >= w.H) return null
    return { x, y }
  }

  private massAt(clientX: number, clientY: number) {
    const c = this.pick(clientX, clientY)
    return c ? this.massOfCell(c) : -1
  }
  /** 格所在的陆块（内陆湖算作所在的陆块；海上为 -1） */
  private massOfCell(c: { x: number; y: number }) {
    const f = this.f
    if (!f) return -1
    const i = c.y * f.W + c.x
    return this.world!.elevation[i] > 0 ? f.near[i] : -1
  }

  // —— 构建 ——
  private lineMat(color: THREE.Color | null, width: number, opacity = 1, depthTest = true) {
    const m = new LineMaterial({
      vertexColors: !color,
      transparent: true,
      opacity,
      depthTest,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      worldUnits: false,
    })
    if (color) m.color.copy(color)
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    m.resolution.copy(size)
    m.linewidth = width * this.renderer.getPixelRatio()
    m.userData.width = width
    m.userData.baseOpacity = opacity
    return m
  }
  /** 场景里的各线材质（画布尺寸变化时要更新分辨率） */
  private lineMats() {
    const out = new Set<LineMaterial>()
    this.scene.traverse((c) => {
      const m = (c as THREE.Mesh).material
      if (m instanceof LineMaterial) out.add(m)
    })
    return out
  }
  /** 一个矩形的四边：写进 out（不画时传 null），并向两端无限延伸（延长线写进 ext / extC） */
  private rect(x: number, z: number, y: number, k: number, out: number[] | null, ext: number[], extC: number[]) {
    const c = [[-x, y, -z], [x, y, -z], [x, y, z], [-x, y, z]]
    const grid = linear(this.pal.grid)
    for (let i = 0; i < 4; i++) {
      const a = c[i]
      const b = c[(i + 1) % 4]
      out?.push(a[0], a[1], a[2], b[0], b[1], b[2])
      this.extendEdge(a, b, grid, k, ext, extC)
    }
  }

  /**
   * 图框：内外两道框线、角标、刻度尺、竖向投影线与后方的标题立牌。
   * 盒子（图框、地图台座、顶上的投影框）的每条边都沿自身方向向两端无限延伸，渐隐成作图辅助线
   */
  private buildFrame() {
    disposeGroup(this.frameGroup)
    const p = this.pal
    const grid = linear(p.grid)
    const hx = SX / 2 + MARGIN
    const hz = this.SZ / 2 + MARGIN
    const y = 0.01
    // 盒子（图框、地图台座、顶上的投影框）的每条边都向两端延伸
    const ext: number[] = []
    const extC: number[] = []
    const bright: number[] = []
    this.rect(hx, hz, y, 1.3, bright, ext, extC)
    const dim: number[] = []
    this.rect(SX / 2, this.SZ / 2, y, 0.55, dim, ext, extC)
    this.rect(hx + 1.4, hz + 1.4, y, 0.55, dim, ext, extC)
    this.rect(SX / 2, this.SZ / 2, -0.29, 0.45, null, ext, extC)
    // 刻度：每 2 单位一短刻，每 10 单位一长刻
    for (let x = -Math.floor(hx / 2) * 2; x <= hx; x += 2) {
      const L = x % 10 === 0 ? 1.0 : 0.45
      bright.push(x, y, -hz, x, y, -hz - L, x, y, hz, x, y, hz + L)
    }
    for (let z = -Math.floor(hz / 2) * 2; z <= hz; z += 2) {
      const L = z % 10 === 0 ? 1.0 : 0.45
      bright.push(-hx, y, z, -hx - L, y, z, hx, y, z, hx + L, y, z)
    }
    // 角标
    const corner: number[] = []
    const c = 4
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const x = sx * (hx + 1.4)
        const z = sz * (hz + 1.4)
        corner.push(x, y, z, x - sx * c, y, z, x, y, z, x, y, z - sz * c)
      }
    // 竖向投影线：四角向上张开，顶上一道大框
    const proj: number[] = []
    const Y = 55
    const k = 1.35
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) proj.push(sx * hx, y, sz * hz, sx * hx * k, Y, sz * hz * k)
    proj.push(-hx * 0.5, y, -hz, -hx * 0.5 * k, Y, -hz * k, hx * 0.5, y, -hz, hx * 0.5 * k, Y, -hz * k)
    this.rect(hx * k, hz * k, Y, 0.35, proj, ext, extC)
    // 台座的四条竖棱与投影线也向两端延伸
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        this.extendEdge([(sx * SX) / 2, -0.29, (sz * this.SZ) / 2], [(sx * SX) / 2, y, (sz * this.SZ) / 2], grid, 0.45, ext, extC)
        this.extendEdge([sx * hx, y, sz * hz], [sx * hx * k, Y, sz * hz * k], grid, 0.35, ext, extC)
      }

    // 中线（虚线效果用短线段串）
    const mid: number[] = []
    for (let x = -hx; x < hx; x += 1.2) mid.push(x, y, 0, Math.min(hx, x + 0.5), y, 0)
    for (let z = -hz; z < hz; z += 1.2) mid.push(0, y, z, 0, y, Math.min(hz, z + 0.5))

    this.frameGroup.add(
      segments(bright, this.lineMat(grid.clone().multiplyScalar(1.3), 1.4)),
      segments(dim, this.lineMat(grid.clone().multiplyScalar(0.55), 1)),
      segments(corner, this.lineMat(linear(p.text).multiplyScalar(1.6), 2.2)),
      segments(proj, this.lineMat(grid.clone().multiplyScalar(0.35), 1)),
      segments(mid, this.lineMat(grid.clone().multiplyScalar(0.3), 1, 1, false)),
      segments(ext, this.lineMat(null, 1), extC),
    )
    this.header = null
    if (this.world) {
      this.buildHeader()
      this.rulerLabels(hx, hz)
    }
  }

  /**
   * 线框盒：四角竖棱，顶上浮一面与台面平行的线框面；西面与北面（默认视角下在地图后方，不挡视线）是立面。
   * 立面：每公里一道的高程线、每 5 个单位一道的竖格线，以及地形的侧视轮廓
   * （西面取每一行的最高海拔，北面取每一列的最高海拔，相当于把整块地形投影到侧壁上）。
   * 顶面：外框与每 10 个单位一道的网格，交点处镂空、正中一个小十字。
   * 立面用自己的竖向比例（最高处为 sectionHeight，可调），不跟台面的垂直夸张走；所有外框边向两端无限延伸
   */
  private buildSection() {
    disposeGroup(this.sectionGroup)
    const f = this.f
    if (!f) return
    // 侧视轮廓：每行、每列的最高海拔（随世界算好）
    const { rowMax, colMax, peak } = f
    const p = this.pal
    const grid = linear(p.grid)
    const land = linear(p.land).multiplyScalar(p.glow)
    const X0 = SX / 2 + MARGIN + 1.4
    const Z0 = this.SZ / 2 + MARGIN + 1.4
    const top = this.sectionTop()
    const kmMax = Math.max(2, Math.ceil(peak))
    const kmH = this.opts.sectionHeight / kmMax
    const frame: number[] = []
    const levels: number[] = []
    const outline: number[] = []
    const ext: number[] = []
    const extC: number[] = []
    const edge = (a: number[], b: number[], k: number) => {
      frame.push(a[0], a[1], a[2], b[0], b[1], b[2])
      this.extendEdge(a, b, grid, k, ext, extC)
    }
    // 盒子四角的竖棱（上下边与台面外框、顶面外框共用）
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) edge([sx * X0, 0, sz * Z0], [sx * X0, top, sz * Z0], 0.4)
    type Side = { pt: (u: number, y: number) => number[]; len: number; prof: Float32Array; toU: (i: number) => number }
    const sides: Side[] = [
      { pt: (u, y) => [-X0, y, u], len: Z0, prof: rowMax, toU: (i) => this.toZ(i) },
      { pt: (u, y) => [u, y, -Z0], len: X0, prof: colMax, toU: (i) => this.toX(i) },
    ]
    for (const { pt, len, prof, toU } of sides) {
      // 高度为 0 时立面压平，高程线都叠在台面上，不画
      if (kmH > 0) for (let km = 1; km <= kmMax; km++) levels.push(...pt(-len, km * kmH), ...pt(len, km * kmH))
      for (let u = Math.ceil(-len / 5) * 5; u < len; u += 5) levels.push(...pt(u, 0), ...pt(u, top))
      for (let i = 0; i + 1 < prof.length; i++) outline.push(...pt(toU(i), prof[i] * kmH + 0.02), ...pt(toU(i + 1), prof[i + 1] * kmH + 0.02))
    }
    // 顶面：外框四边
    this.rect(X0, Z0, top, 0.4, frame, ext, extC)
    // 顶面网格：每 10 个单位，交点处镂空（空当半宽 GAP），正中小十字（臂长 ARM）
    const GAP = 1.1
    const ARM = 0.5
    const xs: number[] = []
    const zs: number[] = []
    for (let x = Math.ceil(-X0 / 10) * 10; x < X0; x += 10) xs.push(x)
    for (let z = Math.ceil(-Z0 / 10) * 10; z < Z0; z += 10) zs.push(z)
    const roof: number[] = []
    const run = (cuts: number[], lo: number, hi: number, put: (a: number, b: number) => void) => {
      let a = lo
      for (const t of cuts) {
        if (t - GAP > a) put(a, t - GAP)
        a = t + GAP
      }
      if (hi > a) put(a, hi)
    }
    for (const x of xs) run(zs, -Z0, Z0, (a, b) => roof.push(x, top, a, x, top, b))
    for (const z of zs) run(xs, -X0, X0, (a, b) => roof.push(a, top, z, b, top, z))
    for (const x of xs) for (const z of zs) roof.push(x - ARM, top, z, x + ARM, top, z, x, top, z - ARM, x, top, z + ARM)
    this.sectionGroup.add(
      segments(frame, this.lineMat(grid.clone().multiplyScalar(0.6), 1)),
      segments(levels, this.lineMat(grid.clone().multiplyScalar(0.18), 1)),
      segments(roof, this.lineMat(grid.clone().multiplyScalar(0.3), 1)),
      segments(outline, this.lineMat(land.clone().multiplyScalar(0.9), 1.3)),
      segments(ext, this.lineMat(null, 1), extC),
    )
    // 高程读数：立在西面立面的北端外侧，正反两面可见；立面矮时隔几公里标一个，免得叠在一起
    const every = kmH > 0 ? Math.ceil(0.5 / kmH) : Infinity
    for (let km = 0; km <= kmMax; km += every) {
      const { tex, aspect, glyphH } = textTexture(`${km} KM`, 'city', p.grid)
      const h = 0.38 / glyphH
      const m = new THREE.Mesh(new THREE.PlaneGeometry(h * aspect, h).translate((-h * aspect) / 2, 0, 0), textMaterial(tex, 0.7, { side: THREE.DoubleSide }))
      m.rotation.y = Math.PI / 2
      m.position.set(-X0, km === 0 ? 0.25 : km * kmH, -Z0 - 0.4)
      this.sectionGroup.add(m)
    }
  }

  /**
   * 一条边向两端的延长线：从端点起先较亮的一段，再淡出到很远处（顶点色线性插值成渐隐）。
   * 边本身不画（由各自的框线画），只写延长部分
   */
  private extendEdge(a: number[], b: number[], color: THREE.Color, k: number, out: number[], outC: number[]) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const L = Math.hypot(d[0], d[1], d[2]) || 1
    const u = d.map((v) => v / L)
    const NEAR = 30
    const FAR = 1500
    const seg = (p: number[], s: number, d0: number, d1: number, k0: number, k1: number) => {
      out.push(p[0] + u[0] * s * d0, p[1] + u[1] * s * d0, p[2] + u[2] * s * d0, p[0] + u[0] * s * d1, p[1] + u[1] * s * d1, p[2] + u[2] * s * d1)
      outC.push(color.r * k0, color.g * k0, color.b * k0, color.r * k1, color.g * k1, color.b * k1)
    }
    for (const [p, s] of [[b, 1], [a, -1]] as [number[], number][]) {
      seg(p, s, 0, NEAR, k * 0.7, k * 0.3)
      seg(p, s, NEAR, FAR, k * 0.3, 0)
    }
  }

  /** 刻度尺上的经纬度读数：每道长刻一个，平放在台面上 */
  private rulerLabels(hx: number, hz: number) {
    const w = this.world!
    const color = this.pal.grid
    const put = (text: string, x: number, z: number) => {
      const { mesh } = flatLabel(text, 'city', color, 0.34)
      mesh.position.set(x, 0.02, z)
      this.frameGroup.add(mesh)
    }
    for (let x = -Math.floor(hx / 10) * 10; x <= hx; x += 10) {
      const { lon } = this.latLon((x / SX + 0.5) * (w.W - 1), 0)
      const t = fmtDeg(lon, 0, 'E', 'W')
      put(t, x, hz + 1.9)
      put(t, x, -hz - 1.9)
    }
    for (let z = -Math.floor(hz / 10) * 10; z <= hz; z += 10) {
      const { lat } = this.latLon(0, (z / this.SZ + 0.5) * (w.H - 1))
      const t = fmtDeg(lat, 0, 'N', 'S')
      put(t, -hx - 2.4, z)
      put(t, hx + 2.4, z)
    }
  }

  /** 地图后缘竖起的立牌：只有文字（标题、世界名，右侧比例与种子），没有底板。换地名时单独重建 */
  private buildHeader() {
    if (this.header) {
      disposeGroup(this.header)
      this.frameGroup.remove(this.header)
    }
    const w = this.world!
    const p = this.pal
    const CW = 2400
    const CH = 150
    const cv = document.createElement('canvas')
    cv.width = CW
    cv.height = CH
    const g = cv.getContext('2d')!
    g.textBaseline = 'alphabetic'
    g.fillStyle = p.text
    g.font = `700 54px "Archivo", sans-serif`
    g.fontStretch = 'expanded'
    g.fillText('WORLD MAP', 40, 78)
    g.fontStretch = 'normal'
    g.globalAlpha = 0.7
    const name = worldTitle(w)
    g.font = `600 24px "Archivo", ${lang === 'en' ? 'sans-serif' : cjkFont(lang, true)}`
    g.letterSpacing = '4px'
    g.fillText(lang === 'en' ? name.toUpperCase() : name, 42, 116)
    g.letterSpacing = '0px'
    // 右侧两项读数，右对齐
    const label = (x: number, k: string, v: string) => {
      g.textAlign = 'right'
      g.globalAlpha = 0.6
      g.font = `400 20px "Berkeley Mono", monospace`
      g.fillText(k, x, 52)
      g.globalAlpha = 1
      g.font = `400 34px "Berkeley Mono", monospace`
      g.fillText(v, x, 96)
      g.textAlign = 'left'
    }
    label(CW - 40, 'SEED', w.params.seed.toUpperCase())
    label(CW - 420, 'SCALE', `${Math.round(w.W * w.kmPerCell).toLocaleString('en-US')} KM`)
    g.globalAlpha = 1
    const width = SX + MARGIN * 2
    this.header = new THREE.Mesh(new THREE.PlaneGeometry(width, (width * CH) / CW), textMaterial(canvasTexture(cv), 0.75, { side: THREE.DoubleSide }))
    this.frameGroup.add(this.header)
    this.placeHeader()
  }
  /** 立牌浮在线框盒北面立面的上方 */
  private placeHeader() {
    const m = this.header
    if (!m) return
    const height = (m.geometry as THREE.PlaneGeometry).parameters.height
    m.position.set(0, this.sectionTop() + height / 2 + 0.6, -(this.SZ / 2 + MARGIN) - 1.4)
  }

  /**
   * 海岸双线。位置只随世界与垂直夸张重建；每个顶点记下所属陆块，
   * 锁定陆块时只重算颜色（recolorLines），不重建几何
   */
  private buildLines() {
    disposeGroup(this.lineGroup)
    this.coastLines = null
    const f = this.f
    if (!f) return
    const { W, H } = f
    const massOf = (cx: number, cy: number) => {
      const x = Math.min(W - 1, Math.max(0, Math.round(cx)))
      const y = Math.min(H - 1, Math.max(0, Math.round(cy)))
      return f.near[y * W + x]
    }
    let nSeg = 0
    for (const ring of f.coast) if (ring.length >= 6) nSeg += ring.length / 2
    const outerP = new Float32Array(nSeg * 6)
    const innerP = new Float32Array(nSeg * 6)
    /** 每段两个端点各自所属的陆块（取内线上的点，落在陆地一侧） */
    const segMass = new Int32Array(nSeg * 2)
    const coastY = LIFT + 0.03
    let k = 0
    for (const ring of f.coast) {
      const n = ring.length / 2
      if (n < 3) continue
      // 内线：沿法线往陆地一侧偏 0.9 格
      const ix = new Float32Array(n)
      const iy = new Float32Array(n)
      const im = new Int32Array(n)
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n
        const b = (i + 1) % n
        let nx = -(ring[b * 2 + 1] - ring[a * 2 + 1])
        let ny = ring[b * 2] - ring[a * 2]
        const L = Math.hypot(nx, ny) || 1
        nx /= L
        ny /= L
        const x = ring[i * 2]
        const y = ring[i * 2 + 1]
        const sgn = this.groundAt(x + nx, y + ny) > this.groundAt(x - nx, y - ny) ? 0.9 : -0.9
        ix[i] = x + nx * sgn
        iy[i] = y + ny * sgn
        im[i] = massOf(ix[i], iy[i])
      }
      for (let i = 0; i < n; i++, k++) {
        const j = (i + 1) % n
        const o = k * 6
        outerP[o] = this.toX(ring[i * 2])
        outerP[o + 1] = coastY
        outerP[o + 2] = this.toZ(ring[i * 2 + 1])
        outerP[o + 3] = this.toX(ring[j * 2])
        outerP[o + 4] = coastY
        outerP[o + 5] = this.toZ(ring[j * 2 + 1])
        innerP[o] = this.toX(ix[i])
        innerP[o + 1] = this.heightAt(ix[i], iy[i]) + 0.04
        innerP[o + 2] = this.toZ(iy[i])
        innerP[o + 3] = this.toX(ix[j])
        innerP[o + 4] = this.heightAt(ix[j], iy[j]) + 0.04
        innerP[o + 5] = this.toZ(iy[j])
        segMass[k * 2] = im[i]
        segMass[k * 2 + 1] = im[j]
      }
    }
    const inner = segments(innerP, this.lineMat(null, 1, 0.8))
    const outer = segments(outerP, this.lineMat(null, 1.4))
    this.lineGroup.add(inner, outer)
    this.coastLines = { inner, outer, segMass }
    this.recolorLines()
  }

  /** 按锁定的陆块给海岸线上色 */
  private recolorLines() {
    const c = this.coastLines
    if (!c) return
    const p = this.pal
    const land = linear(p.land).multiplyScalar(p.glow)
    const acc = linear(p.accent)
    const sel = this.selected
    // 第一次建颜色缓冲，之后原地改写再标记上传
    const paint = (line: LineSegments2, k: number, kHot: number) => {
      const geo = line.geometry as LineSegmentsGeometry
      const attr = geo.attributes.instanceColorStart as THREE.InterleavedBufferAttribute | undefined
      const mass = c.segMass
      const out = attr ? (attr.data.array as Float32Array) : new Float32Array(mass.length * 3)
      for (let i = 0; i < mass.length; i++) {
        const hot = sel >= 0 && mass[i] === sel
        const col = hot ? acc : land
        const g = hot ? kHot : k
        out[i * 3] = col.r * g
        out[i * 3 + 1] = col.g * g
        out[i * 3 + 2] = col.b * g
      }
      if (attr) attr.data.needsUpdate = true
      else geo.setColors(out)
    }
    paint(c.outer, 0.6, 0.85)
    paint(c.inner, 0.25, 0.4)
    this.dirty = true
  }

  /** 平铺在台面上的地名：大陆与岛屿、海洋、城市；按优先级贪心避让 */
  private buildLabels() {
    const job = ++this.labelJob
    const run = () => {
      if (job !== this.labelJob || !this.world) return
      this.clearLabels()
      const w = this.world
      const cs = SX / (w.W - 1)
      const p = this.pal
      type Cand = { text: string; style: LabelStyle; cx: number; cy: number; size: number; color: string; dot?: boolean }
      const cands: Cand[] = []
      const lands = w.labels.filter((l) => l.kind === 'continent' || l.kind === 'island').sort((a, b) => b.weight - a.weight)
      for (const l of lands.slice(0, 24)) {
        const size = Math.min(2.2, Math.max(0.5, l.span * cs * (l.kind === 'continent' ? 0.07 : 0.1)))
        cands.push({ text: placeName(l), style: l.kind === 'continent' ? 'continent' : 'land', cx: l.x, cy: l.y, size, color: p.text })
      }
      const seas = w.labels.filter((l) => l.kind === 'ocean' || l.kind === 'sea').sort((a, b) => b.weight - a.weight)
      for (const l of seas.slice(0, 10))
        cands.push({ text: placeName(l), style: 'sea', cx: l.x, cy: l.y, size: l.kind === 'ocean' ? 1.1 : 0.7, color: p.grid })
      const annotated = new Set(this.annotatedCities())
      const cities = w.labels.filter((l) => (l.kind === 'capital' || l.kind === 'city') && !annotated.has(l)).sort((a, b) => b.weight - a.weight)
      for (const l of cities.slice(0, 32))
        cands.push({ text: placeName(l), style: l.kind === 'capital' ? 'capital' : 'city', cx: l.x, cy: l.y, size: l.kind === 'capital' ? 0.5 : 0.38, color: p.text, dot: true })
      const taken: [number, number, number, number][] = []
      const hit = (b: [number, number, number, number]) => taken.some((t) => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1])
      const cityDots: number[] = []
      for (const c of cands) {
        const { mesh, w: lw, h: lh } = flatLabel(c.text, c.style, c.color, c.size)
        let x = this.toX(c.cx)
        const z = this.toZ(c.cy)
        // 城市：字在点的右边
        if (c.dot) x += lw / 2 + 0.25
        const box: [number, number, number, number] = [x - lw / 2, z - lh * 0.35, x + lw / 2, z + lh * 0.35]
        if (hit(box)) {
          disposeGroup(mesh)
          continue
        }
        taken.push(box)
        mesh.position.set(x, 0, z)
        const dy = c.style === 'continent' ? 0.25 : 0.12
        mesh.position.y = this.heightAt(c.cx, c.cy) + dy
        this.placed.push({ obj: mesh, cx: c.cx, cy: c.cy, dy })
        this.labelGroup.add(mesh)
        if (c.dot) cityDots.push(c.cx, c.cy)
      }
      // 城市位置：平放的小十字（各自一个对象、共用材质，垂直夸张变化时随地名一起改高度）
      const r = 0.22
      const cross = [-r, 0, 0, r, 0, 0, 0, 0, -r, 0, 0, r]
      const mark = this.lineMat(linear(p.text).multiplyScalar(0.9), 1.2)
      for (let i = 0; i < cityDots.length; i += 2) {
        const m = segments(cross, mark)
        m.position.set(this.toX(cityDots[i]), 0, this.toZ(cityDots[i + 1]))
        m.position.y = this.heightAt(cityDots[i], cityDots[i + 1]) + 0.08
        this.placed.push({ obj: m, cx: cityDots[i], cy: cityDots[i + 1], dy: 0.08 })
        this.labelGroup.add(m)
      }
      this.labelGroup.visible = this.opts.labels
      this.dirty = true
    }
    // 等界面字体（Archivo 加宽）到位再画，否则贴图里是回退字体
    void Promise.all([document.fonts.load('600 64px "Archivo"'), document.fonts.load('500 20px "Berkeley Mono"')]).then(run, run)
  }
  private clearLabels() {
    disposeGroup(this.labelGroup)
    this.placed = []
  }

  /** 引线标注的城市：重要度最高的几座 */
  private annotatedCities() {
    const w = this.world
    if (!w) return []
    return w.labels
      .filter((l) => l.kind === 'capital' || l.kind === 'city')
      .sort((a, b) => b.weight - a.weight)
      .slice(0, ANNO_CITIES)
  }

  /**
   * 图纸式引线标注：城市是地面十字 + 竖直引线 + 折线 + 文字；
   * 最大几块陆块的最高峰另带一道从海平面量到峰顶的高程尺寸线
   */
  private buildAnnotations() {
    this.billboards = []
    disposeGroup(this.annoGroup)
    const w = this.world
    const f = this.f
    if (!w || !f) return
    const p = this.pal
    const leader = this.lineMat(linear(p.text).multiplyScalar(0.8), 1.2)
    const dim = this.lineMat(linear(p.grid).multiplyScalar(1.1), 1.2)
    const marks = this.lineMat(linear(p.text).multiplyScalar(0.9), 1.2)
    const ground: number[] = []
    const place = (g: THREE.Group, x: number, y: number, z: number) => {
      g.position.set(x, y, z)
      this.billboards.push(g)
      this.annoGroup.add(g)
    }
    const fmtLL = (cx: number, cy: number) => {
      const { lat, lon } = this.latLon(cx, cy)
      return `${fmtDeg(lat, 1, 'N', 'S')} ${fmtDeg(lon, 1, 'E', 'W')}`
    }
    // 引线高度错开三档，减少相邻标注的文字互相压住
    this.annotatedCities().forEach((l, i) => {
      const x = this.toX(l.x)
      const z = this.toZ(l.y)
      const y = this.heightAt(l.x, l.y) + 0.03
      groundMark(x, y, z, ground)
      const e = w.elevation[Math.round(l.y) * w.W + Math.round(l.x)]
      const sub = `${fmtLL(l.x, l.y)} · ${Math.max(0, Math.round(e * 1000))} M`
      place(annotation({ title: placeName(l), sub, lift: 4.5 + (i % 3) * 2.6 }, p.text, p.grid, leader), x, y, z)
    })
    const peaks = f.masses
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.peak > 0.6)
      .sort((a, b) => b.m.cells - a.m.cells)
      .slice(0, ANNO_PEAKS)
    for (const { m } of peaks) {
      const x = this.toX(m.peakX)
      const z = this.toZ(m.peakY)
      const top = this.heightAt(m.peakX, m.peakY)
      const range = this.nearestLabel(m.peakX, m.peakY, 'range')
      const title = `${Math.round(m.peak * 1000).toLocaleString('en-US')} M`
      const sub = `${range ? placeName(range) + ' · ' : ''}${fmtLL(m.peakX, m.peakY)}`
      place(annotation({ title, sub, lift: 3.5, dimension: top }, p.grid, p.text, dim), x, top, z)
    }
    this.annoGroup.add(segments(ground, marks))
    this.faceCamera()
  }

  /** 离格点最近的某类地名（在一定范围内） */
  private nearestLabel(cx: number, cy: number, kind: World['labels'][number]['kind']) {
    const w = this.world!
    let best: World['labels'][number] | null = null
    let bd = (w.W / 12) ** 2
    for (const l of w.labels) {
      if (l.kind !== kind) continue
      const d = (l.x - cx) ** 2 + (l.y - cy) ** 2
      if (d < bd) (bd = d), (best = l)
    }
    return best
  }

  /**
   * 引线标注绕竖轴转向镜头；文字面片再绕自身底边后仰，正对镜头（引线保持竖直）。
   * 引线与文字按镜头距离缩放：拉近时不至于占满画面，拉远时不至于小到看不清
   */
  private faceCamera() {
    const c = this.camera.position
    for (const g of this.billboards) {
      const dx = c.x - g.position.x
      const dy = c.y - g.position.y
      const dz = c.z - g.position.z
      const flat = Math.hypot(dx, dz)
      g.rotation.y = Math.atan2(dx, dz)
      const text = g.userData.text as THREE.Object3D
      text.rotation.x = -Math.atan2(dy, flat)
      const k = Math.min(1.1, Math.max(0.22, Math.hypot(flat, dy) / ANNO_DIST))
      ;(g.userData.tag as THREE.Object3D).scale.setScalar(k)
    }
  }

  // —— 每帧 ——
  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (!w || !h) return
    const pr = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h, false)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.composer.setPixelRatio(pr)
    this.composer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    for (const m of this.lineMats()) {
      m.resolution.copy(size)
      m.linewidth = (m.userData.width as number) * pr
    }
    this.dirty = true
  }

  /** 每个 rAF：处理悬停与时钟，需要时才画一帧 */
  private tick() {
    if (this.controls.update()) this.dirty = true
    // 拾取只在光标动过之后做一次
    if (this.pointerMoved && this.pointer && this.world) {
      this.pointerMoved = false
      const c = this.pick(this.pointer.x, this.pointer.y)
      if (c) {
        this.hover(this.massOfCell(c))
        const { lat, lon } = this.latLon(c.x, c.y)
        this.hud.setDestination(lat, lon)
      } else this.hover(-1)
    }
    this.hud.tick()
    if (!this.revealDone) this.dirty = true
    if (this.dirty) {
      this.dirty = false
      this.render()
    }
  }

  private render() {
    // 开场：地形从后往前铺开，线与地名随后淡入
    if (!this.revealDone) {
      const rv = Math.min(1, (this.clock.getElapsedTime() - this.revealAt) / REVEAL_S)
      this.terrain.uniforms.uReveal.value = 1 - Math.pow(1 - rv, 3)
      // 线与文字面片（不论在哪个组里）一起淡入
      const fadeIn = smoothstep(0.55, 1, rv)
      this.scene.traverse((c) => {
        const mat = (c as THREE.Mesh).material
        if (mat instanceof LineMaterial) mat.opacity = fadeIn * ((mat.userData.baseOpacity as number | undefined) ?? 1)
        else if (mat instanceof THREE.MeshBasicMaterial && mat.map) mat.opacity = fadeIn
      })
      this.annoGroup.visible = rv >= 1
      if (rv >= 1) this.revealDone = true
    }
    this.faceCamera()
    this.composer.render()
  }
}
