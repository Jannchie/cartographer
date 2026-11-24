import * as THREE from 'three'
import { NOISE_GLSL } from '../aerial/glsl'
import { LIFE_GLSL } from './buildingShader'
import { HEIGHT_SCALE, SP, SPECIES, SPECIES_COUNT } from './treeSpecies'

/**
 * 树的材质：在 MeshStandardMaterial / MeshDepthMaterial 上补实例的摆放、细节层级的淡入淡出与树冠的着色。
 *
 * 两套顶点程序，片元的光照部分共用：
 * - 近景（near）：各树形的网格（treeMeshes.ts）。片元里按树冠表面的三维蜂窝画出一簇簇的叶——簇与簇的明暗、
 *   法线的错动，贴近轮廓处按簇镂空（轮廓是参差的叶缘而不是光滑的球面）；簇小于像素时全部淡出到平均色
 * - 远景（far）：所有树形共用一个回转体，轮廓、法线与遮蔽由顶点程序按树形表（treeSpecies.ts）给出
 *
 * 细节层级：每一级只画镜头距离落在 uLodRange 里的实例，两级交界处用抖动（屏幕空间噪声，逐帧换相位）交叉淡入淡出，
 * 静止后的时间累积把它收成平滑的过渡；阴影通道在交界的中点一刀切开。
 *
 * 光照：直射与天光之外，
 * - 遮蔽：顶点烘焙的遮蔽压暗天光与一部分直射；密林里（郁闭度高）树冠的下半截再压暗
 * - 透光：逆光看时树冠边缘透出偏黄的光。树冠自己的阴影不该挡掉它，所以另取一个朝太阳挪出树冠的点查阴影贴图
 *   （只问"这棵树照不照得到太阳"）；远景干脆只用这一次查询，自身的明暗由法线给出，免得粗阴影贴图在树冠上起斑
 */

type Uniforms = Record<string, THREE.IUniform>

const HASH3_GLSL = /* glsl */ `
  vec3 tHash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float tNoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float a = mix(tHash33(i).x, tHash33(i + vec3(1.0, 0.0, 0.0)).x, u.x);
    float b = mix(tHash33(i + vec3(0.0, 1.0, 0.0)).x, tHash33(i + vec3(1.0, 1.0, 0.0)).x, u.x);
    float c = mix(tHash33(i + vec3(0.0, 0.0, 1.0)).x, tHash33(i + vec3(1.0, 0.0, 1.0)).x, u.x);
    float d = mix(tHash33(i + vec3(0.0, 1.0, 1.0)).x, tHash33(i + vec3(1.0, 1.0, 1.0)).x, u.x);
    return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
  }
  /** 叶簇：三维蜂窝（只查 2×2×2 邻域）。返回自最近的簇心指向 p 的向量，id 为那一簇的三个随机数 */
  vec3 tLeafCells(vec3 p, out vec3 id) {
    vec3 i = floor(p - 0.5), f = p - i;
    float best = 8.0;
    vec3 to = vec3(0.0);
    id = vec3(0.5);
    for (int z = 0; z <= 1; z++) for (int y = 0; y <= 1; y++) for (int x = 0; x <= 1; x++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 h = tHash33(i + g);
      vec3 d = f - g - h;
      float dd = dot(d, d);
      if (dd < best) { best = dd; id = h; to = d; }
    }
    return to;
  }
`

