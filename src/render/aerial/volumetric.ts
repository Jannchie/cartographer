import * as THREE from 'three'
import { FS_VERT, FullscreenPass } from './fullscreen'
import type { CloudLayer } from './post'

/**
 * 体积云：
 * 1. 场景先渲染到带深度纹理的 HDR 目标
 * 2. 半分辨率全屏光线步进：在云层高度区间内沿视线积分密度，
 *    密度 = 覆盖度图 × 高度剖面（平底、隆起的顶）× 3D Perlin-Worley 噪声（再被细节噪声侵蚀）
 *    每个采样点向太阳二次步进求自阴影（Beer），叠加糖粉效应与双瓣 Henyey-Greenstein 相函数（银边）
 *    视线在场景深度处截止，所以山峰能插进云里
 * 3. 合成（见 post.ts）：场景 × 透射率 + 云的散射光
 */

// ——————————————— 3D 噪声纹理（可平铺） ———————————————
let noiseTex: THREE.Data3DTexture | null = null

function makeNoise3D(): THREE.Data3DTexture {
  if (noiseTex) return noiseTex
  const S = 64
  const data = new Uint8Array(S * S * S * 4)
  // 周期性值噪声 fbm
  const hash3 = (x: number, y: number, z: number, p: number, seed: number) => {
    x = ((x % p) + p) % p
    y = ((y % p) + p) % p
    z = ((z % p) + p) % p
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) + seed * 1442695041
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296
  }
  const vn = (x: number, y: number, z: number, p: number, seed: number) => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const z0 = Math.floor(z)
    let fx = x - x0
    let fy = y - y0
    let fz = z - z0
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    fz = fz * fz * (3 - 2 * fz)
    const l = (a: number, b: number, t: number) => a + (b - a) * t
    const c = (dx: number, dy: number, dz: number) => hash3(x0 + dx, y0 + dy, z0 + dz, p, seed)
    return l(
      l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy),
      l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy),
      fz,
    )
  }
  // 周期性 Worley（反相后是一团团的"花椰菜"）
  const worley = (x: number, y: number, z: number, cells: number, seed: number) => {
    const gx = (x / S) * cells
    const gy = (y / S) * cells
    const gz = (z / S) * cells
    const ix = Math.floor(gx)
    const iy = Math.floor(gy)
    const iz = Math.floor(gz)
    let d = 9
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx
          const cy = iy + dy
          const cz = iz + dz
          const px = cx + hash3(cx, cy, cz, cells, seed)
          const py = cy + hash3(cx, cy, cz, cells, seed + 1)
          const pz = cz + hash3(cx, cy, cz, cells, seed + 2)
          const dd = (px - gx) ** 2 + (py - gy) ** 2 + (pz - gz) ** 2
          if (dd < d) d = dd
        }
    return Math.min(1, Math.sqrt(d))
  }
  for (let z = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let pf = 0
        let a = 0.5
        let norm = 0
        for (let o = 0; o < 4; o++) {
          const p = 4 << o
          pf += a * vn((x / S) * p, (y / S) * p, (z / S) * p, p, 3 + o)
          norm += a
          a *= 0.5
        }
        pf /= norm
        const w1 = 1 - worley(x, y, z, 4, 11)
        const w2 = 1 - worley(x, y, z, 8, 23)
        const w3 = 1 - worley(x, y, z, 16, 37)
        const wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125
        // Perlin-Worley：用 Worley 重映射 Perlin，得到蓬松又连贯的团块
        const base = Math.min(1, Math.max(0, pf + (wf - 1) * -0.6 * (1 - pf) + (wf - 0.5) * 0.6))
        const o4 = ((z * S + y) * S + x) * 4
        data[o4] = base * 255
        data[o4 + 1] = (w2 * 0.6 + w3 * 0.4) * 255
        data[o4 + 2] = wf * 255
        data[o4 + 3] = 255
      }
    }
  }
  const t = new THREE.Data3DTexture(data, S, S, S)
  t.format = THREE.RGBAFormat
  t.type = THREE.UnsignedByteType
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping
  t.minFilter = t.magFilter = THREE.LinearFilter
  t.needsUpdate = true
  noiseTex = t
  return t
}

