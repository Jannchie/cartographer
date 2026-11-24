import * as THREE from 'three'
import { treeMesh, type TreeLod, type TreeMeshData } from './treeMeshes'
import { contactMaterial, farMaterials, nearMaterials, type LodRange, type TreeMaterials } from './treeShader'
import { HEIGHT_SCALE, SP, SPECIES, SPECIES_COUNT } from './treeSpecies'
import { INST_B, INST_F, type TreeBuild, type TreeSet } from './vegetation'

/**
 * 沙盘的植被层：实例数据在 Worker 里备好（vegetation.ts），这里按镜头距离分四级画。
 *
 * | 级 | 镜头距离 | 几何 | 实例从哪来 |
 * | --- | --- | --- | --- |
 * | 近 | < 28 米 | 各树形的网格，团块细分 2 次（几千个三角形） | 每帧按细格收集视点附近的 |
 * | 中 | 28 ~ 90 米 | 同一套团块细分 1 次（一两千） | 同上 |
 * | 低 | 90 ~ 260 米 | 同一套团块不细分（几百） | 同上 |
 * | 远甲 | 260 ~ 750 米 | 回转体（7 边、带树干，55 个三角形），所有树形共用 | 分块的静态缓冲，按视锥裁剪 |
 * | 远乙 | > 750 米 | 回转体（5 边、不带树干，25 个三角形） | 同上 |
 *
 * 每一级的着色器只留下距离落在自己范围里的实例，交界处抖动着交叉淡入淡出（见 treeShader.ts），所以分块与细格
 * 只是粗筛：前三级把视点周围的格子里的实例拷进动态缓冲（几千棵，逐帧重填），远景两级按分块到镜头的距离开关。
 * 阴影通道：前三级用自己的网格（自遮蔽的形状要对得上），远景只画回转体的"冠底—最宽处—顶点"三环（见 lathe 的 proxy）。
 * 矮植被（灌木、芦苇、绿篱、藤架）没有远景，在低模一级的尽头淡出。
 */

type Uniforms = Record<string, THREE.IUniform>

/** 各级交界的镜头距离（米）与交叉淡入淡出带的半宽（比例） */
const D_NEAR = 28
const D_MID = 90
const D_LOW = 260
const D_FAR = 750
const BAND = 0.08
/** 近、中、低三级的动态缓冲各放得下多少棵 */
const CAPS = [256, 1024, 8192]
/** 视锥外这么远（米）以内的树照样收集：它们的影子可能落进画面 */
const SHADOW_REACH = 60

const lo = (d: number) => d * (1 - BAND)
const hi = (d: number) => d * (1 + BAND)

/** 远景的回转体：canopy 为用到的环（treeSpecies 的轮廓下标，最后一个是顶点），sides 为树干的边数（0 不画） */
function lathe(segs: number, rings: number[], sides: number) {
  const pos: number[] = []
  const aux: number[] = []
  const idx: number[] = []
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) & 0xffff) / 65536
  const ringAt: number[] = []
  rings.slice(0, -1).forEach((ri) => {
    ringAt.push(pos.length / 3)
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2
      pos.push(Math.cos(a), ri, Math.sin(a))
      aux.push(0, rnd())
    }
  })
  const apex = pos.length / 3
  pos.push(0, rings[rings.length - 1], 0)
  aux.push(0, rnd())
  const band = (l: number, u: number) => {
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs
      idx.push(u + j, u + j1, l + j, u + j1, l + j1, l + j)
    }
  }
  const fan = (l: number) => {
    for (let j = 0; j < segs; j++) idx.push(apex, l + ((j + 1) % segs), l + j)
  }
  // 阴影用的低模排在前面：冠底—最宽处—顶点
  const widest = ringAt[rings.indexOf(2)]
  band(ringAt[0], widest)
  fan(widest)
  const proxy = idx.length
  for (let k = 0; k + 1 < ringAt.length; k++) band(ringAt[k], ringAt[k + 1])
  fan(ringAt[ringAt.length - 1])
  if (sides) {
    const b = pos.length / 3
    for (const y of [0, 1])
      for (let j = 0; j < sides; j++) {
        const a = (j / sides) * Math.PI * 2
        pos.push(Math.cos(a), y, Math.sin(a))
        aux.push(1, 0)
      }
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides
      idx.push(b + sides + j, b + sides + j1, b + j, b + sides + j1, b + j1, b + j)
    }
  }
  return {
    position: new THREE.BufferAttribute(new Float32Array(pos), 3),
    aux: new THREE.BufferAttribute(new Float32Array(aux), 2),
    index: new THREE.BufferAttribute(new Uint16Array(idx), 1),
    proxy,
    full: idx.length - proxy,
  }
}

