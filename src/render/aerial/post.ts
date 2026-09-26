import * as THREE from 'three'
import { FS_VERT, FullscreenPass } from './fullscreen'
import { NOISE_GLSL } from './glsl'

/**
 * 后期管线：
 * 场景（HDR + MSAA + 深度）→ 空气透视与体积云合成 → 景深 → 时间累积 → 泛光 → 色调映射与调色 → 屏幕。
 *
 * 镜头静止时逐帧累积：每帧给投影加亚像素抖动、给景深采样换一个旋转角，
 * 画面在几秒内收敛成超采样、散景柔顺的"成片"；镜头一动就从单帧重新开始。
 */

/** 空气透视（均匀霾 + 贴海面的高度雾）+ 云（预乘）叠加，输出线性 HDR */
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
  uniform vec4 uBox;
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(uScene, vUv);
    vec3 col = s.rgb;
    float depth = texture2D(uDepth, vUv).r;
    if (depth < 0.9999 && s.a > 0.0 && uHazeDensity + uFogDensity > 0.0) {
      // 由深度重建世界坐标
      vec2 ndc = vUv * 2.0 - 1.0;
      vec4 vp = uInvProj * vec4(ndc, depth * 2.0 - 1.0, 1.0);
      vp /= vp.w;
      vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
      vec3 rd = wp - uCamPos;
      float t = length(rd);
      rd /= t;
      // 空气只在沙盘上方的方柱里：视线与方柱求交，只积分这一段（桌面、底座不被染成天色）
      vec3 inv = 1.0 / mix(rd, vec3(1e-6), vec3(lessThan(abs(rd), vec3(1e-6))));
      vec3 b0 = (vec3(uBox.x, -1.0, uBox.y) - uCamPos) * inv;
      vec3 b1 = (vec3(uBox.z, 1e4, uBox.w) - uCamPos) * inv;
      vec3 tn = min(b0, b1);
      vec3 tf = max(b0, b1);
      float ta = max(max(max(tn.x, tn.y), tn.z), 0.0);
      float tb = min(min(min(tf.x, tf.y), tf.z), t);
      float seg = max(tb - ta, 0.0);
      // 光学厚度：均匀霾 + 贴近海面的高度雾（沿视线解析积分 ∫exp(-y/H)dt）
      float ya = max(uCamPos.y + rd.y * ta, 0.0);
      float yb = max(uCamPos.y + rd.y * tb, 0.0);
      float dy = rd.y;
      float H = uFogHeight;
      float hInt = seg <= 0.0 ? 0.0 : abs(dy) > 1e-3 ? H / dy * (exp(-ya / H) - exp(-yb / H)) : seg * exp(-ya / H);
      float od = uHazeDensity * seg + uFogDensity * max(hInt, 0.0);
      // 只有落在沙盘上的像素（地表、水面）才蒙霾；桌面、底座即使视线穿过了空气柱也保持干净
      float inside = step(uBox.x, wp.x) * step(wp.x, uBox.z) * step(uBox.y, wp.z) * step(wp.z, uBox.w) * step(-0.5, wp.y);
      od *= inside;
      // 蓝光散射得更多：远处偏蓝
      vec3 T = exp(-od * vec3(0.62, 0.8, 1.0));
      float mu = max(dot(rd, normalize(uSun)), 0.0);
      vec3 inscatter = uHaze * (0.85 + 0.15 * rd.y) + uSunColor * (pow(mu, 8.0) * 0.55 + pow(mu, 32.0) * 0.6);
      col = col * T + inscatter * (1.0 - T) * s.a;
    }
    // 云（预乘，没有云时绑定的是透射率为 1 的空纹理）叠在最上面；背景保持透明
    vec4 c = texture2D(uClouds, vUv);
    gl_FragColor = vec4(col * c.a + c.rgb, 1.0 - (1.0 - s.a) * c.a);
  }
