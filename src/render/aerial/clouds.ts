import * as THREE from 'three'
import { NOISE_GLSL } from './glsl'

interface Puff {
  x: number
  y: number
  z: number
  s: number
  seed: number
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function vnoise(x: number, y: number, seed: number) {
  const h = (a: number, b: number) => {
    let n = Math.imul(a, 374761393) + Math.imul(b, 668265263) + seed * 1442695041
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296
  }
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  let fx = x - x0
  let fy = y - y0
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  return (h(x0, y0) * (1 - fx) + h(x0 + 1, y0) * fx) * (1 - fy) + (h(x0, y0 + 1) * (1 - fx) + h(x0 + 1, y0 + 1) * fx) * fy
}

/** 一朵积云的"棉团"贴图：多个软圆叠加再乘噪声，边缘蓬松 */
function puffTexture(): THREE.Texture {
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(S, S)
  const r = rng(7)
  const blobs = Array.from({ length: 9 }, () => ({ x: 0.5 + (r() - 0.5) * 0.45, y: 0.5 + (r() - 0.5) * 0.35, r: 0.18 + r() * 0.16 }))
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S
      const v = y / S
      let d = 0
      for (const b of blobs) d = Math.max(d, 1 - Math.hypot(u - b.x, v - b.y) / b.r)
      const n = vnoise(u * 9, v * 9, 3) * 0.5 + vnoise(u * 21, v * 21, 5) * 0.3 + vnoise(u * 45, v * 45, 9) * 0.2
      let a = Math.max(0, d) * (0.55 + 0.9 * n)
      a = Math.min(1, Math.max(0, (a - 0.15) * 1.6))
      const edge = Math.min(u, v, 1 - u, 1 - v) * 8
      a *= Math.min(1, edge)
      const o = (y * S + x) * 4
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255
      img.data[o + 3] = a * 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  return t
}

export interface CloudLayer {
  mesh: THREE.Mesh
  shadow: THREE.DataTexture
  rect: THREE.Vector4
  baseY: number
  update(camera: THREE.Camera): void
  setSun(dir: THREE.Vector3, color: THREE.Color, light: number): void
  setFog(color: THREE.Color, density: number): void
  dispose(): void
}

/**
 * 积云层：覆盖度噪声决定云团位置，每团由若干棉团公告板组成（平底、隆起的顶），
 * 按阳光方向做明暗；另生成一张云影密度图供地表与水面采样。
 */
export function createClouds(seed: number, SX: number, SZ: number, baseY: number, coverage: number): CloudLayer {
  const r = rng(seed)
  const puffs: Puff[] = []
  const ext = 1.7
  const x0 = (-SX / 2) * ext
  const z0 = (-SZ / 2) * ext
  const w = SX * ext
  const h = SZ * ext
  const step = SX / 38
  const thr = 0.74 - coverage * 0.22
  for (let z = z0; z < z0 + h; z += step) {
    for (let x = x0; x < x0 + w; x += step) {
      const cx = x + (r() - 0.5) * step
      const cz = z + (r() - 0.5) * step
      const c = vnoise(cx * 0.045, cz * 0.045, seed) * 0.65 + vnoise(cx * 0.13, cz * 0.13, seed + 1) * 0.35
      if (c < thr) continue
      const strength = Math.min(1, (c - thr) / 0.18)
      const R = step * (0.35 + 0.5 * strength)
      const n = 4 + Math.floor(strength * 10)
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2
        const d = Math.sqrt(r()) * R
        const s = (SX / 100) * (0.55 + 1.1 * strength * (1 - (d / R) * 0.6)) * (0.7 + r() * 0.6)
        puffs.push({
          x: cx + Math.cos(a) * d,
          z: cz + Math.sin(a) * d * 0.8,
          y: baseY + s * 0.3 + r() * s * 0.5 * (1 - d / R),
          s,
          seed: r(),
        })
      }
    }
  }

  // 云影密度图
  const TW = 512
  const TH = Math.round((512 * h) / w)
  const dens = new Float32Array(TW * TH)
  for (const p of puffs) {
    const px = ((p.x - x0) / w) * TW
    const pz = ((p.z - z0) / h) * TH
    const rad = ((p.s * 0.75) / w) * TW
    const r0 = Math.ceil(rad * 2)
    for (let yy = Math.max(0, Math.floor(pz - r0)); yy < Math.min(TH, pz + r0); yy++) {
      for (let xx = Math.max(0, Math.floor(px - r0)); xx < Math.min(TW, px + r0); xx++) {
        const d2 = ((xx - px) ** 2 + (yy - pz) ** 2) / (rad * rad)
        dens[yy * TW + xx] += Math.exp(-d2) * 0.55
      }
    }
  }
  const data = new Uint8Array(TW * TH)
  for (let i = 0; i < data.length; i++) data[i] = Math.min(255, dens[i] * 255)
  const shadow = new THREE.DataTexture(data, TW, TH, THREE.RedFormat, THREE.UnsignedByteType)
  shadow.magFilter = THREE.LinearFilter
  shadow.minFilter = THREE.LinearFilter
  shadow.needsUpdate = true
  const rect = new THREE.Vector4(x0, z0, w, h)