function instanced(g: THREE.InstancedBufferGeometry, f: THREE.InstancedInterleavedBuffer, b: THREE.InstancedInterleavedBuffer) {
  g.setAttribute('aTree', new THREE.InterleavedBufferAttribute(f, 4, 0))
  g.setAttribute('aTreeLife', new THREE.InterleavedBufferAttribute(f, 2, 4))
  g.setAttribute('aTreeA', new THREE.InterleavedBufferAttribute(b, 4, 0, true))
  g.setAttribute('aTreeC', new THREE.InterleavedBufferAttribute(b, 4, 4, true))
  g.setAttribute('aTreeG', new THREE.InterleavedBufferAttribute(b, 4, 8, true))
}

/** 一批逐帧重填的实例（一种树形的一级，或接触阴影） */
class Batch {
  readonly mesh: THREE.Mesh
  private f: Float32Array
  private b: Uint8Array
  private fb: THREE.InstancedInterleavedBuffer
  private bb: THREE.InstancedInterleavedBuffer
  private geo: THREE.InstancedBufferGeometry
  n = 0
  constructor(
    geo: THREE.InstancedBufferGeometry,
    material: THREE.Material,
    private cap: number,
  ) {
    this.geo = geo
    this.f = new Float32Array(cap * INST_F)
    this.b = new Uint8Array(cap * INST_B)
    this.fb = new THREE.InstancedInterleavedBuffer(this.f, INST_F)
    this.bb = new THREE.InstancedInterleavedBuffer(this.b, INST_B)
    this.fb.setUsage(THREE.DynamicDrawUsage)
    this.bb.setUsage(THREE.DynamicDrawUsage)
    instanced(geo, this.fb, this.bb)
    geo.instanceCount = 0
    this.mesh = new THREE.Mesh(geo, material)
    // 位置在着色器里由实例属性给出，实例又是按镜头收集的：不再做视锥裁剪
    this.mesh.frustumCulled = false
  }
  add(s: TreeSet, i: number) {
    if (this.n >= this.cap) return
    const o = this.n++
    this.f.set(s.inst.subarray(i * INST_F, i * INST_F + INST_F), o * INST_F)
    this.b.set(s.attr.subarray(i * INST_B, i * INST_B + INST_B), o * INST_B)
  }
  commit() {
    this.geo.instanceCount = this.n
    if (!this.n) return
    for (const [buf, stride] of [[this.fb, INST_F], [this.bb, INST_B]] as const) {
      buf.clearUpdateRanges()
      buf.addUpdateRange(0, this.n * stride)
      buf.needsUpdate = true
    }
  }
}

function meshGeometry(d: TreeMeshData) {
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(d.nrm, 3, true))
  const ib = new THREE.InterleavedBuffer(d.aux, 8)
  g.setAttribute('aCol', new THREE.InterleavedBufferAttribute(ib, 4, 0, true))
  g.setAttribute('aVtx', new THREE.InterleavedBufferAttribute(ib, 4, 4, true))
  g.setIndex(new THREE.BufferAttribute(d.idx, 1))
  return g
}

interface Chunk {
  box: THREE.Box3
  a: THREE.Mesh
  b: THREE.Mesh
}

