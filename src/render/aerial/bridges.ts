import * as THREE from 'three'
import type { Road, World } from '../../gen/types'
import { riverThreshold } from '../../gen/world'
import type { SmoothRiver } from '../rivers'

/** 桥面宽度（世界单位）：与 3D 道路遮罩里看得见的土路宽度一致 */
const WIDTH: Record<Road['kind'], number> = { major: 0.06, minor: 0.044, sea: 0 }

/**
 * 桥：道路（陆路）与 3D 河道的每个交点上架一座石桥。
 * 桥身沿道路折线本身扫掠（弯道、斜交都顺着路走，两端与路面接得上）；
 * 高度取烘焙后的真实地表：两端贴着路面，中段拱起、离河面留出一点余量。
 * heightAt 返回渲染地形的真实高度（世界单位）。全部合成一张网格。
 */
export function buildBridges(world: World, rivers: SmoothRiver[], SX: number, SZ: number, heightAt: (x: number, z: number) => number) {
  const { W, H } = world
  const thr = riverThreshold(W)
  const cell = SX / (W - 1)
  // 道路点是格坐标；河流点比格坐标多半格（与 rivers3d 的 toX 一致）
  const toX = (gx: number) => (gx / (W - 1) - 0.5) * SX
  const toZ = (gy: number) => (gy / (H - 1) - 0.5) * SZ

  // 河道线段按 8 格的桶分组
  const B = 8
  const bw = Math.ceil(W / B) + 1
  const buckets = new Map<number, number[]>()
  const segs: { ax: number; ay: number; bx: number; by: number; fl: number }[] = []
  for (const r of rivers) {
    for (let k = 0; k < r.xs.length - 1; k++) {
      const s = { ax: r.xs[k] - 0.5, ay: r.ys[k] - 0.5, bx: r.xs[k + 1] - 0.5, by: r.ys[k + 1] - 0.5, fl: (r.fl[k] + r.fl[k + 1]) / 2 }
      const id = segs.push(s) - 1
      for (let y = Math.floor(Math.min(s.ay, s.by) / B); y <= Math.floor(Math.max(s.ay, s.by) / B); y++) {
        for (let x = Math.floor(Math.min(s.ax, s.bx) / B); x <= Math.floor(Math.max(s.ax, s.bx) / B); x++) {
          const key = y * bw + x
          if (!buckets.has(key)) buckets.set(key, [])
          buckets.get(key)!.push(id)
        }
      }
    }
  }

  const parts: { pos: number[] } = { pos: [] }
  const done: [number, number][] = []
  for (const road of world.roads ?? []) {
    if (road.kind === 'sea') continue
    // 道路折线换到世界坐标，并算出每个点的弧长
    const n = road.pts.length / 2
    const px: number[] = []
    const pz: number[] = []
    const arc: number[] = [0]
    for (let i = 0; i < n; i++) {
      px.push(toX(road.pts[i * 2]))
      pz.push(toZ(road.pts[i * 2 + 1]))
      if (i) arc.push(arc[i - 1] + Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]))
    }
    for (let i = 0; i < n - 1; i++) {
      const ax = road.pts[i * 2], ay = road.pts[i * 2 + 1], bx = road.pts[i * 2 + 2], by = road.pts[i * 2 + 3]
      const seen = new Set<number>()
      for (let y = Math.floor(Math.min(ay, by) / B); y <= Math.floor(Math.max(ay, by) / B); y++) {
        for (let x = Math.floor(Math.min(ax, bx) / B); x <= Math.floor(Math.max(ax, bx) / B); x++) {
          for (const id of buckets.get(y * bw + x) ?? []) {
            if (seen.has(id)) continue
            seen.add(id)
            const s = segs[id]
            const t = intersect(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by)
            if (t === null) continue
            const hx = ax + (bx - ax) * t
            const hy = ay + (by - ay) * t
            // 同一处（道路在接头处断开、重叠）只架一座
            if (done.some(([x0, y0]) => Math.hypot(x0 - hx, y0 - hy) < 1.2)) continue
            done.push([hx, hy])
            if (heightAt(toX(hx), toZ(hy)) < 0) continue
            // 河面半宽（世界单位，与 rivers3d 的水面一致）；斜交时沿路方向更长
            const f = Math.max(0, s.fl / thr)
            const half = cell * Math.min(0.55, 0.05 + 0.11 * Math.log2(1 + f)) * 1.3
            const rdx = bx - ax, rdy = by - ay, sdx = s.bx - s.ax, sdy = s.by - s.ay
            const sin = Math.abs(rdx * sdy - rdy * sdx) / ((Math.hypot(rdx, rdy) || 1) * (Math.hypot(sdx, sdy) || 1))
            const e = Math.min(half * 2.2, half / Math.max(0.35, sin)) + 0.035
            const s0 = arc[i] + (arc[i + 1] - arc[i]) * t
            sweep(parts.pos, px, pz, arc, s0 - e, s0 + e, WIDTH[road.kind], heightAt)
          }
        }
      }
    }
  }
  if (!parts.pos.length) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(parts.pos, 3))
  // 不共享顶点：棱角分明的石砌感
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#d2c6ab', roughness: 0.85 }))
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/** 桥身截面（u 横向、v 竖向，相对桥面）：两侧矮护栏 + 桥面 + 下方的拱腹厚度 */
function profile(w: number): [number, number][] {
  const h = w / 2
  const rail = 0.004
  const lip = 0.004
  return [
    [-h, -0.004],
    [-h, rail],
    [-h + lip, rail],
    [-h + lip, 0],
    [h - lip, 0],
    [h - lip, rail],
    [h, rail],
    [h, -0.004],
  ]
}

