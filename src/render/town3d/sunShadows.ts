import * as THREE from 'three'

/**
 * 主光与三级阴影。
 *
 * 一张随镜头收缩的阴影贴图顾不了两头：贴近一栋房子平视时，脚下要厘米级的纹素，远处的城区又不能没有影子。
 * 这里用三张贴图：
 * - 全城一级：覆盖整个沙盘，只在太阳、人口变化时重画，镜头怎么动都不必重画；
 * - 近、中两级：以视点为中心的方框，边长随镜头距离（中级约为近级的五倍），只在视点移出一段、
 *   缩放明显时重画；绕视点转动不重画。方框的中心对齐到纹素格点，重画前后影子的边缘不会抖。
 * 片元落在哪一级的方框里就用哪一级，靠近方框边缘时向外一级渐变。
 *
 * 半影宽度按世界尺寸给（不随贴图的纹素大小变）：缩放时影子的软硬不变，级与级之间也看不出接缝。
 * 取样是 8 点的圆盘，每个像素转一个角度、每个累积帧再转一次，镜头静止时由时间累积收敛成平滑的半影。
 *
 * 实现：three.js 的平行光每盏一张阴影贴图、各算各的光照，没有"一盏灯多张贴图"的入口。
 * 这里放三盏平行光，第一盏是真正的主光，后两盏强度为零、只携带阴影贴图；
 * 并在全局的着色器片段 lights_fragment_begin 里加一个分支：场景里恰好是三盏带阴影的平行光时，
 * 只算第一盏的光照，阴影在三张贴图间按上面的规则选取。别的场景（世界沙盘只有一盏）走原来的分支，输出不变；
 * 沙盘里的材质不需要任何配合。
 */

let installed = false

/** 往 three.js 的着色器片段里装三级阴影的分支（幂等） */
function install() {
  if (installed) return
  installed = true
  const C = THREE.ShaderChunk
  const COND = '( NUM_DIR_LIGHTS == 3 ) && ( NUM_DIR_LIGHT_SHADOWS == 3 ) && defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_PCF )'
  C.shadowmap_pars_fragment += /* glsl */ `
#if ${COND}
	// 一级阴影：8 点圆盘的硬件比较取样；方框之外不遮挡
	float townCascadePCF( sampler2DShadow map, DirectionalLightShadow s, vec4 coord, float phi ) {
		vec3 c = coord.xyz / coord.w;
		c.z += s.shadowBias;
		if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
		vec2 r = s.shadowRadius / s.shadowMapSize;
		float sum = 0.0;
		for ( int k = 0; k < 8; k ++ ) sum += textureLod( map, vec3( c.xy + vogelDiskSample( k, 8, phi ) * r, c.z ), 0.0 );
		return sum * 0.125;
	}
	// 片元在这一级方框里的权重：内部为 1，靠近边缘渐变到 0
	float townCascadeWeight( vec4 coord ) {
		vec3 c = coord.xyz / coord.w;
		vec2 e = min( c.xy, 1.0 - c.xy );
		return step( c.z, 1.0 ) * smoothstep( 0.015, 0.09, min( e.x, e.y ) );
	}
#endif
`
  const src = C.lights_fragment_begin
  const a = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )')
  const b = src.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )')
  if (a < 0 || b < a) {
    // three.js 改了这段片段的写法：退回三盏灯各算各的（只有主光有强度，近级之外没有阴影），不至于出错
    console.warn('sunShadows: lights_fragment_begin 的结构变了，三级阴影没有装上')
    return
  }
  C.lights_fragment_begin =
    src.slice(0, a) +
    /* glsl */ `
#if ${COND} && defined( RE_Direct )
	// 聚落沙盘的主光（见 town3d/sunShadows.ts）：第一盏灯的光照，三张阴影贴图
	getDirectionalLightInfo( directionalLights[ 0 ], directLight );
	if ( receiveShadow ) {
		// 全城一级的 shadowIntensity 借来传累积帧的取样旋转；近、中两级的是开关
		float townPhi = ( interleavedGradientNoise( gl_FragCoord.xy ) + directionalLightShadows[ 2 ].shadowIntensity ) * PI2;
		float townW0 = directionalLightShadows[ 0 ].shadowIntensity * townCascadeWeight( vDirectionalShadowCoord[ 0 ] );
		float townSh = 1.0;
		if ( townW0 < 1.0 ) {
			float townW1 = directionalLightShadows[ 1 ].shadowIntensity * townCascadeWeight( vDirectionalShadowCoord[ 1 ] );
			if ( townW1 < 1.0 ) townSh = townCascadePCF( directionalShadowMap[ 2 ], directionalLightShadows[ 2 ], vDirectionalShadowCoord[ 2 ], townPhi );
			if ( townW1 > 0.0 ) townSh = mix( townSh, townCascadePCF( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ], vDirectionalShadowCoord[ 1 ], townPhi ), townW1 );
		}
		if ( townW0 > 0.0 ) townSh = mix( townSh, townCascadePCF( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ], vDirectionalShadowCoord[ 0 ], townPhi ), townW0 );
		directLight.color *= townSh;
	}
	RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#else
` +
    src.slice(a, b) +
    '\n#endif\n\n' +
    src.slice(b)
}

