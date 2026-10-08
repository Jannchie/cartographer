import * as THREE from 'three'
import { NOISE_GLSL } from '../aerial/glsl'

/**
 * 全息沙盘的着色器。颜色都是线性空间，交给后期管线泛光后再转 sRGB；
 * 亮线故意超过 1，好让泛光把它们晕开。
 */

/**
 * 镂空网格：间距 s 的网格线在交点附近断开（方形空当，半宽 gap），交点正中留一个臂长 arm 的小十字。
 * 返回 vec2(网格线, 十字)；k 为线宽（像素倍数）。网格密过像素时整体淡出
 */
const NOTCHED_GRID = /* glsl */ `
  vec2 notchedGrid(vec2 p, float s, float gap, float arm, float k) {
    vec2 g = p / s;
    vec2 w = fwidth(g);
    vec2 d = 0.5 - abs(fract(g) - 0.5);
    // l.x：x 为常数的线（沿 z 走），l.y：z 为常数的线
    vec2 l = 1.0 - smoothstep(vec2(0.0), w * k, d);
    vec2 dw = d * s;
    vec2 pw = fwidth(p);
    // 沿 z 走的线在靠近横线处断开，反之亦然
    float lines = max(l.x * smoothstep(gap - pw.y, gap + pw.y, dw.y), l.y * smoothstep(gap - pw.x, gap + pw.x, dw.x));
    float cross = max(l.x * (1.0 - smoothstep(arm - pw.y, arm + pw.y, dw.y)), l.y * (1.0 - smoothstep(arm - pw.x, arm + pw.x, dw.x)));
    float fade = 1.0 - smoothstep(0.15, 0.45, max(w.x, w.y));
    return vec2(lines, cross) * fade;
  }
`

/**
 * 点阵：间距 s 的规则点阵，每点约一像素（近看不放大）；亮度不均，
 * 低频噪声让点阵成片明暗起伏，每个点再带一点随机。格子小于像素时退回平均亮度，避免摩尔纹
 */
const DOT_MATRIX = /* glsl */ `
  float dotMatrix(vec2 p, float s) {
    vec2 g = p / s;
    // 透视下纵向压缩得更厉害：按两个方向里更密的一边决定何时退回平均亮度
    vec2 fw = fwidth(g);
    float px = max(fw.x, fw.y) + 1e-5;
    float r = min(0.28, px * 0.7);
    float d = length(fract(g) - 0.5);
    float m = 1.0 - smoothstep(r * 0.5, r + px * 0.5, d);
    // 点距小于约 8 像素就开始退回平均亮度（点径不到一像素时，镜头一动点就在像素间跳动闪烁）；
    // 每点的随机亮度同样抹平
    float avg = smoothstep(0.12, 0.3, px);
    m = mix(m, min(1.0, 3.1416 * r * r * 1.4), avg);
    float n = vnoise(p * 0.07) * 0.65 + vnoise(p * 0.33 + 7.0) * 0.35;
    return m * smoothstep(0.2, 0.85, n) * (0.55 + 0.45 * mix(hash12(floor(g)), 0.5, avg));
  }
`

/** 地形格坐标 → 贴图坐标（格中心对齐纹素中心） */
const TEX_UV = /* glsl */ `
  vec2 texUv(vec2 uv) { return (vec2(uv.x, 1.0 - uv.y) * (uGrid - 1.0) + 0.5) / uGrid; }
`

/** 海拔 → 台面高度：陆地整体抬起 uLift（像一块块切出来的地形片），再按 uRelief 夸张起伏 */
const GROUND_H = /* glsl */ `
  float groundH(float e) { return smoothstep(-0.004, 0.004, e) * uLift + max(e, 0.0) * uRelief; }
`

export interface TerrainUniforms {
  uHeight: { value: THREE.Texture | null }
  uData: { value: THREE.Texture | null }
  uIds: { value: THREE.Texture | null }
  /** 锁定、悬停的陆块编号 +1（0 为无） */
  uSel: { value: number }
  uHov: { value: number }
  uGrid: { value: THREE.Vector2 }
  uSize: { value: THREE.Vector2 }
  uRelief: { value: number }
  uLift: { value: number }
  uReveal: { value: number }
  /**
   * 展开动画（离线录制的片头）：地图分成方块，以 uCenter（场景 xz）为圆心、按方块中心的距离（加一点随机）
   * 落在半径 uUnfold 以内的方块才有地形；前沿 uBand 宽的一圈方块从平地升到原本的高度，刚出现的方块发亮并描出方格。
   * uUnfold 很大时不起作用
   */
  uUnfold: { value: number }
  uCenter: { value: THREE.Vector2 }
  uBand: { value: number }
  uLand: { value: THREE.Color }
  uAccent: { value: THREE.Color }
  uSea: { value: THREE.Color }
  uLine: { value: THREE.Color }
  uFill: { value: THREE.Vector2 }
  uGlow: { value: number }
}

