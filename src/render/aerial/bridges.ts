import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { World } from '../../gen/types'
import { riverThreshold } from '../../gen/world'
import type { SmoothRiver } from '../rivers'

/**
 * 桥：道路（陆路）与 3D 河道的每个交点上放一座石桥——桥面顺着道路方向横跨河面，
 * 两侧矮护栏，两端桥台往下插进河岸，桥面比两岸略高。全部合成一张网格。
 */
export function buildBridges(world: World, rivers: SmoothRiver[], SX: number, SZ: number, heightAt: (x: number, z: number) => number) {
  const { W, H } = world
  const thr = riverThreshold(W)
  const cell = SX / (W - 1)
  // 道路与河流都换到"格"坐标：道路点就是格坐标；河流点比格坐标多半格（与 rivers3d 的 toX 一致）
  const toX = (gx: number) => (gx / (W - 1) - 0.5) * SX
  const toZ = (gy: number) => (gy / (H - 1) - 0.5) * SZ

  // 河道线段按 8 格的桶分组
  const B = 8
  const bw = Math.ceil(W / B)
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

  // 求交
  const hits: { x: number; y: number; dx: number; dy: number; half: number; sin: number }[] = []
  for (const road of world.roads ?? []) {
    if (road.kind === 'sea') continue
    const p = road.pts
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3]
      const seen = new Set<number>()
      for (let y = Math.floor(Math.min(ay, by) / B); y <= Math.floor(Math.max(ay, by) / B); y++) {
        for (let x = Math.floor(Math.min(ax, bx) / B); x <= Math.floor(Math.max(ax, bx) / B); x++) {
          for (const id of buckets.get(y * bw + x) ?? []) {
            if (seen.has(id)) continue
            seen.add(id)
            const s = segs[id]
            const hit = intersect(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by)
            if (!hit) continue
            const rdx = bx - ax
            const rdy = by - ay
            const rl = Math.hypot(rdx, rdy) || 1
            const sdx = s.bx - s.ax
            const sdy = s.by - s.ay
            const sl = Math.hypot(sdx, sdy) || 1
            const sin = Math.abs((rdx * sdy - rdy * sdx) / (rl * sl))
            // 河面半宽（世界单位），与 rivers3d 的水面一致
            const f = Math.max(0, s.fl / thr)
            const half = cell * Math.min(0.55, 0.05 + 0.11 * Math.log2(1 + f)) * 1.3
            hits.push({ x: hit[0], y: hit[1], dx: rdx / rl, dy: rdy / rl, half, sin })
          }
        }
      }
    }
  }

  // 去重：同一处（道路分段在接头处重复求交）只留一座
  const bridges: typeof hits = []
  for (const h of hits) if (!bridges.some((b) => Math.hypot(b.x - h.x, b.y - h.y) < 1.2)) bridges.push(h)

  const parts: THREE.BufferGeometry[] = []
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, yaw: number) => {
    const g = new THREE.BoxGeometry(w, h, d)
    q.setFromAxisAngle(up, yaw)
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1))
    g.applyMatrix4(m)
    parts.push(g)
  }
  for (const b of bridges) {
    const cx = toX(b.x)
    const cz = toZ(b.y)
    if (heightAt(cx, cz) < 0) continue
    // 跨度：斜交时河面在道路方向上更长；两端各留一段搭在岸上
    const span = Math.min(b.half * 4, (2 * b.half) / Math.max(0.35, b.sin)) + 0.05
    const dx = b.dx * (SX / (W - 1))
    const dz = b.dy * (SZ / (H - 1))
    const dl = Math.hypot(dx, dz) || 1
    const ux = dx / dl
    const uz = dz / dl
    const e = span / 2
    const hA = heightAt(cx - ux * e, cz - uz * e)
    const hB = heightAt(cx + ux * e, cz + uz * e)
    const deck = Math.max(hA, hB, heightAt(cx, cz)) + 0.008
    const yaw = Math.atan2(-uz, ux)
    const width = 0.075
    // 桥面
    box(span, 0.009, width, cx, deck, cz, yaw)
    // 护栏
    for (const s of [-1, 1]) {
      const ox = -uz * s * (width / 2 - 0.004)
      const oz = ux * s * (width / 2 - 0.004)
      box(span, 0.01, 0.007, cx + ox, deck + 0.009, cz + oz, yaw)
    }
    // 两端桥台：往下插进河岸，遮住桥面与地形之间的缝
    for (const s of [-1, 1]) {
      const ax = cx + ux * s * (e - 0.012)
      const az = cz + uz * s * (e - 0.012)
      const ground = Math.min(hA, hB) - 0.03
      const hgt = deck - ground
      box(0.024, hgt, width + 0.01, ax, ground + hgt / 2, az, yaw)
    }
  }
  if (!parts.length) return null
  const geo = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#b8ab92', roughness: 0.85 }))
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/** 线段 ab 与 cd 的交点 */
function intersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): [number, number] | null {
  const rx = bx - ax
  const ry = by - ay
  const sx = dx - cx
  const sy = dy - cy
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-9) return null
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return [ax + rx * t, ay + ry * t]
}