`

/**
 * 景深（单遍散射式聚集，Gustafsson 2018）：沿黄金角螺线取样，
 * 每个样本按自己的弥散圆半径决定是否"溅"到当前像素；
 * 背景样本的弥散圆不超过当前像素的两倍，避免清晰前景被背景糊掉。
 */
const DOF_FRAG = /* glsl */ `
  #include <packing>
  uniform sampler2D uColor;
  uniform sampler2D uDepth;
  uniform vec2 uTexel;
  uniform float uNear;
  uniform float uFar;
  uniform float uFocus;
  uniform float uAperture;
  uniform float uMaxCoc;
  uniform float uRot;
  varying vec2 vUv;
  const float GOLDEN = 2.39996323;
  float viewZ(vec2 uv) {
    float d = texture2D(uDepth, uv).r;
    // 没有几何体的地方当作远景
    return d >= 1.0 ? uFar : -perspectiveDepthToViewZ(d, uNear, uFar);
  }
  // 焦点前后留一段清晰带，再平滑过渡到虚化（真实镜头的焦深极浅，沙盘上只剩一条线是清楚的）
  float coc(float z) {
    float d = abs(1.0 - uFocus / z);
    return min(uMaxCoc, uAperture * max(0.0, d - 0.07) * smoothstep(0.07, 0.2, d));
  }
  void main() {
    vec4 center = texture2D(uColor, vUv);
    float cz = viewZ(vUv);
    float cs = coc(cz);
    vec4 acc = center;
    float tot = 1.0;
    float radius = 1.1;
    float ang = uRot;
    for (int i = 0; i < 120; i++) {
      if (radius >= uMaxCoc) break;
      vec2 tc = vUv + vec2(cos(ang), sin(ang)) * uTexel * radius;
      vec4 sc = texture2D(uColor, tc);
      float sz = viewZ(tc);
      float ss = coc(sz);
      if (sz > cz) ss = clamp(ss, 0.0, cs * 2.0);
      float m = smoothstep(radius - 0.5, radius + 0.5, ss);
      acc += mix(acc / tot, sc, m);
      tot += 1.0;
      ang += GOLDEN;
      radius += 1.6 / radius;
    }
    gl_FragColor = acc / tot;
  }
`

const ACC_FRAG = /* glsl */ `
  uniform sampler2D uPrev;
  uniform sampler2D uCur;
  uniform float uW;
  varying vec2 vUv;
  void main() {
    gl_FragColor = mix(texture2D(uPrev, vUv), texture2D(uCur, vUv), uW);
  }
`

/** 泛光：逐级 4 点双线性降采样（首级带柔和阈值），再 9 点帐篷滤波逐级升采样叠加 */
const DOWN_FRAG = /* glsl */ `
  uniform sampler2D uSrc;
  uniform vec2 uTexel;
  uniform float uFirst;
  varying vec2 vUv;
  void main() {
    vec2 o = uTexel;
    vec4 c = (texture2D(uSrc, vUv + vec2(-o.x, -o.y)) + texture2D(uSrc, vUv + vec2(o.x, -o.y))
            + texture2D(uSrc, vUv + vec2(-o.x, o.y)) + texture2D(uSrc, vUv + vec2(o.x, o.y))) * 0.25;
    if (uFirst > 0.5) {
      // 柔和阈值：只让偏亮的部分进入泛光，暗部不发雾
      float l = max(c.r, max(c.g, c.b));
      float k = clamp((l - 0.55) / 0.6, 0.0, 1.0);
      c.rgb *= k * k;
    }
    gl_FragColor = c;
  }
`

const UP_FRAG = /* glsl */ `
  uniform sampler2D uSrc;
  uniform sampler2D uBase;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec2 o = uTexel;
    vec4 s = texture2D(uSrc, vUv) * 4.0;
    s += (texture2D(uSrc, vUv + vec2(-o.x, 0.0)) + texture2D(uSrc, vUv + vec2(o.x, 0.0))
        + texture2D(uSrc, vUv + vec2(0.0, -o.y)) + texture2D(uSrc, vUv + vec2(0.0, o.y))) * 2.0;
    s += texture2D(uSrc, vUv + vec2(-o.x, -o.y)) + texture2D(uSrc, vUv + vec2(o.x, -o.y))
       + texture2D(uSrc, vUv + vec2(-o.x, o.y)) + texture2D(uSrc, vUv + vec2(o.x, o.y));
    gl_FragColor = s / 16.0 + texture2D(uBase, vUv);
  }
