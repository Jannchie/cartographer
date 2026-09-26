import * as THREE from 'three'
import type { World } from '../../gen/types'
import { riverThreshold } from '../../gen/world'
import type { SmoothRiver } from '../rivers'
import { BAKED_GLSL } from './bake'

/**
 * 河流几何：沿平滑河道生成带状网格（宽度随流量），顶点高度取烘焙地形，
 * 与细分后的地表严丝合缝；片元用简化的水面着色（天空反射 + 太阳高光 + 边缘柔化）。
 * 与贴图分辨率无关，拉近看始终是清晰的河道。
 */
export function createRiverMesh(world: World, rivers: SmoothRiver[], SX: number, SZ: number) {
  const { W, H } = world
  const thr = riverThreshold(W)
  const cell = SX / (W - 1)
  const pos: number[] = []
  const side: number[] = []
  const idx: number[] = []
  const toX = (gx: number) => ((gx - 0.5) / (W - 1) - 0.5) * SX
  const toZ = (gy: number) => ((gy - 0.5) / (H - 1) - 0.5) * SZ
  for (const r0 of rivers) {
    const r = extendToWater(world, r0)
    const n = r.xs.length
    if (n < 2) continue
    const base = pos.length / 3
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
      pos.push(x - tz * w, 0, z + tx * w, x + tz * w, 0, z - tx * w)
      side.push(-1, 1)
      if (k < n - 1) {
        const i = base + k * 2
        idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('side', new THREE.Float32BufferAttribute(side, 1))
  g.setIndex(idx)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.hypot(SX, SZ))
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      uBaked: { value: null as THREE.Texture | null },
      uGSize: { value: new THREE.Vector2(1, 1) },
      uBMapSize: { value: new THREE.Vector2(SX, SZ) },
      uVScale: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.6, 0.3) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uSky: { value: new THREE.Color('#9fbfdf') },
      uLight: { value: 1 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uVScale;
      attribute float side;
      ${BAKED_GLSL}
      varying float vSide;
      varying vec3 vWorld;
      void main() {
        float h = bakedAt(position.xz).x;
        vec3 p = vec3(position.x, max(h, 0.0) * uVScale + 0.004, position.z);
        vSide = side;
        vWorld = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSky;
      uniform float uLight;
      uniform float uTime;
      varying float vSide;
      varying vec3 vWorld;
      void main() {
        float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 n = normalize(vec3(sin(vWorld.x * 90.0 + uTime) * 0.03, 1.0, cos(vWorld.z * 80.0 - uTime) * 0.03));
        float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 body = vec3(0.05, 0.12, 0.14);
        vec3 col = mix(body, uSky, fres * 0.7) * uLight;
        vec3 Hh = normalize(normalize(uSunDir) + V);
        col += uSunColor * pow(max(dot(n, Hh), 0.0), 300.0) * 2.0;
        // 河岸的湿润过渡
        col = mix(col, body * 0.6, (1.0 - edge) * 0.5);
        gl_FragColor = vec4(col, edge * 0.92);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
  const mesh = new THREE.Mesh(g, mat)
  mesh.renderOrder = 1
  mesh.frustumCulled = false
  return { mesh, mat }
}

/**
 * 入海口 / 入湖口：河道点列止于最后一个陆地格，离水边还差一段。
 * 沿末端方向继续延伸到水面以下，伸进水里的部分被水面盖住，河口因此严丝合缝。
 */
function extendToWater(world: World, r: SmoothRiver): SmoothRiver {
  const n = r.xs.length
  if (n < 2) return r
  const { W, H, elevation: e, water } = world
  const wetAt = (x: number, y: number) => {
    // 河道坐标以格左上角为原点，格心在 +0.5
    const gx = Math.min(W - 1, Math.max(0, Math.round(x - 0.5)))
    const gy = Math.min(H - 1, Math.max(0, Math.round(y - 0.5)))
    const i = gy * W + gx
    return e[i] <= 0 || !Number.isNaN(water[i])
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
  const xs: number[] = []
  const ys: number[] = []
  const f = r.fl[n - 1]
  let reached = false
  for (let s = 0.35; s <= 3.5; s += 0.35) {
    const x = x1 + dx * s
    const y = y1 + dy * s
    xs.push(x)
    ys.push(y)
    if (wetAt(x, y)) {
      // 再多伸一小段进水里
      xs.push(x + dx * 0.8)
      ys.push(y + dy * 0.8)
      reached = true
      break
    }
  }
  if (!reached) return r
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