  // 实例化公告板
  const geo = new THREE.InstancedBufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
  geo.setIndex([0, 1, 2, 0, 2, 3])
  const n = puffs.length
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
  const iSize = new THREE.InstancedBufferAttribute(new Float32Array(n), 1)
  const iSeed = new THREE.InstancedBufferAttribute(new Float32Array(n), 1)
  geo.setAttribute('iPos', iPos)
  geo.setAttribute('iSize', iSize)
  geo.setAttribute('iSeed', iSeed)
  geo.instanceCount = n
  const tex = puffTexture()
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTex: { value: tex },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
      uShadow: { value: new THREE.Color('#8e9db3') },
      uLight: { value: 1 },
      uFogColor: { value: new THREE.Color('#bcd3e6') },
      uFogDensity: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute float iSize;
      attribute float iSeed;
      varying vec2 vUv;
      varying float vSeed;
      varying float vDist;
      varying float vH;
      void main() {
        vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
        mv.xy += position.xy * iSize;
        vUv = position.xy * 0.5 + 0.5;
        vSeed = iSeed;
        vDist = length(mv.xyz);
        vH = position.y;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      uniform vec3 uSunView;
      uniform vec3 uSunColor;
      uniform vec3 uShadow;
      uniform float uLight;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      varying vec2 vUv;
      varying float vSeed;
      varying float vDist;
      varying float vH;
      ${NOISE_GLSL}
      void main() {
        float a = vSeed * 6.2831;
        vec2 uv = vUv - 0.5;
        uv = mat2(cos(a), sin(a), -sin(a), cos(a)) * uv + 0.5;
        float alpha = texture2D(uTex, uv).a;
        alpha *= 0.7 + 0.6 * vnoise(vUv * 6.0 + vSeed * 40.0);
        if (alpha < 0.01) discard;
        // 以棉团为球面估算法线，朝阳面亮、背阳与底部偏蓝灰
        vec2 q = vUv * 2.0 - 1.0;
        vec3 n = normalize(vec3(q, sqrt(max(0.0, 1.0 - dot(q, q)))));
        float lit = dot(n, normalize(uSunView)) * 0.5 + 0.5;
        lit = lit * 0.75 + (vH * 0.5 + 0.5) * 0.35;
        vec3 col = mix(uShadow, uSunColor * 1.08, smoothstep(0.15, 0.95, lit)) * uLight;
        float fog = 1.0 - exp(-pow(uFogDensity * vDist, 2.0));
        col = mix(col, uFogColor, fog * 0.85);
        gl_FragColor = vec4(col, min(1.0, alpha * 0.92));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = 5

  // 按到相机的距离由远及近排序，半透明叠加才正确
  const order = puffs.map((_, i) => i)
  const last = new THREE.Vector3(Infinity, 0, 0)
  const cam = new THREE.Vector3()
  const sortTo = (c: THREE.Vector3) => {
    const d = puffs.map((p) => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 + (p.z - c.z) ** 2)
    order.sort((a, b) => d[b] - d[a])
    const P = iPos.array as Float32Array
    const Sz = iSize.array as Float32Array
    const Sd = iSeed.array as Float32Array
    order.forEach((idx, k) => {
      const p = puffs[idx]
      P[k * 3] = p.x
      P[k * 3 + 1] = p.y
      P[k * 3 + 2] = p.z
      Sz[k] = p.s
      Sd[k] = p.seed
    })
    iPos.needsUpdate = true
    iSize.needsUpdate = true
    iSeed.needsUpdate = true
  }
  const sunWorld = new THREE.Vector3(0, 1, 0)
  return {
    mesh,
    shadow,
    rect,
    baseY,
    update(camera) {
      camera.getWorldPosition(cam)
      if (cam.distanceToSquared(last) > 0.25) {
        last.copy(cam)
        sortTo(cam)
      }
      const v = sunWorld.clone().transformDirection(camera.matrixWorldInverse)
      mat.uniforms.uSunView.value.copy(v)
    },
    setSun(dir, color, light) {
      sunWorld.copy(dir).normalize()
      mat.uniforms.uSunColor.value.copy(color)
      mat.uniforms.uLight.value = light
    },
    setFog(color, density) {
      mat.uniforms.uFogColor.value.copy(color)
      mat.uniforms.uFogDensity.value = density
    },
    dispose() {
      geo.dispose()
      mat.dispose()
      tex.dispose()
      shadow.dispose()
    },
  }
}