// ——————————————— 覆盖度图 ———————————————
function coverageMap(seed: number, coverage: number) {
  const N = 512
  const data = new Uint8Array(N * N)
  const h = (x: number, y: number, s: number) => {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + s * 1442695041
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296
  }
  const vn = (x: number, y: number, s: number) => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    let fx = x - x0
    let fy = y - y0
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    return (h(x0, y0, s) * (1 - fx) + h(x0 + 1, y0, s) * fx) * (1 - fy) + (h(x0, y0 + 1, s) * (1 - fx) + h(x0 + 1, y0 + 1, s) * fx) * fy
  }
  const thr = 0.62 - coverage * 0.25
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N
      const v = y / N
      // 天气尺度（成片的晴/多云）× 云团尺度（单朵积云）
      const weather = vn(u * 6, v * 6, seed + 7)
      const c = (vn(u * 30, v * 30, seed) * 0.55 + vn(u * 72, v * 72, seed + 1) * 0.3 + vn(u * 160, v * 160, seed + 2) * 0.15) * (0.75 + 0.5 * weather)
      const cov = Math.min(1, Math.max(0, (c - thr) / 0.22))
      data[y * N + x] = cov * 255
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType)
  t.minFilter = t.magFilter = THREE.LinearFilter
  t.needsUpdate = true
  return t
}

