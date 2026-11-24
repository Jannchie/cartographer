import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { NOISE_GLSL } from '../aerial/glsl'
import { LIFE_GLSL } from './buildingShader'
import type { TreeKind, TreeSet } from './vegetation'

/**
 * 沙盘的树：每种树形一个实例化网格（实例数据见 vegetation.ts，在 Worker 里构建）。
 * 位置、大小与生卒都在顶点着色器里由实例属性给出。
 */

type Uniforms = Record<string, THREE.IUniform>

/** 树：实例属性 aTree (x, 地面高, z, 冠径)、aTreeLife；uShape (横向, 竖向, 抬高) 按冠径缩放，颜色按位置哈希 */
function patchTree(mat: THREE.Material, u: Uniforms, shape: THREE.Vector3, tint: THREE.Color, depth: boolean) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, { uShape: { value: shape }, uTint: { value: tint } })
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${LIFE_GLSL}\n${NOISE_GLSL}\nattribute vec4 aTree;\nattribute vec2 aTreeLife;\nuniform vec3 uShape;\nuniform vec3 uTint;\nvarying vec3 vTint;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float lk = lifeK(aTreeLife);
        float h = hash12(aTree.xz);
        float r = aTree.w * lk * (0.9 + 0.2 * h);
        transformed = vec3(position.x * uShape.x, position.y * uShape.y + uShape.z, position.z * uShape.x) * r + aTree.xyz;
        if (lk <= 0.0) transformed = vec3(0.0);
        vTint = uTint * (0.75 + 0.5 * hash12(aTree.zx + 3.7));`,
      )
    if (depth) return
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vTint;')
  }
  mat.customProgramCacheKey = () => `town-tree-${depth ? 'd' : 'c'}`
}

/** 各树形的树冠几何与比例（冠径为 1 时）：横向半径、竖向半径、中心离地 */
const TREE_SHAPE: Record<TreeKind, { geo: () => THREE.BufferGeometry; shape: [number, number, number]; tint: string }> = {
  broadleaf: { geo: () => new THREE.IcosahedronGeometry(1, 0), shape: [0.85, 0.8, 0.85], tint: '#4d6b24' },
  conifer: { geo: () => new THREE.ConeGeometry(1, 1, 7, 1, true), shape: [0.7, 2.4, 1.2], tint: '#2f4d26' },
  columnar: { geo: () => new THREE.OctahedronGeometry(1, 0), shape: [0.42, 1.25, 1.25], tint: '#35522a' },
}

/** 一种树形的实例化网格：成长的生卒由共享的 uniform（uPop、uPrev、uT）驱动；自带深度材质（userData.depth，随网格一起释放） */
export function createTreeMesh(t: TreeSet, u: Uniforms): THREE.Mesh {
  const s = TREE_SHAPE[t.kind]
  // 只留位置并合并共用顶点：平面着色的法线在片元里由导数求出，顶点着色器的调用数降到约五分之一
  const raw = s.geo()
  raw.deleteAttribute('normal')
  raw.deleteAttribute('uv')
  const src = mergeVertices(raw)
  raw.dispose()
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', src.getAttribute('position'))
  g.setIndex(src.index)
  const ib = new THREE.InstancedInterleavedBuffer(t.data, 6)
  g.setAttribute('aTree', new THREE.InterleavedBufferAttribute(ib, 4, 0))
  g.setAttribute('aTreeLife', new THREE.InterleavedBufferAttribute(ib, 2, 4))
  g.instanceCount = t.count
  const shape = new THREE.Vector3(...s.shape)
  const tint = new THREE.Color(s.tint)
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, flatShading: true })
  patchTree(mat, u, shape, tint, false)
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  patchTree(depth, u, shape, tint, true)
  const m = new THREE.Mesh(g, mat)
  m.customDepthMaterial = depth
  m.castShadow = m.receiveShadow = true
  // 位置在着色器里由实例属性给出：包围球按不到，不做视锥裁剪
  m.frustumCulled = false
  m.userData.depth = depth
  return m
}
