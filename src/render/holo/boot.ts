/**
 * 图框与辅助线的进入动画（片头逐帧录制用）。
 * 每一小段线带一对时刻 (t0, t1)：t0 之前不画，t0~t1 之间从起点画到终点，线头加亮；画完的瞬间闪一下再回落。
 * 时刻都按同一个片头时钟（秒）计，时钟由 bootClock 统一给出；平时时钟停在很远的将来，所有线都已画完，与原样一致
 */
import * as THREE from 'three'
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'

/**
 * 片头的进入动画时刻（秒，[开始, 画完]）：图框（角标、外框与刻度、内外两道细框、中线、投影线与顶框）
 * 与线框盒（竖棱、顶面外框、立面竖格与高程线、顶面网格、地形侧视轮廓），以及立牌亮起的时刻
 */
export const BOOT = {
  corner: [0, 0.35],
  frame: [0.25, 1.25],
  outer: [0.1, 0.95],
  inner: [0.55, 1.45],
  mid: [0.9, 1.6],
  rise: [1.2, 2.1],
  crown: [2.1, 2.8],
  pillar: [1.5, 2.3],
  lid: [2.3, 3],
  facade: [2.5, 3.2],
  levels: [2.8, 3.5],
  roof: [2.9, 3.8],
  outline: [3.2, 4.6],
  header: 3.4,
} as const
/** 进入动画画完的时刻（秒） */
export const BOOT_LEN = BOOT.outline[1]
/** 地板底纹铺满时的方形距离（以图框为 1，超出画面） */
export const FLOOR_FULL = 9

/** 片头时钟（秒）：所有带进入动画的线共用这一个 uniform */
export const bootClock = { value: 1e6 }

/** 已改过着色器的材质（避免重复挂 onBeforeCompile） */
const patched = new WeakSet<LineMaterial>()

/**
 * 给线材质加上进入动画：按 instanceBoot 属性（每段的 t0、t1）截短线段、加亮线头与收尾时的闪光。
 * ease 为 true 时画线的速度先快后慢（缓出），否则匀速
 */
export function bootMaterial(m: LineMaterial, ease = false) {
  if (patched.has(m)) return m
  patched.add(m)
  m.customProgramCacheKey = () => `boot${ease ? 1 : 0}`
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBoot = bootClock
    sh.vertexShader = sh.vertexShader
      .replace(
        'uniform float linewidth;',
        `uniform float linewidth;
        uniform float uBoot;
        attribute vec2 instanceBoot;
        varying float vBootF;
        varying float vBootAlong;
        varying float vBootAge;`,
      )
      .replace(
        'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );',
        `float bootF = clamp( ( uBoot - instanceBoot.x ) / max( 1e-4, instanceBoot.y - instanceBoot.x ), 0.0, 1.0 );
        ${ease ? 'bootF = 1.0 - pow( 1.0 - bootF, 3.0 );' : ''}
        vBootF = uBoot < instanceBoot.x ? 0.0 : bootF;
        vBootAlong = position.y < 0.5 ? 0.0 : 1.0;
        vBootAge = uBoot - instanceBoot.y;
        vec4 end = modelViewMatrix * vec4( mix( instanceStart, instanceEnd, max( bootF, 1e-3 ) ), 1.0 );`,
      )
    sh.fragmentShader = sh.fragmentShader
      .replace(
        'uniform float linewidth;',
        `uniform float linewidth;
        varying float vBootF;
        varying float vBootAlong;
        varying float vBootAge;`,
      )
      .replace(
        'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
        `if ( vBootF <= 0.0 ) discard;
        // 正在画：越靠线头越亮；刚画完：整段闪一下，0.4 秒内回落
        float bootHead = vBootF < 1.0 ? pow( vBootAlong, 6.0 ) * 2.6 : 0.0;
        float bootFlash = vBootF >= 1.0 ? exp( - max( vBootAge, 0.0 ) * 7.0 ) * 1.4 : 0.0;
        diffuseColor.rgb *= 1.0 + bootHead + bootFlash;
        gl_FragColor = vec4( diffuseColor.rgb, alpha * ( 1.0 + bootHead * 0.5 ) );`,
      )
  }
  m.needsUpdate = true
  return m
}

/** 给一组线段写入各段的 (t0, t1)，times 每段两个数，与线段一一对应 */
export function bootTimes(line: LineSegments2, times: number[]) {
  line.geometry.setAttribute('instanceBoot', new THREE.InstancedBufferAttribute(new Float32Array(times), 2))
  return line
}

/**
 * 按每段的两端算 (t0, t1)：pos 为线段端点坐标串（每段 6 个数），fn 返回该段的 [t0, t1]
 */
export function timesOf(pos: ArrayLike<number>, fn: (a: [number, number, number], b: [number, number, number], i: number, n: number) => [number, number]) {
  const n = pos.length / 6
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const o = i * 6
    out.push(...fn([pos[o], pos[o + 1], pos[o + 2]], [pos[o + 3], pos[o + 4], pos[o + 5]], i, n))
  }
  return out
}

/**
 * 点在矩形（半宽 hx、半深 hz）周边上、按顺时针走到它所在那条边的比例（0~1）：
 * 与 rect() 写边的顺序一致（北边自西向东、东边自北向南、南边自东向西、西边自南向北）
 */
export function perimeterFrac(x: number, z: number, hx: number, hz: number) {
  const e = 1e-3
  if (Math.abs(z + hz) < e) return (x + hx) / (2 * hx)
  if (Math.abs(x - hx) < e) return (z + hz) / (2 * hz)
  if (Math.abs(z - hz) < e) return (hx - x) / (2 * hx)
  return (hz - z) / (2 * hz)
}

/**
 * 霓虹灯管通电：进度 p（0~1）对应的亮度。先断续闪两三下、中途一次半亮，再稳定点亮；
 * 熄灭时进度倒着走，闪烁的次序也倒过来
 */
export function neonFlicker(p: number) {
  if (p <= 0) return 0
  if (p >= 1) return 1
  const steps: [number, number, number][] = [
    [0.06, 0.1, 1],
    [0.16, 0.19, 0.55],
    [0.26, 0.34, 1],
    [0.42, 0.46, 0.35],
    [0.55, 0.6, 1],
    [0.66, 0.7, 0.6],
    [0.76, 1, 1],
  ]
  for (const [a, b, v] of steps) if (p >= a && p < b) return v
  return 0.04
}

/**
 * 文字、立牌的进入：t 秒起闪烁着亮起（全息投影接通时的抖动），0.35 秒后稳定。返回 0~1 的不透明度
 */
export function bootFlicker(clock: number, t: number) {
  const s = clock - t
  if (s <= 0) return 0
  if (s >= 0.35) return 1
  // 确定性的抖动：同一时刻总是同一个值，逐帧录制可复现
  const n = Math.sin(s * 211.7 + t * 37.3) * 43758.5453
  const r = n - Math.floor(n)
  return (s / 0.35) * (r > 0.35 ? 1 : 0.25)
}
