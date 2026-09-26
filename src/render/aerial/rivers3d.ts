import * as THREE from 'three'
import type { World } from '../../gen/types'
import { riverThreshold } from '../../gen/world'
import type { SmoothRiver } from '../rivers'

/**
 * 河流几何，两张网格：
 *  - 下切网格（carve）：比河面宽，渲染进"河谷下切深度图"，烘焙地形时减去——河流有了自己的河床与两岸；
 *  - 水面网格：落在河谷里（中线原地面以下一点），着色与海水、湖水共用同一个水体着色器（water.ts 的 RIVER 变体），
 *    两岸由真实地形与水面的交线决定；入海处河谷切到海平面以下，海水自己灌进河口。
 */
export function createRiverMesh(world: World, rivers: SmoothRiver[], SX: number, SZ: number, mat: THREE.Material) {
  const { W, H } = world
  const thr = riverThreshold(W)
  const cell = SX / (W - 1)
  const pos: number[] = []
  const side: number[] = []
  const mouth: number[] = []
  const floorY: number[] = []
  const center: number[] = []
  const idx: number[] = []
  const cPos: number[] = []
  const cSide: number[] = []
  const cDepth: number[] = []
  const toX = (gx: number) => ((gx - 0.5) / (W - 1) - 0.5) * SX
  const toZ = (gy: number) => ((gy - 0.5) / (H - 1) - 0.5) * SZ
  for (const r0 of rivers) {
    const r = extendToWater(world, r0)
    const n = r.xs.length
    if (n < 2) continue
    const base = pos.length / 3
    // 距末端的弧长（格）：末端最后一段渐隐收尾，接不到深水时也不会一刀切
    const toEnd = new Float32Array(n)
    for (let k = n - 2; k >= 0; k--) toEnd[k] = toEnd[k + 1] + Math.hypot(r.xs[k + 1] - r.xs[k], r.ys[k + 1] - r.ys[k])
    // 只对流到岸边的河道收尾；支流末端要接住干流，不能渐隐
    const coastal = waterDepth(world, r.xs[n - 1], r.ys[n - 1]).depth > -0.02
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - 1)
      const b = Math.min(n - 1, k + 1)
      let tx = r.xs[b] - r.xs[a]
      let tz = r.ys[b] - r.ys[a]
      const tl = Math.hypot(tx, tz) || 1
      tx /= tl
      tz /= tl
      // 宽度：源头细、下游宽（世界单位）
      const f = Math.max(0, r.fl[k] / thr)
      const w = cell * Math.min(0.55, 0.05 + 0.11 * Math.log2(1 + f))
      const x = toX(r.xs[k])
      const z = toZ(r.ys[k])
      // 水面网格比河道宽三成，真正的水边由河岸地形与水面的交线截出
      const wg = w * 1.3
      pos.push(x - tz * wg, 0, z + tx * wg, x + tz * wg, 0, z - tx * wg)
      side.push(-1, 1)
      center.push(x, z, x, z)
      // 河谷：比河面宽约四成（至少 0.3 格，细流也能切出沟），深度随流量（km）
      const cw = Math.max(w * 1.4, cell * 0.3)
      cPos.push(x - tz * cw, 0, z + tx * cw, x + tz * cw, 0, z - tx * cw)
      cSide.push(-1, 1)
      const cd = Math.min(0.035, 0.008 + 0.007 * Math.log2(1 + f))
      cDepth.push(cd, cd)
      // 河口：进入水域后按水深渐隐、向水色过渡；河带贴在水面上（湖面或海面）
      const wd = waterDepth(world, r.xs[k], r.ys[k])
      const m = Math.max(smooth01((wd.depth - 0.01) / 0.025), coastal ? 1 - smooth01(toEnd[k] / 1.5) : 0)
      mouth.push(m, m)
      floorY.push(wd.level, wd.level)
      if (k < n - 1) {
        const i = base + k * 2
        idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('side', new THREE.Float32BufferAttribute(side, 1))
  g.setAttribute('aMouth', new THREE.Float32BufferAttribute(mouth, 1))
  g.setAttribute('aFloor', new THREE.Float32BufferAttribute(floorY, 1))
  g.setAttribute('aCenter', new THREE.Float32BufferAttribute(center, 2))
  g.setIndex(idx)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.hypot(SX, SZ))
  const mesh = new THREE.Mesh(g, mat)
  // 画在水面之后，河口才能盖在水上渐隐
  mesh.renderOrder = 3
  mesh.frustumCulled = false
  const cg = new THREE.BufferGeometry()
  cg.setAttribute('position', new THREE.Float32BufferAttribute(cPos, 3))
  cg.setAttribute('side', new THREE.Float32BufferAttribute(cSide, 1))
  cg.setAttribute('aDepth', new THREE.Float32BufferAttribute(cDepth, 1))
  cg.setIndex(idx)
  return { mesh, carveGeometry: cg }
}