const MARCH_FRAG = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler2D uDepth;
  uniform sampler2D uCov;
  uniform sampler3D uNoise;
  uniform vec4 uCovRect;
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform vec3 uCamPos;
  uniform float uBase;
  uniform float uTop;
  uniform float uNoiseScale;
  uniform vec3 uSun;
  uniform vec3 uSunColor;
  uniform vec3 uSkyTop;
  uniform vec3 uSkyHorizon;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uTime;
  uniform float uSteps;
  uniform vec4 uMapRect;
  uniform float uFrame;
  uniform vec4 uSub;
  varying vec2 vUv;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float HG(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * c, 1.5));
  }

  float density(vec3 p, bool cheap) {
    // 只在沙盘上空成云，边缘柔和收拢
    vec2 mq = (p.xz - uMapRect.xy) / uMapRect.zw;
    float edge = smoothstep(0.0, 0.06, min(min(mq.x, 1.0 - mq.x), min(mq.y, 1.0 - mq.y)));
    if (edge <= 0.0) return 0.0;
    vec2 cuv = (p.xz - uCovRect.xy) / uCovRect.zw;
    if (cuv.x < 0.0 || cuv.y < 0.0 || cuv.x > 1.0 || cuv.y > 1.0) return 0.0;
    // 域扭曲：用 3D 噪声推开覆盖度的采样点，轮廓不再是规整的团块
    vec3 wq = p * uNoiseScale * 0.35 + vec3(uTime * 0.002, 0.0, 0.0);
    vec2 warp = (texture(uNoise, wq).rb - 0.5) * 0.012;
    float cov = texture(uCov, cuv + warp).r;
    if (cov < 0.01) return 0.0;
    float h = (p.y - uBase) / (uTop - uBase);
    if (h < 0.0 || h > 1.0) return 0.0;
    // 积云剖面：平底、覆盖度越大顶越高
    float topH = mix(0.3, 1.0, cov);
    float shape = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(topH * 0.45, topH, h));
    vec3 q = p * uNoiseScale + vec3(uTime * 0.006, 0.0, uTime * 0.003);
    float n = texture(uNoise, q).r;
    float c = cov * shape * edge;
    float d = clamp((n - (1.0 - c)) / max(c, 0.001), 0.0, 1.0);
    // 厚薄不一：低频"云水量"场让有的云浓、有的只是一缕薄纱
    float lwc = texture(uCov, fract(cuv * 3.7 + warp * 6.0 + 0.37)).r;
    d *= mix(0.18, 1.0, smoothstep(0.1, 0.9, lwc));
    if (!cheap && d > 0.0) {
      // 细节噪声侵蚀边缘：底部拉丝、顶部卷曲
      float dn = texture(uNoise, q * 4.1 + vec3(0.0, uTime * 0.01, 0.0)).r;
      d = clamp(d - (dn - 0.3) * mix(0.4, 0.22, h) * (1.0 - d), 0.0, 1.0);
    }
    return d;
  }

  void main() {
    // 场景深度可能只画在左下角的一块（动态分辨率）
    float depth = texture(uDepth, min(vUv * uSub.xy, uSub.zw)).r;
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 vp = uInvProj * vec4(ndc, depth * 2.0 - 1.0, 1.0);
    vp /= vp.w;
    float sceneDist = depth >= 0.9999 ? 1e9 : length(vp.xyz);
    vec4 vd = uInvProj * vec4(ndc, 1.0, 1.0);
    vec3 viewDir = normalize(vd.xyz / vd.w);
    vec3 dir = normalize((uCamWorld * vec4(viewDir, 0.0)).xyz);

    // 与云层厚度区间求交
    float t0, t1;
    if (abs(dir.y) < 1e-4) {
      if (uCamPos.y < uBase || uCamPos.y > uTop) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      t0 = 0.0; t1 = 400.0;
    } else {
      float a = (uBase - uCamPos.y) / dir.y;
      float b = (uTop - uCamPos.y) / dir.y;
      t0 = max(min(a, b), 0.0);
      t1 = max(a, b);
    }
    t1 = min(t1, min(sceneDist, 700.0));
    // 再与沙盘上空的方柱求交：平视时视线在云层里的路径很长，只算沙盘范围内的那一段
    {
      vec2 inv = 1.0 / (sign(dir.xz) * max(abs(dir.xz), vec2(1e-5)) + vec2(equal(dir.xz, vec2(0.0))) * 1e-5);
      vec2 ta = (uMapRect.xy - uCamPos.xz) * inv;
      vec2 tb = (uMapRect.xy + uMapRect.zw - uCamPos.xz) * inv;
      vec2 tmin = min(ta, tb), tmax = max(ta, tb);
      t0 = max(t0, max(tmin.x, tmin.y));
      t1 = min(t1, min(tmax.x, tmax.y));
    }
    if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

    // 步长有上限：平视时路径长，按长度增加步数，而不是把步子拉大到跨过整朵云
    // uSteps 为画质档位的步进密度（44 时步长为云层厚度的 12%）
    float maxStep = (uTop - uBase) * 5.28 / uSteps;
    int N = int(clamp(ceil((t1 - t0) / maxStep), uSteps * 0.5, 128.0));
    float dt = (t1 - t0) / float(N);
    // 逐像素抖动（交错梯度噪声）：镜头动时固定不变（平视不闪烁），静止累积时逐帧错开，噪点被平均掉
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uFrame * 5.588238, vec2(0.06711056, 0.00583715))));
    float t = t0 + dt * ign;
    vec3 L = normalize(uSun);
    float cosT = dot(dir, L);
    float phase = mix(HG(cosT, 0.62), HG(cosT, -0.22), 0.35) * 4.0 * 3.14159;
    float sigma = 2.6;
    float lstep = (uTop - uBase) * 0.1;
    vec3 col = vec3(0.0);
    float trans = 1.0;
    float firstHit = -1.0;
    for (int i = 0; i < 128; i++) {
      if (i >= N) break;
      vec3 p = uCamPos + dir * t;
      // 离镜头很近的云淡出：贴近拍摄（手动拉近或巡览）时不会糊一脸云
      float d = density(p, false) * smoothstep(2.5, 8.0, t);
      if (d > 0.003) {
        if (firstHit < 0.0) firstHit = t;
        // 向太阳的自阴影
        float sumL = 0.0;
        vec3 lp = p;
        for (int j = 0; j < 4; j++) {
          lp += L * lstep * (1.0 + float(j) * 0.6);
          sumL += density(lp, true) * lstep * (1.0 + float(j) * 0.6);
        }
        float Tl = exp(-sumL * sigma);
        float powder = 1.0 - exp(-d * 6.0);
        float h = clamp((p.y - uBase) / (uTop - uBase), 0.0, 1.0);
        vec3 amb = mix(uSkyHorizon * 0.55, uSkyTop * 1.05, h) * (0.55 + 0.45 * h);
        vec3 S = uSunColor * Tl * phase * mix(0.55, 1.0, powder) * 2.2 + amb;
        float st = exp(-d * sigma * dt);
        col += trans * S * (1.0 - st);
        trans *= st;
        if (trans < 0.015) break;
      }
      t += dt;
    }
    // 空气透视：远处的云融进天际雾霭
    if (firstHit > 0.0) {
      float fog = 1.0 - exp(-pow(uFogDensity * firstHit, 2.0));
      col = mix(col, uFogColor * (1.0 - trans), fog);
    }
    gl_FragColor = vec4(col, trans);
  }
