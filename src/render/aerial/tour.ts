import * as THREE from 'three'

/**
 * 自动运镜：从世界里挑地标（都城、城镇、山脉、湖、岛、大陆），按电影镜头语言排一串镜头，
 * 镜头之间近则平滑转场（摇臂式弧线越过地形），远则淡出淡入切镜。
 *
 * 镜头：全景环绕（交代全貌）、环绕地标、沿山脉飞越、升镜揭示、缓推。
 * 构图：主体放在三分线上；俯角 20° ~ 50°。每个镜头起止缓入缓出（梯形速度曲线），接缝处速度连续为零。
 * 安全：每帧取镜头周围的地形高度，平滑抬升，不穿山。
 */

export interface TourPoi {
  x: number
  z: number
  kind: string
  weight: number
  /** 山脉的走向（弧度，世界 xz 平面） */
  angle?: number
}

export interface TourHost {
  /** 沙盘尺寸（世界单位） */
  SX: number
  SZ: number
  /** 地表高度（世界单位；海面以下为负） */
  heightAt(x: number, z: number): number
  pois: TourPoi[]
}

interface Pose {
  pos: THREE.Vector3
  target: THREE.Vector3
}

interface Shot {
  dur: number
  /** u ∈ [0, 1]：已按梯形速度曲线换算过的进度 */
  at(u: number, out: Pose): void
  /** 主体（对焦点） */
  subject: THREE.Vector3
}

const TAU = Math.PI * 2
const smoother = (x: number) => x * x * x * (x * (x * 6 - 15) + 10)
/** 梯形速度曲线：两端各 ramp 的时间缓入缓出，中段匀速 */
function trapezoid(t: number, ramp = 0.18) {
  const v = 1 / (1 - ramp)
  if (t < ramp) return (v * t * t) / (2 * ramp)
  if (t > 1 - ramp) return 1 - (v * (1 - t) * (1 - t)) / (2 * ramp)
  return v * (t - ramp / 2)
}

/** 离地检查的采样点（镜头位置周围） */
const CLEAR_PROBES: [number, number][] = [
  [0, 0],
  [1.2, 0],
  [-1.2, 0],
  [0, 1.2],
  [0, -1.2],
]
/** thirds 每帧都要用的临时向量 */
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()

export class CameraTour {
  active = false
  /** 切镜淡出淡入的遮罩不透明度（0 ~ 1），由宿主画到画面上 */
  fade = 0
  private shot: Shot | null = null
  private t = 0
  private recent: TourPoi[] = []
  private count = 0
  /** 转场：从上一个姿态移到下一个镜头的起点 */
  /** 转场：从 from 平滑移到下一个镜头的起始姿态 to（开拍前算好一次） */
  private travel: { from: Pose; to: Pose; shot: Shot; dur: number; t: number; arc: number } | null = null
  private cut: { shot: Shot; t: number } | null = null
  private pose: Pose = { pos: new THREE.Vector3(), target: new THREE.Vector3() }
  private lift = 0
  private rng = Math.random

  constructor(private host: TourHost) {}

  start(camera: THREE.PerspectiveCamera, target: THREE.Vector3) {
    this.active = true
    this.count = 0
    this.recent = []
    this.pose.pos.copy(camera.position)
    this.pose.target.copy(target)
    this.lift = 0
    // 第一个镜头是全景；从当前视角平滑过去
    this.beginTravel(this.establishing())
  }

  stop() {
    this.active = false
    this.shot = this.travel = this.cut = null
    this.fade = 0
  }

  /** 跳到下一个镜头 */
  next() {
    if (!this.active) return
    this.pickNext()
  }

  get subject() {
    return (this.travel?.shot ?? this.cut?.shot ?? this.shot)?.subject ?? null
  }

