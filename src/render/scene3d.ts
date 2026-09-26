import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Biome, type World } from '../gen/types'
import { buildMaterialMask } from './aerial/mask'
import { createSky } from './aerial/sky'
import { createTerrainMaterial, type TerrainUniforms } from './aerial/terrainMaterial'
import { VolumetricClouds } from './aerial/volumetric'
import { createWaterMaterial } from './water'

export interface View3DOptions {
  exaggeration: number
  trees: boolean
  labels: boolean
  sunAzimuth: number
  sunElevation: number
  /** 航拍写实 / 沙盘模型 */
  look: 'aerial' | 'model'
  clouds: boolean
}

const SKY_TOP = new THREE.Color('#3b6ea8')
const HAZE = new THREE.Color('#a9c6e4')

const SX = 100

/**
 * 3D 立体沙盘：地形网格 + 水面 + 植被实例 + 侧面剖面，
 * 光照带实时阴影，太阳方位与高度可调。
 */
export class Scene3D {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  private sun: THREE.DirectionalLight
  private hemi: THREE.HemisphereLight
  private group = new THREE.Group()
  private world: World | null = null
  private terrain: THREE.Mesh | null = null
  private water: THREE.Mesh | null = null
  private waterMat: THREE.ShaderMaterial | null = null
  private trees: THREE.InstancedMesh[] = []
  private heightTex: THREE.DataTexture | null = null
  private tempTex: THREE.DataTexture | null = null
  private maskTex: THREE.DataTexture | null = null
  private terrainU: TerrainUniforms | null = null
  private clouds: VolumetricClouds | null = null
  private sky = createSky()
  private outer: THREE.Mesh | null = null
  private fog = new THREE.FogExp2(HAZE.getHex(), 0.0036)
  private clock = new THREE.Clock()
  private opts: View3DOptions
  private labelLayer: HTMLDivElement
  private labelEls: { el: HTMLDivElement; pos: THREE.Vector3; kind: string; w: number; h: number }[] = []
  private raf = 0
  private SZ = 62.5
  active = true

  constructor(private container: HTMLElement, opts: View3DOptions) {
    this.opts = { ...opts }
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.setClearColor(0x000000, 0)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 6000)
    this.camera.position.set(0, 50, 60)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.07
    this.controls.maxPolarAngle = Math.PI * 0.47
    this.controls.minDistance = 4
    this.controls.maxDistance = 260
    this.controls.screenSpacePanning = false
    this.controls.zoomToCursor = true

