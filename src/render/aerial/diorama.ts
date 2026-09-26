import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { NOISE_GLSL } from './glsl'
import { createSky } from './sky'

/**
 * 沙盘作为一件摆在桌上的实物：
 * - 四周剖面：褶皱的沉积岩层（随地表抬升上拱）、表土与草皮、海床沉积、底部结晶基底
 * - 海水剖面：随深度吸收变暗，近水面有焦散光纹与水面亮线
 * - 胡桃木底座（清漆）+ 黄铜包边 + 刻字铭牌
 * - 深色亚麻桌面（聚光灯一样的光池，向外沉进暗处）+ 展厅背景
 */

const srgb = (hex: string) => new THREE.Color(hex)

/**
 * onBeforeCompile 的公共部分：顶点着色器传出世界坐标 vWp，片元着色器带上噪声函数，
 * 再用 color 替换掉 color_fragment（程序化的反照率）。
 */
function shadeByWorldPos(
  sh: THREE.WebGLProgramParametersWithUniforms,
  o: { vertDecl?: string; vertBody?: string; fragDecl?: string; color: string },
) {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vWp;\n${o.vertDecl ?? ''}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;\n${o.vertBody ?? ''}`)
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vWp;\n${o.fragDecl ?? ''}\n${NOISE_GLSL}`)
    .replace('#include <color_fragment>', o.color)
}

/** 岩层剖面材质：几何带 aTop（该列地表高度） */
function createStrataMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide })
  const uniforms = {
    uBase: { value: -4 },
    uPal: {
      value: ['#d2b184', '#8d877d', '#c08f55', '#ddd2b6', '#a08066', '#b57a5c', '#b0a58f', '#7c7064'].map(srgb),
    },
  }
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms)
    shadeByWorldPos(sh, {
      vertDecl: 'attribute float aTop;\nvarying float vTop;',
      vertBody: 'vTop = aTop;',
      fragDecl: 'varying float vTop;\nuniform float uBase;\nuniform vec3 uPal[8];',
      color: /* glsl */ `
        {
          // 沿剖面方向的坐标（每一面只有 x 或 z 在变）
          float s = vWp.x + vWp.z;
          float below = vTop - vWp.y;
          // 地层随地表抬升上拱（山下是背斜），再叠一点起伏与断续
          float warp = max(vTop, -0.5) * 0.42 + sin(s * 0.11) * 0.18 + (fbm3(vec2(s * 0.15, vWp.y * 0.6)) - 0.5) * 0.35;
          float lc = (vWp.y - warp) * 2.3;
          float id = floor(lc);
          float f = fract(lc);
          // 层厚不一：每层内部再按哈希切成一厚一薄
          float split = 0.35 + 0.4 * hash12(vec2(id, 3.1));
          float sub = f < split ? 0.0 : 1.0;
          vec3 c = uPal[int(mod(floor(hash12(vec2(id, sub + 7.0)) * 8.0), 8.0))];
          // 层内细纹与颗粒
          float grain = vnoise(vec2(s * 9.0, vWp.y * 38.0));
          c *= 0.86 + 0.2 * grain + 0.08 * sin(f * 40.0 + fbm3(vec2(s * 2.0, id)) * 6.0);
          // 层理面：细暗线
          float edge = min(abs(f - split), min(f, 1.0 - f));
          c *= mix(0.62, 1.0, smoothstep(0.0, 0.035, edge));
          // 结晶基底：底部四分之一换成带斑点的深色花岗岩
          float bdepth = vWp.y - uBase;
          float basement = 1.0 - smoothstep(0.55, 0.85, bdepth + (fbm3(vec2(s * 0.4, 1.7)) - 0.5) * 0.6);
          vec3 granite = vec3(0.12, 0.115, 0.11) * (0.8 + 0.5 * step(0.82, hash12(floor(vec2(s, vWp.y) * 26.0))));
          c = mix(c, granite, basement);
          if (vTop > 0.0) {
            // 陆地：草皮 → 腐殖质表土 → 渐变到母岩
            float soil = 0.07 + 0.05 * fbm3(vec2(s * 0.8, 2.3));
            vec3 humus = vec3(0.13, 0.085, 0.05) * (0.8 + 0.4 * grain);
            c = mix(humus, c, smoothstep(soil * 0.7, soil * 1.4, below));
            float turf = 0.012 + 0.012 * vnoise(vec2(s * 14.0, 0.5));
            c = mix(vec3(0.16, 0.24, 0.07) * (0.8 + 0.4 * grain), c, smoothstep(turf, turf + 0.006, below));
          } else {
            // 海床：一层灰黄的泥沙
            float sed = 0.1 + 0.05 * fbm3(vec2(s * 0.6, 4.1));
            c = mix(vec3(0.36, 0.32, 0.24) * (0.85 + 0.3 * grain), c, smoothstep(sed, sed * 1.5, below));
          }
          diffuseColor.rgb = c;
        }`,
    })
  }
  mat.customProgramCacheKey = () => 'strata'
  return { mat, uniforms }
}