/** 主光离方框中心的距离（世界单位）：只决定阴影相机的位置，取大于沙盘对角线即可 */
const SUN_DIST = 400
/** 近级方框的最小半边长（米） */
const NEAR_MIN = 16

interface Box {
  x: number
  z: number
  /** 半边长（世界单位）；0 表示还没拟合过 */
  r: number
  on: boolean
}

export class SunShadows {
  /** [近, 中, 全城]；第一盏是主光 */
  readonly lights: THREE.DirectionalLight[]
  private boxes: Box[] = [
    { x: 0, z: 0, r: 0, on: false },
    { x: 0, z: 0, r: 0, on: false },
  ]
  private dirty = [true, true, true]
  private dir = new THREE.Vector3(0.4, 0.8, 0.4).normalize()
  private right = new THREE.Vector3(1, 0, 0)
  private up = new THREE.Vector3(0, 0, -1)
  /** 沙盘范围：半宽、半深、高度区间（世界单位），与世界单位 / 米 */
  private ext = { hx: 50, hz: 31, y0: -6, y1: 6, K: 0.05 }
  /** 全城一级的半边长（取两个方向里大的），近、中两级据此决定开关 */
  private farR = 70
  /** 半影宽度（世界单位） */
  private penumbra = 0.01
  private v = new THREE.Vector3()

  constructor(scene: THREE.Scene) {
    install()
    this.lights = [0, 1, 2].map((i) => {
      const l = new THREE.DirectionalLight(0xffffff, i === 0 ? 1 : 0)
      l.castShadow = true
      l.shadow.autoUpdate = false
      scene.add(l, l.target)
      return l
    })
  }

  /** 主光（颜色、强度由调用方设置） */
  get sun() {
    return this.lights[0]
  }

  /** 贴图尺寸：全城一级用 size，近、中两级用一半（方框小，纹素已经够细） */
  setSize(size: number) {
    const sizes = [Math.max(1024, size / 2), Math.max(1024, size / 2), size]
    this.lights.forEach((l, i) => {
      if (l.shadow.mapSize.x === sizes[i]) return
      l.shadow.mapSize.set(sizes[i], sizes[i])
      l.shadow.map?.dispose()
      l.shadow.map = null
      this.dirty[i] = true
    })
    this.boxes[0].r = this.boxes[1].r = 0
    this.placeFar()
  }

  /** 半影宽度（世界单位） */
  setPenumbra(p: number) {
    if (p === this.penumbra) return
    this.penumbra = p
    this.lights.forEach((_, i) => this.applyBias(i))
  }

  /** 主光方向（指向光源的单位向量） */
  setDirection(d: THREE.Vector3) {
    if (this.dir.distanceToSquared(d) < 1e-12) return
    this.dir.copy(d).normalize()
    // 阴影相机的朝向（与 three.js 的 lookAt 一致）：右 = 上 × 光向，上 = 光向 × 右
    this.right.set(0, 1, 0).cross(this.dir)
    if (this.right.lengthSq() < 1e-8) this.right.set(1, 0, 0)
    this.right.normalize()
    this.up.copy(this.dir).cross(this.right).normalize()
    this.boxes[0].r = this.boxes[1].r = 0
    this.placeFar()
  }

  /** 沙盘范围变了（换城） */
  setExtent(hx: number, hz: number, y0: number, y1: number, K: number) {
    this.ext = { hx, hz, y0, y1, K }
    this.boxes[0].r = this.boxes[1].r = 0
    this.placeFar()
  }

  /** 场景内容变了（人口、成长过渡）：三级都重画 */
  invalidate() {
    this.dirty[0] = this.boxes[0].on || this.dirty[0]
    this.dirty[1] = this.boxes[1].on || this.dirty[1]
    this.dirty[2] = true
  }

  /** 累积帧序号：每帧把圆盘取样转一个角度 */
  setFrame(n: number) {
    this.lights[2].shadow.intensity = (n * 0.61803398875) % 1
  }