`

export class VolumetricClouds implements CloudLayer {
  readonly coverage: THREE.DataTexture
  readonly rect: THREE.Vector4
  base: number
  top: number
  readonly cloudRT: THREE.WebGLRenderTarget
  private fs = new FullscreenPass()
  readonly march: THREE.ShaderMaterial

  constructor(seed: number, SX: number, SZ: number, base: number, top: number, coverage: number, depth: THREE.DepthTexture) {
    this.coverage = coverageMap(seed, coverage)
    const ext = 3.2
    // 覆盖度图覆盖地图外相当大的范围，远处海面上也有云
    this.rect = new THREE.Vector4((-SX * ext) / 2, (-Math.max(SX, SZ) * ext) / 2, SX * ext, Math.max(SX, SZ) * ext)
    this.base = base
    this.top = top
    this.cloudRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
    this.march = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: MARCH_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uDepth: { value: depth },
        uCov: { value: this.coverage },
        uNoise: { value: makeNoise3D() },
        uCovRect: { value: this.rect },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uBase: { value: base },
        uTop: { value: top },
        uNoiseScale: { value: 1 / (SX * 0.05) },
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSkyTop: { value: new THREE.Color('#3b6ea8') },
        uSkyHorizon: { value: new THREE.Color('#a9c6e4') },
        uFogColor: { value: new THREE.Color('#a9c6e4') },
        uFogDensity: { value: 0.0036 },
        uTime: { value: 0 },
        uSteps: { value: 44 },
        uMapRect: { value: new THREE.Vector4(-SX / 2, -SZ / 2, SX, SZ) },
        uFrame: { value: 0 },
        uSub: { value: new THREE.Vector4(1, 1, 1, 1) },
      },
    })
  }

  get texture() {
    return this.cloudRT.texture
  }

  /** 相对画布的渲染分辨率 */
  scale = 0.5

  setSize(w: number, h: number) {
    this.cloudRT.setSize(Math.max(1, Math.floor(w * this.scale)), Math.max(1, Math.floor(h * this.scale)))
  }

  /** 云的演化时间（秒） */
  set time(t: number) {
    this.march.uniforms.uTime.value = t
  }

  /** 半分辨率步进云层（要在场景深度渲染之后调用）；frame 为累积帧序号，0 表示镜头在动 */
  /** 动态分辨率时云也只画到目标左下角同样比例的一块；合成时按 sub 读取 */
  readonly sub = new THREE.Vector4(1, 1, 1, 1)

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, frame: number, sub: THREE.Vector4) {
    const u = this.march.uniforms
    u.uSub.value.copy(sub)
    const rt = this.cloudRT
    const cw = Math.max(1, Math.round(rt.width * sub.x))
    const ch = Math.max(1, Math.round(rt.height * sub.y))
    rt.viewport.set(0, 0, cw, ch)
    this.sub.set(cw / rt.width, ch / rt.height, (cw - 0.5) / rt.width, (ch - 0.5) / rt.height)
    u.uInvProj.value.copy(camera.projectionMatrixInverse)
    u.uCamWorld.value.copy(camera.matrixWorld)
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld)
    u.uFrame.value = frame % 64
    this.fs.render(renderer, this.march, this.cloudRT)
  }

  dispose() {
    this.coverage.dispose()
    this.cloudRT.dispose()
    ;(this.march.uniforms.uNoise.value as THREE.Texture).dispose()
    this.march.dispose()
    this.fs.dispose()
  }
}