  /** 推进 dt 秒，把结果写到 camera 与 target */
  update(dt: number, camera: THREE.PerspectiveCamera, target: THREE.Vector3) {
    if (!this.active) return
    dt = Math.min(dt, 0.1)
    const P = this.pose
    if (this.cut) {
      // 淡出 0.5 秒 → 切到新镜头 → 淡入 0.7 秒
      const c = this.cut
      c.t += dt
      if (c.t < 0.5) this.fade = smoother(c.t / 0.5)
      else {
        if (this.shot !== c.shot) {
          this.shot = c.shot
          this.t = 0
          this.lift = 0
        }
        this.fade = 1 - smoother(Math.min(1, (c.t - 0.5) / 0.7))
        if (c.t >= 1.2) {
          this.cut = null
          this.fade = 0
        }
      }
    }
    if (this.travel) {
      const tr = this.travel
      tr.t += dt
      const k = smoother(Math.min(1, tr.t / tr.dur))
      const { to } = tr
      P.pos.lerpVectors(tr.from.pos, to.pos, k)
      // 摇臂式弧线：中途升高，越过山头
      P.pos.y += Math.sin(Math.PI * k) * tr.arc
      P.target.lerpVectors(tr.from.target, to.target, k)
      if (tr.t >= tr.dur) {
        this.travel = null
        this.shot = tr.shot
        this.t = 0
      }
    } else if (this.shot) {
      this.t += dt
      const u = Math.min(1, this.t / this.shot.dur)
      this.shot.at(trapezoid(u), P)
      if (u >= 1 && !this.cut) this.pickNext()
    }
    this.clearTerrain(P, dt)
    camera.position.copy(P.pos)
    target.copy(P.target)
    camera.lookAt(target)
  }

  /** 镜头周围取地形最高处，保持离地余量；抬升量平滑变化，不抖 */
  private clearTerrain(P: Pose, dt: number) {
    const h = this.host
    let g = -Infinity
    for (const [dx, dz] of CLEAR_PROBES) g = Math.max(g, h.heightAt(P.pos.x + dx, P.pos.z + dz))
    const need = Math.max(0, g) + 1.6 - P.pos.y
    const want = Math.max(0, need)
    this.lift += (want - this.lift) * Math.min(1, dt * (want > this.lift ? 6 : 1.5))
    P.pos.y += this.lift
  }

  private pickNext() {
    this.count++
    // 全景偶尔出现（交代全貌），其余都是贴近地标与复杂地形的镜头
    const next = this.count % 9 === 0 ? this.establishing() : this.shotFor(this.choosePoi())
    // 从当前姿态出发：近就平滑转场，远就切镜
    const start: Pose = { pos: new THREE.Vector3(), target: new THREE.Vector3() }
    next.at(0, start)
    const d = start.pos.distanceTo(this.pose.pos) + start.target.distanceTo(this.pose.target) * 0.5
    if (d < this.host.SX * 0.42) this.beginTravel(next)
    else {
      this.travel = null
      this.cut = { shot: next, t: 0 }
    }
  }

  private beginTravel(shot: Shot) {
    const start: Pose = { pos: new THREE.Vector3(), target: new THREE.Vector3() }
    shot.at(0, start)
    const d = start.pos.distanceTo(this.pose.pos)
    this.travel = {
      from: { pos: this.pose.pos.clone(), target: this.pose.target.clone() },
      to: start,
      shot,
      dur: Math.min(9, Math.max(3.5, d / 9)),
      t: 0,
      arc: Math.min(14, d * 0.12),
    }
  }

  /** 按权重挑地标，避开最近看过的，偏好离当前视点不太远的（转场更顺） */
  private choosePoi(): TourPoi {
    const { pois } = this.host
    const cur = this.pose.target
    let best = pois[0]
    let bs = -Infinity
    for (const p of pois) {
      if (this.recent.includes(p)) continue
      const d = Math.hypot(p.x - cur.x, p.z - cur.z)
      const s = Math.log(1 + p.weight) - (d / this.host.SX) * 1.2 + this.rng() * 1.6
      if (s > bs) {
        bs = s
        best = p
      }
    }
    this.recent.push(best)
    if (this.recent.length > Math.min(6, Math.floor(pois.length / 2))) this.recent.shift()
    return best
  }