/** 顶点：实例属性、细节层级与个体的变换（横竖比例、倾斜、朝向） */
const VERT_COMMON = /* glsl */ `
  ${LIFE_GLSL}
  ${NOISE_GLSL}
  attribute vec4 aTree;
  attribute vec2 aTreeLife;
  attribute vec4 aTreeA;
  attribute vec4 aTreeC;
  uniform vec3 uLodCam;
  uniform vec4 uLodRange;
  vec2 tRot;
  float tWs;
  float tHs;
  vec2 tLean;
  void treeSetup(float lean, float aligned) {
    float s1 = aTreeA.w, s2 = aTreeC.w;
    float a = s1 * 6.2831853;
    tRot = vec2(cos(a), sin(a));
    tHs = mix(${HEIGHT_SCALE[0].toFixed(3)}, ${HEIGHT_SCALE[1].toFixed(3)}, aTreeA.y);
    tWs = aligned > 0.5 ? 1.0 : 0.9 + 0.22 * fract(s1 * 7.31 + s2 * 3.17);
    float la = s2 * 6.2831853;
    tLean = aligned > 0.5 ? vec2(0.0) : vec2(cos(la), sin(la)) * lean * (0.3 + s2);
  }
  vec3 treePlace(vec3 p) {
    p.xz *= tWs;
    p.y *= tHs;
    p.xz += tLean * p.y * p.y;
    p.xz = vec2(tRot.x * p.x - tRot.y * p.z, tRot.y * p.x + tRot.x * p.z);
    return p;
  }
  vec3 treeNormal(vec3 n) {
    n.xz /= tWs;
    n.y /= tHs;
    n.xz = vec2(tRot.x * n.x - tRot.y * n.z, tRot.y * n.x + tRot.x * n.z);
    return normalize(n);
  }
  /** 这一级里的可见度：(淡入, 淡出)，片元按抖动噪声 n 保留 淡出 <= n < 淡入 的 */
  vec2 treeFade() {
    float d = distance(aTree.xyz, uLodCam);
    return vec2(smoothstep(uLodRange.x, uLodRange.y, d), smoothstep(uLodRange.z, uLodRange.w, d));
  }
`

/** 顶点：朝太阳挪出树冠的点的阴影坐标（主光方向由阴影矩阵的深度一行读出） */
const SHADOW_FAR_PARS = /* glsl */ `
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    varying vec4 vShadowFar;
  #endif
`
const SHADOW_FAR_VERT = /* glsl */ `
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  {
    mat4 sm = directionalShadowMatrix[ 0 ];
    vec3 toSun = -normalize(vec3(sm[0][2], sm[1][2], sm[2][2]));
    float crown = aTree.w * tCrown * length(modelMatrix[0].xyz);
    vShadowFar = sm * (worldPosition + vec4(toSun * crown * 2.4, 0.0));
  }
  #endif
`

/** 片元：细节层级的抖动淡入淡出（tDn 为这个像素这一帧的抖动噪声） */
const FADE_FRAG = /* glsl */ `
  float tDn = fract(fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) + uDither);
  if (tDn >= vFade.x || tDn < vFade.y) discard;
`

