import * as THREE from 'three'
import type { DisplayList } from '../atlas/svg/displayList'
import { buildSettlementVector } from '../../settlement/render'
import type { SettleStyleId } from '../../settlement/themes'
import type { Settlement } from '../../settlement/types'
import { NOISE_GLSL } from '../aerial/glsl'
import { WATER_LEVEL, type TerrainMesh } from './relief'

/**
 * 聚落沙盘的地面：
 * - 地形网格：见 relief.ts（在 Worker 里构建）。
 * - 地面贴图：二维渲染器只画地面层（田、绿地、街区底、水、路、院落，见 settlement/render.ts 的 ground3d），
 *   整幅栅格化为一张贴图；镜头拉近时另在视点附近栅格化一块高清块（约 0.2 米 / 像素）叠在上面。
 * - 水面：海平面附近的一个平面，按到水距离场决定深浅与透明度；静止的光滑水面（树脂水面的微缩感）。
 * - 四周剖面：世界沙盘的岩层与海水剖面材质。
 */

/** 地形网格（Worker 里算好的数组） */
export function terrainGeometry(t: TerrainMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(t.pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(t.uv, 2))
  g.setAttribute('normal', new THREE.BufferAttribute(t.nrm, 3, true))
  g.setIndex(new THREE.BufferAttribute(t.idx, 1))
  g.computeBoundingSphere()
  return g
}

/** 到水距离场 → 单通道贴图 */
export function waterTexture(st: Settlement, t: TerrainMesh) {
  const tex = new THREE.DataTexture(t.water, st.terrain.W, st.terrain.H, THREE.RedFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

/** 地面材质：整幅贴图 + 视点附近的高清块（uDetailRect：x0, z0, 1/宽, 1/高，米；宽为 0 时不用） */
export function createGroundMaterial(base: THREE.Texture, detail: THREE.Texture) {
  const mat = new THREE.MeshStandardMaterial({ map: base, roughness: 0.94, metalness: 0 })
  const uniforms = {
    uDetail: { value: detail },
    uDetailRect: { value: new THREE.Vector4(0, 0, 0, 0) },
  }
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGround;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = position.xz;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vGround;\nuniform sampler2D uDetail;\nuniform vec4 uDetailRect;\n${NOISE_GLSL}`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        if (uDetailRect.z > 0.0) {
          vec2 d = (vGround - uDetailRect.xy) * uDetailRect.zw;
          if (all(greaterThan(d, vec2(0.0))) && all(lessThan(d, vec2(1.0)))) {
            // 高清块四周留一圈渐变，与整幅贴图无缝衔接
            vec2 e = min(d, 1.0 - d);
            float k = smoothstep(0.0, 0.06, min(e.x, e.y));
            vec4 hd = texture2D(uDetail, vec2(d.x, 1.0 - d.y));
            diffuseColor.rgb = mix(diffuseColor.rgb, hd.rgb, k);
          }
        }
        // 地面的细微颗粒（草皮、土的不匀），近看不那么平
        diffuseColor.rgb *= 0.94 + 0.12 * vnoise(vGround * 0.9);`,
      )
  }
  mat.customProgramCacheKey = () => 'town-ground'
  return { mat, uniforms }
}

/**
 * 水面：按距离场取深浅（浅处透出河床、深处偏墨绿蓝），岸边淡出；
 * 法线加一点静止的细波纹，反射环境贴图与太阳高光
 */
