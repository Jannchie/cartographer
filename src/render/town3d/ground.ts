import * as THREE from 'three'
import { buildGroundVector, clearGroundTiles, type GroundVector } from '../../settlement/render'
import { DIORAMA_STYLE, dioramaGround, type SettleStyleId } from '../../settlement/themes'
import type { Settlement } from '../../settlement/types'
import { NOISE_GLSL } from '../aerial/glsl'
import { LIFE_GLSL } from './buildingShader'
import { WATER_LEVEL, type TerrainMesh } from './relief'

/**
 * 聚落沙盘的地面与水：
 * - 地形网格：见 relief.ts（在 Worker 里构建），岸线、护城河与池塘处细分并下刻。
 * - 地面贴图：二维渲染器的地面层（settlement/render.ts 的 buildGroundVector）栅格化成整幅一张，
 *   镜头拉近时再在视点附近栅格化一粗一细两级高清块（各 2048 见方，纹素约等于屏幕像素），三级之间渐变衔接。
 * - 写实地景（"彩绘"地面）：贴图只给各要素的固有色，另有一张材质掩膜（材质编号与方向），
 *   着色器按材质叠加草皮、垄沟、铺石、土路的颗粒等程序化细节，各自按像素足迹淡出到平均色；
 *   水边按地面与水面的高差画河床、湿岸与沙滩，与几何上的岸线一致。其他风格只贴图（画在沙盘上的地图）。
 * - 水面：与地形共用顶点、压平到水面高度的一层，水深由高差得到；按水深取色与透明度，
 *   反射天光与太阳高光，河面有顺流的静态流纹，海面近岸有成排的涌浪与一线白沫。
 * - 四周剖面：世界沙盘的岩层与海水剖面材质，上沿取地形网格的边缘顶点，与地表、水面严丝合缝。
 */

type Uniforms = Record<string, THREE.IUniform>

/** 整幅贴图的宽度与高清块的边长（像素） */
const BASE_W = 4096
const LEVEL = 2048

// —————————————————————— 着色器 ——————————————————————

/** 地面与水面共用：像素足迹、按足迹淡出、凹凸法线、蜂窝 */
const SURFACE_GLSL = /* glsl */ `
  ${NOISE_GLSL}
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  /** 两个互不相关的值噪声（一次取格点，比分两次省一半） */
  vec2 vnoise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash22(i), hash22(i + vec2(1.0, 0.0)), u.x), mix(hash22(i + vec2(0.0, 1.0)), hash22(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  vec2 fbm3v(vec2 p) {
    vec2 s = vec2(0.0);
    float a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 3; i++) { s += a * vnoise2(p); p = r * p * 2.03 + 17.1; a *= 0.5; }
    return s / 0.875;
  }
  /** 周期为 period（米）的花纹在像素足迹 px（米）下还剩多少：足迹到周期的三分之一起淡出，到四分之三全无 */
  float gFade(float period, float px) { return 1.0 - smoothstep(0.3, 0.75, px / period); }
  /** 一个像素盖住的地面（米）：斜看时取长短两向的几何平均 */
  float gFootprint(vec2 p) {
    float a = length(dFdx(p)), b = length(dFdy(p));
    return sqrt(max(a, b) * max(min(a, b), 1e-5));
  }
  /** 水岸贴图 R 通道解成到水的距离（米，水中为负；编码见 relief.ts 的 TerrainMesh.shore） */
  float gShoreDist(float r) {
    float v = r * 255.0;
    return v <= 192.0 ? (128.0 - v) / 4.0 : -16.0 - (v - 192.0) / 0.6;
  }
  /** 最近特征点的距离与该点的随机数 */
  vec2 gCell(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float d = 8.0, h = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = hash22(i + g);
      vec2 o = g + r - f;
      float l = dot(o, o);
      if (l < d) { d = l; h = r.x; }
    }
    return vec2(sqrt(d), h);
  }
  /** 高度场 h（场景单位）扰动法线：视空间的位置 pos 与法线 n，梯度由屏幕导数求出 */
  vec3 gBumpNormal(vec3 pos, vec3 n, float h) {
    vec3 dpx = dFdx(pos), dpy = dFdy(pos);
    float hx = dFdx(h), hy = dFdy(h);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
    float det = dot(dpx, r1);
    vec3 g = sign(det) * (hx * r1 + hy * r2);
    return normalize(abs(det) * n - g);
  }
`

const GROUND_VERT_HEAD = /* glsl */ `
  ${LIFE_GLSL}
  attribute vec4 aCarve;
  attribute vec3 aNormal2;
  varying vec2 vGround;
  varying float vH;
  varying float vY;
  varying vec3 vUp;
  float gDig() { return aCarve.x < 0.0 ? lifeK(aCarve.yz) : 0.0; }
`