/**
 * 河谷下切深度图：把下切网格正交投影到整张地图，横断面是抛物线（中间最深），
 * 多条河重叠处取最大值。烘焙地形时减去这张图。
 */
export class RiverCarve {
  readonly rt: THREE.WebGLRenderTarget
  private scene = new THREE.Scene()
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private mat: THREE.ShaderMaterial

  constructor(W: number, H: number, mapSize: THREE.Vector2) {
    const cw = Math.min(4096, W * 4)
    const ch = Math.round((cw * H) / W)
    this.rt = new THREE.WebGLRenderTarget(cw, ch, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    })
    this.mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      uniforms: { uMap: { value: mapSize } },
      vertexShader: /* glsl */ `
        uniform vec2 uMap;
        attribute float side;
        attribute float aDepth;
        varying float vSide;
        varying float vDepth;
        void main() {
          vSide = side;
          vDepth = aDepth;
          gl_Position = vec4(position.x / uMap.x * 2.0, position.z / uMap.y * 2.0, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vSide;
        varying float vDepth;
        void main() {
          float s = clamp(abs(vSide), 0.0, 1.0);
          gl_FragColor = vec4(vDepth * (1.0 - s * s), 0.0, 0.0, 1.0);
        }
      `,
    })
  }

  render(renderer: THREE.WebGLRenderer, geo: THREE.BufferGeometry) {
    const mesh = new THREE.Mesh(geo, this.mat)
    mesh.frustumCulled = false
    this.scene.clear()
    this.scene.add(mesh)
    const prev = renderer.getRenderTarget()
    const cc = renderer.getClearColor(new THREE.Color())
    const ca = renderer.getClearAlpha()
    renderer.setRenderTarget(this.rt)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, false, false)
    renderer.render(this.scene, this.cam)
    renderer.setRenderTarget(prev)
    renderer.setClearColor(cc, ca)
  }

  dispose() {
    this.rt.dispose()
    this.mat.dispose()
  }
}

/** 着色器里读取下切深度（km），世界坐标 → 下切图 */
export const CARVE_GLSL = /* glsl */ `
uniform sampler2D uCarve;
uniform vec2 uCarveMap;
float carveAt(vec2 xz) {
  return texture(uCarve, xz / uCarveMap + 0.5).r;
}
`

/**
 * 入海口 / 入湖口：河道点列止于最后一个陆地格，离水边还差一段。
 * 沿末端方向继续延伸到水面以下，伸进水里的部分被水面盖住，河口因此严丝合缝。
 */