/** 海水剖面：几何带 aTop（海床高度，负值） */
function createSeaSectionMaterial() {
  const uniforms = {
    uTime: { value: 0 },
    uLight: { value: 1 },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aTop;
      varying float vTop;
      varying vec3 vWp;
      void main() {
        vTop = aTop;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWp = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uLight;
      uniform vec3 uSunColor;
      varying float vTop;
      varying vec3 vWp;
      ${NOISE_GLSL}
      float caustic(vec2 uv, float time) {
        vec2 p = mod(uv * 6.2831853, 6.2831853) - 250.0;
        vec2 i = p;
        float c = 1.0;
        for (int n = 0; n < 4; n++) {
          float t = time * (1.0 - 3.5 / float(n + 1));
          i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
          c += 1.0 / length(vec2(p.x / (sin(i.x + t) / 0.005), p.y / (cos(i.y + t) / 0.005)));
        }
        c /= 4.0;
        c = 1.17 - pow(c, 1.4);
        return pow(abs(c), 8.0);
      }
      void main() {
        float d = max(0.0, -vWp.y);
        float s = vWp.x + vWp.z;
        // 吸收：浅处青绿，深处墨蓝
        vec3 shallow = vec3(0.045, 0.26, 0.3);
        vec3 deep = vec3(0.004, 0.025, 0.07);
        vec3 c = mix(deep, shallow, exp(-d * 1.1));
        // 焦散：迭代扭曲出的网状亮线（越深越淡）
        float caus = caustic(vec2(s, vWp.y * 1.6) * 0.55, uTime * 0.35) * exp(-d * 1.6);
        // 光束：自水面斜射下来的淡淡光柱
        float shaft = pow(vnoise(vec2(s * 0.9 + vWp.y * 0.35 + uTime * 0.03, 0.5)), 3.0) * exp(-d * 0.9) * 0.35;
        c += uSunColor * (caus * 0.28 + shaft * 0.1);
        // 靠海床处浑浊一些
        c = mix(c, vec3(0.1, 0.13, 0.12), (1.0 - smoothstep(0.0, 0.25, vWp.y - vTop)) * 0.5);
        c *= uLight;
        // 水面：一条亮线（弯月面）
        float top = smoothstep(0.03, 0.0, d);
        c = mix(c, vec3(0.75, 0.9, 0.95) * uLight, top * 0.8);
        float a = mix(0.72, 0.93, 1.0 - exp(-d * 1.5));
        gl_FragColor = vec4(c * a, a);
      }
    `,
    // 预乘：与后期管线一致
    premultipliedAlpha: true,
  })
  return { mat, uniforms }
}

/** 胡桃木：沿 x 走向的年轮纹理，清漆面 */
function walnutMaterial(env: THREE.Texture) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: '#ffffff',
    roughness: 0.42,
    clearcoat: 0.45,
    clearcoatRoughness: 0.22,
    envMap: env,
    envMapIntensity: 0.25,
  })
  mat.onBeforeCompile = (sh) =>
    shadeByWorldPos(sh, {
      color: /* glsl */ `
        {
          // 年轮：到一条沿 x 延伸的"树心"的距离，被低频噪声扭曲
          vec2 r = vec2(vWp.z, vWp.y) * 2.4;
          float w = fbm3(vec2(vWp.x * 0.06, vWp.z * 0.2)) * 5.0 + fbm3(vec2(vWp.x * 0.5, vWp.y * 3.0)) * 0.6;
          float ring = fract(length(r + vec2(0.0, 30.0)) + w);
          float band = smoothstep(0.0, 0.18, ring) * (1.0 - smoothstep(0.55, 1.0, ring));
          // 木射线与导管：细长的亮暗纹
          float pore = vnoise(vec2(vWp.x * 3.0, (vWp.z + vWp.y) * 90.0));
          vec3 dark = vec3(0.022, 0.011, 0.0055);
          vec3 light = vec3(0.07, 0.036, 0.017);
          vec3 c = mix(dark, light, band * 0.75 + 0.25 * fbm3(vec2(vWp.x * 0.3, vWp.z * 4.0)));
          c *= 0.85 + 0.25 * pore;
          diffuseColor.rgb = c;
        }`,
    })
  mat.customProgramCacheKey = () => 'walnut'
  return mat
}

/** 桌面：深色亚麻，光池外沉进暗处 */
function tableMaterial(radius: number) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 })
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uR = { value: radius }
    shadeByWorldPos(sh, {
      fragDecl: 'uniform float uR;\nfloat gFall;',
      color: /* glsl */ `
        {
          // 亚麻织纹：经纬两向的细密起伏 + 粗细不匀的纱线
          vec2 p = vWp.xz * 7.0;
          float warp = 0.5 + 0.5 * sin(p.x * 6.2832) * (0.7 + 0.3 * vnoise(vec2(p.x * 0.3, p.y * 0.02)));
          float weft = 0.5 + 0.5 * sin(p.y * 6.2832) * (0.7 + 0.3 * vnoise(vec2(p.x * 0.02, p.y * 0.3)));
          float weave = mix(warp, weft, step(0.5, fract((floor(p.x) + floor(p.y)) * 0.5)));
          vec3 c = vec3(0.034, 0.032, 0.03) * (0.92 + 0.12 * weave) * (0.85 + 0.3 * fbm3(vWp.xz * 0.08)) * (0.94 + 0.12 * vnoise(vWp.xz * 3.1));
          // 光池：离沙盘越远越暗（连同高光一起压，掠射角的菲涅耳反光不会把远处桌面照亮）
          float r = length(vWp.xz) / uR;
          gFall = exp(-r * r * 1.6);
          diffuseColor.rgb = c;
        }`,
    })
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight *= gFall;\n#include <opaque_fragment>')
  }
  mat.customProgramCacheKey = () => 'table'
  return mat
}

/** 铭牌：黄铜底、刻字 */
function nameplateTexture(title: string, sub: string) {
  const W = 2048
  const H = 160
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, '#d8b670')
  grad.addColorStop(0.5, '#b8924c')
  grad.addColorStop(1, '#9c783a')
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)
  // 拉丝
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,240,200' : '80,55,20'},${Math.random() * 0.06})`
    g.fillRect(0, Math.random() * H, W, 1)
  }
  // 刻线边框
  g.strokeStyle = 'rgba(60,40,12,0.8)'
  g.lineWidth = 3
  g.strokeRect(14, 14, W - 28, H - 28)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const engrave = (text: string, font: string, y: number, spacing: number) => {
    g.font = font
    ;(g as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`
    // 刻痕：下沿一道亮边，字本身是暗的
    g.fillStyle = 'rgba(255,236,190,0.55)'
    g.fillText(text, W / 2, y + 2)
    g.fillStyle = '#3a2708'
    g.fillText(text, W / 2, y)
  }
  engrave(title.toUpperCase(), '600 70px "Cormorant Garamond", "Noto Serif SC", serif', H / 2 - 14, 26)
  engrave(sub, '600 34px "Cormorant Garamond", "Noto Serif SC", serif', H / 2 + 42, 8)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return { tex, aspect: W / H }
}

export interface DioramaOptions {
  SX: number
  SZ: number
  title: string
  subtitle: string
}

/**
 * 底座 + 包边 + 铭牌 + 桌面 + 背景，以及四周剖面的材质。
 * build() 随世界重建；垂直夸张只改变岩层底面高度，setBase() 整体平移即可。
 */
export class Diorama {
  readonly group = new THREE.Group()
  /** 展台（桌面、接触阴影、背景）：关掉时沙盘浮在页面上 */
  readonly stage = new THREE.Group()
  readonly strata = createStrataMaterial()
  readonly seaSection = createSeaSectionMaterial()
  /** 随世界重建的部分（原点在岩层底面） */
  private content = new THREE.Group()
  private stageContent = new THREE.Group()
  private env: THREE.Texture
  private pmrem: THREE.PMREMGenerator
  private sky = createSky()

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.env = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    // 展厅背景：近地面最暗，往上是一点点暖灰，没有日晕
    const u = this.sky.mat.uniforms
    u.uHorizon.value.setRGB(0.0035, 0.0038, 0.0045)
    u.uTop.value.setRGB(0.012, 0.012, 0.013)
    u.uSunColor.value.setRGB(0, 0, 0)
    this.stage.add(this.sky.mesh, this.stageContent)
    this.group.add(this.content, this.stage)
  }

  /** 光照强度与太阳颜色（海水剖面是自发光的着色器，要跟着太阳变） */
  setLight(k: number, sun: THREE.Color) {
    this.seaSection.uniforms.uLight.value = k
    this.seaSection.uniforms.uSunColor.value.copy(sun)
  }

  set time(t: number) {
    this.seaSection.uniforms.uTime.value = t
  }

  /** 岩层剖面底面高度（随垂直夸张变化） */
  setBase(base: number) {
    this.strata.uniforms.uBase.value = base
    this.content.position.y = base
    this.stageContent.position.y = base
  }

  private clearContent() {
    for (const g of [this.content, this.stageContent]) {
      g.traverse((c) => {
        const m = c as THREE.Mesh
        if (!m.isMesh) return
        m.geometry.dispose()
        const mat = m.material as THREE.MeshStandardMaterial
        mat.map?.dispose()
        mat.alphaMap?.dispose()
        mat.dispose()
      })
      g.clear()
    }
  }

  build(o: DioramaOptions) {
    this.clearContent()
    const { SX, SZ } = o
    const m = 1.3
    const hP = 2.4
    const trim = 0.14
    const PW = SX + m * 2
    const PD = SZ + m * 2

    // 胡桃木底座：顶面略低于岩层底，露出一圈木沿
    const plinth = new THREE.Mesh(new RoundedBoxGeometry(PW, hP, PD, 4, 0.22), walnutMaterial(this.env))
    plinth.position.y = -trim - hP / 2
    // 黄铜包边：夹在岩层与木座之间
    const band = new THREE.Mesh(
      new RoundedBoxGeometry(SX + 0.36, trim, SZ + 0.36, 2, 0.05),
      new THREE.MeshPhysicalMaterial({ color: '#c9a25a', metalness: 1, roughness: 0.28, envMap: this.env, envMapIntensity: 1.1 }),
    )
    band.position.y = -trim / 2
    for (const x of [plinth, band]) x.castShadow = x.receiveShadow = true

    // 铭牌：钉在朝向默认镜头的一面
    const { tex, aspect } = nameplateTexture(o.title, o.subtitle)
    const ph = hP * 0.42
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(ph * aspect, ph),
      new THREE.MeshPhysicalMaterial({ map: tex, metalness: 0.85, roughness: 0.32, envMap: this.env, envMapIntensity: 1.0 }),
    )
    plate.position.set(0, plinth.position.y, PD / 2 + 0.012)
    plate.receiveShadow = true
    this.content.add(plinth, band, plate)

    // 桌面与接触阴影：桌面只铺到光池暗透的地方，再往外是展厅背景
    const tableY = -trim - hP
    const R = Math.max(PW, PD) * 1.05
    const table = new THREE.Mesh(new THREE.PlaneGeometry(R * 8, R * 8).rotateX(-Math.PI / 2), tableMaterial(R))
    table.position.y = tableY
    table.receiveShadow = true
    const ao = new THREE.Mesh(
      new THREE.PlaneGeometry(PW + 8, PD + 8).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false, alphaMap: contactTexture(PW, PD) }),
    )
    ao.position.y = tableY + 0.01
    ao.renderOrder = 1
    this.stageContent.add(table, ao)
  }

  dispose() {
    this.clearContent()
    this.strata.mat.dispose()
    this.seaSection.mat.dispose()
    this.sky.mat.dispose()
    this.sky.mesh.geometry.dispose()
    this.env.dispose()
    this.pmrem.dispose()
  }
}

/** 底座下的接触阴影：圆角矩形的柔和暗影 */
function contactTexture(PW: number, PD: number) {
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = S
  cv.height = S
  const g = cv.getContext('2d')!
  const img = g.createImageData(S, S)
  const hx = PW / 2
  const hz = PD / 2
  const ex = hx + 4
  const ez = hz + 4
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = ((x + 0.5) / S - 0.5) * 2 * ex
      const pz = ((y + 0.5) / S - 0.5) * 2 * ez
      // 到底座矩形的距离（内部为负）
      const dx = Math.abs(px) - hx
      const dz = Math.abs(pz) - hz
      const out = Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0)
      const a = out < 0 ? 0.85 : 0.85 * Math.exp(-out * 1.1)
      const i = (y * S + x) * 4
      const v = Math.round(a * 255)
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return new THREE.CanvasTexture(cv)
}