const GROUND_FRAG_HEAD = /* glsl */ `
  varying vec2 vGround;
  varying float vH;
  varying float vY;
  varying vec3 vUp;
  uniform sampler2D uBase;
  uniform sampler2D uBaseMask;
  uniform sampler2D uLv1;
  uniform sampler2D uLv1Mask;
  uniform sampler2D uLv2;
  uniform sampler2D uLv2Mask;
  uniform vec4 uRect1;
  uniform vec4 uRect2;
  uniform vec3 uTexel;
  uniform vec2 uSize;
  uniform sampler2D uShore;
  uniform float uReal;
  uniform float uMeter;
  uniform float uPaved;
  ${SURFACE_GLSL}
  float gRough = 0.94;
  float gBump = 0.0;
  float gGloss = 0.0;

  /** 高清块里的权重：四周留一圈渐变 */
  float gInside(vec2 q) {
    vec2 e = min(q, 1.0 - q);
    return smoothstep(0.0, 0.07, min(e.x, e.y));
  }
  /** 条纹（相位 t，以周期计）在一个像素跨过 w 个周期时还剩多少 */
  float gStripe(float w) { return 1.0 - smoothstep(0.3, 0.7, w); }
  /** 卵石 / 小方石铺地：石面亮、石缝暗，每块石头深浅不一 */
  void gCobble(vec2 p, float px, float size, inout vec3 col, inout float bump) {
    vec2 c = gCell(p / size);
    float f = gFade(size, px);
    float stone = 1.0 - smoothstep(0.32, 0.5, c.x);
    col *= mix(0.95, mix(0.68, 0.9 + 0.28 * c.y, stone), f);
    bump += stone * (1.0 - c.x * c.x * 2.5) * 0.04 * f;
  }
  /** 石板铺地：错缝的长方石板（q 为顺着铺向的局部坐标） */
  void gFlags(vec2 q, float px, vec2 size, inout vec3 col, inout float bump) {
    float row = floor(q.y / size.y);
    float x = q.x / size.x + hash12(vec2(row, 1.7));
    vec2 f = vec2(fract(x), fract(q.y / size.y));
    vec2 e = min(f, 1.0 - f) * size;
    float joint = smoothstep(0.012, 0.035 + px, min(e.x, e.y));
    float tone = hash12(vec2(floor(x), row));
    col *= mix(1.0, 0.88 + 0.24 * tone, gFade(size.y * 2.5, px)) * mix(0.95, mix(0.62, 1.0, joint), gFade(size.y, px));
    bump += joint * 0.03 * gFade(size.y, px);
  }
`

