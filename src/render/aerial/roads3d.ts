import * as THREE from 'three'
import type { Road, World } from '../../gen/types'

/**
 * 道路遮罩：把道路条带在 GPU 上栅格化成一张俯视的全图纹理（与河谷下切图同一套映射），
 * 地形着色器按世界坐标采样，在地表上"印"出路面——粗网格与视口高清块自然对齐，
 * 不会有贴片浮空或 z 冲突。
 *   R 陆路覆盖度（中心 1，边缘渐隐）  G 航线（虚线）  B 干道标记
 */
export class RoadMask {
  readonly rt: THREE.WebGLRenderTarget
  private scene = new THREE.Scene()
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private mat: THREE.ShaderMaterial

  constructor(W: number, H: number, mapSize: THREE.Vector2) {
    const cw = Math.min(4096, W * 4)
    const ch = Math.round((cw * H) / W)
    this.rt = new THREE.WebGLRenderTarget(cw, ch, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false })
    this.mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      // 交叉、重叠处取最大，不叠加变浓
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      uniforms: { uMap: { value: mapSize } },
      vertexShader: /* glsl */ `
        uniform vec2 uMap;
        attribute float aSide;
        attribute float aAlong;
        attribute vec2 aKind;
        varying float vSide;
        varying float vAlong;
        varying vec2 vKind;
        void main() {
          vSide = aSide;
          vAlong = aAlong;
          vKind = aKind;
          gl_Position = vec4(position.x / uMap.x * 2.0, position.z / uMap.y * 2.0, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vSide;
        varying float vAlong;
        varying vec2 vKind;
        void main() {
          float cover = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
          if (vKind.x > 1.5) {
            // 航线：虚线
            float dash = step(fract(vAlong / 0.9), 0.55);
            gl_FragColor = vec4(0.0, cover * dash, 0.0, 1.0);
          } else {
            gl_FragColor = vec4(cover, 0.0, vKind.x * cover, 1.0);
          }
        }
      `,
    })
  }

  render(renderer: THREE.WebGLRenderer, world: World, mapSize: THREE.Vector2) {
    const geo = ribbons(world, mapSize)
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
    geo.dispose()
  }

  dispose() {
    this.rt.dispose()
    this.mat.dispose()
  }
}

/** 半宽（世界单位；沙盘宽 100）：路比真实比例粗得多，拉近时才看得见 */
const HALF: Record<Road['kind'], number> = { major: 0.034, minor: 0.024, sea: 0.03 }

/** 每条道路的折线展开成两侧带 aSide = ±1 的三角带 */
function ribbons(world: World, mapSize: THREE.Vector2) {
  const { W, H } = world
  const pos: number[] = []
  const side: number[] = []
  const along: number[] = []
  const kind: number[] = []
  const wx = (x: number) => (x / (W - 1) - 0.5) * mapSize.x
  const wz = (y: number) => (y / (H - 1) - 0.5) * mapSize.y
  for (const r of world.roads ?? []) {
    const n = r.pts.length / 2
    if (n < 2) continue
    const hw = HALF[r.kind]
    const k = r.kind === 'sea' ? [2, 0] : r.kind === 'major' ? [1, 0] : [0, 0]
    const xs: number[] = []
    const zs: number[] = []
    for (let i = 0; i < n; i++) {
      xs.push(wx(r.pts[i * 2]))
      zs.push(wz(r.pts[i * 2 + 1]))
    }
    // 两端沿切向各多伸出一个半宽：接头、拐角处条带互相压住，不留楔形的缝
    for (const [e, o] of [[0, 1], [n - 1, n - 2]]) {
      const dx = xs[e] - xs[o]
      const dz = zs[e] - zs[o]
      const l = Math.hypot(dx, dz) || 1
      xs[e] += (dx / l) * hw
      zs[e] += (dz / l) * hw
    }
    let dist = 0
    let prev: [number, number, number, number, number] | null = null
    for (let i = 0; i < n; i++) {
      // 顶点法线：前后两段方向的平均
      const a = Math.max(0, i - 1)
      const b = Math.min(n - 1, i + 1)
      let tx = xs[b] - xs[a]
      let tz = zs[b] - zs[a]
      const tl = Math.hypot(tx, tz) || 1
      tx /= tl
      tz /= tl
      if (i > 0) dist += Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1])
      const cur: [number, number, number, number, number] = [xs[i] - tz * hw, zs[i] + tx * hw, xs[i] + tz * hw, zs[i] - tx * hw, dist]
      if (prev) {
        const [lx0, lz0, rx0, rz0, d0] = prev
        const [lx1, lz1, rx1, rz1, d1] = cur
        pos.push(lx0, 0, lz0, rx0, 0, rz0, lx1, 0, lz1, rx0, 0, rz0, rx1, 0, rz1, lx1, 0, lz1)
        side.push(-1, 1, -1, 1, 1, -1)
        along.push(d0, d0, d1, d0, d1, d1)
        for (let t = 0; t < 6; t++) kind.push(k[0], k[1])
      }
      prev = cur
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1))
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1))
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 2))
  return g
}