/** 片元：遮蔽与透光（接在光照之后）。用到 tAo、tLeafM（叶为 1）、tTip（梢度）与 vTree（郁闭度, 高度比） */
const LIGHT_FRAG = /* glsl */ `
  {
    // 密林里树冠的下半截照不到天光
    float ao = tAo * mix(1.0, 0.3 + 0.7 * smoothstep(0.0, 0.8, vTree.y), vTree.x);
    // 天光不压到全黑：叶层之间总有漫射进来的光。叶是半透的，背阴处靠层层透射与散射比不透明的表面亮
    reflectedLight.indirectDiffuse *= (0.3 + 0.7 * ao) * mix(1.25, 1.8, tLeafM);
    // 夜里：月光下的树冠主要靠整片夜空透过叶层照亮，半球天光低估了它；不补的话深色的叶在浅色的地面上只剩纯黑的剪影
    reflectedLight.indirectDiffuse *= 1.0 + 2.0 * uNight * tLeafM;
    reflectedLight.indirectSpecular *= ao;
    reflectedLight.directDiffuse *= mix(1.0, ao, 0.5);
    // 叶面的高光压低：法线错动后掠射角上的高光会成片发白
    reflectedLight.directSpecular *= ao * ao * mix(1.0, 0.25, tLeafM);
    #if NUM_DIR_LIGHTS > 0
    {
      float lit = 1.0;
      #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0 && defined( SHADOWMAP_TYPE_PCF )
        vec3 sc = vShadowFar.xyz / vShadowFar.w;
        if (sc.x >= 0.0 && sc.x <= 1.0 && sc.y >= 0.0 && sc.y <= 1.0 && sc.z <= 1.0) lit = texture(directionalShadowMap[ 0 ], vec3(sc.xy, sc.z + directionalLightShadows[ 0 ].shadowBias));
      #endif
      vec3 sl = directionalLights[ 0 ].direction;
      // 逆光：视线越对着太阳、越靠树冠边缘，透出的光越多
      float back = pow(saturate(dot(geometryViewDir, -sl)), 3.0);
      float rim = pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 2.0);
      // 背光面：阳光穿过叶层散射进来（包裹光照），背光的半边不是死黑
      float nl = dot(geometryNormal, sl);
      float scatter = (saturate((nl + 0.7) / 1.7) - saturate(nl)) * 0.3;
      float t = (back * (0.18 + 0.82 * rim) * 0.75 + scatter) * (0.35 + 0.65 * tTip) * (0.4 + 0.6 * ao) * tLeafM;
      reflectedLight.directDiffuse += directionalLights[ 0 ].color * lit * diffuseColor.rgb * vec3(1.35, 1.25, 0.45) * (t * RECIPROCAL_PI);
      // 叶层里的多次透射与散射：整棵树晒得到太阳时，背阴、落在别的团块影子里的叶也被透过来的光照着，
      // 不是死黑（深色的叶在浅色的地面旁，只靠天光会被后期压成纯黑）
      reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * lit * diffuseColor.rgb * (0.12 * (0.2 + 0.8 * saturate(-nl * 1.5 + 0.3)) * (0.4 + 0.6 * ao) * tLeafM);
      // 地面的反光：晒着的地面把光反上来，照亮树干与冠底（场景里没有全局光照，树下不该是死黑）
      vec3 up = normalize(viewMatrix[1].xyz);
      float bounce = saturate(dot(sl, up)) * 0.3 * (0.5 - 0.5 * dot(geometryNormal, up)) * (1.0 - 0.6 * vTree.x);
      reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * diffuseColor.rgb * (bounce * (0.5 + 0.5 * tAo) * RECIPROCAL_PI);
    }
    #endif
  }
`

const NS = SPECIES_COUNT

// —— 近景 ——
const NEAR_VERT_PARS = /* glsl */ `
  ${VERT_COMMON}
  attribute vec4 aCol;
  attribute vec4 aVtx;
  attribute vec4 aTreeG;
  /** 倾斜量、形变量、朝向固定、树高（冠径单位） */
  uniform vec4 uForm;
  /** 树冠半径（冠径单位） */
  uniform float uCrown;
`
/** 摆放：算出 tp（单位树，已做个体形变）、tPos（聚落米坐标）、tFade、lk */
const NEAR_PLACE = /* glsl */ `
  treeSetup(uForm.x, uForm.z);
  float tCrown = uCrown;
  float lk = lifeK(aTreeLife);
  vec2 tFade = treeFade();
  vec3 tp = position;
  {
    // 个体形变：树冠连同枝梢按低频场错动（根部不动），同一树形的个体轮廓各不相同
    vec3 q = tp * 1.9 + vec3(aTreeA.w * 31.0, aTreeC.w * 17.0, aTreeA.w * 53.0);
    tp += uForm.y * smoothstep(0.15, 0.9, tp.y) * vec3(sin(q.y * 1.7 + q.z * 1.3), 0.5 * sin(q.z * 1.9 + q.x * 1.1), sin(q.x * 1.5 + q.y * 2.1));
  }
  vec3 tPos = treePlace(tp) * (aTree.w * lk);
  // 沿线排布的（绿篱、藤架）顺着地面的坡度走
  if (uForm.z > 0.5) tPos.y += dot((aTreeG.xy * 255.0 - 128.0) / 100.0, tPos.xz);
  tPos += aTree.xyz;
`

const FRAG_COMMON = /* glsl */ `
  uniform float uDither;
  /** 夜（0 ~ 1，与城里的窗灯同一个量） */
  uniform float uNight;
  varying vec2 vFade;
  varying vec3 vLeaf;
  varying vec3 vTree;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    varying vec4 vShadowFar;
  #endif
`