  /**
   * 镜头所在方位角：放在"沙盘中心 → 地标"的外侧、朝内看，背景总是地图本身，
   * 不会拍到沙盘外的虚空；在这个方向附近随机偏一点
   */
  private outward(p: TourPoi, spread = 0.9, reach = 0, sweep = 0) {
    const base = (Math.hypot(p.x, p.z) < 3 ? this.rng() * TAU : Math.atan2(p.z, p.x)) + (this.rng() - 0.5) * spread
    if (!reach) return base
    // 镜头在整段运动里都要落在沙盘上方（否则前景是展台边框）：从外侧方向起逐步偏转，找到第一个可行的方位
    const { SX, SZ } = this.host
    const ok = (az: number) => {
      for (const s of [0, sweep * 0.5, sweep]) {
        const x = p.x + Math.cos(az + s) * reach
        const z = p.z + Math.sin(az + s) * reach
        if (Math.abs(x) > SX / 2 - 1.5 || Math.abs(z) > SZ / 2 - 1.5) return false
      }
      return true
    }
    for (let k = 0; k <= 12; k++) {
      const d = Math.ceil(k / 2) * 0.26 * (k % 2 ? 1 : -1)
      if (ok(base + d)) return base + d
    }
    return base + Math.PI
  }

  private ground(x: number, z: number) {
    return Math.max(0, this.host.heightAt(x, z))
  }

  private shotFor(p: TourPoi): Shot {
    const r = this.rng
    switch (p.kind) {
      case 'range':
        return r() < 0.6 ? this.flyover(p) : this.reveal(p)
      case 'peak': {
        // 险峻山地：低空贴近，升镜揭示或近距离环绕
        const k = r()
        return k < 0.4 ? this.reveal(p) : k < 0.75 ? this.orbit(p, 5 + r() * 3, 0.42 + r() * 0.15) : this.flyover(p)
      }
      case 'coast':
        return r() < 0.6 ? this.orbit(p, 6 + r() * 4, 0.45 + r() * 0.15) : this.pushIn(p)
      case 'capital':
      case 'city':
        return r() < 0.55 ? this.orbit(p, 5 + r() * 4, 0.45 + r() * 0.2) : this.pushIn(p)
      case 'lake':
      case 'island':
        return this.orbit(p, 8 + r() * 5, 0.5 + r() * 0.2)
      default:
        return r() < 0.5 ? this.orbit(p, 13 + r() * 6, 0.6) : this.reveal(p)
    }
  }

  /** 三分构图：目标点往镜头右（或左）偏一点，主体落在画面三分线附近 */
  private thirds(pos: THREE.Vector3, subject: THREE.Vector3, side: number, out: THREE.Vector3) {
    const fwd = _fwd.subVectors(subject, pos)
    const dist = fwd.length()
    const right = _right.set(-fwd.z, 0, fwd.x).normalize()
    out.copy(subject).addScaledVector(right, side * dist * 0.14)
  }

  /** 全景：高空绕沙盘中心慢转 */
  private establishing(): Shot {
    const { SX, SZ } = this.host
    const az0 = this.rng() * TAU
    const sweep = (0.35 + this.rng() * 0.2) * (this.rng() < 0.5 ? -1 : 1)
    // 距离让沙盘大致占满画面宽度（40° 竖直视场、宽屏）
    const R = Math.max(SX, SZ) * 0.6
    const subject = new THREE.Vector3(0, 0, 0)
    return {
      dur: 16,
      subject,
      at: (u, o) => {
        const az = az0 + sweep * u
        o.pos.set(Math.cos(az) * R, R * (0.58 - 0.06 * u), Math.sin(az) * R)
        o.target.set(0, 0, 0)
      },
    }
  }