/** 地面的固有色、粗糙度与凹凸（替换 map_fragment） */
const GROUND_FRAG_BODY = /* glsl */ `
  {
    vec2 gp = vGround;
    float px = gFootprint(gp);
    vec2 lp = gp;
    if (uReal > 0.5) {
      // 贴图的查找点按米级的噪声挪一点：田埂、路边、草与土的分界不是笔直的线
      lp += (vnoise2(gp * 0.42 + 3.0) - 0.5) * 0.55 + (vnoise2(gp * 1.9 + 11.0) - 0.5) * 0.16;
    }
    // —— 贴图：整幅 + 两级高清块 ——
    vec3 alb = texture2D(uBase, vec2(lp.x / uSize.x, 1.0 - lp.y / uSize.y)).rgb;
    vec2 q1 = (lp - uRect1.xy) * uRect1.zw;
    vec2 q2 = (lp - uRect2.xy) * uRect2.zw;
    float k1 = uRect1.z > 0.0 ? gInside(q1) : 0.0;
    float k2 = uRect2.z > 0.0 ? gInside(q2) : 0.0;
    alb = mix(alb, texture2D(uLv1, vec2(q1.x, 1.0 - q1.y)).rgb, k1);
    alb = mix(alb, texture2D(uLv2, vec2(q2.x, 1.0 - q2.y)).rgb, k2);
    if (uReal < 0.5) {
      // 画在沙盘上的地图：只加一点纸面的不匀
      diffuseColor.rgb = alb * (0.94 + 0.12 * vnoise(gp * 0.9));
    } else {
      // —— 材质掩膜：取最细的一级；查找点再按纹素大小抖动，材质的分界不呈纹素的锯齿 ——
      float mt = k2 > 0.5 ? uTexel.z : (k1 > 0.5 ? uTexel.y : uTexel.x);
      vec2 mp = lp + (vnoise2(gp / mt * 0.8) - 0.5) * mt * 1.1;
      vec4 mk;
      if (k2 > 0.5) mk = textureLod(uLv2Mask, vec2((mp.x - uRect2.x) * uRect2.z, 1.0 - (mp.y - uRect2.y) * uRect2.w), 0.0);
      else if (k1 > 0.5) mk = textureLod(uLv1Mask, vec2((mp.x - uRect1.x) * uRect1.z, 1.0 - (mp.y - uRect1.y) * uRect1.w), 0.0);
      else mk = textureLod(uBaseMask, vec2(mp.x / uSize.x, 1.0 - mp.y / uSize.y), 0.0);
      float idB = floor(mk.b * 255.0 / 8.0);
      float idG = floor(mk.g * 255.0 / 8.0);
      bool known = abs(mod(idB * 13.0 + 5.0, 32.0) - idG) < 0.5 && abs(fract(mk.b * 255.0 / 8.0) - 0.5) < 0.3;
      int cls = known ? int(idB + 0.5) : 0;
      float ang = mk.r * 255.0 > 0.5 && known ? (mk.r * 255.0 - 1.0) / 253.0 * 3.14159265 : 0.0;
      vec2 du = vec2(cos(ang), sin(ang));
      // 顺垄向与跨垄向的坐标（米）；一个像素跨过多少米的垄（条纹按它淡出，斜看也不出摩尔纹）
      float ta = dot(gp, du);
      float tn = dot(gp, vec2(-du.y, du.x));
      float wn = fwidth(tn);

      // —— 各级噪声：百米、十米（各两个互不相关的）、米、分米 ——
      vec2 big = fbm3v(gp * 0.011 + 3.1);
      vec2 mid = mix(vec2(0.5), fbm3v(gp * 0.085 + 9.7), gFade(6.0, px));
      vec2 fine = vnoise2(gp * 1.1 + 5.0);
      float n1 = mix(0.5, fine.x, gFade(0.9, px));
      float n2 = mix(0.5, vnoise(gp * 5.3 + 1.0), gFade(0.19, px));
      float m2 = mid.x;

      vec3 col = alb;
      float bump = 0.0;
      float rough = 0.95;
      float gloss = 0.0;
      // 草与土的成分：叠各自的斑驳与颗粒；natural：野地与田（水边铺沙、陡坡露岩只在这些地方）
      float grass = 0.0;
      float dirt = 0.0;
      float natural = 0.0;

      if (cls == 1) {
        // 野地：成片的枯黄与深绿，零星露土，一丛丛深色的灌草
        grass = 1.0; natural = 1.0;
        float dry = smoothstep(0.5, 0.75, big.y * 0.6 + mid.y * 0.4);
        float lush = smoothstep(0.45, 0.75, (1.0 - big.y) * 0.5 + mid.y * 0.5);
        col = mix(col, col * vec3(1.2, 1.07, 0.8), dry * 0.8);
        col = mix(col, col * vec3(0.74, 0.9, 0.68), lush * 0.7);
        col = mix(col, vec3(0.3, 0.24, 0.16), smoothstep(0.68, 0.78, m2) * 0.4);
        vec2 tc = gCell(gp / 2.3 + 40.0);
        float tuft = step(0.62, tc.y) * (1.0 - smoothstep(0.12, 0.34, tc.x)) * gFade(1.6, px);
        col = mix(col, col * vec3(0.52, 0.66, 0.46), tuft);
        // 草丛只略高出一点：凸得多了，斜阳下一个个成了带影子的小坑
        bump += tuft * 0.07;
      } else if (cls == 2) {
        // 庄稼：顺垄向的一行行，行间露土；行略有弯，疏密不匀，几垄一带深浅不同
        natural = 1.0;
        float P = 1.15;
        float t = tn / P + (vnoise(vec2(ta * 0.06, tn * 0.25)) - 0.5) * 0.7;
        float f = gStripe(wn / P);
        float s = smoothstep(0.2, 0.8, 0.5 + 0.5 * cos(6.2832 * t));
        float gap = smoothstep(0.2, 0.42, vnoise(vec2(ta * 0.8, floor(t + 0.5) * 3.7)));
        float land = vnoise(vec2(tn / 6.5, ta * 0.01)) * gStripe(wn / 13.0);
        col *= mix(0.95, mix(0.8, 1.1, s * gap), f) * (0.92 + 0.16 * land) * (0.93 + 0.14 * m2) * (0.9 + 0.2 * n2);
        bump += s * gap * 0.1 * f + n2 * 0.03;
      } else if (cls == 3) {
        // 菜园：一畦一畦，畦上一丛丛菜
        natural = 1.0;
        float P = 1.5;
        float t = tn / P;
        float f = gStripe(wn / P);
        float bed = mix(0.8, smoothstep(0.06, 0.14, abs(fract(t) - 0.5)), f);
        vec2 cc = gCell(vec2(ta / 0.5, t * 3.0));
        float fp = gFade(0.5, px);
        float plant = mix(0.42, 1.0 - smoothstep(0.24, 0.44, cc.x), fp) * bed;
        vec3 leaf = mix(vec3(0.1, 0.2, 0.05), vec3(0.2, 0.3, 0.08), cc.y);
        col = mix(col * mix(0.72, 1.0, bed) * (0.9 + 0.2 * n2), leaf, plant);
        bump += bed * 0.12 * f + plant * 0.1 * fp;
      } else if (cls == 8) {
        // 葡萄园：一行行的架子，藤叶断断续续
        natural = 1.0;
        float P = 2.6;
        float t = tn / P;
        float f = gStripe(wn / P);
        float row = 1.0 - smoothstep(0.1, 0.2, abs(fract(t) - 0.5));
        float can = smoothstep(0.18, 0.42, vnoise(vec2(ta * 1.1, floor(t) * 5.1)));
        float cover = mix(0.26, row * can, f);
        dirt = 1.0 - cover;
        col = mix(col, vec3(0.085, 0.17, 0.045) * (0.75 + 0.5 * n1), cover);
        bump += row * can * 0.35 * f;
      } else if (cls == 4) {
        // 草甸：高草里点点野花
        grass = 1.0; natural = 1.0;
        vec2 fc = gCell(gp / 0.5);
        float fl = step(0.8, fc.y) * (1.0 - smoothstep(0.1, 0.17, fc.x)) * gFade(0.5, px);
        col = mix(col, fc.y > 0.9 ? vec3(0.72, 0.7, 0.6) : vec3(0.7, 0.55, 0.1), fl);
      } else if (cls == 5 || cls == 6) {
        // 牧场、果园的草地
        grass = 0.9; natural = 1.0;
      } else if (cls == 7) {
        // 水田：泥水映着天，秧苗成行
        float P = 0.9;
        float t = tn / P;
        float f = gStripe(wn / P);
        vec2 cc = gCell(vec2(ta / 0.55, t));
        float cover = mix(0.3, 1.0 - smoothstep(0.16, 0.34, cc.x), f);
        col = mix(col * 0.55, vec3(0.13, 0.27, 0.07), cover * 0.8);
        rough = mix(0.16, 0.7, cover);
        gloss = 1.0 - cover;
      } else if (cls == 9) {
        // 园地、草坪：修剪过的匀净的草
        grass = 0.75;
      } else if (cls == 10) {
        // 墓地：草地上一块块墓石
        grass = 1.0;
        vec2 q = gp / 2.6;
        float h = hash12(floor(q) + 3.3);
        vec2 b = abs((fract(q) - 0.5) * 2.6 - (vec2(h, fract(h * 13.7)) - 0.5) * 0.8) - vec2(0.3, 0.6);
        float slab = step(0.4, h) * (1.0 - smoothstep(-0.04, 0.04 + px, max(b.x, b.y))) * gFade(1.2, px);
        col = mix(col, vec3(0.36, 0.36, 0.34) * (0.75 + 0.5 * fract(h * 7.1)), slab);
        grass *= 1.0 - slab;
      } else if (cls == 11) {
        // 街区里的院地：踩实的土，墙根与角落长草
        float g = smoothstep(0.4, 0.62, mid.y * 0.7 + fine.y * 0.3);
        grass = g * 0.85;
        dirt = 1.0 - g;
        col = mix(col, col * vec3(0.66, 0.9, 0.56), g * 0.85);
      } else if (cls == 12) {
        // 街道：铺石或夯土
        if (uPaved > 0.5) { gCobble(gp, px, 0.3, col, bump); col *= 0.93 + 0.14 * m2; rough = 0.86; }
        else dirt = 1.0;
      } else if (cls == 13 || cls == 14 || cls == 15) {
        dirt = 1.0;
      } else if (cls == 16) {
        // 广场：顺着广场长轴的石板
        gFlags(vec2(ta, tn), px, vec2(1.5, 0.95), col, bump);
        col *= 0.93 + 0.14 * m2;
        rough = 0.84;
      } else if (cls == 17) {
        gCobble(gp, px, 0.5, col, bump);
      } else if (cls == 18) {
        // 白砂：耙纹与砂粒
        float P = 0.32;
        float f = gStripe(wn / P);
        float s = cos(6.2832 * tn / P);
        col *= 1.0 + 0.1 * s * f + (hash12(floor(gp / 0.07)) - 0.5) * 0.18 * gFade(0.07, px);
        bump += s * 0.02 * f;
      } else if (cls == 19) {
        // 花坛：一丛丛的灌木与花
        vec2 fc = gCell(gp / 0.6);
        float ff = gFade(0.6, px);
        float dome = 1.0 - smoothstep(0.15, 0.55, fc.x);
        vec3 leaf = vec3(0.07, 0.16, 0.045) * (0.6 + 0.8 * dome);
        vec3 petal = fc.y < 0.2 ? vec3(0.55, 0.07, 0.08) : fc.y < 0.38 ? vec3(0.75, 0.55, 0.08) : fc.y < 0.52 ? vec3(0.7, 0.68, 0.62) : fc.y < 0.64 ? vec3(0.4, 0.14, 0.4) : leaf;
        col = mix(col, mix(leaf, petal, dome * 0.85), ff);
        bump += dome * 0.3 * ff;
      } else if (cls == 21) {
        // 池水（没有下刻的小池、水渠）：一层映着天的静水
        col = mix(vec3(0.02, 0.05, 0.05), col, 0.3);
        rough = 0.12;
        gloss = 1.0;
      } else if (cls == 22) {
        // 护城河的岸坡：湿土
        dirt = 1.0;
        col *= 0.8;
        rough = 0.8;
      }

      if (grass > 0.0) {
        // 草：十米级的黄绿斑驳、几米一团的深浅、米级的草丛、近看的草叶颗粒
        vec3 tint = mix(vec3(0.8, 0.94, 0.74), vec3(1.18, 1.07, 0.9), m2);
        float g = 1.0 + (fine.y - 0.5) * 0.14 * gFade(0.9, px) + (n1 - 0.5) * 0.3 + (n2 - 0.5) * 0.36;
        col *= mix(vec3(1.0), tint * g, grass);
        bump += (n1 * 0.12 + n2 * 0.05) * grass;
      }
      if (dirt > 0.0) {
        // 土：深浅不匀、颗粒与零星的石子
        vec2 pc = gCell(gp / 0.4 + 7.0);
        float peb = step(0.72, pc.y) * (1.0 - smoothstep(0.1, 0.2, pc.x)) * gFade(0.4, px);
        col *= mix(1.0, 1.0 + (m2 - 0.5) * 0.22 + (n1 - 0.5) * 0.16 + (n2 - 0.5) * 0.2, dirt);
        col = mix(col, col * 1.22 + 0.02, peb * dirt);
        bump += (n2 * 0.03 + peb * 0.04) * dirt;
      }
      // 百米级的明暗：整片地面不是一个色
      col *= 0.88 + 0.24 * big.x;

      // —— 陡坡露岩 ——
      float slope = 1.0 - normalize(vUp).y;
      // 依山的样例里 25° 上下的坡很多，从那里起露岩会让整片山坡发灰：到 30° 左右才开始，草与岩石的边界按噪声犬牙交错
      float rock = smoothstep(0.15, 0.3, slope + (m2 - 0.5) * 0.1 + (n1 - 0.5) * 0.04) * natural;
      if (rock > 0.0) {
        float strata = vnoise(vec2(gp.x * 0.21 + gp.y * 0.16, vY * 0.8)) * 0.6 + n1 * 0.4;
        col = mix(col, vec3(0.2, 0.19, 0.175) * (0.7 + 0.6 * strata), rock);
        rough = mix(rough, 0.9, rock);
        bump = mix(bump, strata * 0.12, rock);
      }

      // —— 水边：与水面的高差决定河床、湿岸；开阔水面的岸边一条沙滩 ——
      if (vH < 2.0) {
        vec4 sh = textureLod(uShore, gp / uSize, 0.0);
        float sd = gShoreDist(sh.r);
        float wv = mid.y * 0.6 + fine.y * 0.4;
        vec3 sandDry = vec3(0.42, 0.37, 0.25) * (0.86 + 0.28 * n1) * (0.92 + 0.16 * n2);
        float beach = sh.g * natural * (1.0 - smoothstep(2.5, 6.0 + 9.0 * wv, sd)) * (1.0 - smoothstep(0.7, 1.6, vH));
        col = mix(col, sandDry, beach);
        // 湿岸：刚出水的一条颜色深、略反光
        float wet = 1.0 - smoothstep(0.02, 0.2 + 0.35 * wv, vH);
        col *= mix(1.0, 0.6, wet);
        rough = mix(rough, 0.5, wet);
        // 水下：浅处是沙砾，深处是淤泥
        float under = 1.0 - smoothstep(-0.06, 0.02, vH);
        if (under > 0.0) {
          float depth = -vH;
          vec2 pc = gCell(gp / 0.45 + 3.0);
          float peb = step(0.55, pc.y) * (1.0 - smoothstep(0.1 + 0.15 * fine.y, 0.2 + 0.2 * fine.y, pc.x)) * gFade(0.45, px);
          vec3 sand = mix(vec3(0.17, 0.15, 0.1), vec3(0.3, 0.27, 0.18), sh.g) * (0.85 + 0.3 * n1);
          sand = mix(sand, sand * 1.3, peb);
          vec3 bedc = mix(sand, vec3(0.06, 0.075, 0.055), smoothstep(0.25, 2.0, depth));
          col = mix(col, bedc, under);
          rough = mix(rough, 0.6, under);
          gloss *= 1.0 - under;
          bump *= 1.0 - under;
        }
      }
      diffuseColor.rgb = col;
      gRough = rough;
      gBump = bump;
      gGloss = gloss;
    }
  }
`