const NEAR_FRAG_PARS = /* glsl */ `
  ${FRAG_COMMON}
  ${HASH3_GLSL}
  /** 叶簇的大小（米）、竖向拉伸、轮廓的镂空、粗糙度 */
  uniform vec4 uLeaf;
  /** 树冠表面零星透空的比例（透过去看到的是团块背面的暗处） */
  uniform float uHole;
  varying vec3 vObj;
  varying vec4 vVtx;
  varying vec4 vCol;
`

/** 片元：部位的固有色、叶簇与镂空。写 tAo、tLeafM、tTip、tRough、tBump（世界空间的法线错动） */
const NEAR_FRAG_COLOR = /* glsl */ `
  ${FADE_FRAG}
  float tKind = vVtx.z;
  float tAo = vVtx.x;
  float tLeafM = step(0.12, tKind);
  float tTip = 0.0;
  float tRough = 0.95;
  vec3 tBump = vec3(0.0);
  {
    // 一个像素对应的米数：叶簇、小叶、树皮的纹理按它淡出
    float aa = max(length(fwidth(vObj)), 1e-4);
    if (tKind > 0.75) {
      // 簇的尺度：近处是一簇叶的大小；远了成倍放大，始终有几个像素大（轮廓的参差不随距离消失）。
      // 相邻两档之间按抖动过渡
      float lv = clamp(log2(aa / (uLeaf.x * 0.2)), 0.0, 3.6);
      float oc = floor(lv) + step(tDn, smoothstep(0.7, 1.0, fract(lv)));
      float detail = pow(0.72, oc);
      vec3 id;
      vec3 q = vec3(vObj.x, vObj.y / uLeaf.y, vObj.z) / (uLeaf.x * exp2(oc));
      // 取样点按低频错动一下：簇与簇的分界不是笔直的
      q += 0.2 * sin(q.yzx * 3.1 + q.zxy * 1.7);
      vec3 to = tLeafCells(q, id);
      float dist = length(to);
      // 每簇是一个小圆团（半径各不相同）：贴近轮廓处只留簇心的一团，簇与簇之间透空；
      // 正面簇间的缝隙也零星透空，露出团块的里侧
      float rad = 0.36 + 0.3 * id.x;
      float ndv = abs(dot(normalize(vNormal), normalize(vViewPosition)));
      float edge = 1.0 - smoothstep(0.0, 0.55, ndv);
      float own = step(0.5, vCol.a);
      #ifdef TREE_HOLES
      float open = gl_FrontFacing ? mix(1.0, 0.52, min(1.0, uHole * 2.0)) * (0.82 + 0.4 * id.y) : 9.0;
      #else
      float open = 9.0;
      #endif
      if (dist > mix(open, rad * (1.2 - 0.62 * uLeaf.z), edge) + own * 9.0) discard;
      vec3 leaf = mix(vLeaf, vCol.rgb, vCol.a);
      // 团块的里侧（从透空处看进去）：暗
      if (!gl_FrontFacing) { leaf *= 0.62; tAo *= 0.7; }
      // 团与团的色差；簇与簇的明暗，簇心亮、簇缘暗
      float tone = (0.86 + 0.3 * id.z) * (1.0 - 0.42 * smoothstep(rad * 0.35, rad * 1.25, dist));
      leaf *= (0.84 + 0.32 * vVtx.y) * mix(1.0, tone * 1.16, detail);
      // 外层的叶偏黄、偏亮
      leaf = mix(leaf, leaf * vec3(1.1, 1.06, 0.84), vVtx.w * 0.5);
      if (vTree.z > 0.5 && own < 0.5) {
        // 花果：零星的簇换成异色；远看只给整棵树带一点色
        vec3 ac = vTree.z < 1.5 ? vec3(0.5, 0.05, 0.035) : vTree.z < 2.5 ? vec3(0.72, 0.27, 0.02) : vec3(0.85, 0.76, 0.78);
        leaf = mix(leaf, ac, oc < 0.5 ? step(0.86, id.y) * smoothstep(rad * 0.7, rad * 0.4, dist) : 0.05);
      }
      diffuseColor.rgb = leaf;
      // 每簇鼓成一个小圆包，各自再歪一点
      tBump = (to / max(dist, 1e-3) * smoothstep(0.0, rad, dist) * 0.85 + (id - 0.5) * 0.45) * detail;
      tRough = uLeaf.w;
      tTip = vVtx.w;
    } else if (tKind > 0.375) {
      // 羽状叶：沿程 u、横向 v（中肋为 0），镂出两排斜伸的小叶
      float u = vVtx.y, v = vVtx.w;
      float fine = 1.0 - smoothstep(0.02, 0.07, aa);
      float comb = abs(fract(u * 34.0 - v * 1.3) - 0.5) * 2.0;
      if (v > 0.14 && comb > mix(1.01, 0.56, fine)) discard;
      vec3 leaf = vLeaf * (0.78 + 0.34 * u) * (0.9 + 0.2 * tHash33(vec3(floor(u * 34.0 - v * 1.3), vTree.x, 1.0)).x * fine);
      diffuseColor.rgb = mix(leaf, vec3(0.42, 0.4, 0.2), (1.0 - smoothstep(0.05, 0.16, v)) * 0.6);
      tRough = uLeaf.w;
      tTip = 0.8;
    } else if (tKind > 0.12) {
      // 条形叶：根部深、梢部枯黄
      float u = vVtx.y;
      diffuseColor.rgb = mix(vLeaf * vec3(0.55, 0.7, 0.5), vLeaf * 1.1, smoothstep(0.0, 0.8, u));
      tRough = uLeaf.w;
      tTip = 0.8;
    } else {
      // 树皮：竖向的裂纹
      float n = tNoise3(vObj * vec3(8.0, 1.2, 8.0));
      float n2 = tNoise3(vObj * vec3(26.0, 4.0, 26.0)) * (1.0 - smoothstep(0.01, 0.04, aa));
      diffuseColor.rgb = vCol.rgb * (0.68 + 0.5 * n + 0.3 * (n2 - 0.5));
      tBump = vec3(n - 0.5, 0.0, n2 - 0.5) * 0.5;
    }
  }
`

