import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { World } from '../gen/types'
import { buildDetailMask, buildMaterialMask } from './aerial/mask'
import { createTerrainMaterial, type TerrainUniforms } from './aerial/terrainMaterial'
import { VolumetricClouds } from './aerial/volumetric'
import { PostPipeline } from './aerial/post'
import { Diorama } from './aerial/diorama'
import { TerrainBake } from './aerial/bake'
import { RoadMask } from './aerial/roads3d'
import { placeName, t, worldTitle } from '../i18n'
import { createRiverMesh, RiverCarve } from './aerial/rivers3d'
import type { SmoothRiver } from './rivers'
import { createRiverWaterMaterial, createWaterMaterial } from './water'

export interface View3DOptions {
  exaggeration: number
  labels: boolean
  sunAzimuth: number
  sunElevation: number
  /** 空气感：远景霾与低空薄雾 */
  haze: boolean
  clouds: boolean
  /** 移轴景深强度 0~1（0 关闭）：对焦在旋转中心，前后虚化出微缩模型感 */
  dof: number
  /** 展台：桌面与展厅背景（关掉时沙盘浮在页面上） */
  stage: boolean
  /** 道路与航线 */
  roads: boolean
}

const SKY_TOP = new THREE.Color('#3b6ea8')
const HAZE = new THREE.Color('#a9c6e4')
/** 云里远处的淡出（空气透视） */
const CLOUD_FOG = 0.0036

const SX = 100