/** 映着天的水面（水田、小池）：天光的菲涅耳反射，加在 lights_fragment_end 之后 */
const GLOSS_GLSL = /* glsl */ `
  #if NUM_HEMI_LIGHTS > 0
  if (gGloss > 0.0) {
    float gnv = saturate(dot(normal, geometryViewDir));
    reflectedLight.indirectSpecular += hemisphereLights[0].skyColor * 0.55 * (0.03 + 0.97 * pow(1.0 - gnv, 5.0)) * gGloss;
  }
  #endif
`

/** 地面材质（uniform 由 TownGround 持有，换城不换贴图） */
function createGroundMaterial(u: Uniforms) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0 })
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${GROUND_VERT_HEAD}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nfloat digK = gDig();\nobjectNormal = normalize(mix(objectNormal, aNormal2, digK));\nvUp = objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += aCarve.x * digK;\nvGround = position.xz;\nvY = transformed.y;\nvH = transformed.y - aCarve.w;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${GROUND_FRAG_HEAD}`)
      .replace('#include <map_fragment>', GROUND_FRAG_BODY)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nif (gBump != 0.0) normal = gBumpNormal(-vViewPosition, normal, gBump * uMeter);')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${GLOSS_GLSL}`)
  }
  mat.customProgramCacheKey = () => 'town-ground-3'
  return mat
}