// —— 远景 ——
const FAR_VERT_PARS = /* glsl */ `
  ${VERT_COMMON}
  attribute vec2 aLathe;
  /** 各树形 5 个环：半径、高度、法线的竖直分量、遮蔽 */
  uniform vec4 uProf[${NS * 5}];
  /** 各树形：树干半径、轮廓的参差、倾斜量、朝向固定 */
  uniform vec4 uSpec[${NS}];
  uniform vec3 uBark[${NS}];
  /** 各树形分层针叶的层数（0 为不分层） */
  uniform float uTier[${NS}];
`
/** 摆放：算出 tPos、tn（单位树的法线）、tAoV、tPart（1 树干）、tTipV、tTone、lk、tFade */
const FAR_PLACE = /* glsl */ `
  float tSpb = floor(aTreeA.x * 255.0 + 0.5);
  float tAccent = floor(tSpb / 16.0);
  int tSi = int(tSpb - tAccent * 16.0);
  vec4 tSpec = uSpec[tSi];
  treeSetup(tSpec.z, tSpec.w);
  float tCrown = uProf[tSi * 5 + 2].x;
  float lk = lifeK(aTreeLife);
  vec2 tFade = treeFade();
  float tPart = aLathe.x;
  vec3 tp;
  vec3 tn;
  float tAoV;
  float tTipV = 0.0;
  float tTone = 1.0;
  float tHr;
  {
    float top = uProf[tSi * 5 + 4].y;
    if (tPart > 0.5) {
      float y0 = uProf[tSi * 5].y;
      tp = vec3(position.x * tSpec.x, mix(-0.3, mix(y0, uProf[tSi * 5 + 2].y, 0.4), position.y), position.z * tSpec.x);
      tn = vec3(position.x, 0.0, position.z);
      tAoV = mix(0.62, 0.36, position.y);
    } else {
      int ring = int(position.y + 0.5);
      vec4 pr = uProf[tSi * 5 + ring];
      // 轮廓的参差：每个顶点的半径各不相同（团状的树冠不是正多边形）
      float h = hash12(vec2(aLathe.y * 57.0 + aTreeC.w * 7.0, aTreeA.w * 113.0));
      float jit = 1.0 + tSpec.y * (h - 0.5);
      tp = vec3(position.x * pr.x * jit, pr.y + tSpec.y * 0.3 * (h - 0.5) * step(0.5, float(ring)), position.z * pr.x * jit);
      float nr = sqrt(max(0.0, 1.0 - pr.z * pr.z));
      tn = vec3(position.x * nr, pr.z, position.z * nr);
      tAoV = pr.w;
      tTone = 0.88 + 0.24 * h;
      tTipV = 0.25 + 0.12 * float(ring);
    }
    tHr = tp.y / top;
  }
  vec3 tPos = treePlace(tp) * (aTree.w * lk) + aTree.xyz;
`