/**
 * 3D 立体沙盘：地形网格 + 水面 + 河流 + 侧面剖面，
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
  private heightTex: THREE.DataTexture | null = null
  private tempTex: THREE.DataTexture | null = null
  private maskTex: THREE.DataTexture | null = null
  private mask2Tex: THREE.DataTexture | null = null
  private terrainU: TerrainUniforms | null = null
  /** 视口高清块：镜头拉近时在视口附近烘焙更细的地形并用更密的网格绘制 */
  private patch: {
    bake: TerrainBake
    mesh: THREE.Mesh
    u: TerrainUniforms
    cx: number
    cz: number
    S: number
    vs: number
  } | null = null
  private clouds: VolumetricClouds | null = null
  private post = new PostPipeline()
  private diorama: Diorama
  /** 对焦点（世界坐标）：鼠标指向的地面；为空时对焦旋转中心 */
  private focusPoint: THREE.Vector3 | null = null
  private focusDist = 0
  /** 鼠标在画布上的位置（离开画布为空）；dirty 表示需要重新取焦点 */
  private pointer: { x: number; y: number; dirty: boolean } | null = null
  private pickRay = new THREE.Raycaster()
  private pickNdc = new THREE.Vector2()
  private bake: TerrainBake | null = null
  private riverMat: THREE.ShaderMaterial | null = null
  private carve: RiverCarve | null = null
  private roadMask: RoadMask | null = null
  private riverList: SmoothRiver[] = []
  private lastInteract = 0
  private frame = 0
  /** 性能读数（按 P 开关）：帧率、GPU 耗时（EXT_disjoint_timer_query_webgl2） */
  private perf: { el: HTMLDivElement; ext: any; pending: WebGLQuery[]; gpu: number; frames: number; t0: number } | null = null
  /** 天色（随太阳高度变化），水面反射、云、空气透视共用 */
  private skyTop = new THREE.Color()
  private skyHorizon = new THREE.Color()
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
    // 后期管线有 HDR 目标 + 多重采样，高 DPI 屏上限制像素比
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio))
    // 色调映射与调色在后期管线的终合成里做
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.shadowMap.enabled = true
    // 地形是静态的：阴影只在太阳或地形变化时重绘
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.setClearColor(0x000000, 0)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 6000)
    this.camera.position.set(0, 50, 60)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.07
    this.controls.maxPolarAngle = Math.PI * 0.47
    this.controls.minDistance = 3
    this.controls.maxDistance = 260
    this.controls.screenSpacePanning = false
    this.controls.zoomToCursor = true

    this.sun = new THREE.DirectionalLight(0xfff1dc, 3.1)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(4096, 4096)
    const sc = this.sun.shadow.camera
    sc.left = -70
    sc.right = 70
    sc.top = 70
    sc.bottom = -70
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
    this.diorama = new Diorama(this.renderer)
    this.scene.add(this.diorama.group)

    this.labelLayer = document.createElement('div')
    this.labelLayer.className = 'labels3d'
    container.appendChild(this.labelLayer)

    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()
    this.updateSun()
    // 交互检测：镜头静止 1.5 秒后降到 30 fps（水波、云的缓慢变化看不出差别）
    const touch = () => (this.lastInteract = performance.now())
    // 镜头的变化由后期管线自己比对矩阵发现，这里只管降帧
    this.controls.addEventListener('change', touch)
    this.renderer.domElement.addEventListener('pointerdown', touch)
    this.renderer.domElement.addEventListener('wheel', touch, { passive: true })
    // 对焦跟随鼠标：悬停处的地面就是焦点；拖动时焦点不跟着跑，离开画布回到旋转中心
    this.renderer.domElement.addEventListener('pointermove', (e) => {
      if (e.buttons) return
      this.pointer = { x: e.clientX, y: e.clientY, dirty: true }
    })
    this.renderer.domElement.addEventListener('pointerleave', () => {
      this.pointer = null
      this.focusPoint = null
    })
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      if (!this.active) return
      this.controls.update()
      this.frame++
      if (performance.now() - this.lastInteract > 1500 && this.frame % 2) return
      const pf = this.perf
      const gl = this.renderer.getContext() as WebGL2RenderingContext
      let q: WebGLQuery | null = null
      if (pf?.ext && pf.pending.length < 3) {
        q = gl.createQuery()
        gl.beginQuery(pf.ext.TIME_ELAPSED_EXT, q!)
      }
      const t = this.clock.getElapsedTime()
      if (this.waterMat) this.waterMat.uniforms.uTime.value = t
      if (this.clouds) this.clouds.time = t
      this.diorama.time = t
      this.updatePatch()
      this.renderFrame()
      if (pf) {
        if (q) {
          gl.endQuery(pf.ext.TIME_ELAPSED_EXT)
          pf.pending.push(q)
        }
        while (pf.pending.length && gl.getQueryParameter(pf.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
          const done = pf.pending.shift()!
          const ns = gl.getQueryParameter(done, gl.QUERY_RESULT) as number
          pf.gpu = pf.gpu * 0.9 + (ns / 1e6) * 0.1
          gl.deleteQuery(done)
        }
        pf.frames++
        const now = performance.now()
        if (now - pf.t0 > 500) {
          const fps = (pf.frames * 1000) / (now - pf.t0)
          const c = this.renderer.domElement
          pf.el.textContent = `${fps.toFixed(0)} fps · GPU ${pf.ext ? pf.gpu.toFixed(1) + ' ms' : 'n/a'} · ${c.width}×${c.height}`
          pf.frames = 0
          pf.t0 = now
        }
      }
      this.updateLabels()
    }
    loop()
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'p' && e.key !== 'P') return
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      this.togglePerf()
    })
  }

  togglePerf() {
    if (this.perf) {
      this.perf.el.remove()
      this.perf = null
      return
    }
    const el = document.createElement('div')
    el.className = 'perf'
    el.textContent = '…'
    this.container.appendChild(el)
    const ext = (this.renderer.getContext() as WebGL2RenderingContext).getExtension('EXT_disjoint_timer_query_webgl2')
    this.perf = { el, ext, pending: [], gpu: 0, frames: 0, t0: performance.now() }
  }

  get vScale() {
    const w = this.world
    if (!w) return 0.5
    return (SX / (w.W * w.kmPerCell)) * this.opts.exaggeration
  }

  private viewDir = new THREE.Vector3()
  /** 场景 → 云 → 空气透视合成 → 景深 → 累积 → 泛光与调色（见 aerial/post.ts） */
  private renderFrame() {
    const cam = this.camera
    const moved = this.post.cameraChanged(cam)
    cam.getWorldDirection(this.viewDir)
    // 重新取焦点：鼠标移动后，或镜头停下后（运动中焦点跟着镜头平移，不逐帧步进高度场）
    if (this.pointer && moved) this.pointer.dirty = true
    if (this.pointer?.dirty && !moved && this.world) {
      this.focusPoint = this.pickWorld(this.pointer.x, this.pointer.y)
      this.pointer.dirty = false
    }
    const fp = this.focusPoint ?? this.controls.target
    const want = Math.max(cam.near * 4, this.tmp.copy(fp).sub(cam.position).dot(this.viewDir))
    // 换焦点时平滑追过去（像手动拉焦）；镜头在动时直接跟上，不拖泥带水
    const prevFocus = this.focusDist
    this.focusDist = prevFocus > 0 && !moved ? prevFocus + (want - prevFocus) * 0.18 : want
    const focus = this.focusDist
    // 焦点越近弥散圆越大（固定镜头拍更小的物体），拉近时微缩感更强
    const aperture = this.opts.dof * 22 * Math.min(1.8, Math.sqrt(60 / focus))
    this.post.render(this.renderer, this.scene, cam, focus, aperture, this.opts.clouds ? this.clouds : null)
  }

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.renderer.setSize(w, h, false)
    const pr = this.renderer.getPixelRatio()
    this.clouds?.setSize(Math.round(w * pr), Math.round(h * pr))
    this.post.setSize(Math.round(w * pr), Math.round(h * pr))
    this.renderer.domElement.style.width = w + 'px'
    this.renderer.domElement.style.height = h + 'px'
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
  }

  setOptions(o: Partial<View3DOptions>) {
    const prev = this.opts
    this.opts = { ...this.opts, ...o }
    if (o.exaggeration !== undefined && o.exaggeration !== prev.exaggeration && this.world) this.rebuildGeometry()
    if (o.labels !== undefined) this.labelLayer.style.display = this.opts.labels ? '' : 'none'
    // 地名是 DOM，其余选项都改变画面
    if (Object.keys(o).some((k) => k !== 'labels')) {
      this.lastInteract = performance.now()
      this.applyLook()
    }
  }

  /** 云层、空气感、展台开关与光照 */
  private applyLook() {
    this.diorama.stage.visible = this.opts.stage
    const roadsOn = this.opts.roads && !!this.roadMask ? 1 : 0
    if (this.terrainU) this.terrainU.uRoadOn.value = roadsOn
    if (this.waterMat) this.waterMat.uniforms.uRoadOn.value = roadsOn
    const cloudsOn = this.opts.clouds && !!this.clouds
    if (this.terrainU) this.terrainU.uCloudOn.value = cloudsOn ? 1 : 0
    if (this.waterMat) this.waterMat.uniforms.uCloudOn.value = cloudsOn ? 1 : 0
    this.updateSun()
  }

  /** 光照变了（太阳、天色、空气感）：阴影与累积的历史都要重来 */
  private updateSun() {
    this.renderer.shadowMap.needsUpdate = true
    this.post.reset()
    const az = (this.opts.sunAzimuth * Math.PI) / 180
    const el = (this.opts.sunElevation * Math.PI) / 180
    const d = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
    this.sun.position.copy(d).multiplyScalar(150)
    this.sun.target.position.set(0, 0, 0)
    // 低太阳角：暖色、光弱；高角度：白光
    const warm = 1 - Math.min(1, Math.max(0, (this.opts.sunElevation - 4) / 40))
    this.sun.color.setRGB(1, 0.95 - 0.2 * warm, 0.86 - 0.36 * warm)
    const k = Math.min(1, Math.max(0.15, Math.sin(el) * 2.2))
    // 天光弱、日光强，地形明暗对比更像真实照片
    this.sun.intensity = 3.8 * k
    this.hemi.intensity = 0.42 + 0.3 * k
    if (this.waterMat) {
      this.waterMat.uniforms.uSunDir.value.copy(d)
      this.waterMat.uniforms.uSunColor.value.copy(this.sun.color)
      this.waterMat.uniforms.uLight.value = 0.45 + 0.55 * k
    }
    this.diorama.setLight(0.45 + 0.55 * k, this.sun.color)
    // 天空随太阳高度变暗、偏暖
    this.skyTop.copy(SKY_TOP).multiplyScalar(0.35 + 0.65 * k)
    this.skyHorizon.copy(HAZE).lerp(new THREE.Color('#f0c59a'), warm * 0.45).multiplyScalar(0.45 + 0.55 * k)
    if (this.waterMat) {
      this.waterMat.uniforms.uSkyTop.value.copy(this.skyTop)
      this.waterMat.uniforms.uSkyHorizon.value.copy(this.skyHorizon)
    }
    if (this.terrainU) this.terrainU.uSun.value.copy(d)
    if (this.clouds) {
      const u = this.clouds.march.uniforms
      u.uSun.value.copy(d)
      u.uSunColor.value.copy(this.sun.color).multiplyScalar(0.35 + 0.65 * k)
      u.uSkyTop.value.copy(this.skyTop)
      u.uSkyHorizon.value.copy(this.skyHorizon)
      u.uFogColor.value.copy(this.skyHorizon)
      u.uFogDensity.value = this.opts.haze ? CLOUD_FOG : 0
    }
    // 空气感：霾色随天空，顺光方向有太阳散射光晕；低空薄雾高度约 0.9 km
    const c = this.post.comp.uniforms
    c.uSun.value.copy(d)
    c.uSunColor.value.copy(this.sun.color).multiplyScalar(0.25 + 0.35 * k)
    c.uHaze.value.copy(this.skyHorizon).multiplyScalar(0.9)
    c.uFogHeight.value = this.vScale * 0.9
    c.uHazeDensity.value = this.opts.haze ? 0.0026 : 0
    c.uFogDensity.value = this.opts.haze ? 0.035 : 0
  }

  setWorld(world: World, color: HTMLCanvasElement, rough: HTMLCanvasElement, rivers: SmoothRiver[] = []) {
    this.riverList = rivers
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
    this.heightTex?.dispose()
    // 水面材质随世界重建，河流材质跟着重建
    this.riverMat = null

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
    this.mask2Tex?.dispose()
    const mk2 = new THREE.DataTexture(buildDetailMask(world), W, H, THREE.RGBAFormat, THREE.UnsignedByteType)
    mk2.magFilter = THREE.LinearFilter
    mk2.minFilter = THREE.LinearFilter
    mk2.needsUpdate = true
    this.mask2Tex = mk2
    const hSize = new THREE.Vector2(W, H)
    const { mat, uniforms, depth, makePatch } = createTerrainMaterial(colorTex, roughTex, mk, mk2, ht, hSize, new THREE.Vector2(SX, this.SZ), this.vScale)
    this.terrainU = uniforms
    this.patch?.bake.dispose()
    {
      const bake = new TerrainBake(PATCH_N, PATCH_N, ht, hSize, new THREE.Vector2(SX, this.SZ))
      const pm = makePatch(bake.rt.texture, PATCH_N)
      const mesh = new THREE.Mesh(patchGeometry(PATCH_N), pm.mat)
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.visible = false
      this.group.add(mesh)
      this.patch = { bake, mesh, u: pm.uniforms, cx: 0, cz: 0, S: 0, vs: 0 }
      uniforms.uPatch.value.set(0, 0, 0, 0)
    }
    this.terrain = new THREE.Mesh(new THREE.BufferGeometry(), mat)
    this.terrain.customDepthMaterial = depth
    this.terrain.castShadow = true
    this.terrain.receiveShadow = true
    this.group.add(this.terrain)

    this.waterMat = createWaterMaterial(ht, tt, colorTex, this.vScale, new THREE.Vector2(SX, this.SZ), hSize)
    // 道路遮罩与垂直夸张无关，每个世界画一次
    this.roadMask?.dispose()
    this.roadMask = new RoadMask(W, H, new THREE.Vector2(SX, this.SZ))
    this.roadMask.render(this.renderer, world, new THREE.Vector2(SX, this.SZ))
    uniforms.uRoads.value = this.roadMask.rt.texture
    this.waterMat.uniforms.uRoads.value = this.roadMask.rt.texture
    this.water = new THREE.Mesh(new THREE.BufferGeometry(), this.waterMat)
    this.water.renderOrder = 2
    this.group.add(this.water)
    this.post.comp.uniforms.uBox.value.set(-SX / 2, -this.SZ / 2, SX / 2, this.SZ / 2)
    this.buildNameplate()

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
    this.clouds = new VolumetricClouds(seed, SX, this.SZ, base, top, 0.28, this.post.sceneRT.depthTexture!)
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
    // 烘焙高度/坡度/侵蚀（换世界或改垂直夸张时）
    const { GW, GH } = this.gridDims(w)
    if (!this.bake || this.bake.GW !== GW || this.bake.GH !== GH) {
      this.bake?.dispose()
      this.bake = new TerrainBake(GW, GH, this.heightTex!, new THREE.Vector2(w.W, w.H), new THREE.Vector2(SX, this.SZ))
    }
    // 河流：先建网格并渲染河谷下切图，烘焙时从地形里减去
    for (const c of [...this.group.children]) if (c.userData.river) {
      this.group.remove(c)
      ;(c as THREE.Mesh).geometry.dispose()
    }
    if (!this.riverMat) this.riverMat = createRiverWaterMaterial(this.waterMat!)
    const rv = createRiverMesh(w, this.riverList, SX, this.SZ, this.riverMat)
    rv.mesh.userData.river = true
    this.group.add(rv.mesh)
    this.carve?.dispose()
    this.carve = new RiverCarve(w.W, w.H, new THREE.Vector2(SX, this.SZ))
    this.carve.render(this.renderer, rv.carveGeometry)
    rv.carveGeometry.dispose()
    const ct = this.carve.rt
    this.bake.setCarve(ct.texture, ct.width, ct.height)
    this.patch?.bake.setCarve(ct.texture, ct.width, ct.height)
    this.waterMat!.uniforms.uCarve.value = ct.texture
    this.bake.bake(this.renderer, vs)
    for (const u of [this.terrainU!, this.waterMat!.uniforms as unknown as TerrainUniforms]) {
      u.uBaked.value = this.bake.rt.texture
      u.uGSize.value.set(GW, GH)
    }
    this.renderer.shadowMap.needsUpdate = true
    this.water!.geometry.dispose()
    this.water!.geometry = this.waterGeometry(w, vs)
    this.waterMat!.uniforms.uVScale.value = vs
    this.terrainU!.uVScale.value = vs
    // 侧面剖面
    for (const c of [...this.group.children]) if (c.userData.skirt) {
      this.group.remove(c)
      ;(c as THREE.Mesh).geometry.dispose()
    }
    // 岩层剖面底面随垂直夸张变化，底座与桌面跟着平移
    const base = -4.8 * vs - 1.2
    this.group.add(...this.skirts(w, vs, base))
    this.diorama.setBase(base)
    for (const l of this.labelEls) l.pos.y = this.labelY(l.kind, l.pos.x, l.pos.z)
    this.buildClouds()
    this.applyLook()
  }

  /** 世界坐标 → 格坐标 */
  private toCell(x: number, z: number) {
    const w = this.world!
    return { gx: (x / SX + 0.5) * (w.W - 1), gy: (z / this.SZ + 0.5) * (w.H - 1) }
  }

  /**
   * 视口高清块：镜头静止后，若离地够近，就以视线落点附近为中心烘焙一块
   * 边长约为观察距离 1.5 倍的高清地形（侵蚀噪声多 1~3 层）；镜头移出一定范围或缩放明显时重新烘焙。
   */
  private updatePatch() {
    const p = this.patch
    const u = this.terrainU
    if (!p || !u || !this.world) return
    const dist = this.camera.position.distanceTo(this.controls.target)
    if (dist > 26) {
      if (p.mesh.visible) {
        p.mesh.visible = false
        u.uPatch.value.w = 0
      }
      return
    }
    // 交互中不重烘焙，停下来再换
    if (performance.now() - this.lastInteract < 180) return
    const t = this.controls.target
    const c = this.camera.position
    // 中心略偏向镜头：画面下半部分（离镜头更近）最需要细节
    const cx = t.x + (c.x - t.x) * 0.35
    const cz = t.z + (c.z - t.z) * 0.35
    const S = Math.min(32, Math.max(2.5, dist * 1.5))
    const vs = this.vScale
    if (p.mesh.visible && p.vs === vs && Math.hypot(cx - p.cx, cz - p.cz) < p.S * 0.15 && Math.abs(Math.log(S / p.S)) < 0.25) return
    const oct = S < 5 ? 7 : S < 12 ? 6 : 5
    p.bake.setRegion(cx, cz, S, S, oct)
    p.bake.bake(this.renderer, vs)
    p.u.uBOrigin.value.set(cx, cz)
    p.u.uBMapSize.value.set(S, S)
    u.uPatch.value.set(cx, cz, S, 1)
    this.post.reset()
    Object.assign(p, { cx, cz, S, vs })
    p.mesh.visible = true
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
  private gridDims(w: World) {
    const d = Math.min(2, Math.sqrt(3.2e6 / (w.W * w.H)))
    return { GW: Math.round((w.W - 1) * d) + 1, GH: Math.round((w.H - 1) * d) + 1 }
  }

  private terrainGeometry(w: World, _vs: number) {
    const { W, H } = w
    const { GW, GH } = this.gridDims(w)
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

  /** 沙盘四周的剖面：岩层 + 海水截面（aTop 为该列地表 / 海床高度），岩层底面在 base */
  private skirts(w: World, vs: number, base: number): THREE.Object3D[] {
    const { W, H, elevation: e } = w
    const rockPos: number[] = []
    const rockTop: number[] = []
    const seaPos: number[] = []
    const seaTop: number[] = []
    const edges: [number, number][][] = [
      Array.from({ length: W }, (_, x) => [x, 0]),
      Array.from({ length: W }, (_, x) => [W - 1 - x, H - 1]),
      Array.from({ length: H }, (_, y) => [0, H - 1 - y]),
      Array.from({ length: H }, (_, y) => [W - 1, y]),
    ]
    const dx = SX / (W - 1)
    const dz = this.SZ / (H - 1)
    for (const edge of edges) {
      for (let k = 0; k < edge.length - 1; k++) {
        const [x0, y0] = edge[k]
        const [x1, y1] = edge[k + 1]
        const X0 = x0 * dx - SX / 2, Z0 = y0 * dz - this.SZ / 2
        const X1 = x1 * dx - SX / 2, Z1 = y1 * dz - this.SZ / 2
        const h0 = e[y0 * W + x0] * vs
        const h1 = e[y1 * W + x1] * vs
        quad(rockPos, rockTop, [X0, h0, Z0], [X1, h1, Z1], [X1, base, Z1], [X0, base, Z0], h0, h1)
        if (h0 < 0 || h1 < 0) {
          quad(seaPos, seaTop, [X0, 0, Z0], [X1, 0, Z1], [X1, Math.min(h1, 0), Z1], [X0, Math.min(h0, 0), Z0], h0, h1)
        }
      }
    }
    const mk = (p: number[], top: number[], mat: THREE.Material) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
      g.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1))
      g.computeVertexNormals()
      const m = new THREE.Mesh(g, mat)
      m.userData.skirt = true
      return m
    }
    const rock = mk(rockPos, rockTop, this.diorama.strata.mat)
    rock.castShadow = true
    rock.receiveShadow = true
    const sea = mk(seaPos, seaTop, this.diorama.seaSection.mat)
    sea.renderOrder = 3
    return [rock, sea]
  }

  /** 地点被编辑后重建 3D 地名 */
  /** 语言切换：地名与铭牌换成新语言 */
  refreshLanguage() {
    if (!this.world) return
    this.buildLabels()
    this.buildNameplate()
    this.diorama.setBase(-4.8 * this.vScale - 1.2)
    this.post.reset()
  }

  private buildNameplate() {
    const w = this.world!
    this.diorama.build({
      SX,
      SZ: this.SZ,
      title: worldTitle(w),
      subtitle: t('{km} 公里 · 种子 {seed}', { km: Math.round(w.W * w.kmPerCell).toLocaleString('en-US'), seed: w.params.seed }),
    })
  }

  refreshLabels() {
    if (this.world) this.buildLabels()
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
      el.textContent = placeName(l)
      const x = (l.x / (w.W - 1) - 0.5) * SX
      const z = (l.y / (w.H - 1) - 0.5) * this.SZ
      const pos = new THREE.Vector3(x, this.labelY(l.kind, x, z), z)
      this.labelLayer.appendChild(el)
      this.labelEls.push({ el, pos, kind: l.kind, w: 0, h: 0 })
    }
    for (const l of this.labelEls) {
      l.w = l.el.offsetWidth
      l.h = l.el.offsetHeight
    }
    this.labelLayer.style.display = this.opts.labels ? '' : 'none'
  }

  /** 地名锚点高度：城镇标点钉在地面上，海名贴海面，山脉、大陆等区域名悬在上空 */
  private labelY(kind: string, x: number, z: number) {
    if (kind === 'ocean' || kind === 'sea') return 0.3
    if (kind === 'city' || kind === 'capital') return this.heightAt(x, z) + 0.01
    return this.heightAt(x, z) + 0.6
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
      const dot = l.kind === 'capital' ? 3.5 : l.kind === 'city' ? 2.5 : 0
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${(y + dot).toFixed(1)}px) translate(-50%, -100%)`
    }
  }

  /** 屏幕坐标 → 格坐标 */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const p = this.pickWorld(clientX, clientY)
    if (!p) return null
    const { gx, gy } = this.toCell(p.x, p.z)
    return { x: Math.round(gx), y: Math.round(gy) }
  }

  /** 屏幕坐标 → 地表（海面）上的世界坐标（沿视线在高度场上步进求交） */
  pickWorld(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.world) return null
    const r = this.renderer.domElement.getBoundingClientRect()
    this.pickNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    const ray = this.pickRay
    ray.setFromCamera(this.pickNdc, this.camera)
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
      if (y <= h) return new THREE.Vector3(x, h, z)
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

/** 高清块网格分辨率 */
const PATCH_N = 513

/**
 * 高清块：[0,1]² 的规则网格（顶点着色器按 uPatch 映射到世界），
 * 四周再加一圈向下的裙边（position.y = 1 的顶点下沉），遮住与粗网格之间的细缝。
 */
function patchGeometry(N: number) {
  const ring: number[] = []
  for (let x = 0; x < N; x++) ring.push(x)
  for (let y = 1; y < N; y++) ring.push(y * N + N - 1)
  for (let x = N - 2; x >= 0; x--) ring.push((N - 1) * N + x)
  for (let y = N - 2; y > 0; y--) ring.push(y * N)
  const total = N * N + ring.length
  const pos = new Float32Array(total * 3)
  const uv = new Float32Array(total * 2)
  const nor = new Int8Array(total * 3)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x
      pos[i * 3] = x / (N - 1)
      pos[i * 3 + 2] = y / (N - 1)
    }
  }
  ring.forEach((src, k) => {
    const i = N * N + k
    pos[i * 3] = pos[src * 3]
    pos[i * 3 + 1] = 1
    pos[i * 3 + 2] = pos[src * 3 + 2]
  })
  for (let i = 0; i < total; i++) nor[i * 3 + 1] = 127
  const idx: number[] = Array.from(gridIndex(N, N).array as Uint32Array)
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]
    const b = ring[(k + 1) % ring.length]
    const a2 = N * N + k
    const b2 = N * N + ((k + 1) % ring.length)
    // 两面都连：裙边从哪一侧看都不透
    idx.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true))
  g.setIndex(idx)
  return g
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

function quad(pos: number[], top: number[], a: number[], b: number[], c: number[], d: number[], ta: number, tb: number) {
  pos.push(...a, ...b, ...c, ...a, ...c, ...d)
  top.push(ta, tb, tb, ta, tb, ta)
}