/** 地面的阴影深度：护城河、池塘刻下去之后的形状 */
function createGroundDepth(u: Uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${LIFE_GLSL}\nattribute vec4 aCarve;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (aCarve.x < 0.0) transformed.y += aCarve.x * lifeK(aCarve.yz);')
  }
  mat.customProgramCacheKey = () => 'town-ground-depth'
  return mat
}

/**
 * 水面：与地形共用顶点，压平到各自的水面高度，水深 = 水面 − 地面（下刻随人口收放）。
 * 浅处透出河床、深处是沉稳的水色；法线带静态的细波与顺流的流纹；反射天光（半球光的天色）与太阳高光
 */
function createWaterMaterial(u: Uniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.22, metalness: 0, transparent: true })
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${LIFE_GLSL}\nattribute vec4 aCarve;\nvarying vec2 vGround;\nvarying float vDepth;`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDepth = aCarve.w - (transformed.y + (aCarve.x < 0.0 ? aCarve.x * lifeK(aCarve.yz) : 0.0));\ntransformed.y = aCarve.w;\nvGround = position.xz;',
      )
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vGround;\nvarying float vDepth;\nuniform sampler2D uShore;\nuniform vec2 uSize;\nuniform float uReal;\nuniform float uMeter;\n${SURFACE_GLSL}\nfloat gBump = 0.0;\nfloat gFres = 0.0;`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        {
          if (vDepth <= 0.0) discard;
          vec2 gp = vGround;
          float px = gFootprint(gp);
          float pxL = max(length(dFdx(gp)), length(dFdy(gp)));
          vec4 sh = textureLod(uShore, gp / uSize, 0.0);
          // 离岸的远近（米）与开阔程度（海、湖为 1，河为 0）
          float off = -gShoreDist(sh.r);
          float open = sh.g;
          vec2 fl = sh.ba * 2.0 - 1.0;
          // 细波：各向同性的两层
          float rip = fbm3(gp * 0.42 + 2.0);
          float fr = gFade(2.4, px);
          // 流纹：沿流向拉长的噪声。流向处处不同，取三个固定朝向的条纹按与流向的接近程度混合，不随位置旋转坐标
          float st = 0.0, ws = 0.0;
          for (int i = 0; i < 3; i++) {
            float a = float(i) * 1.0471976;
            vec2 d = vec2(cos(a), sin(a));
            float w = max(0.0, dot(fl, vec2(cos(2.0 * a), sin(2.0 * a))) + 0.3);
            w *= w;
            st += w * vnoise(vec2(dot(gp, d) * 0.08, dot(gp, vec2(-d.y, d.x)) * 0.95) + float(i) * 13.1);
            ws += w;
          }
          st = ws > 1e-4 ? st / ws : 0.5;
          float fs = gFade(1.1, px) * (1.0 - open) * smoothstep(0.1, 0.5, length(fl));
          // 涌浪：开阔水面近岸一排排与岸平行的浪，最里一线白沫
          float swell = 0.0, foam = 0.0;
          if (open > 0.01) {
            float ph = off / 12.0 + fbm3(gp * 0.013 + 8.0) * 2.2;
            float crest = pow(0.5 + 0.5 * sin(6.2832 * ph), 5.0);
            // 浪列与岸平行，贴地斜看时沿视线方向一个像素跨好几排：按长向的足迹淡出，否则岸边一圈白色的等高线。
            // 浪峰（pow 5）只占周期的几分之一，按 30 米而不是 12 米的周期淡出
            swell = crest * open * (1.0 - smoothstep(30.0, 85.0, off)) * smoothstep(1.0, 6.0, off) * gFade(30.0, pxL);
            // 浪列沿岸有起有落、时断时续：处处等高的浪就是岸线的一圈圈复本，逆光时一眼看出是等距线
            swell *= mix(0.2, 1.0, smoothstep(0.3, 0.7, vnoise(gp * 0.022 + 31.0)));
            float lace = smoothstep(0.42, 0.62, fbm3(gp * 0.7 + 21.0));
            // 浪头上的白沫只在快到岸、浪要碎的一带，再往外只有浪的起伏（整片海上都带白沫像天上的云）
            foam = open * (1.0 - smoothstep(0.02, 0.3, vDepth)) * mix(0.35, 1.0, lace) + swell * lace * 0.3 * (1.0 - smoothstep(6.0, 16.0, off));
          }
          gBump = ((rip - 0.5) * 0.07 * fr + (st - 0.5) * 0.05 * fs + swell * 0.14) * uMeter;
          vec3 nv = normalize(vNormal);
          gFres = 0.02 + 0.98 * pow(1.0 - saturate(dot(nv, normalize(vViewPosition))), 5.0);
          if (uReal > 0.5) {
            vec3 shallow = mix(vec3(0.06, 0.1, 0.065), vec3(0.045, 0.13, 0.13), open);
            vec3 deep = mix(vec3(0.016, 0.04, 0.032), vec3(0.006, 0.035, 0.06), open);
            vec3 c = mix(shallow, deep, 1.0 - exp(-vDepth * 0.9));
            c *= 1.0 + (st - 0.5) * 0.5 * fs;
            float a = (1.0 - exp(-vDepth * 2.4)) * 0.95;
            c = mix(c, vec3(0.62, 0.64, 0.62), foam * 0.7);
            a = max(a, foam * 0.75);
            diffuseColor.rgb = c;
            diffuseColor.a = 1.0 - (1.0 - a) * (1.0 - gFres);
          } else {
            // 地图风格的地面：水面只是一层薄薄的树脂，画上的水透上来
            float deepK = smoothstep(0.0, 2.5, vDepth);
            diffuseColor.rgb = mix(vec3(0.16, 0.3, 0.3), vec3(0.05, 0.12, 0.15), deepK);
            diffuseColor.a = 1.0 - (1.0 - smoothstep(0.0, 0.4, vDepth) * mix(0.18, 0.42, deepK)) * (1.0 - gFres);
          }
        }`,
      )
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = gBumpNormal(-vViewPosition, normal, gBump);')
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        #if NUM_HEMI_LIGHTS > 0
        {
          float gnv = saturate(dot(normal, geometryViewDir));
          reflectedLight.indirectSpecular += hemisphereLights[0].skyColor * 0.6 * (0.02 + 0.98 * pow(1.0 - gnv, 5.0));
        }
        #endif`,
      )
  }
  mat.customProgramCacheKey = () => 'town-water-3'
  return mat
}