/** 沿折线弧长 [s0, s1] 扫掠桥身截面 */
function sweep(out: number[], px: number[], pz: number[], arc: number[], s0: number, s1: number, width: number, heightAt: (x: number, z: number) => number) {
  const total = arc[arc.length - 1]
  s0 = Math.max(0, s0)
  s1 = Math.min(total, s1)
  if (s1 - s0 < 0.02) return
  // 在弧长上取样
  const at = (s: number) => {
    let k = 0
    while (k < arc.length - 2 && arc[k + 1] < s) k++
    const seg = arc[k + 1] - arc[k] || 1
    const t = Math.min(1, Math.max(0, (s - arc[k]) / seg))
    const x = px[k] + (px[k + 1] - px[k]) * t
    const z = pz[k] + (pz[k + 1] - pz[k]) * t
    const tl = Math.hypot(px[k + 1] - px[k], pz[k + 1] - pz[k]) || 1
    return { x, z, tx: (px[k + 1] - px[k]) / tl, tz: (pz[k + 1] - pz[k]) / tl }
  }
  const N = Math.max(8, Math.ceil((s1 - s0) / 0.012))
  const pts = Array.from({ length: N + 1 }, (_, k) => at(s0 + ((s1 - s0) * k) / N))
  const ground = pts.map((p) => heightAt(p.x, p.z))
  // 桥面高度：两端贴着路面（真实地表），中段按正弦拱起，且任何一点都高出下方地表 / 河面
  // 拱只比路面高一点点：远看是路的延续，近看才看出桥身
  const lift = 0.0015
  const rise = Math.min(0.006, (s1 - s0) * 0.05) + 0.002
  const deck = pts.map((_, k) => {
    const t = k / N
    const base = ground[0] + (ground[N] - ground[0]) * t + lift
    const arch = Math.sin(Math.PI * t)
    return Math.max(base + rise * arch, ground[k] + lift + 0.005 * arch)
  })
  const prof = profile(width)
  const ring = (k: number) => {
    const p = pts[k]
    // 横向单位向量（道路方向在水平面内转 90°）
    const nx = -p.tz
    const nz = p.tx
    return prof.map(([u, v]) => [p.x + nx * u, deck[k] + v, p.z + nz * u] as const)
  }
  let prev = ring(0)
  for (let k = 1; k <= N; k++) {
    const cur = ring(k)
    for (let j = 0; j < prof.length - 1; j++) {
      const a = prev[j], b = prev[j + 1], c = cur[j], d = cur[j + 1]
      // 绕序让法线朝外（截面沿 u→v 顺时针，沿道路方向挤出）
      out.push(...a, ...b, ...c, ...b, ...d, ...c)
    }
    // 底面
    const a = prev[prof.length - 1], b = prev[0], c = cur[prof.length - 1], d = cur[0]
    out.push(...a, ...b, ...c, ...b, ...d, ...c)
    prev = cur
  }
}

/** 线段 ab 与 cd 的交点在 ab 上的参数 t（不相交为 null） */
function intersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number | null {
  const rx = bx - ax
  const ry = by - ay
  const sx = dx - cx
  const sy = dy - cy
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-9) return null
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return t
}