`

/**
 * 终合成：泛光 → 曝光 → AgX（带 punchy 观感）→ 调色（冷暗部/暖亮部、饱和度）→ 暗角 → 胶片颗粒。
 * 全程预乘 alpha：沙盘浮在页面上，色调映射前先除掉 alpha。
 */
const FINAL_FRAG = /* glsl */ `
  uniform sampler2D uSrc;
  uniform sampler2D uBloom;
  uniform float uBloomAmt;
  uniform float uExposure;
  uniform float uSat;
  uniform float uContrast;
  uniform vec3 uShadowTint;
  uniform vec3 uHighTint;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uSeed;
  uniform vec2 uRes;
  varying vec2 vUv;
  ${NOISE_GLSL}

  const mat3 LIN_SRGB_TO_REC2020 = mat3(
    vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 REC2020_TO_LIN_SRGB = mat3(
    vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 AGX_IN = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 AGX_OUT = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  vec3 agxContrast(vec3 x) {
    vec3 x2 = x * x;
    vec3 x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }
  vec3 agx(vec3 c) {
    c = AGX_IN * (LIN_SRGB_TO_REC2020 * c);
    c = clamp((log2(max(c, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
    c = agxContrast(c);
    // 观感（在 AgX 的显示编码空间里调）：饱和度与反差
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = l + uSat * (c - l);
    c = 0.5 + (c - 0.5) * uContrast;
    c = AGX_OUT * c;
    c = pow(max(c, 0.0), vec3(2.2));
    return clamp(REC2020_TO_LIN_SRGB * c, 0.0, 1.0);
  }
  void main() {
    vec4 s = texture2D(uSrc, vUv);
    vec3 b = texture2D(uBloom, vUv).rgb;
    float a = s.a;
    vec3 c = s.rgb + b * uBloomAmt;
    a = clamp(a + dot(b, vec3(0.333)) * uBloomAmt, 0.0, 1.0);
    if (a <= 0.0005) { gl_FragColor = vec4(0.0); return; }
    c /= a;
    // 暗角：边角稍压曝光
    vec2 q = vUv - 0.5;
    q.x *= uRes.x / uRes.y;
    float v = 1.0 - uVignette * smoothstep(0.35, 1.05, length(q));
    c = agx(c * uExposure * v);
    // 分离色调：暗部偏冷、亮部偏暖
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c *= mix(uShadowTint, uHighTint, smoothstep(0.02, 0.6, l));
    // 胶片颗粒（中间调最明显），兼做去色带抖动
    float n = hash12(gl_FragCoord.xy + uSeed * 97.0) + hash12(gl_FragCoord.xy * 1.37 + uSeed * 31.0) - 1.0;
    c += n * (uGrain * (0.25 + l * (1.0 - l) * 3.0) + 1.0 / 255.0) * sqrt(max(c, 0.0));
    gl_FragColor = vec4(max(c, 0.0) * a, a);
    #include <colorspace_fragment>
  }
`

/** 云层：半分辨率步进到自己的目标里（预乘），合成时叠加 */
export interface CloudLayer {
  readonly texture: THREE.Texture
  /** frame：累积帧序号（0 表示镜头刚动），用来逐帧错开步进抖动 */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, frame: number): void
}

/** 累积上限：水面、云在动，历史只保留最近这么多帧 */
const MAX_SAMPLES = 12

const hdr = (w = 1, h = 1) =>
  new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })

export class PostPipeline {
  readonly sceneRT: THREE.WebGLRenderTarget
  private hdrRT = hdr()
  private dofRT = hdr()
  private acc = [hdr(), hdr()]
  private accIdx = 0
  private bloomRTs: THREE.WebGLRenderTarget[] = []
  private bloomUp: THREE.WebGLRenderTarget[] = []
  readonly comp: THREE.ShaderMaterial
  private dof: THREE.ShaderMaterial
  private accMat: THREE.ShaderMaterial
  private down: THREE.ShaderMaterial
  private up: THREE.ShaderMaterial
  private final: THREE.ShaderMaterial
  private fs = new FullscreenPass()
  /** 空纹理：rgb 0、alpha 1（没有云时透射率为 1；当泛光输入时只读 rgb） */
  private empty = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
  /** 已累积的帧数（0 表示下一帧从头开始） */
  samples = 0
  private w = 1
  private h = 1
  private lastView = new THREE.Matrix4()
  private lastProj = new THREE.Matrix4()
  private lastFocus = 0
  private lastAperture = 0
  private jitterIdx = 0

  constructor() {
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
    this.sceneRT.depthTexture = new THREE.DepthTexture(1, 1)
    this.sceneRT.depthTexture.type = THREE.UnsignedIntType
    this.empty.needsUpdate = true
    const mat = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false })
    this.comp = mat(COMPOSITE_FRAG, {
      uScene: { value: this.sceneRT.texture },
      uClouds: { value: this.empty },
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
      uBox: { value: new THREE.Vector4(-1e4, -1e4, 1e4, 1e4) },
    })
    this.dof = mat(DOF_FRAG, {
      uColor: { value: this.hdrRT.texture },
      uDepth: { value: this.sceneRT.depthTexture },
      uTexel: { value: new THREE.Vector2() },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uFocus: { value: 50 },
      uAperture: { value: 0 },
      uMaxCoc: { value: 16 },
      uRot: { value: 0 },
    })
    this.accMat = mat(ACC_FRAG, { uPrev: { value: null }, uCur: { value: null }, uW: { value: 1 } })
    this.down = mat(DOWN_FRAG, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } })
    this.up = mat(UP_FRAG, { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() } })
    this.final = mat(FINAL_FRAG, {
      uSrc: { value: null },
      uBloom: { value: this.empty },
      uBloomAmt: { value: 0.08 },
      uExposure: { value: 1.35 },
      uSat: { value: 1.12 },
      uContrast: { value: 1.22 },
      uShadowTint: { value: new THREE.Color(0.97, 0.99, 1.04) },
      uHighTint: { value: new THREE.Color(1.03, 1.0, 0.96) },
      uVignette: { value: 0.28 },
      uGrain: { value: 0.035 },
      uSeed: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
    })
    this.final.toneMapped = false
  }

  setSize(w: number, h: number) {
    this.w = w
    this.h = h
    this.sceneRT.setSize(w, h)
    for (const rt of [this.hdrRT, this.dofRT, ...this.acc]) rt.setSize(w, h)
    for (const rt of [...this.bloomRTs, ...this.bloomUp]) rt.dispose()
    this.bloomRTs = []
    this.bloomUp = []
    let bw = w
    let bh = h
    for (let i = 0; i < 6; i++) {
      bw = Math.max(1, bw >> 1)
      bh = Math.max(1, bh >> 1)
      this.bloomRTs.push(hdr(bw, bh))
      this.bloomUp.push(hdr(bw, bh))
    }
    this.final.uniforms.uRes.value.set(w, h)
    this.dof.uniforms.uTexel.value.set(1 / w, 1 / h)
    this.reset()
  }

  /** 场景、光照或参数变了：丢掉累积的历史 */
  reset() {
    this.samples = 0
  }

  /** 镜头（位置、朝向、投影）自上一帧起是否变了；变了就重新累积 */
  cameraChanged(camera: THREE.PerspectiveCamera) {
    camera.updateMatrixWorld()
    if (this.lastView.equals(camera.matrixWorld) && this.lastProj.equals(camera.projectionMatrix)) return false
    this.lastView.copy(camera.matrixWorld)
    this.lastProj.copy(camera.projectionMatrix)
    this.samples = 0
    return true
  }

  /**
   * 渲染一帧（先调用 cameraChanged）。云在场景渲染之后、合成之前步进（它要读场景深度）。
   * `focus`：对焦点的视空间深度；`aperture`：弥散圆强度（像素，按 1000 像素高归一）。
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    focus: number,
    aperture: number,
    clouds: CloudLayer | null,
  ) {
    // 焦点或光圈变了也要重新累积（景深关着时焦点怎么变都不影响画面）
    if (aperture !== this.lastAperture || (aperture > 0 && Math.abs(focus - this.lastFocus) > focus * 0.002)) this.samples = 0
    this.lastFocus = focus
    this.lastAperture = aperture
    const n = this.samples
    // 亚像素抖动（Halton 2,3）：只在累积时加，单帧时保持稳定
    if (n > 0) {
      this.jitterIdx = (this.jitterIdx + 1) % 32
      camera.setViewOffset(this.w, this.h, halton(this.jitterIdx + 1, 2) - 0.5, halton(this.jitterIdx + 1, 3) - 0.5, this.w, this.h)
    }

    renderer.setRenderTarget(this.sceneRT)
    renderer.render(scene, camera)

    const cu = this.comp.uniforms
    cu.uInvProj.value.copy(camera.projectionMatrixInverse)
    cu.uCamWorld.value.copy(camera.matrixWorld)
    cu.uCamPos.value.setFromMatrixPosition(camera.matrixWorld)
    clouds?.render(renderer, camera, n)
    cu.uClouds.value = clouds ? clouds.texture : this.empty
    this.fs.render(renderer, this.comp, this.hdrRT)
    if (n > 0) camera.clearViewOffset()

    // 景深关着时直接累积合成结果
    let cur = this.hdrRT
    if (aperture > 0) {
      const du = this.dof.uniforms
      du.uNear.value = camera.near
      du.uFar.value = camera.far
      du.uFocus.value = focus
      const k = this.h / 1000
      du.uAperture.value = aperture * k
      du.uMaxCoc.value = Math.max(2, 18 * k)
      du.uRot.value = n * 2.39996323 * 0.37 + (n % 2) * 1.3
      this.fs.render(renderer, this.dof, this.dofRT)
      cur = this.dofRT
    }

    // 累积：1/n 的等权平均，上限之后变成指数滑动平均（动的东西不会拖影太久）
    const prev = this.acc[this.accIdx]
    const next = this.acc[1 - this.accIdx]
    this.accMat.uniforms.uPrev.value = prev.texture
    this.accMat.uniforms.uCur.value = cur.texture
    this.accMat.uniforms.uW.value = 1 / Math.min(n + 1, MAX_SAMPLES)
    this.fs.render(renderer, this.accMat, next)
    this.accIdx = 1 - this.accIdx
    this.samples = n + 1

    // 泛光
    let src: THREE.Texture = next.texture
    for (let i = 0; i < this.bloomRTs.length; i++) {
      const rt = this.bloomRTs[i]
      this.down.uniforms.uSrc.value = src
      this.down.uniforms.uTexel.value.set(0.5 / rt.width, 0.5 / rt.height)
      this.down.uniforms.uFirst.value = i === 0 ? 1 : 0
      this.fs.render(renderer, this.down, rt)
      src = rt.texture
    }
    let upSrc = this.bloomRTs[this.bloomRTs.length - 1].texture
    for (let i = this.bloomRTs.length - 2; i >= 0; i--) {
      const rt = this.bloomUp[i]
      this.up.uniforms.uSrc.value = upSrc
      this.up.uniforms.uBase.value = this.bloomRTs[i].texture
      this.up.uniforms.uTexel.value.set(1 / this.bloomRTs[i + 1].width, 1 / this.bloomRTs[i + 1].height)
      this.fs.render(renderer, this.up, rt)
      upSrc = rt.texture
    }

    const fu = this.final.uniforms
    fu.uSrc.value = next.texture
    fu.uBloom.value = upSrc
    fu.uSeed.value = (fu.uSeed.value + 1) % 64
    this.fs.render(renderer, this.final, null)
  }

  dispose() {
    for (const rt of [this.sceneRT, this.hdrRT, this.dofRT, ...this.acc, ...this.bloomRTs, ...this.bloomUp]) rt.dispose()
    for (const m of [this.comp, this.dof, this.accMat, this.down, this.up, this.final]) m.dispose()
    this.fs.dispose()
    this.empty.dispose()
  }
}

function halton(i: number, b: number) {
  let f = 1
  let r = 0
  while (i > 0) {
    f /= b
    r += f * (i % b)
    i = Math.floor(i / b)
  }
  return r
}