export function createWaterMaterial(field: THREE.Texture, env: THREE.Texture, size: { w: number; h: number }) {
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, metalness: 0, transparent: true, envMap: env, envMapIntensity: 0.15 })
  const uniforms = {
    uField: { value: field },
    uSize: { value: new THREE.Vector2(size.w, size.h) },
  }
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGround;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = position.xz;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vGround;\nuniform sampler2D uField;\nuniform vec2 uSize;\n${NOISE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        float depth = (texture2D(uField, vGround / uSize).r * 255.0 - 128.0) / 4.0;
        if (depth < -0.4) discard;
        float deep = smoothstep(0.0, 18.0, depth);
        diffuseColor.rgb = mix(vec3(0.16, 0.3, 0.3), vec3(0.03, 0.09, 0.12), deep);
        diffuseColor.a = smoothstep(-0.4, 1.2, depth) * mix(0.55, 0.92, deep);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #include <normal_fragment_maps>
        {
          // 静止的细波纹：两层值噪声的梯度扰动法线（视空间里水面法线约等于 viewMatrix 的 y 轴）
          vec2 p = vGround * 0.35;
          float e = 0.35;
          float h0 = fbm3(p);
          vec2 gr = vec2(fbm3(p + vec2(e, 0.0)) - h0, fbm3(p + vec2(0.0, e)) - h0) / e;
          vec3 wn = normalize(vec3(-gr.x * 0.05, 1.0, -gr.y * 0.05));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`,
      )
  }
  mat.customProgramCacheKey = () => 'town-water'
  return { mat, uniforms }
}

/**
 * 四周剖面（米坐标，随城市组一起缩放）：岩层 + 海水截面；aTop 为该列地表高度（沙盘单位，岩层材质按它分层）。
 * K：米 → 沙盘单位；base：岩层底面（沙盘单位）
 */
export function skirtGeometries(st: Settlement, H: (x: number, z: number) => number, K: number, base: number) {
  const rockPos: number[] = []
  const rockTop: number[] = []
  const seaPos: number[] = []
  const seaTop: number[] = []
  const step = st.terrain.cell * 2
  const W = st.width
  const D = st.height
  const nx = Math.ceil(W / step)
  const nz = Math.ceil(D / step)
  const edges: [number, number][][] = [
    Array.from({ length: nx + 1 }, (_, i) => [Math.min(W, i * step), 0]),
    Array.from({ length: nz + 1 }, (_, i) => [W, Math.min(D, i * step)]),
    Array.from({ length: nx + 1 }, (_, i) => [Math.max(0, W - i * step), D]),
    Array.from({ length: nz + 1 }, (_, i) => [0, Math.max(0, D - i * step)]),
  ]
  const b = base / K
  const ground = (x: number, z: number) => Math.max(H(x, z), WATER_LEVEL - 4)
  for (const edge of edges) {
    for (let k = 0; k < edge.length - 1; k++) {
      const [x0, z0] = edge[k]
      const [x1, z1] = edge[k + 1]
      const h0 = ground(x0, z0)
      const h1 = ground(x1, z1)
      // 外侧朝外：沿边逆时针走（从上方看），面 (底0, 底1, 顶1, 顶0)
      quad(rockPos, rockTop, [x0, b, z0], [x1, b, z1], [x1, h1, z1], [x0, h0, z0], h0 * K, h1 * K, true)
      if (h0 < WATER_LEVEL || h1 < WATER_LEVEL) {
        quad(seaPos, seaTop, [x0, Math.min(h0, WATER_LEVEL), z0], [x1, Math.min(h1, WATER_LEVEL), z1], [x1, WATER_LEVEL, z1], [x0, WATER_LEVEL, z0], h0 * K, h1 * K, false)
      }
    }
  }
  const mk = (p: number[], top: number[]) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    g.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1))
    g.computeVertexNormals()
    return g
  }
  return { rock: mk(rockPos, rockTop), sea: seaPos.length ? mk(seaPos, seaTop) : null }
}

function quad(pos: number[], top: number[], a: number[], b: number[], c: number[], d: number[], ta: number, tb: number, ccw: boolean) {
  if (ccw) {
    pos.push(...a, ...c, ...b, ...a, ...d, ...c)
    top.push(ta, tb, tb, ta, ta, tb)
  } else {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d)
    top.push(ta, tb, tb, ta, tb, ta)
  }
}

/**
 * 地面贴图：二维渲染器的地面层栅格化到画布。
 * 显示列表按人口与风格缓存一份（高清块从同一份列表栅格化）
 */
export class GroundPainter {
  readonly base = document.createElement('canvas')
  readonly detail = document.createElement('canvas')
  private measurer = document.createElement('canvas').getContext('2d')!
  private list: DisplayList | null = null
  private key = ''
  private st: Settlement | null = null

  constructor(
    private maxTex: number,
    private detailSize = 2048,
  ) {
    // 高清块尺寸固定：贴图在显存里按首次上传的尺寸分配，之后只更新内容
    this.detail.width = this.detail.height = detailSize
  }

  /** 显示列表（同一快照、同一风格只建一次） */
  private listFor(st: Settlement, style: SettleStyleId) {
    const key = `${style}`
    if (this.list && this.st === st && this.key === key) return this.list
    this.list = buildSettlementVector(st, style, { labels: false, contours: false, ground3d: true }, this.measurer)
    this.st = st
    this.key = key
    return this.list
  }

  /** 整幅贴图：宽 texW 像素（不超过显卡上限），返回耗时与画布尺寸是否变了（变了要重新分配贴图） */
  paintBase(st: Settlement, style: SettleStyleId, texW = 4096) {
    const t0 = performance.now()
    const list = this.listFor(st, style)
    const t1 = performance.now()
    const w = Math.min(texW, this.maxTex)
    const sc = w / list.MW
    const h = Math.min(this.maxTex, Math.round(list.MH * sc))
    const cv = this.base
    const resized = cv.width !== w || cv.height !== h
    if (resized) {
      cv.width = w
      cv.height = h
    }
    const ctx = cv.getContext('2d')!
    list.render(ctx, sc, -list.M * sc, -list.M * sc, 'map', false)
    return { list: t1 - t0, raster: performance.now() - t1, resized }
  }

  /** 高清块：米坐标的矩形 [x0, z0, 边长 size] 栅格化到 detailSize 见方的画布 */
  paintDetail(x0: number, z0: number, size: number) {
    const list = this.list
    const st = this.st
    if (!list || !st) return false
    const cv = this.detail
    const S = list.MW / st.width
    const sc = this.detailSize / (size * S)
    const ctx = cv.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cv.width, cv.height)
    list.render(ctx, sc, -(list.M + x0 * S) * sc, -(list.M + z0 * S) * sc, 'map', false)
    return true
  }

  dispose() {
    this.list = null
    this.st = null
    this.base.width = this.base.height = 1
    this.detail.width = this.detail.height = 1
  }
}