export class TreeLayer {
  /** 挂进城市组（聚落米坐标） */
  readonly group = new THREE.Group()
  private shared: Uniforms
  private chunks: Chunk[] = []
  /** 各树形的近、中、低三批（没出现的树形为 null） */
  private near: (Batch[] | null)[] = []
  private contact: Batch
  private materials: THREE.Material[] = []
  private sets: TreeSet[]
  /** 上次收集时的镜头（位置朝向、投影的缩放两项）：没变就不重新收集 */
  private last = new THREE.Matrix4()
  private lastProj = [0, 0]
  private frame = 0
  private tmp = { inv: new THREE.Matrix4(), m: new THREE.Matrix4(), cam: new THREE.Vector3(), frustum: new THREE.Frustum(), sphere: new THREE.Sphere(), far: new THREE.Vector3() }

  /** life：成长的共享 uniform（uPop、uPrev、uT，见 buildingShader.ts 的 LIFE_GLSL） */
  constructor(data: TreeBuild, life: Uniforms) {
    this.sets = [data.trees, data.low]
    this.shared = { uPop: life.uPop, uPrev: life.uPrev, uT: life.uT, uNight: life.uNight, uLodCam: { value: new THREE.Vector3(0, 1e6, 0) }, uDither: { value: 0 } }
    const own = (m: TreeMaterials) => {
      this.materials.push(m.mat, m.depth)
      return m
    }
    const add = (mesh: THREE.Mesh, depth: THREE.Material | null) => {
      if (depth) {
        mesh.customDepthMaterial = depth
        mesh.castShadow = mesh.receiveShadow = true
      }
      this.group.add(mesh)
      return mesh
    }

    // —— 近、中：出现过的树形各一对动态批 ——
    const present = new Set<number>()
    for (const s of this.sets) for (let i = 0; i < s.count; i++) present.add(s.attr[i * INST_B] & 15)
    const low = new Set<number>([SP.shrub, SP.reed, SP.hedge, SP.vine])
    for (let sp = 0; sp < SPECIES_COUNT; sp++) {
      if (!present.has(sp)) {
        this.near.push(null)
        continue
      }
      const ranges: LodRange[] = [
        [-2, -1, lo(D_NEAR), hi(D_NEAR)],
        [lo(D_NEAR), hi(D_NEAR), lo(D_MID), hi(D_MID)],
        // 矮植被没有远景：在这一级的尽头淡出
        low.has(sp) ? [lo(D_MID), hi(D_MID), D_LOW * 0.7, D_LOW * 0.95] : [lo(D_MID), hi(D_MID), lo(D_LOW), hi(D_LOW)],
      ]
      this.near.push(
        ranges.map((r, lod) => {
          const m = own(nearMaterials(sp, this.shared, r, lod))
          const b = new Batch(meshGeometry(treeMesh(sp, lod as TreeLod)), m.mat, CAPS[lod])
          add(b.mesh, m.depth)
          return b
        }),
      )
    }

    // —— 接触阴影 ——
    const disc = new THREE.InstancedBufferGeometry()
    {
      const p = [0, 0, 0]
      const ix: number[] = []
      const n = 12
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2
        p.push(Math.cos(a), 0, Math.sin(a))
        ix.push(0, 1 + ((j + 1) % n), 1 + j)
      }
      disc.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3))
      disc.setIndex(ix)
    }
    const cm = contactMaterial(this.shared, [D_LOW * 0.55, D_LOW * 0.9])
    this.materials.push(cm)
    this.contact = new Batch(disc, cm, CAPS[2])
    this.contact.mesh.renderOrder = 1
    add(this.contact.mesh, null)

    // —— 远景：分块 ——
    const t = data.trees
    const la = lathe(7, [0, 1, 2, 3, 4], 3)
    // 750 米外树干不到一个像素：不画
    const lb = lathe(5, [0, 2, 3, 4], 0)
    const ma = own(farMaterials(this.shared, [lo(D_LOW), hi(D_LOW), lo(D_FAR), hi(D_FAR)]))
    const mb = own(farMaterials(this.shared, [lo(D_FAR), hi(D_FAR), 1e9, 2e9]))
    const pp = t.per * t.per
    for (let c = 0; c < t.cnx * t.cnz; c++) {
      const first = t.start[c * pp]
      const count = t.start[(c + 1) * pp] - first
      if (!count) continue
      const f = new THREE.InstancedInterleavedBuffer(t.inst.subarray(first * INST_F, (first + count) * INST_F), INST_F)
      const b = new THREE.InstancedInterleavedBuffer(t.attr.subarray(first * INST_B, (first + count) * INST_B), INST_B)
      const box = new THREE.Box3()
      for (let i = first; i < first + count; i++) {
        const x = t.inst[i * INST_F]
        const y = t.inst[i * INST_F + 1]
        const z = t.inst[i * INST_F + 2]
        const r = t.inst[i * INST_F + 3]
        box.expandByPoint(this.tmp.far.set(x - r * 1.4, y - 1, z - r * 1.4))
        box.expandByPoint(this.tmp.far.set(x + r * 1.4, y + r * 5.5, z + r * 1.4))
      }
      const make = (l: ReturnType<typeof lathe>, m: TreeMaterials) => {
        const g = new THREE.InstancedBufferGeometry()
        g.setAttribute('position', l.position)
        g.setAttribute('aLathe', l.aux)
        g.setIndex(l.index)
        instanced(g, f, b)
        g.instanceCount = count
        g.boundingBox = box
        g.boundingSphere = box.getBoundingSphere(new THREE.Sphere())
        g.setDrawRange(l.proxy, l.full)
        const mesh = add(new THREE.Mesh(g, m.mat), m.depth)
        // 阴影通道只画低模的那一段下标
        mesh.onBeforeShadow = () => g.setDrawRange(0, l.proxy)
        mesh.onAfterShadow = () => g.setDrawRange(l.proxy, l.full)
        return mesh
      }
      this.chunks.push({ box, a: make(la, ma), b: make(lb, mb) })
    }
  }

  /**
   * 按实例数据把这一刻活着的乔木的树冠盖进高度场（见 HeightField 的 stamp）：圆盘半径取轮廓最宽处，顶高取轮廓顶点。
   * K、origin：城市组的缩放与平移（米 → 世界）；pop：时间轴上的人口
   */
  stamp(put: (x: number, z: number, r: number, top: number) => void, K: number, origin: THREE.Vector3, pop: number) {
    const t = this.sets[0]
    const [h0, h1] = HEIGHT_SCALE
    for (let i = 0; i < t.count; i++) {
      const f = i * INST_F
      if (pop < t.inst[f + 4] || pop >= t.inst[f + 5]) continue
      const b = i * INST_B
      const sp = SPECIES[t.attr[b] & 15]
      const r = t.inst[f + 3]
      let w = 0
      for (const q of sp.profile) w = Math.max(w, q[0])
      const top = t.inst[f + 1] + sp.profile[sp.profile.length - 1][1] * r * (h0 + (t.attr[b + 1] / 255) * (h1 - h0))
      put(origin.x + t.inst[f] * K, origin.z + t.inst[f + 2] * K, w * r * (1 + sp.lump) * K, origin.y + top * K)
    }
  }

  /**
   * 每帧渲染前调用：按镜头更新细节层级——收集视点附近的实例进近、中两级的动态批，开关远景的分块。
   * 镜头没动时只推进抖动的相位（静止后的累积把交界处的抖动收成平滑的过渡）
   */
  update(camera: THREE.PerspectiveCamera) {
    const { inv, m, cam, frustum, sphere, far } = this.tmp
    this.shared.uDither.value = (++this.frame * 0.61803399) % 1
    camera.updateMatrixWorld()
    this.group.updateWorldMatrix(true, false)
    // 累积时投影矩阵带亚像素抖动：只比较缩放两项
    const pe = camera.projectionMatrix.elements
    if (camera.matrixWorld.equals(this.last) && pe[0] === this.lastProj[0] && pe[5] === this.lastProj[1]) return
    this.last.copy(camera.matrixWorld)
    this.lastProj = [pe[0], pe[5]]
    m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.group.matrixWorld)
    frustum.setFromProjectionMatrix(m)
    inv.copy(this.group.matrixWorld).invert()
    cam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv)
    ;(this.shared.uLodCam.value as THREE.Vector3).copy(cam)

    // 远景：分块到镜头的最近、最远距离与两级的范围相交才画
    for (const c of this.chunks) {
      const dmin = c.box.distanceToPoint(cam)
      far.set(cam.x < (c.box.min.x + c.box.max.x) / 2 ? c.box.max.x : c.box.min.x, cam.y < (c.box.min.y + c.box.max.y) / 2 ? c.box.max.y : c.box.min.y, cam.z < (c.box.min.z + c.box.max.z) / 2 ? c.box.max.z : c.box.min.z)
      const dmax = far.distanceTo(cam)
      c.a.visible = dmin < hi(D_FAR) && dmax > lo(D_LOW)
      c.b.visible = dmax > lo(D_FAR)
    }

    // 近、中：视点周围的细格
    for (const bs of this.near) if (bs) for (const b of bs) b.n = 0
    this.contact.n = 0
    const R = hi(D_LOW)
    const shade = D_LOW * 0.9
    for (const s of this.sets) {
      if (!s.count) continue
      const C = s.cell
      const nx = s.cnx * s.per
      const nz = s.cnz * s.per
      const i0 = Math.max(0, Math.floor((cam.x - R) / C))
      const i1 = Math.min(nx - 1, Math.floor((cam.x + R) / C))
      const j0 = Math.max(0, Math.floor((cam.z - R) / C))
      const j1 = Math.min(nz - 1, Math.floor((cam.z + R) / C))
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const k = (Math.floor(j / s.per) * s.cnx + Math.floor(i / s.per)) * s.per * s.per + (j % s.per) * s.per + (i % s.per)
          const a = s.start[k]
          const e = s.start[k + 1]
          if (a === e) continue
          const y0 = s.yr[k * 2]
          const y1 = s.yr[k * 2 + 1] + 20
          const dx = Math.max(i * C - cam.x, 0, cam.x - (i + 1) * C)
          const dz = Math.max(j * C - cam.z, 0, cam.z - (j + 1) * C)
          const dy = Math.max(y0 - cam.y, 0, cam.y - y1)
          if (dx * dx + dy * dy + dz * dz > R * R) continue
          sphere.center.set((i + 0.5) * C, (y0 + y1) / 2, (j + 0.5) * C)
          sphere.radius = C * 0.71 + (y1 - y0) / 2 + 8 + SHADOW_REACH
          if (!frustum.intersectsSphere(sphere)) continue
          for (let t = a; t < e; t++) {
            const o = t * INST_F
            const d = Math.hypot(s.inst[o] - cam.x, s.inst[o + 1] - cam.y, s.inst[o + 2] - cam.z)
            if (d >= R) continue
            const b = this.near[s.attr[t * INST_B] & 15]
            if (!b) continue
            // 落在交界带里的两级都收（各自的着色器按抖动留一部分）
            if (d < hi(D_NEAR)) b[0].add(s, t)
            if (d > lo(D_NEAR) && d < hi(D_MID)) b[1].add(s, t)
            if (d > lo(D_MID)) b[2].add(s, t)
            if (d < shade) this.contact.add(s, t)
          }
        }
    }
    for (const bs of this.near) if (bs) for (const b of bs) b.commit()
    this.contact.commit()
  }

  /** 这一帧各级画了多少棵（调试用） */
  stats() {
    const n = [0, 0, 0]
    for (const bs of this.near) if (bs) bs.forEach((b, i) => (n[i] += b.n))
    return { near: n[0], mid: n[1], low: n[2], farA: this.chunks.filter((c) => c.a.visible).length, farB: this.chunks.filter((c) => c.b.visible).length, chunks: this.chunks.length }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.geometry.dispose()
    })
    for (const m of this.materials) m.dispose()
    this.group.clear()
  }
}