// —————————————————————— 四周剖面 ——————————————————————

/**
 * 四周剖面（米坐标，随城市组一起缩放）：岩层 + 海水截面。上沿是地形网格的边缘顶点（rim，见 relief.ts），
 * 与地表共用同一批点；水下的一段在水面处截断。aTop 为该列地表高度（沙盘单位，岩层材质按它分层）。
 * K：米 → 沙盘单位；base：岩层底面（沙盘单位）
 */
export function skirtGeometries(rim: Float32Array, K: number, base: number) {
  const rockPos: number[] = []
  const rockTop: number[] = []
  const seaPos: number[] = []
  const seaTop: number[] = []
  const b = base / K
  const L = WATER_LEVEL
  for (let k = 0; k + 5 < rim.length; k += 3) {
    const x0 = rim[k]
    const h0 = rim[k + 1]
    const z0 = rim[k + 2]
    const x1 = rim[k + 3]
    const h1 = rim[k + 4]
    const z1 = rim[k + 5]
    // 外侧朝外：沿边逆时针走（从上方看），面 (底0, 底1, 顶1, 顶0)
    quad(rockPos, rockTop, [x0, b, z0], [x1, b, z1], [x1, h1, z1], [x0, h0, z0], h0 * K, h1 * K, true)
    if (h0 >= L && h1 >= L) continue
    // 海水截面：两端都在水下是四边形；一端出水时截到地表与水面的交点
    let ax = x0
    let az = z0
    let ah = h0
    let bx = x1
    let bz = z1
    let bh = h1
    if (h0 > L) {
      const t = (h0 - L) / (h0 - h1)
      ax = x0 + (x1 - x0) * t
      az = z0 + (z1 - z0) * t
      ah = L
    } else if (h1 > L) {
      const t = (L - h0) / (h1 - h0)
      bx = x0 + (x1 - x0) * t
      bz = z0 + (z1 - z0) * t
      bh = L
    }
    quad(seaPos, seaTop, [ax, ah, az], [bx, bh, bz], [bx, L, bz], [ax, L, az], ah * K, bh * K, false)
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

// —————————————————————— 地面：网格、贴图与高清块 ——————————————————————

interface Level {
  color: HTMLCanvasElement
  mask: HTMLCanvasElement
  colorTex: THREE.CanvasTexture
  maskTex: THREE.CanvasTexture
  rect: THREE.Vector4
  /** 画的时候的视点与边长（米），边长 0 为没在用 */
  cx: number
  cz: number
  size: number
  x0: number
  z0: number
}

/**
 * 沙盘的地面：贴图（画布与显存里的贴图跨城复用）、材质的 uniform，和每座城的地形与水面网格。
 * 二维渲染器的显示列表按快照与风格留一份，整幅贴图与高清块都从它栅格化
 */
export class TownGround {
  private base = document.createElement('canvas')
  private baseMask = document.createElement('canvas')
  private baseTex: THREE.CanvasTexture
  private baseMaskTex: THREE.CanvasTexture
  /** 高清块：0 粗、1 细 */
  private levels: Level[]
  private measurer = document.createElement('canvas').getContext('2d')!
  private vec: GroundVector | null = null
  private st: Settlement | null = null
  private style: SettleStyleId = DIORAMA_STYLE
  private maxTex: number
  private u: Uniforms

  constructor(renderer: THREE.WebGLRenderer) {
    this.maxTex = renderer.capabilities.maxTextureSize
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy())
    const colorTex = (cv: HTMLCanvasElement) => {
      const t = new THREE.CanvasTexture(cv)
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = aniso
      return t
    }
    // 掩膜存的是编号：不插值、不要多级渐远
    const maskTex = (cv: HTMLCanvasElement) => {
      const t = new THREE.CanvasTexture(cv)
      t.colorSpace = THREE.NoColorSpace
      t.magFilter = t.minFilter = THREE.NearestFilter
      t.generateMipmaps = false
      return t
    }
    this.base.width = this.base.height = 4
    this.baseMask.width = this.baseMask.height = 4
    this.baseTex = colorTex(this.base)
    this.baseMaskTex = maskTex(this.baseMask)
    this.levels = [0, 1].map(() => {
      const color = document.createElement('canvas')
      const mask = document.createElement('canvas')
      // 高清块尺寸固定：贴图在显存里按首次上传的尺寸分配，之后只更新内容
      color.width = color.height = mask.width = mask.height = LEVEL
      return { color, mask, colorTex: colorTex(color), maskTex: maskTex(mask), rect: new THREE.Vector4(0, 0, 0, 0), cx: 0, cz: 0, size: 0, x0: 0, z0: 0 }
    })
    this.u = {
      uBase: { value: this.baseTex },
      uBaseMask: { value: this.baseMaskTex },
      uLv1: { value: this.levels[0].colorTex },
      uLv1Mask: { value: this.levels[0].maskTex },
      uLv2: { value: this.levels[1].colorTex },
      uLv2Mask: { value: this.levels[1].maskTex },
      uRect1: { value: this.levels[0].rect },
      uRect2: { value: this.levels[1].rect },
      uTexel: { value: new THREE.Vector3(1, 1, 1) },
      uSize: { value: new THREE.Vector2(1, 1) },
      uShore: { value: null },
      uReal: { value: 1 },
      uMeter: { value: 1 },
      uPaved: { value: 0 },
    }
  }

  /**
   * 换一座城：地形与水面网格（加进城市组；几何、材质随网格释放，水岸贴图与深度材质挂在 userData.field / depth 上）。
   * life：成长的 uniform（uPop、uPrev、uT），K：场景单位 / 米
   */
  build(st: Settlement, t: TerrainMesh, life: Uniforms, K: number): THREE.Mesh[] {
    this.forget()
    clearGroundTiles()
    const shore = new THREE.DataTexture(t.shore, st.terrain.W, st.terrain.H, THREE.RGBAFormat, THREE.UnsignedByteType)
    shore.magFilter = shore.minFilter = THREE.LinearFilter
    shore.needsUpdate = true
    this.u.uShore.value = shore
    this.u.uSize.value.set(st.width, st.height)
    this.u.uMeter.value = K
    this.u.uPaved.value = dioramaGround(st.params.culture).paved ? 1 : 0
    const u = { ...this.u, ...life }

    const pos = new THREE.BufferAttribute(t.pos, 3)
    const carve = new THREE.BufferAttribute(t.carve, 4)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', pos)
    g.setAttribute('normal', new THREE.BufferAttribute(t.nrm, 3, true))
    g.setAttribute('aNormal2', new THREE.BufferAttribute(t.nrm2, 3, true))
    g.setAttribute('aCarve', carve)
    g.setIndex(new THREE.BufferAttribute(t.idx, 1))
    g.computeBoundingSphere()
    const ground = new THREE.Mesh(g, createGroundMaterial(u))
    ground.receiveShadow = ground.castShadow = true
    const depth = createGroundDepth(life)
    ground.customDepthMaterial = depth
    ground.userData.depth = depth
    ground.userData.field = shore

    const wg = new THREE.BufferGeometry()
    wg.setAttribute('position', pos)
    // 法线在着色器里恒为朝上；带上这个属性只为不被当成平面着色（那样法线由屏幕导数求，没有 vNormal）
    wg.setAttribute('normal', g.getAttribute('normal'))
    wg.setAttribute('aCarve', carve)
    wg.setIndex(new THREE.BufferAttribute(t.wet, 1))
    wg.boundingSphere = g.boundingSphere!.clone()
    const water = new THREE.Mesh(wg, createWaterMaterial(u))
    water.receiveShadow = true
    water.renderOrder = 2
    return [ground, water]
  }

  /** 忘掉上一座城的高清块与显示列表 */
  forget() {
    for (const lv of this.levels) {
      lv.size = 0
      lv.rect.set(0, 0, 0, 0)
    }
    this.vec = null
    this.st = null
  }

  /**
   * 按快照与风格重画整幅贴图（宽 4096 像素，掩膜减半），正在用的高清块跟着重画
   *（成长回放时镜头不动，近处与整幅保持一致）。返回耗时（毫秒）
   */
  paint(st: Settlement, style: SettleStyleId): number {
    const t0 = performance.now()
    if (!this.vec || this.st !== st || this.style !== style) {
      this.vec = buildGroundVector(st, style, this.measurer)
      this.st = st
      this.style = style
    }
    const { color, mask } = this.vec
    const w = Math.min(BASE_W, this.maxTex)
    const sc = w / color.MW
    const h = Math.min(this.maxTex, Math.round(color.MH * sc))
    const fit = (cv: HTMLCanvasElement, tex: THREE.Texture, cw: number, ch: number) => {
      if (cv.width === cw && cv.height === ch) return
      cv.width = cw
      cv.height = ch
      // 尺寸变了：显存里的贴图要重新分配
      tex.dispose()
    }
    fit(this.base, this.baseTex, w, h)
    color.render(this.base.getContext('2d')!, sc, -color.M * sc, -color.M * sc, 'map', false)
    this.baseTex.needsUpdate = true
    if (mask) {
      fit(this.baseMask, this.baseMaskTex, w >> 1, h >> 1)
      mask.render(this.baseMask.getContext('2d')!, sc / 2, (-mask.M * sc) / 2, (-mask.M * sc) / 2, 'map', false)
      this.baseMaskTex.needsUpdate = true
    }
    this.u.uReal.value = mask ? 1 : 0
    this.u.uTexel.value.x = st.width / (w >> 1)
    for (const lv of this.levels) if (lv.size) this.paintLevel(lv, lv.x0, lv.z0, lv.size)
    return performance.now() - t0
  }

  /** 高清块：米坐标的方块 [x0, z0, 边长 size] 栅格化到 LEVEL 见方的画布 */
  private paintLevel(lv: Level, x0: number, z0: number, size: number) {
    const { color, mask } = this.vec!
    const S = color.MW / this.st!.width
    const sc = LEVEL / (size * S)
    const draw = (cv: HTMLCanvasElement, list: typeof color) => {
      const ctx = cv.getContext('2d')!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = '#808080'
      ctx.fillRect(0, 0, LEVEL, LEVEL)
      list.render(ctx, sc, -(list.M + x0 * S) * sc, -(list.M + z0 * S) * sc, 'map', false)
    }
    draw(lv.color, color)
    lv.colorTex.needsUpdate = true
    if (mask) {
      draw(lv.mask, mask)
      lv.maskTex.needsUpdate = true
    }
    Object.assign(lv, { x0, z0, size })
    lv.rect.set(x0, z0, 1 / size, 1 / size)
    const tx = this.u.uTexel.value as THREE.Vector3
    if (lv === this.levels[0]) tx.y = size / LEVEL
    else tx.z = size / LEVEL
  }

  /**
   * 高清块跟着视点（镜头停稳后调用）：视点 (cx, cz)、观察距离 dist（米）。
   * 细的一级边长约为观察距离的 1.3 倍（纹素约等于视点处的屏幕像素）；它比整幅细得多时，中间再垫一级。
   * 视点移出一定范围或缩放明显才重画，一次只画一级（栅格化与上传要几十毫秒）：
   * changed 为这次画面变了，pending 为还有一级等着下次画
   */
  focus(cx: number, cz: number, dist: number): { changed: boolean; pending: boolean } {
    const r = { changed: false, pending: false }
    const st = this.st
    if (!this.vec || !st) return r
    const tb = st.width / this.base.width
    const s2 = Math.max(48, dist * 1.3)
    const t2 = s2 / LEVEL
    const want = [0, 0]
    if (t2 < tb * 0.7) {
      want[1] = s2
      if (tb / t2 > 5) want[0] = Math.sqrt(t2 * tb) * LEVEL
    }
    let painted = false
    for (const k of [1, 0]) {
      const lv = this.levels[k]
      const size = want[k]
      if (!size) {
        if (lv.size) {
          lv.size = 0
          lv.rect.set(0, 0, 0, 0)
          r.changed = true
        }
        continue
      }
      if (lv.size && Math.hypot(cx - lv.cx, cz - lv.cz) < lv.size * 0.16 && Math.abs(Math.log(size / lv.size)) < 0.28) continue
      if (painted) {
        r.pending = true
        continue
      }
      // 尽量整块落在图内（图外没有东西可画）
      const fitIn = (c: number, span: number) => (size >= span ? (span - size) / 2 : Math.min(span - size, Math.max(0, c - size / 2)))
      this.paintLevel(lv, fitIn(cx, st.width), fitIn(cz, st.height), size)
      lv.cx = cx
      lv.cz = cz
      painted = r.changed = true
    }
    return r
  }

  dispose() {
    this.forget()
    this.baseTex.dispose()
    this.baseMaskTex.dispose()
    this.base.width = this.base.height = 1
    this.baseMask.width = this.baseMask.height = 1
    for (const lv of this.levels) {
      lv.colorTex.dispose()
      lv.maskTex.dispose()
      lv.color.width = lv.color.height = lv.mask.width = lv.mask.height = 1
    }
  }
}