function extendToWater(world: World, r: SmoothRiver): SmoothRiver {
  const n = r.xs.length
  if (n < 2) return r
  const { W, H, elevation: e, water } = world
  // 只有几米深的近岸浅水看上去就是沙滩，要伸到看得见的水里（约 15 m 深，或湖面）才算接上
  const wetAt = (x: number, y: number) => {
    // 河道坐标以格左上角为原点，格心在 +0.5
    const fx = Math.min(W - 1.001, Math.max(0, x - 0.5))
    const fy = Math.min(H - 1.001, Math.max(0, y - 0.5))
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const i = y0 * W + x0
    const h = (e[i] * (1 - tx) + e[i + 1] * tx) * (1 - ty) + (e[i + W] * (1 - tx) + e[i + W + 1] * tx) * ty
    const lake = !Number.isNaN(water[Math.round(fy) * W + Math.round(fx)]) && h > 0
    return h < -0.022 || (lake && water[Math.round(fy) * W + Math.round(fx)] - h > 0.012)
  }
  // 末端方向取最后约 2 格的平均走向，避免被蜿蜒的最后一小段带偏
  const x1 = r.xs[n - 1]
  const y1 = r.ys[n - 1]
  let k = n - 2
  while (k > 0 && Math.hypot(x1 - r.xs[k], y1 - r.ys[k]) < 2) k--
  let dx = x1 - r.xs[k]
  let dy = y1 - r.ys[k]
  const dl = Math.hypot(dx, dy) || 1
  dx /= dl
  dy /= dl
  const f = r.fl[n - 1]
  const march = (ux: number, uy: number) => {
    const xs: number[] = []
    const ys: number[] = []
    // 穿过潮滩的潮沟略带弯曲，不是一条直线
    const ph = (x1 * 12.9898 + y1 * 78.233) % 6.283
    for (let s = 0.35; s <= 20; s += 0.35) {
      const wig = Math.sin(s * 0.7 + ph) * 0.5 * Math.min(1, s / 3)
      const x = x1 + ux * s - uy * wig
      const y = y1 + uy * s + ux * wig
      xs.push(x)
      ys.push(y)
      if (wetAt(x, y)) {
        // 再多伸一小段进水里
        xs.push(x + ux * 1.2)
        ys.push(y + uy * 1.2)
        return { xs, ys }
      }
    }
    return null
  }
  // 先沿末端走向；走向与海岸平行时改朝最近的深水
  let ext = march(dx, dy)
  // 只对真正到了岸边的河道（末端几乎贴海平面）找最近的深水，支流末端不动
  const endH = e[Math.min(H - 1, Math.max(0, Math.round(y1 - 0.5))) * W + Math.min(W - 1, Math.max(0, Math.round(x1 - 0.5)))]
  if (!ext && endH < 0.01) {
    let best = 99
    let bx = 0
    let by = 0
    for (let oy = -20; oy <= 20; oy++) {
      for (let ox = -20; ox <= 20; ox++) {
        const d = Math.hypot(ox, oy)
        if (d < best && d > 0 && wetAt(x1 + ox, y1 + oy)) {
          best = d
          bx = ox / d
          by = oy / d
        }
      }
    }
    if (best < 99) ext = march(bx, by)
  }
  if (!ext) return r
  const { xs, ys } = ext
  const m = xs.length
  const ox = new Float32Array(n + m)
  const oy = new Float32Array(n + m)
  const of = new Float32Array(n + m)
  ox.set(r.xs)
  oy.set(r.ys)
  of.set(r.fl)
  for (let j = 0; j < m; j++) {
    ox[n + j] = xs[j]
    oy[n + j] = ys[j]
    // 河口略微展宽
    of[n + j] = f * (1 + (j + 1) / m)
  }
  return { xs: ox, ys: oy, fl: of }
}

function smooth01(t: number) {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/** 某点的水深（km，陆地为负）与水面高度（海 0 / 湖面 / 陆地取海平面以下占位） */
function waterDepth(world: World, x: number, y: number) {
  const { W, H, elevation: e, water } = world
  const fx = Math.min(W - 1.001, Math.max(0, x - 0.5))
  const fy = Math.min(H - 1.001, Math.max(0, y - 0.5))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const i = y0 * W + x0
  const h = (e[i] * (1 - tx) + e[i + 1] * tx) * (1 - ty) + (e[i + W] * (1 - tx) + e[i + W + 1] * tx) * ty
  const lv = water[Math.round(fy) * W + Math.round(fx)]
  if (!Number.isNaN(lv) && lv > 0) return { depth: lv - h, level: lv }
  return { depth: -h, level: 0 }
}