const FAR_FRAG_PARS = /* glsl */ `
  ${FRAG_COMMON}
  varying vec3 vFar;
  varying float vTier;
`
const FAR_FRAG_COLOR = /* glsl */ `
  ${FADE_FRAG}
  float tAo = vFar.x;
  float tLeafM = 1.0 - vFar.y;
  float tTip = vFar.z;
  diffuseColor.rgb = vLeaf;
  // 分层针叶：每层上沿受光、下沿是上一层投下的暗处；层窄到一两个像素时淡出到平均色（不出摩尔纹）
  if (vTier > 0.5 && tLeafM > 0.5) {
    float ty = vTree.y * vTier;
    float band = smoothstep(0.0, 0.85, fract(ty));
    diffuseColor.rgb *= mix(0.93, mix(0.66, 1.08, band), 1.0 - smoothstep(0.2, 0.5, fwidth(ty)));
  }
`

export interface TreeMaterials {
  mat: THREE.MeshStandardMaterial
  depth: THREE.MeshDepthMaterial
}

function hook(mat: THREE.Material, key: string, fn: (sh: THREE.WebGLProgramParametersWithUniforms) => void) {
  mat.onBeforeCompile = fn
  mat.customProgramCacheKey = () => key
}

/** 细节层级的两个带：[淡入起, 淡入止, 淡出起, 淡出止]（米） */
export type LodRange = [number, number, number, number]

/**
 * 近景材质：一种树形一对（颜色、深度）。shared 为各级共享的 uniform（成长、镜头位置、抖动相位）
 */