  /**
   * 按视点与镜头距离拟合近、中两级：方框大小与位置变化不大时沿用上一次的贴图。
   * force：不管变化多小都按当前镜头重新拟合（测帧耗时用）
   */
  fit(target: THREE.Vector3, dist: number, force = false) {
    const { K } = this.ext
    const wantNear = Math.max(NEAR_MIN * K, dist)
    const wants = [wantNear, wantNear * 5]
    // 方框大到接近全城一级的纹素密度时关掉这一级
    const limit = [0.5, 0.8]
    for (let i = 0; i < 2; i++) {
      const b = this.boxes[i]
      const on = wants[i] * 1.25 < this.farR * limit[i]
      if (!on) {
        if (b.on || !b.r) {
          b.on = false
          b.r = b.r || 1
          this.lights[i].shadow.intensity = 0
          // 从未画过的贴图也要画一次：着色器里的取样器得绑着一张深度贴图
          if (!this.lights[i].shadow.map) this.place(i, target.x, target.z, 1)
        }
        continue
      }
      const moved = Math.hypot(target.x - b.x, target.z - b.z)
      if (!force && b.on && Math.abs(Math.log((wants[i] * 1.25) / b.r)) < 0.2 && moved < b.r * 0.2) continue
      b.on = true
      this.lights[i].shadow.intensity = 1
      this.place(i, target.x, target.z, wants[i] * 1.25)
    }
  }

  /** 把要重画的级交给渲染器；返回这一帧有没有重画阴影 */
  flush(renderer: THREE.WebGLRenderer): boolean {
    let any = false
    this.lights.forEach((l, i) => {
      l.shadow.needsUpdate = this.dirty[i]
      any ||= this.dirty[i]
      this.dirty[i] = false
    })
    if (any) renderer.shadowMap.needsUpdate = true
    return any
  }

  /** 全城一级：方框取沙盘（含底座四周一圈桌面）在光的方向上的投影 */
  private placeFar() {
    const { hx, hz, y0, y1 } = this.ext
    const m = 4
    let rx = 0
    let ry = 0
    for (let k = 0; k < 8; k++) {
      this.v.set((k & 1 ? 1 : -1) * (hx + m), k & 2 ? y1 : y0, (k & 4 ? 1 : -1) * (hz + m))
      rx = Math.max(rx, Math.abs(this.v.dot(this.right)))
      ry = Math.max(ry, Math.abs(this.v.dot(this.up) - ((y0 + y1) / 2) * this.up.y))
    }
    this.farR = Math.max(rx, ry)
    this.setCamera(2, 0, (y0 + y1) / 2, 0, rx, ry)
  }

  private place(i: number, x: number, z: number, r: number) {
    const b = this.boxes[i]
    b.x = x
    b.z = z
    b.r = r
    this.setCamera(i, x, 0, z, r, r)
  }

  /** 第 i 级的阴影相机：中心 (x, y, z)，光空间里的半宽 rx、半高 ry；中心对齐到纹素格点 */
  private setCamera(i: number, x: number, y: number, z: number, rx: number, ry: number) {
    const l = this.lights[i]
    const n = l.shadow.mapSize.x
    const c = this.v.set(x, y, z)
    const tx = (2 * rx) / n
    const ty = (2 * ry) / n
    const cx = c.dot(this.right)
    const cy = c.dot(this.up)
    c.addScaledVector(this.right, Math.round(cx / tx) * tx - cx).addScaledVector(this.up, Math.round(cy / ty) * ty - cy)
    l.target.position.copy(c)
    l.position.copy(c).addScaledVector(this.dir, SUN_DIST)
    l.updateMatrixWorld()
    l.target.updateMatrixWorld()
    // 深度范围：整个沙盘在光向上的跨度（方框外的高处也可能把影子投进来）
    const { hx, hz, y0, y1 } = this.ext
    const dc = c.dot(this.dir)
    let lo = Infinity
    let hi = -Infinity
    for (let k = 0; k < 8; k++) {
      const d = (k & 1 ? 1 : -1) * (hx + 5) * this.dir.x + (k & 2 ? y1 : y0) * this.dir.y + (k & 4 ? 1 : -1) * (hz + 5) * this.dir.z - dc
      lo = Math.min(lo, d)
      hi = Math.max(hi, d)
    }
    const sc = l.shadow.camera
    sc.left = -rx
    sc.right = rx
    sc.top = ry
    sc.bottom = -ry
    sc.near = Math.max(1, SUN_DIST - hi - 1)
    sc.far = SUN_DIST - lo + 1
    sc.updateProjectionMatrix()
    this.dirty[i] = true
    this.applyBias(i)
  }

  /** 取样半径与偏移：半影宽度换算成纹素；法线偏移随纹素与取样半径（盘越大，斜面上越容易自遮挡） */
  private applyBias(i: number) {
    const sh = this.lights[i].shadow
    const sc = sh.camera
    const texel = (sc.right - sc.left) / sh.mapSize.x
    const radius = Math.min(18, Math.max(1, this.penumbra / texel))
    sh.radius = radius
    sh.normalBias = texel * (1.1 + 0.55 * radius)
    sh.bias = -(texel * 0.35) / (sc.far - sc.near)
  }

  dispose() {
    for (const l of this.lights) {
      l.shadow.map?.dispose()
      l.removeFromParent()
      l.target.removeFromParent()
      l.dispose()
    }
  }
}
