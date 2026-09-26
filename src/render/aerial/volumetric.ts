import * as THREE from 'three'

/**
 * 体积云：
 * 1. 场景先渲染到带深度纹理的 HDR 目标
 * 2. 半分辨率全屏光线步进：在云层高度区间内沿视线积分密度，
 *    密度 = 覆盖度图 × 高度剖面（平底、隆起的顶）× 3D Perlin-Worley 噪声（再被细节噪声侵蚀）
 *    每个采样点向太阳二次步进求自阴影（Beer），叠加糖粉效应与双瓣 Henyey-Greenstein 相函数（银边）
 *    视线在场景深度处截止，所以山峰能插进云里
 * 3. 合成：场景 × 透射率 + 云的散射光，再做色调映射
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

const FS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

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
  uniform float uEnabled;
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
    if (uEnabled < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float depth = texture(uDepth, vUv).r;
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
    if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

    int N = int(uSteps);
    float dt = (t1 - t0) / uSteps;
    float t = t0 + dt * hash12(gl_FragCoord.xy + fract(uTime) * 91.0);
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
      float d = density(p, false);
      if (d > 0.003) {
        if (firstHit < 0.0) firstHit = t;
        // 向太阳的自阴影
        float sumL = 0.0;
        vec3 lp = p;
        for (int j = 0; j < 5; j++) {
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

const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D uScene;
  uniform sampler2D uClouds;
  uniform sampler2D uDepth;
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform vec3 uCamPos;
  uniform vec3 uSun;
  uniform vec3 uSunColor;
  uniform vec3 uHaze;
  uniform float uHazeDensity;
  uniform float uFogDensity;
  uniform float uFogHeight;
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(uScene, vUv);
    vec4 c = texture2D(uClouds, vUv);
    vec3 col = s.rgb;
    float depth = texture2D(uDepth, vUv).r;
    if (depth < 0.9999 && s.a > 0.0) {
      // 由深度重建世界坐标
      vec2 ndc = vUv * 2.0 - 1.0;
      vec4 vp = uInvProj * vec4(ndc, depth * 2.0 - 1.0, 1.0);
      vp /= vp.w;
      vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
      vec3 rd = wp - uCamPos;
      float t = length(rd);
      rd /= t;
      // 光学厚度：均匀霾 + 贴近海面的高度雾（沿视线解析积分 ∫exp(-y/H)dt）
      float y0 = uCamPos.y;
      float dy = rd.y;
      float H = uFogHeight;
      float hInt = abs(dy) > 1e-3 ? H / dy * (exp(-max(y0, 0.0) / H) - exp(-max(wp.y, 0.0) / H)) : t * exp(-max(y0, 0.0) / H);
      float od = uHazeDensity * t + uFogDensity * max(hInt, 0.0);
      // 蓝光散射得更多：远处偏蓝
      vec3 T = exp(-od * vec3(0.62, 0.8, 1.0));
      float mu = max(dot(rd, normalize(uSun)), 0.0);
      vec3 inscatter = uHaze * (0.85 + 0.15 * rd.y) + uSunColor * (pow(mu, 8.0) * 0.55 + pow(mu, 32.0) * 0.6);
      col = col * T + inscatter * (1.0 - T);
    }
    // 云（预乘）叠在最上面；背景保持透明，沙盘浮在页面上
    vec3 outc = col * c.a + c.rgb;
    float a = 1.0 - (1.0 - s.a) * c.a;
    gl_FragColor = vec4(outc, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export class VolumetricClouds {
  readonly coverage: THREE.DataTexture
  readonly rect: THREE.Vector4
  base: number
  top: number
  private sceneRT: THREE.WebGLRenderTarget
  private cloudRT: THREE.WebGLRenderTarget
  private fsScene = new THREE.Scene()
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private quad: THREE.Mesh
  readonly march: THREE.ShaderMaterial
  readonly comp: THREE.ShaderMaterial

  constructor(seed: number, SX: number, SZ: number, base: number, top: number, coverage: number) {
    this.coverage = coverageMap(seed, coverage)
    const ext = 3.2
    // 覆盖度图覆盖地图外相当大的范围，远处海面上也有云
    this.rect = new THREE.Vector4((-SX * ext) / 2, (-Math.max(SX, SZ) * ext) / 2, SX * ext, Math.max(SX, SZ) * ext)
    this.base = base
    this.top = top
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
    this.sceneRT.depthTexture = new THREE.DepthTexture(1, 1)
    this.sceneRT.depthTexture.type = THREE.UnsignedIntType
    this.cloudRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType })
    this.march = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: MARCH_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uDepth: { value: this.sceneRT.depthTexture },
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
        uSteps: { value: 56 },
        uMapRect: { value: new THREE.Vector4(-SX / 2, -SZ / 2, SX, SZ) },
        uEnabled: { value: 1 },
      },
    })
    this.comp = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      uniforms: {
        uScene: { value: this.sceneRT.texture },
        uClouds: { value: this.cloudRT.texture },
        uDepth: { value: this.sceneRT.depthTexture },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uHaze: { value: new THREE.Color('#a9c6e4') },
        uHazeDensity: { value: 0.0026 },
        uFogDensity: { value: 0.035 },
        uFogHeight: { value: 0.5 },
      },
    })
    const tri = new THREE.BufferGeometry()
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    this.quad = new THREE.Mesh(tri, this.march)
    this.quad.frustumCulled = false
    this.fsScene.add(this.quad)
  }

  setSize(w: number, h: number) {
    this.sceneRT.setSize(w, h)
    const cw = Math.max(1, Math.floor(w / 2))
    const ch = Math.max(1, Math.floor(h / 2))
    this.cloudRT.setSize(cw, ch)
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number) {
    const u = this.march.uniforms
    u.uInvProj.value.copy(camera.projectionMatrixInverse)
    u.uCamWorld.value.copy(camera.matrixWorld)
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld)
    u.uTime.value = time
    const cu = this.comp.uniforms
    cu.uInvProj.value.copy(camera.projectionMatrixInverse)
    cu.uCamWorld.value.copy(camera.matrixWorld)
    cu.uCamPos.value.copy(u.uCamPos.value)
    renderer.setRenderTarget(this.sceneRT)
    renderer.render(scene, camera)
    this.quad.material = this.march
    renderer.setRenderTarget(this.cloudRT)
    renderer.render(this.fsScene, this.fsCam)
    this.quad.material = this.comp
    renderer.setRenderTarget(null)
    renderer.render(this.fsScene, this.fsCam)
  }

  dispose() {
    this.coverage.dispose()
    this.sceneRT.dispose()
    this.cloudRT.dispose()
    this.march.dispose()
    this.comp.dispose()
  }
}
