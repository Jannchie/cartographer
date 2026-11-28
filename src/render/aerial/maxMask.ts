import * as THREE from 'three'

/**
 * 俯视的全图遮罩：把一组条带网格正交投影到整张地图（x、z 按 uMap 映射到裁剪空间），
 * 重叠处取最大值（交叉、重叠不叠加变浓）。道路遮罩与河谷下切图各给自己的着色器与纹理格式。
 * 顶点着色器里可以用 uniform vec2 uMap（地图的世界尺寸）。
 */
export class MaxMask {
  readonly rt: THREE.WebGLRenderTarget
  private scene = new THREE.Scene()
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private mat: THREE.ShaderMaterial

  /** 纹理宽取地图格数的 4 倍（不超过 4096），高按地图比例 */
  constructor(W: number, H: number, mapSize: THREE.Vector2, shader: { vertexShader: string; fragmentShader: string }, target: THREE.RenderTargetOptions = {}) {
    const cw = Math.min(4096, W * 4)
    const ch = Math.round((cw * H) / W)
    this.rt = new THREE.WebGLRenderTarget(cw, ch, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, ...target })
    this.mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      uniforms: { uMap: { value: mapSize } },
      ...shader,
    })
  }

  /** 清空后把 geo 画进遮罩（不释放 geo）；画完恢复渲染器原来的渲染目标与清屏色 */
  render(renderer: THREE.WebGLRenderer, geo: THREE.BufferGeometry) {
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
  }

  dispose() {
    this.rt.dispose()
    this.mat.dispose()
  }
}