    this.sun = new THREE.DirectionalLight(0xfff1dc, 3.1)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(4096, 4096)
    const sc = this.sun.shadow.camera
    sc.left = -62
    sc.right = 62
    sc.top = 62
    sc.bottom = -62
    sc.near = 1
    sc.far = 400
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.04
    this.sun.shadow.radius = 3
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)
    this.hemi = new THREE.HemisphereLight(0xc4d7ea, 0x5b4a3a, 0.9)
    this.scene.add(this.hemi)
    this.scene.add(this.group)
    this.scene.add(this.sky.mesh)

    this.labelLayer = document.createElement('div')
    this.labelLayer.className = 'labels3d'
    container.appendChild(this.labelLayer)

    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()
    this.updateSun()
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      if (!this.active) return
      this.controls.update()
      if (this.waterMat) this.waterMat.uniforms.uTime.value = this.clock.getElapsedTime()
      this.renderFrame()
      this.updateLabels()
    }
    loop()
  }

  get vScale() {
    const w = this.world
    if (!w) return 0.5
    return (SX / (w.W * w.kmPerCell)) * this.opts.exaggeration
  }

  /** 航拍且开云时走体积云管线（场景 → 云 → 合成），否则直接渲染 */
  private renderFrame() {
    // 航拍：后处理管线（空气透视 + 体积云）；沙盘模型：直接渲染
    if (this.opts.look === 'aerial' && this.clouds) {
      this.clouds.march.uniforms.uEnabled.value = this.opts.clouds ? 1 : 0
      this.clouds.render(this.renderer, this.scene, this.camera, this.clock.getElapsedTime())
    } else this.renderer.render(this.scene, this.camera)
  }

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.renderer.setSize(w, h, false)
    const pr = this.renderer.getPixelRatio()
    this.clouds?.setSize(Math.round(w * pr), Math.round(h * pr))
    this.renderer.domElement.style.width = w + 'px'
    this.renderer.domElement.style.height = h + 'px'
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
  }

  setOptions(o: Partial<View3DOptions>) {
    const prev = this.opts
    this.opts = { ...this.opts, ...o }
    if (o.exaggeration !== undefined && o.exaggeration !== prev.exaggeration && this.world) this.rebuildGeometry()
    if (o.trees !== undefined) for (const t of this.trees) t.visible = this.opts.trees
    if (o.sunAzimuth !== undefined || o.sunElevation !== undefined) this.updateSun()
    if (o.labels !== undefined) this.labelLayer.style.display = this.opts.labels ? '' : 'none'
    if (o.look !== undefined || o.clouds !== undefined) this.applyLook()
  }

  /** 航拍：天空、空气透视、延伸到地平线的外海、云；沙盘：悬浮的立体模型 */
  private applyLook() {
    const aerial = this.opts.look === 'aerial'
    // 两种观感都是切出来的方块沙盘：四周是地层与海水剖面，不再延伸无尽外海
    this.sky.mesh.visible = false
    this.scene.fog = null
    if (this.outer) this.outer.visible = false
    for (const c of this.group.children) if (c.userData.skirt) c.visible = true
    const cloudsOn = this.opts.clouds && aerial && !!this.clouds
    if (this.terrainU) this.terrainU.uCloudOn.value = cloudsOn ? 1 : 0
    if (this.waterMat) {
      this.waterMat.uniforms.uCloudOn.value = cloudsOn ? 1 : 0
      this.waterMat.uniforms.uFogDensity.value = 0
    }
    this.renderer.toneMappingExposure = aerial ? 1.0 : 1.05
    this.updateSun()
  }

  private updateSun() {
    const az = (this.opts.sunAzimuth * Math.PI) / 180
    const el = (this.opts.sunElevation * Math.PI) / 180
    const d = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
    this.sun.position.copy(d).multiplyScalar(150)
    this.sun.target.position.set(0, 0, 0)
    // 低太阳角：暖色、光弱；高角度：白光
    const warm = 1 - Math.min(1, Math.max(0, (this.opts.sunElevation - 4) / 40))
    this.sun.color.setRGB(1, 0.95 - 0.2 * warm, 0.86 - 0.36 * warm)
    const k = Math.min(1, Math.max(0.15, Math.sin(el) * 2.2))
    const aerial = this.opts.look === 'aerial'
    // 航拍：天光弱、日光强，地形明暗对比更像真实照片
    this.sun.intensity = (aerial ? 3.8 : 3.2) * k
    this.hemi.intensity = (aerial ? 0.42 : 0.55) + (aerial ? 0.3 : 0.45) * k
    if (this.waterMat) {
      this.waterMat.uniforms.uSunDir.value.copy(d)
      this.waterMat.uniforms.uSunColor.value.copy(this.sun.color)
      this.waterMat.uniforms.uLight.value = 0.45 + 0.55 * k
    }
    this.sky.mat.uniforms.uSun.value.copy(d)
    this.sky.mat.uniforms.uSunColor.value.copy(this.sun.color)
    // 天空随太阳高度变暗、偏暖
    this.sky.mat.uniforms.uTop.value.copy(SKY_TOP).multiplyScalar(0.35 + 0.65 * k)
    this.sky.mat.uniforms.uHorizon.value.copy(HAZE).lerp(new THREE.Color('#f0c59a'), warm * 0.45).multiplyScalar(0.45 + 0.55 * k)
    this.fog.color.copy(this.sky.mat.uniforms.uHorizon.value)
    if (this.waterMat) {
      this.waterMat.uniforms.uFogColor.value.copy(this.fog.color)
      this.waterMat.uniforms.uSkyTop.value.copy(this.sky.mat.uniforms.uTop.value)
      this.waterMat.uniforms.uSkyHorizon.value.copy(this.sky.mat.uniforms.uHorizon.value)
    }
    if (this.terrainU) this.terrainU.uSun.value.copy(d)
    if (this.clouds) {
      const u = this.clouds.march.uniforms
      u.uSun.value.copy(d)
      u.uSunColor.value.copy(this.sun.color).multiplyScalar(0.35 + 0.65 * k)
      u.uSkyTop.value.copy(this.sky.mat.uniforms.uTop.value)
      u.uSkyHorizon.value.copy(this.sky.mat.uniforms.uHorizon.value)
      u.uFogColor.value.copy(this.fog.color)
      u.uFogDensity.value = this.fog.density
      // 空气感：霾色随天空，顺光方向有太阳散射光晕；低空薄雾高度约 0.9 km
      const c = this.clouds.comp.uniforms
      c.uSun.value.copy(d)
      c.uSunColor.value.copy(this.sun.color).multiplyScalar(0.25 + 0.35 * k)
      c.uHaze.value.copy(this.fog.color).multiplyScalar(0.9)
      c.uFogHeight.value = this.vScale * 0.9
    }
  }

  setWorld(world: World, color: HTMLCanvasElement, rough: HTMLCanvasElement) {
    this.world = world
    this.SZ = (SX * world.H) / world.W
    // 清理旧对象
    for (const c of [...this.group.children]) {
      this.group.remove(c)
      c.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
    }
    this.trees = []
    this.heightTex?.dispose()

    const { W, H } = world
    const ht = new THREE.DataTexture(world.elevation, W, H, THREE.RedFormat, THREE.FloatType)
    ht.magFilter = THREE.LinearFilter
    ht.minFilter = THREE.LinearFilter
    ht.flipY = false
    ht.needsUpdate = true
    this.heightTex = ht
    this.tempTex?.dispose()
    const tt = new THREE.DataTexture(world.temperature, W, H, THREE.RedFormat, THREE.FloatType)
    tt.magFilter = THREE.LinearFilter
    tt.minFilter = THREE.LinearFilter
    tt.needsUpdate = true
    this.tempTex = tt

    const colorTex = new THREE.CanvasTexture(color)
    colorTex.colorSpace = THREE.SRGBColorSpace
    colorTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    colorTex.flipY = false
    const roughTex = new THREE.CanvasTexture(rough)
    roughTex.flipY = false
    this.maskTex?.dispose()
    const mk = new THREE.DataTexture(buildMaterialMask(world), W, H, THREE.RGBAFormat, THREE.UnsignedByteType)
    mk.magFilter = THREE.LinearFilter
    mk.minFilter = THREE.LinearFilter
    mk.needsUpdate = true
    this.maskTex = mk
    const hSize = new THREE.Vector2(W, H)
    const { mat, uniforms, depth } = createTerrainMaterial(colorTex, roughTex, mk, ht, hSize, new THREE.Vector2(SX, this.SZ), this.vScale)
    this.terrainU = uniforms
    this.terrain = new THREE.Mesh(new THREE.BufferGeometry(), mat)
    this.terrain.customDepthMaterial = depth
    this.terrain.castShadow = true
    this.terrain.receiveShadow = true
    this.group.add(this.terrain)

    this.waterMat = createWaterMaterial(ht, tt, colorTex, this.vScale, new THREE.Vector2(SX, this.SZ), hSize)
    this.water = new THREE.Mesh(new THREE.BufferGeometry(), this.waterMat)
    this.water.renderOrder = 2
    this.group.add(this.water)
    // 地图外一直延伸到地平线的外海（四块围住地图）
    const R = 3000
    const ring = [
      [0, -(R + this.SZ / 2) / 2, R * 2, R - this.SZ / 2],
      [0, (R + this.SZ / 2) / 2, R * 2, R - this.SZ / 2],
      [-(R + SX / 2) / 2, 0, R - SX / 2, this.SZ],
      [(R + SX / 2) / 2, 0, R - SX / 2, this.SZ],
    ].map(([x, z, w, h]) => new THREE.PlaneGeometry(w, h, 1, 1).rotateX(-Math.PI / 2).translate(x, 0, z))
    const merged = mergeGeoms(ring)
    this.outer = new THREE.Mesh(merged, this.waterMat)
    this.outer.renderOrder = 2
    this.group.add(this.outer)

    this.rebuildGeometry()
    this.updateSun()
    this.applyLook()
    this.buildLabels()
  }

  private buildClouds() {
    const w = this.world!
    this.clouds?.dispose()
    let seed = 0
    for (const ch of w.params.seed) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
    // 积云：云底约 1.6 km、云顶约 4.5 km（随垂直夸张一起缩放）
    const base = this.vScale * 1.6 + 0.4
    const top = this.vScale * 4.5 + 0.9
    this.clouds = new VolumetricClouds(seed, SX, this.SZ, base, top, 0.28)
    const pr = this.renderer.getPixelRatio()
    this.clouds.setSize(Math.round(this.container.clientWidth * pr), Math.round(this.container.clientHeight * pr))
    for (const u of [this.terrainU!, this.waterMat!.uniforms as unknown as TerrainUniforms]) {
      u.uCloud.value = this.clouds.coverage
      u.uCloudRect.value.copy(this.clouds.rect)
      u.uCloudY.value = base + (top - base) * 0.25
    }
  }

  private rebuildGeometry() {
    const w = this.world!
    const vs = this.vScale
    this.terrain!.geometry.dispose()
    this.terrain!.geometry = this.terrainGeometry(w, vs)
    this.water!.geometry.dispose()
    this.water!.geometry = this.waterGeometry(w, vs)
    this.waterMat!.uniforms.uVScale.value = vs
    this.terrainU!.uVScale.value = vs
    // 侧面剖面
    for (const c of [...this.group.children]) if (c.userData.skirt) this.group.remove(c)
    this.group.add(...this.skirts(w, vs))
    for (const t of this.trees) {
      this.group.remove(t)
      t.geometry.dispose()
    }
    this.trees = this.buildTrees(w, vs)
    for (const t of this.trees) {
      t.visible = this.opts.trees
      this.group.add(t)
    }
    for (const l of this.labelEls) l.pos.y = this.heightAt(l.pos.x, l.pos.z) + 0.6
    this.buildClouds()
    this.applyLook()
    this.updateSun()
  }

  /** 世界坐标 → 格坐标 */
  private toCell(x: number, z: number) {
    const w = this.world!
    return { gx: (x / SX + 0.5) * (w.W - 1), gy: (z / this.SZ + 0.5) * (w.H - 1) }
  }

  heightAt(x: number, z: number): number {
    const w = this.world!
    const { gx, gy } = this.toCell(x, z)
    const x0 = Math.max(0, Math.min(w.W - 2, Math.floor(gx)))
    const y0 = Math.max(0, Math.min(w.H - 2, Math.floor(gy)))
    const fx = Math.min(1, Math.max(0, gx - x0))
    const fy = Math.min(1, Math.max(0, gy - y0))
    const e = w.elevation
    const i = y0 * w.W + x0
    const h = (e[i] * (1 - fx) + e[i + 1] * fx) * (1 - fy) + (e[i + w.W] * (1 - fx) + e[i + w.W + 1] * fx) * fy
    return h * this.vScale
  }

  /**
   * 地形网格：比高度图更密（约 2 倍），高度与法线都在顶点着色器里由
   * 双三次插值 + 亚网格细节求得，这里只给平面坐标和贴图坐标。
   */
  private terrainGeometry(w: World, _vs: number) {
    const { W, H } = w
    const d = Math.min(2, Math.sqrt(3.2e6 / (W * H)))
    const GW = Math.round((W - 1) * d) + 1
    const GH = Math.round((H - 1) * d) + 1
    const pos = new Float32Array(GW * GH * 3)
    const uv = new Float32Array(GW * GH * 2)
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const i = y * GW + x
        const fx = x / (GW - 1)
        const fy = y / (GH - 1)
        pos[i * 3] = (fx - 0.5) * SX
        pos[i * 3 + 2] = (fy - 0.5) * this.SZ
        // 与高度图纹素中心对齐
        uv[i * 2] = (fx * (W - 1) + 0.5) / W
        uv[i * 2 + 1] = (fy * (H - 1) + 0.5) / H
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    // 占位法线（真正的法线在顶点着色器里求）：没有 normal 属性时 three 会退化为平面着色
    const nor = new Int8Array(GW * GH * 3)
    for (let i = 0; i < GW * GH; i++) nor[i * 3 + 1] = 127
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true))
    g.setIndex(gridIndex(GW, GH))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Math.hypot(SX, this.SZ))
    return g
  }

  /** 水面网格：海洋为 0，湖泊为湖面；陆地深埋地下（片元着色器按水深丢弃） */
  private waterGeometry(w: World, vs: number) {
    const step = 2
    const { W, H, water } = w
    const GW = Math.ceil((W - 1) / step) + 1
    const GH = Math.ceil((H - 1) / step) + 1
    const pos = new Float32Array(GW * GH * 3)
    const uv = new Float32Array(GW * GH * 2)
    const dx = SX / (W - 1)
    const dz = this.SZ / (H - 1)
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const cx = Math.min(W - 1, gx * step)
        const cy = Math.min(H - 1, gy * step)
        let lv = -Infinity
        for (let oy = -2; oy <= 2; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            const x = cx + ox, y = cy + oy
            if (x < 0 || y < 0 || x >= W || y >= H) continue
            const v = water[y * W + x]
            if (!Number.isNaN(v) && v > lv) lv = v
          }
        }
        const k = gy * GW + gx
        pos[k * 3] = cx * dx - SX / 2
        pos[k * 3 + 1] = lv === -Infinity ? -40 : lv * vs
        pos[k * 3 + 2] = cy * dz - this.SZ / 2
        uv[k * 2] = cx / (W - 1)
        uv[k * 2 + 1] = cy / (H - 1)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(gridIndex(GW, GH))
    g.computeBoundingSphere()
    return g
  }

  /** 沙盘四周的剖面：岩层 + 海水截面 */
  private skirts(w: World, vs: number): THREE.Object3D[] {
    const { W, H, elevation: e } = w
    const base = -4.8 * vs - 1.2
    const rockPos: number[] = []
    const rockCol: number[] = []
    const seaPos: number[] = []
    const seaCol: number[] = []
    const edges: [number, number][][] = [
      Array.from({ length: W }, (_, x) => [x, 0]),
      Array.from({ length: W }, (_, x) => [W - 1 - x, H - 1]),
      Array.from({ length: H }, (_, y) => [0, H - 1 - y]),
      Array.from({ length: H }, (_, y) => [W - 1, y]),
    ]
    const dx = SX / (W - 1)
    const dz = this.SZ / (H - 1)
    const top = new THREE.Color('#5a4a3c')
    const bot = new THREE.Color('#1f1b19')
    const seaTop = new THREE.Color('#2f7f93')
    const seaBot = new THREE.Color('#0b2a44')
    for (const edge of edges) {
      for (let k = 0; k < edge.length - 1; k++) {
        const [x0, y0] = edge[k]
        const [x1, y1] = edge[k + 1]
        const X0 = x0 * dx - SX / 2, Z0 = y0 * dz - this.SZ / 2
        const X1 = x1 * dx - SX / 2, Z1 = y1 * dz - this.SZ / 2
        const h0 = e[y0 * W + x0] * vs
        const h1 = e[y1 * W + x1] * vs
        quad(rockPos, rockCol, [X0, h0, Z0], [X1, h1, Z1], [X1, base, Z1], [X0, base, Z0], top, top, bot, bot)
        if (h0 < 0 || h1 < 0) {
          quad(seaPos, seaCol, [X0, 0, Z0], [X1, 0, Z1], [X1, Math.min(h1, 0), Z1], [X0, Math.min(h0, 0), Z0], seaTop, seaTop, seaBot, seaBot)
        }
      }
    }
    const mk = (p: number[], c: number[], mat: THREE.Material) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
      g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3))
      g.computeVertexNormals()
      const m = new THREE.Mesh(g, mat)
      m.userData.skirt = true
      return m
    }
    const rock = mk(rockPos, rockCol, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }))
    const sea = mk(
      seaPos,
      seaCol,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false }),
    )
    sea.renderOrder = 3
    // 底板
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(SX, this.SZ).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#1a1716', roughness: 1, side: THREE.DoubleSide }),
    )
    plate.position.y = base
    plate.userData.skirt = true
    return [rock, sea, plate]
  }

  /** 植被：森林群系里撒针叶树与阔叶树实例 */
  private buildTrees(w: World, vs: number): THREE.InstancedMesh[] {
    const { W, H, biome, elevation: e } = w
    const density: Record<number, [number, number]> = {
      // [针叶概率, 每格密度]
      [Biome.Taiga]: [1, 0.9],
      [Biome.TemperateForest]: [0.25, 0.85],
      [Biome.TemperateRainforest]: [0.7, 1.2],
      [Biome.TropicalSeasonalForest]: [0, 0.8],
      [Biome.TropicalRainforest]: [0, 1.3],
      [Biome.Wetland]: [0.2, 0.12],
    }
    const colors: Record<number, THREE.Color[]> = {
      [Biome.Taiga]: ['#2b4632', '#324f3a', '#26402f'].map((c) => new THREE.Color(c)),
      [Biome.TemperateForest]: ['#4f6e33', '#5d7a3a', '#6b7f3b', '#3f5f30'].map((c) => new THREE.Color(c)),
      [Biome.TemperateRainforest]: ['#2a4d33', '#315a3a', '#24452d'].map((c) => new THREE.Color(c)),
      [Biome.TropicalSeasonalForest]: ['#56782e', '#648432', '#4a6c2a'].map((c) => new THREE.Color(c)),
      [Biome.TropicalRainforest]: ['#2b5a26', '#336529', '#244f22'].map((c) => new THREE.Color(c)),
    }
    const fallback = ['#5d6b3a', '#4f5f35'].map((c) => new THREE.Color(c))
    const conif: { m: THREE.Matrix4; c: THREE.Color }[] = []
    const broad: { m: THREE.Matrix4; c: THREE.Color }[] = []
    let seed = 1234567
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    const cell = SX / (W - 1)
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const p = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    const limit = 110000
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        const d = density[biome[i]]
        if (!d || e[i] <= 0) continue
        // 陡坡与高海拔少树
        const sl = Math.hypot(e[i + 1] - e[i - 1], e[i + W] - e[i - W]) / (2 * w.kmPerCell)
        let dens = d[1] * (1 - Math.min(1, sl * 3)) * (e[i] > 2.4 ? 0.3 : 1)
        while (dens > 0) {
          if (rnd() > dens) break
          dens -= 1
          const px = (x + rnd() - 0.5) * cell - SX / 2
          const pz = (y + rnd() - 0.5) * (this.SZ / (H - 1)) - this.SZ / 2
          const hy = this.heightAt(px, pz)
          if (hy <= 0.01 * vs) continue
          const isC = rnd() < d[0]
          const sz = cell * (0.55 + rnd() * 0.5)
          p.set(px, hy, pz)
          q.setFromAxisAngle(up, rnd() * Math.PI * 2)
          if (isC) s.set(sz * 0.5, sz * (1.3 + rnd() * 0.5), sz * 0.5)
          else s.set(sz * 0.62, sz * (0.62 + rnd() * 0.2), sz * 0.62)
          const pal = colors[biome[i]] ?? fallback
          const c = pal[Math.floor(rnd() * pal.length)].clone().multiplyScalar(1.0 + rnd() * 0.35)
          ;(isC ? conif : broad).push({ m: new THREE.Matrix4().compose(p, q, s), c })
        }
      }
    }
    const out: THREE.InstancedMesh[] = []
    const cone = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0)
    const blob = new THREE.IcosahedronGeometry(1, 1).translate(0, 0.9, 0)
    for (const [list, geo] of [
      [conif, cone],
      [broad, blob],
    ] as const) {
      const n = Math.min(limit, list.length)
      if (!n) continue
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true })
      const im = new THREE.InstancedMesh(geo, mat, n)
      for (let k = 0; k < n; k++) {
        im.setMatrixAt(k, list[k].m)
        im.setColorAt(k, list[k].c)
      }
      im.castShadow = true
      im.receiveShadow = true
      im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
      out.push(im)
    }
    return out
  }

  private buildLabels() {
    const w = this.world!
    this.labelLayer.innerHTML = ''
    this.labelEls = []
    const kinds = new Set(['continent', 'island', 'ocean', 'sea', 'range', 'city', 'capital', 'lake'])
    const sorted = [...w.labels].filter((l) => kinds.has(l.kind)).sort((a, b) => b.weight - a.weight)
    for (const l of sorted.slice(0, 60)) {
      if (l.kind === 'island' && l.weight < 800) continue
      const el = document.createElement('div')
      el.className = `l3 l3-${l.kind}`
      el.textContent = l.name
      const x = (l.x / (w.W - 1) - 0.5) * SX
      const z = (l.y / (w.H - 1) - 0.5) * this.SZ
      const water = l.kind === 'ocean' || l.kind === 'sea'
      const pos = new THREE.Vector3(x, water ? 0.3 : this.heightAt(x, z) + 0.6, z)
      this.labelLayer.appendChild(el)
      this.labelEls.push({ el, pos, kind: l.kind, w: 0, h: 0 })
    }
    for (const l of this.labelEls) {
      l.w = l.el.offsetWidth
      l.h = l.el.offsetHeight
    }
    this.labelLayer.style.display = this.opts.labels ? '' : 'none'
  }

  private tmp = new THREE.Vector3()
  private updateLabels() {
    if (!this.opts.labels || !this.labelEls.length) return
    const wpx = this.container.clientWidth
    const hpx = this.container.clientHeight
    const dist = this.camera.position.distanceTo(this.controls.target)
    const boxes: number[][] = []
    for (const l of this.labelEls) {
      this.tmp.copy(l.pos).project(this.camera)
      const vis = this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.1 && Math.abs(this.tmp.y) < 1.1
      // 按缩放层级显隐：远看只显示大地名，近看显示城市
      const minor = l.kind === 'city' || l.kind === 'lake' || l.kind === 'island'
      const show = vis && (!minor || dist < 70) && !(l.kind === 'continent' && dist < 18)
      l.el.style.opacity = show ? '1' : '0'
      if (!show) continue
      const x = (this.tmp.x * 0.5 + 0.5) * wpx
      const y = (-this.tmp.y * 0.5 + 0.5) * hpx
      // 与更重要的地名重叠则隐藏
      const b = [x - l.w / 2 - 4, y - l.h - 2, x + l.w / 2 + 4, y + 2]
      if (boxes.some((q) => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1])) {
        l.el.style.opacity = '0'
        continue
      }
      boxes.push(b)
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`
    }
  }

  /** 屏幕坐标 → 格坐标（沿视线在高度场上步进求交） */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!this.world) return null
    const r = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const o = ray.ray.origin
    const d = ray.ray.direction
    if (d.y >= 0) return null
    const top = 8 * this.vScale
    let t = Math.max(0, (top - o.y) / d.y)
    const step = 0.08
    for (let k = 0; k < 4000; k++) {
      const x = o.x + d.x * t
      const y = o.y + d.y * t
      const z = o.z + d.z * t
      if (Math.abs(x) > SX / 2 || Math.abs(z) > this.SZ / 2) {
        if (y < -10) return null
        t += step
        continue
      }
      const h = Math.max(0, this.heightAt(x, z))
      if (y <= h) {
        const { gx, gy } = this.toCell(x, z)
        return { x: Math.round(gx), y: Math.round(gy) }
      }
      t += step
    }
    return null
  }

  resetCamera() {
    this.camera.position.set(0, 50, 60)
    this.controls.target.set(0, 0, 0)
  }

  snapshot(): string {
    this.renderFrame()
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.renderer.dispose()
  }
}

function gridIndex(W: number, H: number) {
  const idx = new Uint32Array((W - 1) * (H - 1) * 6)
  let k = 0
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = y * W + x
      const b = a + 1
      const c = a + W
      const d = c + 1
      idx[k++] = a
      idx[k++] = c
      idx[k++] = b
      idx[k++] = b
      idx[k++] = c
      idx[k++] = d
    }
  }
  return new THREE.BufferAttribute(idx, 1)
}

function quad(
  pos: number[],
  col: number[],
  a: number[],
  b: number[],
  c: number[],
  d: number[],
  ca: THREE.Color,
  cb: THREE.Color,
  cc: THREE.Color,
  cd: THREE.Color,
) {
  pos.push(...a, ...b, ...c, ...a, ...c, ...d)
  for (const x of [ca, cb, cc, ca, cc, cd]) col.push(x.r, x.g, x.b)
}

function mergeGeoms(list: THREE.BufferGeometry[]) {
  const pos: number[] = []
  const idx: number[] = []
  for (const g of list) {
    const base = pos.length / 3
    const p = g.getAttribute('position').array
    for (let i = 0; i < p.length; i++) pos.push(p[i])
    const ix = g.getIndex()!.array
    for (let i = 0; i < ix.length; i++) idx.push(ix[i] + base)
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setIndex(idx)
  return out
}