export function nearMaterials(species: number, shared: Uniforms, range: LodRange, lod: number): TreeMaterials {
  const s = SPECIES[species]
  const top = s.profile[4][1]
  const crown = Math.max(...s.profile.map((p) => p[0]))
  const own: Uniforms = {
    uLodRange: { value: new THREE.Vector4(...range) },
    uForm: { value: new THREE.Vector4(s.lean, s.warp, s.aligned ? 1 : 0, top) },
    uCrown: { value: crown },
    uLeaf: { value: new THREE.Vector4(s.leaf.cell, s.leaf.stretch, s.leaf.erode, s.leaf.rough) },
    uHole: { value: s.leaf.hole },
  }
  // 近景两面都画：透空处露出团块的里侧。中、低两级不在树冠表面开洞（洞小到只剩几个像素，徒增片元：
  // 带 discard 的着色器没有提前深度测试，团块层层叠着全要算），只画正面；羽状叶与条形叶本来就是薄片，各级都两面画
  const sheet = species === SP.palm || species === SP.reed
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: lod === 0 || sheet ? THREE.DoubleSide : THREE.FrontSide })
  if (lod === 0) mat.defines = { TREE_HOLES: '' }
  hook(mat, `town-tree-near-${lod === 0 ? 'holes' : 'solid'}`, (sh) => {
    Object.assign(sh.uniforms, shared, own)
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${NEAR_VERT_PARS}\n${SHADOW_FAR_PARS}\nvarying vec2 vFade;\nvarying vec3 vLeaf;\nvarying vec3 vTree;\nvarying vec3 vObj;\nvarying vec4 vVtx;\nvarying vec4 vCol;`,
      )
      .replace('#include <beginnormal_vertex>', `${NEAR_PLACE}\nvec3 objectNormal = treeNormal(normal);`)
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = tPos;
        if (lk <= 0.0 || tFade.x <= 0.0 || tFade.y >= 1.0) transformed = vec3(0.0);
        vFade = tFade;
        vLeaf = pow(aTreeC.rgb, vec3(2.2));
        // 叶簇纹理的坐标：树自身的米坐标（不随个体的拉伸变形），各棵错开
        vObj = tp * aTree.w + vec3(aTreeA.w, aTreeC.w, aTreeA.w * 0.37) * 40.0;
        vVtx = aVtx;
        vCol = vec4(pow(aCol.rgb, vec3(2.2)), aCol.a);
        vTree = vec3(aTreeA.z, position.y / uForm.w, floor(floor(aTreeA.x * 255.0 + 0.5) / 16.0));`,
      )
      .replace('#include <shadowmap_vertex>', `#include <shadowmap_vertex>\n${SHADOW_FAR_VERT}`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${NEAR_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${NEAR_FRAG_COLOR}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = tRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(normal + (viewMatrix * vec4(tBump, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', LIGHT_FRAG)
  })
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  hook(depth, 'town-tree-near-depth', (sh) => {
    Object.assign(sh.uniforms, shared, own)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${NEAR_VERT_PARS}`)
      .replace('#include <begin_vertex>', `${NEAR_PLACE}\nvec3 transformed = tPos;\nif (lk <= 0.0 || tFade.x <= 0.5 || tFade.y > 0.5) transformed = vec3(0.0);`)
  })
  return { mat, depth }
}

/** 远景回转体各树形的参数表（uniform 数组） */
function farTables(): Uniforms {
  const prof: THREE.Vector4[] = []
  const spec: THREE.Vector4[] = []
  const bark: THREE.Vector3[] = []
  for (const s of SPECIES) {
    const p = s.profile
    const cy = (p[0][1] + p[4][1]) / 2
    const top = p[4][1]
    p.forEach((q, i) => {
      // 轮廓的法线（相邻两环连线的垂线）与"自冠心向外"的方向各半
      const a = p[Math.max(0, i - 1)]
      const b = p[Math.min(4, i + 1)]
      let nr = b[1] - a[1]
      let ny = a[0] - b[0]
      const l = Math.hypot(nr, ny) || 1
      nr /= l
      ny /= l
      const or = q[0]
      const oy = q[1] - cy
      const ol = Math.hypot(or, oy) || 1
      const my = i === 4 ? 1 : ny * 0.5 + (oy / ol) * 0.5
      const mr = i === 4 ? 0 : nr * 0.5 + (or / ol) * 0.5
      const ml = Math.hypot(mr, my) || 1
      // 遮蔽：冠底暗、向上渐亮
      const ao = 0.42 + 0.58 * Math.min(1, Math.max(0, (q[1] - p[0][1]) / (top - p[0][1]) / 0.6))
      prof.push(new THREE.Vector4(q[0], q[1], my / ml, ao))
    })
    spec.push(new THREE.Vector4(s.trunk, s.lump, s.lean, s.aligned ? 1 : 0))
    const c = new THREE.Color(s.bark)
    bark.push(new THREE.Vector3(c.r, c.g, c.b))
  }
  return { uProf: { value: prof }, uSpec: { value: spec }, uBark: { value: bark }, uTier: { value: SPECIES.map((s) => s.tiers ?? 0) } }
}

/** 远景材质：所有树形共用一对 */
export function farMaterials(shared: Uniforms, range: LodRange): TreeMaterials {
  const own: Uniforms = { uLodRange: { value: new THREE.Vector4(...range) }, ...farTables() }
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0 })
  hook(mat, 'town-tree-far', (sh) => {
    Object.assign(sh.uniforms, shared, own)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${FAR_VERT_PARS}\n${SHADOW_FAR_PARS}\nvarying vec2 vFade;\nvarying vec3 vLeaf;\nvarying vec3 vTree;\nvarying vec3 vFar;\nvarying float vTier;`)
      .replace('#include <beginnormal_vertex>', `${FAR_PLACE}\nvec3 objectNormal = treeNormal(tn);`)
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = tPos;
        if (lk <= 0.0 || tFade.x <= 0.0 || tFade.y >= 1.0) transformed = vec3(0.0);
        vFade = tFade;
        vec3 tLeafC = pow(aTreeC.rgb, vec3(2.2)) * tTone;
        // 与近景的平均色一致：外层偏黄亮；花果只带一点色
        tLeafC = mix(tLeafC, tLeafC * vec3(1.1, 1.06, 0.84), tTipV * 0.5);
        if (tAccent > 0.5) tLeafC = mix(tLeafC, tAccent < 1.5 ? vec3(0.5, 0.05, 0.035) : tAccent < 2.5 ? vec3(0.72, 0.27, 0.02) : vec3(0.85, 0.76, 0.78), 0.05);
        vLeaf = tPart > 0.5 ? uBark[tSi] * 0.9 : tLeafC;
        vTree = vec3(aTreeA.z, tHr, tAccent);
        vFar = vec3(tAoV, tPart, tTipV);
        vTier = uTier[tSi];`,
      )
      // 自身的明暗由法线给出：阴影只查朝太阳挪出树冠的那一点（别的树、房子、山投来的）
      .replace('#include <shadowmap_vertex>', `#include <shadowmap_vertex>\n${SHADOW_FAR_VERT}\n#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0\nvDirectionalShadowCoord[ 0 ] = vShadowFar;\n#endif`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FAR_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FAR_FRAG_COLOR}`)
      .replace('#include <aomap_fragment>', LIGHT_FRAG)
  })
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  hook(depth, 'town-tree-far-depth', (sh) => {
    Object.assign(sh.uniforms, shared, own)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${FAR_VERT_PARS}`)
      .replace('#include <begin_vertex>', `${FAR_PLACE}\nvec3 transformed = tPos;\nif (lk <= 0.0 || tFade.x <= 0.5 || tFade.y > 0.5) transformed = vec3(0.0);`)
  })
  return { mat, depth }
}

/**
 * 树下的接触阴影：贴着地面的一片圆（随坡度倾斜），把树冠挡住的天光压暗——树干根部最暗，向外淡出。
 * 只在近处画（远处由阴影贴图交代）；用相乘混合，不写深度
 */
export function contactMaterial(shared: Uniforms, fadeOut: [number, number]): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uFadeOut: { value: new THREE.Vector2(...fadeOut) }, uCrowns: { value: contactCrowns() } },
    vertexShader: /* glsl */ `
      ${LIFE_GLSL}
      attribute vec4 aTree;
      attribute vec2 aTreeLife;
      attribute vec4 aTreeA;
      attribute vec4 aTreeG;
      uniform vec3 uLodCam;
      uniform vec2 uFadeOut;
      uniform vec2 uCrowns[${NS}];
      varying vec3 vDisc;
      void main() {
        float lk = lifeK(aTreeLife);
        int si = int(mod(floor(aTreeA.x * 255.0 + 0.5), 16.0));
        vec2 cr = uCrowns[si];
        float r = aTree.w * cr.x * 1.25;
        vec2 slope = (aTreeG.xy * 255.0 - 128.0) / 100.0;
        vec3 p = vec3(position.x * r, 0.0, position.z * r);
        p.y = dot(slope, p.xz) + 0.12;
        float d = distance(aTree.xyz, uLodCam);
        float k = lk * cr.y * (1.0 - smoothstep(uFadeOut.x, uFadeOut.y, d));
        vDisc = vec3(position.xz, k);
        if (k <= 0.0) p = vec3(0.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p + aTree.xyz, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDisc;
      void main() {
        float r = length(vDisc.xy);
        // 根部一小圈最暗，外面是树冠下大而淡的一片
        float a = (0.3 * (1.0 - smoothstep(0.0, 1.0, r)) + 0.3 * (1.0 - smoothstep(0.0, 0.22, r))) * vDisc.z;
        gl_FragColor = vec4(vec3(1.0 - a), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
  })
}

/** 接触阴影用的各树形参数：树冠半径（冠径单位）、强度（柱形、竹丛的冠贴地，影子淡） */
function contactCrowns(): THREE.Vector2[] {
  return SPECIES.map((s) => {
    const crown = Math.max(...s.profile.map((p) => p[0]))
    const lift = Math.min(1, s.profile[0][1] / 0.6)
    return new THREE.Vector2(crown, s.aligned ? 0.5 : 0.45 + 0.55 * lift)
  })
}