/**
 * 地形：像素块明暗 + 山体晕渲，海岸内外一圈辉光，陆块侧壁发亮；
 * 海面是深色底上的细密点阵与等深线。uData 是模糊的陆地掩膜；uIds 是每格的陆块编号，与 uSel / uHov 比较得出锁定、悬停的范围。
 */
export function createTerrainMaterial() {
  const uniforms: TerrainUniforms = {
    uHeight: { value: null },
    uData: { value: null },
    uIds: { value: null },
    uSel: { value: 0 },
    uHov: { value: 0 },
    uGrid: { value: new THREE.Vector2(1, 1) },
    uSize: { value: new THREE.Vector2(100, 62.5) },
    uRelief: { value: 1 },
    uLift: { value: 0.35 },
    uReveal: { value: 1 },
    uUnfold: { value: 1e6 },
    uCenter: { value: new THREE.Vector2() },
    uBand: { value: 22 },
    uLand: { value: new THREE.Color() },
    uAccent: { value: new THREE.Color() },
    uSea: { value: new THREE.Color() },
    uLine: { value: new THREE.Color() },
    uFill: { value: new THREE.Vector2(0.5, 0.8) },
    uGlow: { value: 1 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      uniform sampler2D uHeight;
      uniform vec2 uGrid;
      uniform float uRelief;
      uniform float uLift;
      uniform float uUnfold;
      uniform vec2 uCenter;
      uniform float uBand;
      varying vec2 vT;
      varying vec3 vWp;
      ${TEX_UV}
      ${GROUND_H}
      // 展开用的方块：边长 2.4，距离按方块中心算并加随机，前沿参差
      float unfoldD(vec2 xz) {
        vec2 t = floor(xz / 2.4);
        return length((t + 0.5) * 2.4 - uCenter) + fract(sin(dot(t, vec2(12.9898, 78.233))) * 43758.5453) * 7.0;
      }
      void main() {
        vT = texUv(uv);
        vec3 p = position;
        // 展开：前沿的一圈方块从平地升起
        float d = unfoldD((modelMatrix * vec4(p, 1.0)).xz);
        float rise = smoothstep(0.0, 1.0, clamp((uUnfold - d) / uBand, 0.0, 1.0));
        p.y = groundH(texture2D(uHeight, vT).r) * rise;
        vec4 w = modelMatrix * vec4(p, 1.0);
        vWp = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uHeight;
      uniform sampler2D uData;
      uniform sampler2D uIds;
      uniform float uSel;
      uniform float uHov;
      uniform vec2 uGrid;
      uniform vec2 uSize;
      uniform float uRelief;
      uniform float uReveal;
      uniform float uUnfold;
      uniform vec2 uCenter;
      uniform vec3 uLand;
      uniform vec3 uAccent;
      uniform vec3 uSea;
      uniform vec3 uLine;
      uniform vec2 uFill;
      uniform float uGlow;
      varying vec2 vT;
      varying vec3 vWp;
      ${NOISE_GLSL}
      // 展开用的方块：边长 2.4，距离按方块中心算并加随机，前沿参差
      float unfoldD(vec2 xz) {
        vec2 t = floor(xz / 2.4);
        return length((t + 0.5) * 2.4 - uCenter) + fract(sin(dot(t, vec2(12.9898, 78.233))) * 43758.5453) * 7.0;
      }

      ${NOTCHED_GRID}
      ${DOT_MATRIX}
      /** 等值线：v 每过一个整数画一道细线（屏幕上约一像素宽） */
      float iso(float v) {
        float w = fwidth(v) + 1e-5;
        return 1.0 - smoothstep(0.0, 1.2 * w, 0.5 - abs(fract(v) - 0.5));
      }
      /** 编号贴图是最近邻采样：取周围四格与 id 比较，再双线性混合，得到边缘平滑的掩膜 */
      float idMask(float id) {
        if (id < 0.5) return 0.0;
        vec2 p = vT * uGrid - 0.5;
        vec2 f = fract(p);
        vec2 b = (floor(p) + 0.5) / uGrid;
        vec2 tx = 1.0 / uGrid;
        vec4 q;
        vec2 c;
        c = texture2D(uIds, b).rg * 255.0;                       q.x = float(abs(c.x + c.y * 256.0 - id) < 0.5);
        c = texture2D(uIds, b + vec2(tx.x, 0.0)).rg * 255.0;     q.y = float(abs(c.x + c.y * 256.0 - id) < 0.5);
        c = texture2D(uIds, b + vec2(0.0, tx.y)).rg * 255.0;     q.z = float(abs(c.x + c.y * 256.0 - id) < 0.5);
        c = texture2D(uIds, b + tx).rg * 255.0;                  q.w = float(abs(c.x + c.y * 256.0 - id) < 0.5);
        return mix(mix(q.x, q.y, f.x), mix(q.z, q.w, f.x), f.y);
      }
      void main() {
        vec2 tx = 1.0 / uGrid;
        float e = texture2D(uHeight, vT).r;
        float coast = texture2D(uData, vT).r;
        float sel = idMask(uSel);
        float hov = uHov == uSel ? 0.0 : idMask(uHov);
        float land = smoothstep(-0.004, 0.004, e);
        float cs = uSize.x / uGrid.x;
        float ex = texture2D(uHeight, vT + vec2(tx.x, 0.0)).r - texture2D(uHeight, vT - vec2(tx.x, 0.0)).r;
        float ez = texture2D(uHeight, vT + vec2(0.0, tx.y)).r - texture2D(uHeight, vT - vec2(0.0, tx.y)).r;
        vec3 n = normalize(vec3(-ex * uRelief / (2.0 * cs), 1.0, -ez * uRelief / (2.0 * cs)));
        float shade = clamp(dot(n, normalize(vec3(-0.55, 0.75, -0.4))), 0.0, 1.0);

        // 像素块：大小不一的方块明暗（像低分辨率的卫星底图）
        vec2 bc = floor(vWp.xz / 0.8);
        float hb = hash12(bc);
        float blk = 0.82 + 0.45 * step(0.74, hb) * hash12(bc + 7.1) - 0.22 * step(hb, 0.12);
        vec2 bc2 = floor(vWp.xz / 2.4);
        blk *= 0.9 + 0.2 * hash12(bc2 + 3.7);

        vec3 tint = mix(uLand * uFill.x, uAccent * uFill.y, sel);
        float tone = clamp(0.2 + 0.85 * pow(shade, 1.3), 0.0, 1.0);
        // 晕渲与像素块的明暗
        vec3 landCol = tint * (0.1 + 0.45 * tone * blk);
        // 山脊上叠一层细等高线
        landCol += tint * iso(e / 0.25) * 0.35 * smoothstep(0.05, 0.3, e);

        vec3 seaCol = uSea * (0.9 + 0.25 * blk);
        // 海面：细密点阵
        seaCol += uLine * dotMatrix(vWp.xz, 0.16) * 0.28;
        seaCol += uLine * iso(-e / 0.8) * 0.07 * smoothstep(0.05, 0.3, -e);

        vec3 col = mix(seaCol, landCol, land);
        // 海岸辉光：模糊掩膜在 0.5 附近
        float rim = 1.0 - smoothstep(0.0, 0.45, abs(coast - 0.5));
        col += mix(uLand, tint, land) * rim * rim * mix(0.03, 0.07, land) * uGlow;
        // 陆块侧壁（几何法线接近水平）发亮
        vec3 cr = cross(dFdx(vWp), dFdy(vWp));
        vec3 ng = cr / max(length(cr), 1e-8);
        float wall = (1.0 - abs(ng.y)) * step(0.01, vWp.y);
        col += mix(uLand, uAccent, sel) * wall * 0.16 * uGlow;
        // 经纬网：每 5 个单位一道淡线，交点处镂空、正中一个小十字
        vec2 gr = notchedGrid(vWp.xz, 5.0, 0.55, 0.22, 1.2);
        col += uLine * (gr.x * 0.05 + gr.y * 0.3);
        // 悬停：再提亮一些
        col *= 1.0 + hov * 0.5;

        // 开场：从后往前铺开，前沿一道亮线
        float rz = mix(-uSize.y * 0.5 - 2.0, uSize.y * 0.5 + 2.0, uReveal);
        if (vWp.z > rz) discard;
        col += uLine * exp(-(rz - vWp.z) * 2.5) * 2.5 * (1.0 - step(1.0, uReveal));
        // 展开：前沿以外的方块不画；刚出现的方块整块发亮并描出方格，随后回落
        float dr = uUnfold - unfoldD(vWp.xz);
        if (dr < 0.0) discard;
        float on = 1.0 - step(1e5, uUnfold);
        vec2 cell = fract(vWp.xz / 2.4);
        float edge = min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y));
        float frame = 1.0 - smoothstep(0.0, 0.05, edge);
        col += uLine * (exp(-dr * 0.7) * (1.2 + frame * 2.5) + exp(-dr * 0.2) * 0.12) * on;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  return { mat, uniforms }
}

/**
 * 投影台地板：网格的要素由近及远递减。图框内外是完整的细网格与镂空主网格，
 * 往外细网格先消失、再是主网格，远处只剩几道辅助线（中轴的延长线、稀疏的长线；图框四边的延长线由场景里的线画）
 */
export function createFloorMaterial() {
  const uniforms = {
    uLine: { value: new THREE.Color() },
    uBg: { value: new THREE.Color() },
    /** 图框的半宽、半深 */
    uHalf: { value: new THREE.Vector2(52, 34) },
    /**
     * 进出场（离线录制的片头片尾）：按 10 单位的主网格分块，方块中心的方形距离（以图框为 1，加一点随机）
     * 小于 uReach 的方块才有底纹；主网格与十字先出，细网格与点阵晚一拍，刚出现的方块整块闪亮。很大时不起作用
     */
    uReach: { value: 1e6 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWp;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWp = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uLine;
      uniform vec3 uBg;
      uniform vec2 uHalf;
      uniform float uReach;
      varying vec3 vWp;
      ${NOISE_GLSL}
      ${NOTCHED_GRID}
      ${DOT_MATRIX}
      /** 一道位于 v = c 的细线（屏幕上约一像素） */
      float lineAt(float v, float c) {
        float w = fwidth(v) + 1e-5;
        return 1.0 - smoothstep(0.0, w * 1.2, abs(v - c));
      }
      void main() {
        vec2 p = vWp.xz;
        // 以图框为 1 的方形距离：要素随它递减
        float rr = max(abs(p.x) / uHalf.x, abs(p.y) / uHalf.y);
        float minorW = 1.0 - smoothstep(1.0, 1.5, rr);
        float majorW = 1.0 - smoothstep(1.3, 2.2, rr);
        // 主网格（10）交点镂空、正中小十字；细网格（2）在主交点的空当里也断开
        vec2 major = notchedGrid(p, 10.0, 1.1, 0.5, 1.6);
        vec2 minor = notchedGrid(p, 2.0, -1.0, -1.0, 1.0);
        vec2 q = abs(mod(p + 5.0, 10.0) - 5.0);
        float hole = step(q.x, 1.1) * step(q.y, 1.1);
        // 进出场：所在方块离中心的距离（含随机），主网格到 uReach 即出，细网格与点阵要再晚 0.35
        vec2 cell = floor(p / 10.0);
        vec2 cc = (cell + 0.5) * 10.0;
        float cr = max(abs(cc.x) / uHalf.x, abs(cc.y) / uHalf.y) + hash12(cell) * 0.45;
        float lead = uReach - cr;
        float inMajor = step(0.0, lead);
        float inMinor = step(0.35, lead);
        float flash = inMajor * exp(-max(lead, 0.0) * 9.0) * (1.0 - step(1e5, uReach));
        float grid = minor.x * (1.0 - hole) * 0.05 * minorW * inMinor + (major.x * 0.16 + major.y * 0.6) * majorW * inMajor * (1.0 + flash * 3.0);
        // 辅助线：中轴的延长线，外加每 50 个单位一道的长线（只在主网格淡出后出现）
        float axis = max(lineAt(p.x, 0.0), lineAt(p.y, 0.0));
        vec2 g50 = notchedGrid(p, 50.0, 2.5, 1.2, 1.0);
        float aux = (axis * 0.08 + (g50.x * 0.06 + g50.y * 0.3) * smoothstep(1.6, 2.4, rr)) * inMajor;
        float fall = exp(-rr * 0.35);
        // 底纹：细密点阵，近处清楚、远处淡去
        float dots = dotMatrix(p, 0.45) * 0.22 * exp(-rr * 0.6) * inMinor;
        // 刚出现的方块：整块淡淡一层亮色
        float fill = flash * 0.05 * exp(-rr * 0.5);
        vec3 c = uBg + uLine * (grid + aux * fall + dots + fill) * (0.55 + 0.45 * exp(-rr * rr * 0.5));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  })
  return { mat, uniforms }
}

/** 收尾：暗角与边缘色差（在泛光之后、转 sRGB 之前；不随时间变化，静止时画面不动） */
export const FinishShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uBg: { value: new THREE.Color() },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uBg;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * 0.012;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      // 暗角往背景色收
      col = mix(col, uBg * 0.6, smoothstep(0.18, 0.62, r2 * 1.6) * 0.75);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
}
