import * as THREE from 'three'
import { FS_VERT, FullscreenPass } from './fullscreen'

/**
 * 自动对焦的测距：在场景深度图上取画面某一点周围一小片的视空间深度，读回 CPU。
 *
 * 对焦在"看到的表面"而不是某个事先知道的点（轨道中心、地面上的拾取点）：
 * 低角度时画面中心往往是挡在视点前面的房子、树，按地面上的点对焦，主体就糊了。
 * 深度图里有画面上的一切，不需要知道场景里是什么网格。
 *
 * 取样是一个小圆盘，结果是各点深度的调和平均（按屈光度平均）：弥散圆与 |1/对焦 − 1/深度| 成正比，
 * 这样取的对焦距离使圆盘内各点的弥散圆总体最小；圆盘跨在屋檐与远处地面上时偏向近处的主体。
 * 没有几何体的像素（背景）不计。
 *
 * 读回是异步的（像素缓冲 + 栅栏同步），不打断 GPU 管线；结果晚一两帧到，对焦本来就要缓动。
 */

const FRAG = /* glsl */ `
  #include <packing>
  uniform sampler2D uDepth;
  uniform vec4 uSub;
  uniform vec2 uCenter;
  uniform vec2 uRadius;
  uniform float uNear;
  uniform float uFar;
  void main() {
    float acc = 0.0;
    float wsum = 0.0;
    for (int i = 0; i < 32; i++) {
      // 黄金角螺线：圆盘内均匀分布，靠中心的权重大
      float t = (float(i) + 0.5) / 32.0;
      float a = float(i) * 2.39996323;
      vec2 uv = clamp(uCenter + vec2(cos(a), sin(a)) * sqrt(t) * uRadius, vec2(0.0), vec2(1.0));
      float d = texture2D(uDepth, min(uv * uSub.xy, uSub.zw)).r;
      if (d >= 0.99999) continue;
      float z = -perspectiveDepthToViewZ(d, uNear, uFar);
      float w = 1.0 - 0.6 * t;
      acc += w / z;
      wsum += w;
    }
    // r：对焦距离（没有取到任何表面时为 0）；g：取到表面的比例
    gl_FragColor = vec4(wsum > 0.0 ? wsum / acc : 0.0, wsum / 22.4, 0.0, 1.0);
  }
`

export class FocusProbe {
  /** 最近一次读回的对焦距离（视空间深度，世界单位）；0 表示那里没有表面 */
  value = 0
  /** 有一次读回还没回来（期间不接受新的请求） */
  pending = false
  private rt: THREE.WebGLRenderTarget
  private mat: THREE.ShaderMaterial
  private fs = new FullscreenPass()
  private buf = new Float32Array(4)
  private serial = 0

  constructor(depth: THREE.DepthTexture) {
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
    this.mat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: FRAG,
      uniforms: {
        uDepth: { value: depth },
        uSub: { value: new THREE.Vector4(1, 1, 1, 1) },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uRadius: { value: new THREE.Vector2(0.02, 0.02) },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
      },
      depthTest: false,
      depthWrite: false,
    })
  }

  private draw(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, u: number, v: number, sub: THREE.Vector4, radius: number) {
    const mu = this.mat.uniforms
    mu.uSub.value.copy(sub)
    mu.uCenter.value.set(u, v)
    mu.uRadius.value.set(radius / camera.aspect, radius)
    mu.uNear.value = camera.near
    mu.uFar.value = camera.far
    const prev = renderer.getRenderTarget()
    this.fs.render(renderer, this.mat, this.rt)
    renderer.setRenderTarget(prev)
  }

  /**
   * 请求一次测距（在场景渲染之后调用）：(u, v) 为画面坐标（0~1，原点在左下），radius 为圆盘半径（相对画面高度），
   * sub 为这一帧实际渲染的子区域（动态分辨率，同 PostPipeline 的 sub）。结果回来时更新 value 并调用 done。
   * 上一次的读回还没回来时不受理，返回 false（调用方下一帧再请求）
   */
  request(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, u: number, v: number, sub: THREE.Vector4, radius: number, done: () => void): boolean {
    if (this.pending) return false
    this.draw(renderer, camera, u, v, sub, radius)
    this.pending = true
    const serial = ++this.serial
    renderer
      .readRenderTargetPixelsAsync(this.rt, 0, 0, 1, 1, this.buf)
      .then(() => {
        if (serial === this.serial) this.value = this.buf[0]
      })
      .catch(() => undefined)
      .finally(() => {
        if (serial !== this.serial) return
        this.pending = false
        done()
      })
    return true
  }

  /** 同步测距（导出图片前用：等不得异步结果）；会等 GPU 画完这一帧 */
  read(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, u: number, v: number, sub: THREE.Vector4, radius: number): number {
    this.draw(renderer, camera, u, v, sub, radius)
    renderer.readRenderTargetPixels(this.rt, 0, 0, 1, 1, this.buf)
    this.value = this.buf[0]
    return this.value
  }

  dispose() {
    this.serial++
    this.rt.dispose()
    this.mat.dispose()
    this.fs.dispose()
  }
}
