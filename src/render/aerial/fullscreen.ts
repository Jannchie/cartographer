import * as THREE from 'three'

/** 全屏三角形的顶点着色器：输出 vUv */
export const FS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

/** 全屏 pass：一个覆盖整个屏幕的三角形，换材质画到指定目标 */
export class FullscreenPass {
  private scene = new THREE.Scene()
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private mesh: THREE.Mesh

  constructor() {
    const tri = new THREE.BufferGeometry()
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    this.mesh = new THREE.Mesh(tri)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }

  render(renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.mesh.material = material
    renderer.setRenderTarget(target)
    renderer.render(this.scene, this.cam)
  }

  dispose() {
    this.mesh.geometry.dispose()
  }
}
