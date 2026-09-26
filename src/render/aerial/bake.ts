import * as THREE from 'three'
import { NOISE_GLSL } from './glsl'
import { HEIGHT_GLSL } from './heightGLSL'

/**
 * 地形烘焙：把"B 样条高度 + 侵蚀噪声位移 + 解析坡度"一次性算进一张浮点纹理
 * （每个网格顶点一个纹素：R 高度 km，G/B 坡度，A 侵蚀值）。
 * 之后顶点着色器、阴影通道、水面都只需采样一次，不再每帧重算几十次噪声。
 * 只有换世界或改垂直夸张时才重新烘焙。
 *
 * 同一个类也用来烘焙"视口高清块"：只覆盖镜头附近的一小块区域（setRegion），
 * 侵蚀噪声多算几层更细的冲沟；块的边缘渐变回粗网格的高度，拼接处无缝。
 */
export class TerrainBake {
  readonly rt: THREE.WebGLRenderTarget
  private mat: THREE.ShaderMaterial
  private scene = new THREE.Scene()
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  constructor(
    readonly GW: number,
    readonly GH: number,
    height: THREE.Texture,
    hSize: THREE.Vector2,
    mapSize: THREE.Vector2,
  ) {
    this.rt = new THREE.WebGLRenderTarget(GW, GH, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    })
    this.mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uHeight: { value: height },
        uHSize: { value: hSize },
        uMapSize: { value: mapSize },
        uDetailKm: { value: 1 },
        uVScale: { value: 1 },
        uGSize: { value: new THREE.Vector2(GW, GH) },
        uRegion: { value: new THREE.Vector4(0, 0, mapSize.x, mapSize.y) },
        uOct: { value: 4 },
      },
      vertexShader: /* glsl */ `
        void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uVScale;
        uniform vec2 uGSize;
        uniform vec4 uRegion;
        uniform int uOct;
        ${NOISE_GLSL}
        ${HEIGHT_GLSL}
        void main() {
          // 纹素 (i, j) 对应网格顶点 (i, j)
          vec2 f = (gl_FragCoord.xy - 0.5) / (uGSize - 1.0);
          vec2 xz = uRegion.xy + (f - 0.5) * uRegion.zw;
          float eN = uMapSize.x / (uHSize.x - 1.0) * 0.5;
          float b0 = bicubicHeight(xz);
          vec2 gB = vec2(bicubicHeight(xz + vec2(eN, 0.0)) - b0, bicubicHeight(xz + vec2(0.0, eN)) - b0) / eN;
          float amp = detailAmp(b0, length(gB) * uVScale);
          vec3 er = amp > 0.0 ? erosionNoise(xz, gB * uVScale, 4, 2.3) : vec3(0.0);
          if (uOct > 4 && amp > 0.0) {
            // 高清块：更多、更细的冲沟层，边缘渐变回粗网格的 4 层结果
            vec2 ff = min(f, 1.0 - f);
            float w = smoothstep(0.0, 0.12, min(ff.x, ff.y));
            // 细层按常规衰减太弱，放大一倍，近看才有清晰的小冲沟与刃脊
            er += (erosionNoise(xz, gB * uVScale, uOct, 2.3) - er) * w * 2.2;
          }
          gl_FragColor = vec4(b0 + amp * (er.x - 0.15), gB + amp * er.yz, er.x);
        }
      `,
    })
    const tri = new THREE.BufferGeometry()
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    const mesh = new THREE.Mesh(tri, this.mat)
    mesh.frustumCulled = false
    this.scene.add(mesh)
  }

  /** 烘焙区域（世界坐标中心与尺寸）与侵蚀层数 */
  setRegion(cx: number, cz: number, sx: number, sz: number, octaves: number) {
    this.mat.uniforms.uRegion.value.set(cx, cz, sx, sz)
    this.mat.uniforms.uOct.value = octaves
  }

  bake(renderer: THREE.WebGLRenderer, vScale: number, detailKm = 1) {
    this.mat.uniforms.uVScale.value = vScale
    this.mat.uniforms.uDetailKm.value = detailKm
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(this.rt)
    renderer.render(this.scene, this.cam)
    renderer.setRenderTarget(prev)
  }

  dispose() {
    this.rt.dispose()
    this.mat.dispose()
  }
}

/** 顶点/片元里按世界坐标采样烘焙纹理 */
export const BAKED_GLSL = /* glsl */ `
uniform sampler2D uBaked;
uniform vec2 uGSize;
uniform vec2 uBMapSize;
uniform vec2 uBOrigin;
vec4 bakedAt(vec2 xz) {
  vec2 f = (xz - uBOrigin) / uBMapSize + 0.5;
  return texture(uBaked, (f * (uGSize - 1.0) + 0.5) / uGSize);
}
`