  /** 环绕：pitch 为俯角正切 */
  private orbit(p: TourPoi, R: number, pitch: number): Shot {
    const y = this.ground(p.x, p.z)
    const subject = new THREE.Vector3(p.x, y, p.z)
    const sweep = (0.55 + this.rng() * 0.35) * (this.rng() < 0.5 ? -1 : 1)
    // 绕行的弧段以外侧为中心，并保证整段都在沙盘上方
    const az0 = this.outward(p, 0.5, R, sweep) - sweep / 2
    const side = this.rng() < 0.5 ? -1 : 1
    return {
      dur: 15 + this.rng() * 4,
      subject,
      at: (u, o) => {
        const az = az0 + sweep * u
        o.pos.set(p.x + Math.cos(az) * R, y + R * pitch, p.z + Math.sin(az) * R)
        this.thirds(o.pos, subject, side * (1 - 0.3 * u), o.target)
      },
    }
  }

  /** 沿山脉飞越：顺着走向前进，视线略向前下方 */
  private flyover(p: TourPoi): Shot {
    const a = p.angle ?? this.rng() * TAU
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
    // 朝沙盘内部飞：前方始终是地图
    if (dir.x * -p.x + dir.z * -p.z < 0) dir.negate()
    // 与走向稍微错开，从山脉一侧掠过
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(4 + this.rng() * 3)
    const L = 22
    const alt = 3.6 + this.rng() * 2.4
    const c = new THREE.Vector3(p.x, this.ground(p.x, p.z), p.z)
    return {
      dur: 17,
      subject: c,
      at: (u, o) => {
        const s = (u - 0.5) * L
        o.pos.copy(c).addScaledVector(dir, s - 9).add(side)
        // 不飞出沙盘
        o.pos.x = Math.max(-this.host.SX / 2 + 1.5, Math.min(this.host.SX / 2 - 1.5, o.pos.x))
        o.pos.z = Math.max(-this.host.SZ / 2 + 1.5, Math.min(this.host.SZ / 2 - 1.5, o.pos.z))
        o.pos.y = this.ground(o.pos.x, o.pos.z) * 0.6 + c.y * 0.4 + alt
        o.target.copy(c).addScaledVector(dir, s + 6)
        o.target.y = this.ground(o.target.x, o.target.z) * 0.5
      },
    }
  }

  /** 升镜揭示：从低处贴近，升起并后拉 */
  private reveal(p: TourPoi): Shot {
    const y = this.ground(p.x, p.z)
    const subject = new THREE.Vector3(p.x, y, p.z)
    const az = this.outward(p, 0.9, 17.5)
    const d = new THREE.Vector3(Math.cos(az), 0, Math.sin(az))
    const side = this.rng() < 0.5 ? -1 : 1
    return {
      dur: 15,
      subject,
      at: (u, o) => {
        const r = 3.5 + 13 * u
        o.pos.copy(subject).addScaledVector(d, r)
        o.pos.y = y + 1.6 + 10 * u * u
        this.thirds(o.pos, subject, side * u, o.target)
      },
    }
  }

  /** 缓推：从远处慢慢推近，带一点横移 */
  private pushIn(p: TourPoi): Shot {
    const y = this.ground(p.x, p.z)
    const subject = new THREE.Vector3(p.x, y, p.z)
    const az = this.outward(p, 0.9, 16)
    const d = new THREE.Vector3(Math.cos(az), 0, Math.sin(az))
    const lat = new THREE.Vector3(-d.z, 0, d.x)
    const drift = (this.rng() - 0.5) * 10
    const side = this.rng() < 0.5 ? -1 : 1
    return {
      dur: 14,
      subject,
      at: (u, o) => {
        const r = 16 - 10 * u
        o.pos.copy(subject).addScaledVector(d, r).addScaledVector(lat, drift * (1 - u))
        o.pos.y = y + r * 0.62
        this.thirds(o.pos, subject, side * 0.8, o.target)
      },
    }
  }
}
