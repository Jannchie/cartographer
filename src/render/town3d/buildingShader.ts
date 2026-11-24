import * as THREE from 'three'
import { NOISE_GLSL } from '../aerial/glsl'

/**
 * 建筑材质：在 MeshStandardMaterial 上补成长升降、墙面与屋面的纹理、窗与门，以及凹凸（扰动法线）。
 *
 * 顶点给出材质字节（mesh.ts 的 MAT，开窗的墙面加 WIN、开门的墙面加 DOOR）与立面坐标
 * （沿墙米数、墙长 + 1024 × 立面样式 STYLE、墙顶）：
 * - 墙面：抹灰、方石、砖、西式木构架、和式真壁、木板、殿堂的木构立面、斗拱层、土坯、白石栏杆；
 *   洞口按立面样式排（民居的窗与门、铺面、教堂的尖拱长窗与玫瑰窗、钟窗、拱廊、槅扇、射孔、伊旺），
 *   样式的细部随文明（uCulture：0 西式、1 东方、2 和式、3 伊斯兰）
 * - 洞口的进深：按视线把洞内的画面向里平移（视差），露出窗洞的侧壁、窗台与过梁底，贴近看有真实的凹进
 * - 屋面：黏土瓦、石板瓦、东亚筒瓦、茅草、木瓦、金属皮；坐标取屋面自身的顺坡、横坡方向
 * - 凹凸：窗框与窗台外凸、砖石缝、瓦垄，按高度场的屏幕导数扰动法线
 * - 细节按像素足迹淡出：每种图案在一个周期不足两三个像素之前退到它的平均色（远看、移动时不闪、不出摩尔纹）
 * 改 MAT、STYLE 的编号要同步改 mesh.ts
 */

/** 成长：生卒 (born, died) 在 uPrev 与 uPop 两个时刻的存亡 → 高度比例（新建的随 uT 升起，拆除的随 uT 沉下） */
export const LIFE_GLSL = /* glsl */ `
  uniform float uPop;
  uniform float uPrev;
  uniform float uT;
  float lifeK(vec2 l) {
    bool now = uPop >= l.x && uPop < l.y;
    bool was = uPrev >= l.x && uPrev < l.y;
    return now ? (was ? 1.0 : uT) : (was ? 1.0 - uT : 0.0);
  }
`

const FRAG_HEAD = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vLocalN;
  varying float vFace;
  varying float vBase;
  varying vec3 vUv;
  varying float vSeed;
  varying vec3 vCam;
  uniform float uNight;
  uniform float uStorey;
  uniform float uMeter;
  uniform float uCulture;
  ${NOISE_GLSL}

  // 片元的公共量：像素足迹（米）、三档细节的淡出、洞口的视差（每米进深在墙面上的平移）
  float gAA;
  float gFine;
  float gMid;
  float gCoarse;
  vec2 gPar;
  // 片元的输出：凹凸高度（米）、玻璃、夜里的窗灯、粗糙度与金属度的改写
  float gBump;
  float gGlass;
  float gLit;
  float gRough;
  float gMetal;

  /** 线宽 w 的抗锯齿边：d 为到边的距离（米） */
  float edgeMask(float d, float w, float aa) { return 1.0 - smoothstep(w - aa, w + aa, d); }
  /** 矩形内的有向距离（负值在内）：中心 c、半宽 h */
  float boxD(vec2 p, vec2 c, vec2 h) { vec2 q = abs(p - c) - h; return max(q.x, q.y); }
  /** 周期为 p 米的图案的可见度：一个周期不足两三个像素时退到平均色 */
  float fadeP(float p) { return 1.0 - smoothstep(0.15, 0.4, gAA / p); }
  /** 周期 p 的格线：到最近格线的距离（米） */
  float gridD(float x, float p) { return abs(fract(x / p + 0.5) - 0.5) * p; }

  /**
   * 洞口的有向距离（负值在洞内）：p 以洞口底边中点为原点，半宽 hw、总高 h；
   * arch：0 平顶，1 尖拱（两段圆弧相交），2 半圆拱，3 马蹄拱（圆心抬高、略大于半圆）
   */
  float holeD(vec2 p, float hw, float h, float arch) {
    float d = max(abs(p.x) - hw, -p.y);
    if (arch < 0.5) return max(d, p.y - h);
    if (arch < 1.5) {
      float R = hw * 1.5;
      float rise = sqrt(R * R - (R - hw) * (R - hw));
      float sp = h - rise;
      if (p.y > sp) d = max(d, length(vec2(abs(p.x) + R - hw, p.y - sp)) - R);
      return d;
    }
    if (arch < 2.5) {
      float sp = h - hw;
      if (p.y > sp) d = max(d, length(vec2(p.x, p.y - sp)) - hw);
      return d;
    }
    float R = hw * 1.12;
    float sp = h - R;
    if (p.y > sp - R * 0.45) d = max(max(-p.y, p.y - h), length(vec2(p.x, p.y - sp)) - R);
    return d;
  }

  /**
   * 带进深的洞口：返回 (洞口内, 洞底的面（玻璃、门扇）可见, 侧壁的明暗)；pi 为洞底平面上的对应点。
   * 视线斜着看进去时洞底的画面向里平移，露出的一圈是侧壁：窗台朝上受光、过梁底在暗处
   */
  vec3 hole(vec2 p, float hw, float h, float arch, float dep, out vec2 pi) {
    float lim = 0.6 * min(hw, h * 0.5);
    vec2 off = clamp(gPar * dep, vec2(-lim), vec2(lim));
    pi = p - off;
    float dO = holeD(p, hw, h, arch);
    float dI = holeD(pi, hw, h, arch);
    float inside = 1.0 - smoothstep(-gAA, gAA, dO);
    float pane = inside * (1.0 - smoothstep(-gAA, gAA, dI));
    float ex = abs(pi.x) - hw;
    float eb = -pi.y;
    float rs = (eb > 0.0 && eb >= ex) ? 1.0 : (ex > 0.0 ? 0.8 : 0.5);
    return vec3(inside, pane, rs);
  }

  /**
   * 砌体：层高 ch、块长 bl、灰缝宽 mw；返回 (块的明暗, 灰缝, 块面凸起)
   */
  vec3 masonry(vec2 p, float ch, float bl, float mw, float aa) {
    float row = floor(p.y / ch);
    float xo = p.x / bl + row * 0.5 + hash12(vec2(row, 3.1)) * 0.2;
    vec2 cell = vec2(floor(xo), row);
    vec2 f = vec2(fract(xo) * bl, fract(p.y / ch) * ch);
    float e = min(min(f.x, bl - f.x), min(f.y, ch - f.y));
    float joint = edgeMask(e, mw * 0.5, aa);
    float tone = 0.86 + 0.28 * hash12(cell + 0.37);
    float bevel = smoothstep(0.0, mw * 1.2 + aa, e);
    return vec3(tone, joint, bevel);
  }

  /** 由高度场 h（场景单位）扰动法线：Mikkelsen 的屏幕空间凹凸 */
  vec3 bumpNormal(vec3 p, vec3 n, float h) {
    vec3 dpx = dFdx(p);
    vec3 dpy = dFdy(p);
    vec3 r1 = cross(dpy, n);
    vec3 r2 = cross(n, dpx);
    float det = dot(dpx, r1);
    vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
    return normalize(abs(det) * n - g);
  }

  /** 玻璃：映着天光（上亮下暗），每扇窗明暗不一；t 为窗内自下而上的比例 */
  vec3 glassC(float t, float seed) {
    return mix(vec3(0.03, 0.04, 0.055), vec3(0.3, 0.36, 0.44), (0.12 + 0.55 * t) * (0.45 + 0.7 * seed));
  }
`

/** 片元：墙面、窗与门、屋面；写 gBump（米）、gGlass（玻璃，压低粗糙度）与 gLit（夜里的窗灯） */
const FRAG_BODY = /* glsl */ `
  gBump = 0.0;
  gGlass = 0.0;
  gLit = 0.0;
  gRough = -1.0;
  gMetal = 0.0;
  {
    float mf = floor(vFace * 255.0 + 0.5);
    bool win = mf >= 127.5;
    float m = win ? mf - 128.0 : mf;
    bool door = m >= 63.5;
    if (door) m -= 64.0;
    vec3 N = normalize(vLocalN);
    vec3 col = diffuseColor.rgb;
    // 一个像素对应的米数：细节按它淡出（远看不闪）
    gAA = max(length(fwidth(vLocal)) * 0.7, 1e-4);
    float aa = gAA;
    gFine = 1.0 - smoothstep(0.018, 0.05, aa);
    gMid = 1.0 - smoothstep(0.045, 0.14, aa);
    gCoarse = 1.0 - smoothstep(0.15, 0.48, aa);
    float fine = gFine;
    float mid = gMid;
    float coarse = gCoarse;
    float n1 = vnoise(vLocal.xz * 0.35 + vLocal.y * 0.2 + vSeed * 17.0);
    bool pitched = m == 1.0 || m == 2.0 || m == 9.0 || m == 14.0 || m == 25.0 || m == 24.0;

    if (pitched) {
      // —— 屋面：顺坡坐标（米，沿坡面量）与横坡坐标 ——
      vec2 dh = N.xz;
      float sl = length(dh);
      vec2 d = sl > 1e-3 ? dh / sl : vec2(0.0, 1.0);
      vec2 tr = vec2(-d.y, d.x);
      float along = dot(vLocal.xz, tr);
      float down = dot(vLocal.xz, d) / max(abs(N.y), 0.3);
      float age = vnoise(vLocal.xz * 0.45 + vSeed * 5.0);
      float streak = vnoise(vec2(along * 1.7 + vSeed * 3.0, down * 0.22));
      if (m == 1.0) {
        // 黏土瓦：一垄一垄的弧形瓦，每排压住下一排，排缝下有阴影
        float rh = 0.34;
        float tw = 0.24;
        float k = fadeP(tw);
        float fr = fract(down / rh);
        float row = floor(down / rh);
        float u = along / tw + hash12(vec2(row, 1.7)) * 0.15;
        float prof = sin(fract(u) * 3.14159);
        float sh = smoothstep(0.0, 0.16, fr);
        float tone = 0.78 + 0.4 * hash12(vec2(floor(u), row) + vSeed);
        col *= mix(0.9, tone * (0.72 + 0.28 * sh) * (0.86 + 0.18 * prof), k);
        gBump += (0.028 * prof * gFine + 0.022 * fr) * k;
      } else if (m == 9.0) {
        // 石板瓦：错缝的矩形薄片
        float rh = 0.2;
        float tw = 0.3;
        float k = fadeP(rh);
        float row = floor(down / rh);
        float fr = fract(down / rh);
        float u = along / tw + row * 0.5;
        float e = min(fract(u), 1.0 - fract(u)) * tw;
        float j = edgeMask(e, 0.008, aa) * fine;
        float sh = smoothstep(0.0, 0.12, fr);
        float tone = 0.82 + 0.34 * hash12(vec2(floor(u), row) + vSeed);
        col *= mix(0.93, tone * (0.75 + 0.25 * sh) * (1.0 - 0.4 * j), k);
        gBump += 0.012 * fr * k;
        gRough = 0.62;
      } else if (m == 2.0) {
        // 东亚筒瓦：板瓦沟与筒瓦垄顺坡而下，筒瓦每节有接缝
        float tw = 0.3;
        float k = fadeP(tw);
        float c = fract(along / tw) - 0.5;
        float cover = 1.0 - smoothstep(0.16, 0.2, abs(c));
        float prof = mix(-0.4 * cos(c * 3.14159), cos(clamp(c / 0.2, -1.0, 1.0) * 1.5708), cover);
        float joint = edgeMask(abs(fract(down / 0.36) - 0.5) * 0.36, 0.012, aa) * cover * fine;
        float tone = 0.9 + 0.2 * hash12(vec2(floor(along / tw), floor(down / 0.36)) + vSeed);
        col *= mix(0.93, mix(0.76, 1.08, cover) * (1.0 - 0.35 * joint) * tone, k);
        gBump += (0.05 * prof - 0.01 * joint) * k;
        // 琉璃瓦（黄、绿的釉面）比青瓦亮
        float sat = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
        gRough = mix(0.8, 0.42, smoothstep(0.06, 0.2, sat));
      } else if (m == 14.0) {
        // 茅草：顺坡的草秆，檐口一层层的茬口
        float k = fadeP(0.08);
        float st = vnoise(vec2(along * 26.0, down * 2.2 + vSeed * 9.0));
        float lay = fract(down / 0.9);
        float k2 = fadeP(0.9);
        col *= mix(0.92, 0.78 + 0.34 * st, k) * mix(1.0, 0.88 + 0.16 * smoothstep(0.0, 0.25, lay), k2);
        gBump += (0.02 * st * k + 0.03 * lay * k2);
        gRough = 0.95;
      } else if (m == 25.0) {
        // 木瓦、桧皮葺：细密的小片，一排排错缝
        float rh = 0.16;
        float tw = 0.12;
        float k = fadeP(tw);
        float row = floor(down / rh);
        float fr = fract(down / rh);
        float u = along / tw + hash12(vec2(row, 4.3));
        float tone = 0.8 + 0.36 * hash12(vec2(floor(u), row) + vSeed);
        float j = edgeMask(min(fract(u), 1.0 - fract(u)) * tw, 0.006, aa) * fine;
        col *= mix(0.92, tone * (0.78 + 0.22 * smoothstep(0.0, 0.2, fr)) * (1.0 - 0.3 * j), k);
        gBump += 0.01 * fr * k;
        gRough = 0.9;
      } else {
        // 檐底：椽子顺坡排列，椽间是暗的望板
        float tw = 0.32;
        float k = fadeP(tw);
        float c = abs(fract(along / tw) - 0.5) * tw;
        float raf = 1.0 - smoothstep(0.055 - aa, 0.055 + aa, c);
        col *= mix(0.86, mix(0.62, 1.25, raf), k);
        gBump += raf * 0.03 * k;
      }
      if (m != 24.0) {
        // 风化：零星的暗斑、顺坡的水渍与青苔
        float w8 = mix(1.0, 0.8 + 0.3 * age, coarse) * mix(1.0, 0.9 + 0.2 * streak, mid);
        col *= w8;
        float moss = smoothstep(0.62, 0.9, vnoise(vLocal.xz * 0.9 + vSeed * 31.0)) * smoothstep(0.5, 0.75, age) * coarse;
        col = mix(col, col * vec3(0.72, 0.86, 0.6), moss * 0.45);
      }
      diffuseColor.rgb = col;
    } else if (m == 8.0) {
      // 平屋顶：灰泥面的斑驳、细裂与积尘
      float cr = vnoise(vLocal.xz * 2.3 + vSeed * 7.0);
      col *= 0.86 + 0.24 * vnoise(vLocal.xz * 0.6 + vSeed * 3.0);
      col *= mix(1.0, 0.9 + 0.2 * cr, mid);
      diffuseColor.rgb = col;
      gRough = 0.95;
    } else if (m == 13.0) {
      // 金属皮：竖向的咬口（穹顶上是经线）与横向的搭接，铜绿的流痕
      float az = atan(N.z, N.x);
      float seamP = 0.2618;
      float sx = abs(fract(az / seamP + 0.5) - 0.5) * seamP * 3.0;
      float k = fadeP(0.6) * step(0.02, length(N.xz));
      float seam = edgeMask(sx, 0.03, aa) * k;
      float lapP = 1.1;
      float lap = edgeMask(gridD(vLocal.y, lapP), 0.015, aa) * fadeP(lapP);
      col *= (0.86 + 0.28 * vnoise(vec2(az * 6.0, vLocal.y * 0.5) + vSeed * 3.0)) * (1.0 - 0.3 * seam) * (1.0 - 0.2 * lap);
      gBump += seam * 0.02;
      gRough = 0.55;
      diffuseColor.rgb = col;
    } else if (m == 28.0) {
      // 鎏金
      diffuseColor.rgb = col * (0.9 + 0.2 * n1);
      gRough = 0.32;
      gMetal = 1.0;
    } else if (abs(N.y) < 0.5) {
      // —— 墙面：沿墙坐标 x（米）、离地高度 y ——
      vec2 tg = vec2(N.z, -N.x) / max(length(N.xz), 1e-4);
      float Lraw = vUv.y;
      float sty = floor(Lraw / 1024.0 + 0.002);
      float L = Lraw - sty * 1024.0;
      bool hasL = Lraw > 0.1;
      float x = hasL ? vUv.x : dot(vLocal.xz, tg);
      float y = vLocal.y - vBase - 0.6;
      vec2 p = vec2(x, y);
      float storey = uStorey;
      // 墙高（自最低的墙脚量起）
      float H = vUv.z - vBase - 0.6;
      // 视差：视线在墙面上的分量 / 垂直墙面的分量
      vec3 V = normalize(vCam);
      vec3 Nh = vec3(N.x, 0.0, N.z) / max(length(N.xz), 1e-4);
      gPar = vec2(dot(V, vec3(tg.x, 0.0, tg.y)), V.y) / max(dot(V, Nh), 0.22);
      // 开间：按墙长均分（窗居中、两端留出墙垛）；没有墙长的面按 1.6 米
      float bay = uCulture < 0.5 ? 2.5 : uCulture < 1.5 ? 3.0 : uCulture < 2.5 ? 1.82 : 3.4;
      if (sty == 3.0 || sty == 4.0) bay = 4.4;
      else if (sty == 7.0) bay = uCulture > 2.5 ? 3.3 : 2.9;
      else if (sty == 8.0) bay = uCulture < 1.5 ? 3.9 : 2.9;
      else if (sty == 9.0) bay = uCulture > 1.5 && uCulture < 2.5 ? 2.2 : 4.2;
      float nb = hasL ? max(1.0, floor(L / bay + 0.35)) : 0.0;
      float bw = nb > 0.0 ? L / nb : 1.6;
      float bi = floor(x / bw);
      float px = x - (bi + 0.5) * bw;
      float fl = floor(y / storey);
      float py = y - fl * storey;
      float seedW = hash12(vec2(bi, fl) + vSeed * 31.7);

      // 墙面底色与纹理
      float grime = mix(0.74, 1.0, smoothstep(0.0, 1.6, y));
      // 檐下、墙顶的雨痕：自上而下的暗条
      float rain = vnoise(vec2(x * 2.1 + vSeed * 13.0, y * 0.25)) * smoothstep(H - 2.5, H, y);
      if (m == 4.0 || (m == 6.0 && fl < 0.5)) {
        // 方整石：层高 0.42、块长 0.8
        vec3 ms = masonry(p, 0.42, 0.82, 0.035, aa);
        float k = fadeP(0.42);
        vec3 stoneC = m == 6.0 ? vec3(0.42, 0.39, 0.34) : col;
        col = mix(stoneC, mix(stoneC * ms.x, stoneC * 1.18, ms.y), k);
        col *= 0.92 + 0.16 * vnoise(p * 0.6 + vSeed * 9.0);
        gBump += ms.z * 0.006 * k;
      } else if (m == 5.0) {
        // 砖：层高 0.11、块长 0.25
        vec3 ms = masonry(p, 0.11, 0.25, 0.014, aa);
        float k = fadeP(0.11);
        col = mix(col * 1.02, mix(col * ms.x, col * 1.25, ms.y), k);
        col *= 0.9 + 0.2 * vnoise(p * 0.7 + vSeed * 9.0);
        gBump += ms.z * 0.004 * k;
      } else if (m == 10.0) {
        // 木板：竖向板缝，每块板明暗不一
        float pw = 0.22;
        float k = fadeP(pw);
        float e = min(fract(x / pw), 1.0 - fract(x / pw)) * pw;
        float j = edgeMask(e, 0.012, aa);
        col *= mix(0.95, (0.82 + 0.3 * hash12(vec2(floor(x / pw), vSeed * 13.0))) * (1.0 - 0.45 * j), k);
        col *= 0.9 + 0.2 * vnoise(vec2(x * 3.0, y * 0.4) + vSeed * 5.0);
        gBump -= j * 0.01 * k;
      } else if (m == 27.0) {
        // 土坯、夯土：一版一版的夯层，掺着草秆与小石
        float k = fadeP(0.5);
        float lay = edgeMask(gridD(y + 0.04 * vnoise(vec2(x * 0.8, 3.0)), 0.5), 0.012, aa);
        col *= (0.88 + 0.22 * vnoise(p * 1.3 + vSeed * 9.0)) * mix(1.0, 1.0 - 0.14 * lay, k);
        col *= mix(1.0, 0.92 + 0.16 * vnoise(p * 9.0), fine);
        gBump -= lay * 0.006 * k;
        gRough = 0.95;
      } else if (m == 26.0) {
        // 白石：须弥座的几道线脚；带栏杆的（样式非 0）顶上一段是望柱与栏板
        float t = vUv.z - vLocal.y;
        col *= 0.93 + 0.1 * vnoise(p * 0.9 + vSeed * 9.0);
        float bh = sty > 0.5 ? 1.05 : 0.0;
        if (t < bh) {
          float pp = 1.7;
          float k = fadeP(pp);
          float cx = gridD(x, pp);
          float post = 1.0 - smoothstep(0.1 - aa, 0.1 + aa, cx);
          float rail = edgeMask(abs(t - 0.12), 0.07, aa);
          float panel = (1.0 - post) * step(0.24, t);
          float carve = edgeMask(abs(boxD(vec2(cx, t), vec2(pp * 0.5, 0.62), vec2(pp * 0.5 - 0.3, 0.2))), 0.02, aa) * panel * fine;
          col *= mix(0.94, 1.0 - 0.1 * panel + 0.06 * post - 0.25 * carve, k);
          gBump += (post * 0.05 + rail * 0.03 - carve * 0.01) * k;
        } else {
          float k = fadeP(0.6);
          float tt = t - bh;
          float m1 = edgeMask(abs(tt - 0.12), 0.06, aa);
          float m2 = edgeMask(abs(H - (vUv.z - vLocal.y) - 0.18), 0.1, aa);
          float jx = edgeMask(gridD(x, 1.4), 0.01, aa) * fine;
          col *= mix(0.97, 1.0 + 0.06 * m1 + 0.04 * m2 - 0.12 * jx, k);
          gBump += (m1 * 0.04 + m2 * 0.03) * k;
        }
        gRough = 0.6;
      } else if (m == 12.0) {
        // 斗拱层：一攒攒上宽下窄的斗拱，攒间是暗的拱眼壁；带高由样式给出（0.15 米一档）
        float bh = max(0.3, sty * 0.15);
        float t = clamp((vUv.z - vLocal.y) / bh, 0.0, 1.0);
        float pp = uCulture < 1.5 ? 1.25 : 1.05;
        float k = fadeP(pp * 0.5);
        float cx = gridD(x, pp);
        float tier = min(2.0, floor((1.0 - t) * 3.0));
        float hw2 = pp * (0.1 + 0.12 * tier);
        float arm = 1.0 - smoothstep(hw2 - aa, hw2 + aa, cx);
        float tf = fract((1.0 - t) * 3.0);
        float gapY = edgeMask(min(tf, 1.0 - tf) * bh / 3.0, 0.012, aa);
        float cid = floor(x / pp + 0.5);
        vec3 c1 = uCulture < 1.5 ? (mod(cid + tier, 2.0) < 0.5 ? vec3(0.07, 0.17, 0.3) : vec3(0.06, 0.24, 0.17)) : vec3(0.3, 0.2, 0.13);
        vec3 edgeC = uCulture < 1.5 ? vec3(0.62, 0.6, 0.5) : vec3(0.75, 0.72, 0.64);
        float rim = arm * max(edgeMask(abs(cx - hw2), 0.025, aa), gapY) * fine;
        vec3 bc = mix(vec3(0.045, 0.035, 0.03), c1, arm);
        bc = mix(bc, edgeC, rim);
        col = mix(mix(vec3(0.045, 0.035, 0.03), c1, 0.55), bc, k);
        gBump += (arm * (0.06 + 0.04 * tier)) * k;
      } else if (m == 15.0) {
        // 釉面砖：蓝绿的几何纹，方砖的缝
        float tp = 0.42;
        float k = fadeP(tp);
        vec2 g = abs(fract(p / tp) - 0.5);
        float star = smoothstep(0.02, 0.0, abs(g.x + g.y - 0.5) * tp - 0.012) + smoothstep(0.02, 0.0, abs(g.x - g.y) * tp - 0.012);
        float cellT = hash12(floor(p / tp) + vSeed);
        vec3 a1 = col * (0.75 + 0.5 * cellT);
        vec3 a2 = mix(col, vec3(0.86, 0.82, 0.68), 0.75);
        col = mix(col * 0.98, mix(a1, a2, clamp(star, 0.0, 1.0) * fine), k);
        gRough = 0.35;
      } else if (m == 11.0) {
        // 殿堂的木构立面：在下面的槅扇样式里画；这里只留底色的斑驳
        col *= 0.92 + 0.14 * vnoise(p * 0.9 + vSeed * 9.0);
      } else {
        // 抹灰、素墙的斑驳，粉刷剥落处露出的底色
        col *= 0.9 + 0.2 * (vnoise(p * 0.8 + vSeed * 9.0) * 0.65 + vnoise(p * 3.3) * 0.35);
        if (m == 3.0) {
          float peel = smoothstep(0.7, 0.86, vnoise(p * 0.55 + vSeed * 23.0)) * (1.0 - smoothstep(0.3, 2.6, y)) * mid;
          col = mix(col, col * vec3(0.78, 0.72, 0.66), peel * 0.6);
        }
      }
      if (m == 6.0 && fl > 0.5) {
        // 西式露明木骨架：开间两侧立柱、楼层与窗台窗楣的横梁，窗两侧的斜撑
        vec3 wood = vec3(0.13, 0.085, 0.055);
        float k = fadeP(0.5);
        float beam = min(abs(py), abs(py - storey));
        float t = edgeMask(abs(x - bi * bw), 0.09, aa);
        t = max(t, edgeMask(abs(x - (bi + 1.0) * bw), 0.09, aa));
        t = max(t, edgeMask(beam, 0.11, aa));
        t = max(t, edgeMask(abs(py - 0.85), 0.07, aa));
        t = max(t, edgeMask(abs(py - 2.32), 0.07, aa));
        // 斜撑：窗外侧的格里，自外下角斜到内上角（一半的开间有）
        float z0 = 0.62;
        float zw = bw * 0.5 - z0;
        if (zw > 0.25 && abs(px) > z0 && seedW > 0.35) {
          float u = (abs(px) - z0) / zw;
          float v = clamp(py / storey, 0.0, 1.0);
          t = max(t, edgeMask(abs((1.0 - u) - v) * min(zw, storey) * 0.7, 0.07, aa));
        }
        col = mix(mix(col, wood, 0.22), mix(col * (0.95 + 0.1 * n1), wood * (0.8 + 0.4 * n1), t), k);
        gBump += t * 0.03 * k;
      }
      if (m == 7.0) {
        // 和式真壁：柱（每开间）、贯（腰、楣）与白壁，底层下段是深色的腰板
        vec3 wood = vec3(0.16, 0.11, 0.075);
        float k = fadeP(0.5);
        float t = max(edgeMask(abs(x - bi * bw), 0.08, aa), edgeMask(abs(x - (bi + 1.0) * bw), 0.08, aa));
        t = max(t, edgeMask(abs(py - 0.9), 0.06, aa));
        t = max(t, edgeMask(abs(py - (storey - 0.35)), 0.07, aa));
        float koshi = fl < 0.5 ? 1.0 - smoothstep(0.88, 0.9, py) : 0.0;
        float boards = edgeMask(gridD(x, 0.18), 0.01, aa) * koshi * fadeP(0.18);
        col = mix(mix(col, wood, 0.12 + 0.25 * koshi), mix(col, wood * (1.0 - 0.4 * boards), max(t, koshi)), k);
        gBump += t * 0.025 * k;
      }
      col *= grime * mix(1.0, 1.0 - 0.22 * rain, mid);

      // —— 洞口 ——
      float lit = 0.0;
      if (sty < 2.5 || sty == 11.0) {
        // 民居：按层、按开间排窗，开门的墙在底层居中的开间开门
        if ((win || door) && nb > 0.0 && coarse > 0.0) {
          bool ground = fl < 0.5;
          if (sty == 1.0) {
            // 山墙尖：居中一扇小窗（能不能放下由几何端判断）
            vec2 q = vec2(x - L * 0.5, vLocal.y - vUv.z - 0.55);
            vec2 qi;
            vec3 hh = hole(q, 0.3, 0.75, uCulture > 2.5 ? 1.0 : 0.0, 0.16, qi);
            float fr = hh.y * smoothstep(-0.05 - aa, -0.05 + aa, holeD(qi, 0.3, 0.75, 0.0));
            float bars = max(edgeMask(abs(qi.x), 0.02, aa), edgeMask(abs(qi.y - 0.4), 0.02, aa)) * fine;
            vec3 wc = mix(glassC(qi.y / 0.75, seedW), vec3(0.7, 0.68, 0.62), max(fr, bars));
            col = mix(col, mix(col * hh.z * 0.8, wc, hh.y), hh.x * coarse);
            gGlass = hh.y * (1.0 - max(fr, bars)) * coarse;
            gBump += (0.02 * fr) * mid;
            lit = gGlass * step(0.7, hash12(vec2(vSeed * 91.0, 3.0)));
          } else {
            bool hasDoor = door && ground && bi == floor(nb * 0.5);
            bool shop = sty == 2.0 && ground;
            vec2 hw;
            float cy;
            if (uCulture < 0.5) { hw = vec2(0.46, 0.7); cy = 1.55; }
            else if (uCulture < 1.5) { hw = vec2(0.62, 0.6); cy = 1.55; }
            else if (uCulture < 2.5) { hw = ground ? vec2(0.72, 0.6) : vec2(0.55, 0.32); cy = ground ? 1.5 : 1.7; }
            else { hw = vec2(0.36, 0.62); cy = 1.75; }
            // 窗要整扇放得下：窗顶（连窗楣）低于墙顶（坡地上墙比整层高，顶上那截不开半扇窗）
            float wallTop = H - fl * storey;
            // 伊斯兰民居底层不开窗（内向的院落住宅），只开门
            bool noGround = (uCulture > 2.5 || sty == 11.0) && ground;
            bool hasWin = win && !noGround && !hasDoor && !shop && bw > hw.x * 2.0 + 0.5 && cy + hw.y + 0.3 < wallTop && y > 0.0;
            vec2 q = vec2(px, py);
            if (hasDoor && !shop) {
              // 门：门洞内凹；双扇木门，每扇上下两块凹进的门板；西式门头上是带棂的气窗；门框
              vec2 dh = uCulture < 0.5 ? vec2(0.58, 1.18) : uCulture < 2.5 ? vec2(0.8, 1.12) : vec2(0.55, 1.2);
              vec2 qi;
              vec3 hh = hole(q, dh.x, dh.y * 2.0, uCulture > 2.5 ? 1.0 : 0.0, 0.22, qi);
              float frame = edgeMask(abs(holeD(q, dh.x, dh.y * 2.0, uCulture > 2.5 ? 1.0 : 0.0)), 0.07, aa);
              float hd = hash12(vec2(vSeed, 7.7));
              vec3 doorC = hd < 0.4 ? vec3(0.15, 0.085, 0.045) : hd < 0.6 ? vec3(0.07, 0.12, 0.075) : hd < 0.8 ? vec3(0.2, 0.055, 0.04) : vec3(0.09, 0.11, 0.14);
              float leafTop = uCulture < 0.5 ? dh.y * 2.0 - 0.42 : dh.y * 2.0;
              // 门板：每扇（以门缝为界）上下两块，四周一圈凹线
              float lx = abs(qi.x) - dh.x * 0.5;
              float pw2 = dh.x * 0.5 - 0.1;
              float pa = boxD(vec2(lx, qi.y), vec2(0.0, 0.62), vec2(pw2, 0.38));
              float pb = boxD(vec2(lx, qi.y), vec2(0.0, (1.12 + leafTop - 0.14) * 0.5), vec2(pw2, (leafTop - 0.14 - 1.12) * 0.5));
              float panel = 1.0 - smoothstep(-aa, aa, min(pa, pb));
              float groove = edgeMask(abs(min(pa, pb)), 0.012, aa) * fine;
              float seam = edgeMask(abs(qi.x), 0.008, aa) * fine;
              vec3 dcol = doorC * (0.85 + 0.3 * n1) * (1.0 - 0.12 * panel) * (1.0 - 0.5 * max(groove, seam));
              if (qi.y > leafTop) {
                // 气窗：玻璃加两道竖棂
                float tb = edgeMask(abs(abs(qi.x) - dh.x * 0.33), 0.02, aa) * fine;
                dcol = mix(vec3(0.05, 0.06, 0.08) + 0.12 * smoothstep(leafTop, dh.y * 2.0, qi.y), vec3(0.6, 0.58, 0.52), max(tb, edgeMask(abs(qi.y - leafTop), 0.03, aa)));
              }
              vec3 rev = (uCulture < 0.5 ? vec3(0.5, 0.46, 0.4) : col * 0.9) * hh.z;
              col = mix(col, mix(rev, dcol, hh.y), hh.x * coarse);
              col = mix(col, uCulture < 0.5 ? vec3(0.55, 0.5, 0.43) : vec3(0.12, 0.08, 0.05), frame * mid * (1.0 - hh.x));
              gBump += (0.03 * frame - 0.012 * panel * hh.y) * mid;
              // 门前的台阶
              float step0 = (1.0 - smoothstep(0.0, aa, py - 0.16)) * (1.0 - smoothstep(dh.x + 0.2 - aa, dh.x + 0.2, abs(px)));
              col = mix(col, vec3(0.45, 0.43, 0.4), step0 * mid);
              gBump += step0 * 0.04 * mid;
            } else if (shop && bw > 1.6 && wallTop > 2.9) {
              // 铺面：宽大的铺面口，上有木过梁，里面是暗的店堂；开门的开间落地，其余下段是柜台
              float sw = bw * 0.5 - 0.2;
              vec2 qi;
              vec3 hh = hole(q - vec2(0.0, 0.12), sw, 2.35, uCulture > 2.5 ? 1.0 : 0.0, 0.9, qi);
              float counter = hasDoor ? 0.0 : 1.0 - smoothstep(0.78 - aa, 0.78 + aa, q.y);
              vec3 inC = mix(vec3(0.05, 0.04, 0.035), vec3(0.2, 0.15, 0.1), smoothstep(1.2, 0.0, qi.y) * 0.5);
              vec3 woodC = uCulture > 0.5 && uCulture < 2.5 ? vec3(0.2, 0.13, 0.085) : vec3(0.24, 0.16, 0.1);
              float post = edgeMask(abs(abs(q.x) - sw), 0.07, aa);
              float lintel = edgeMask(abs(q.y - 2.56), 0.1, aa) * (1.0 - smoothstep(sw + 0.1, sw + 0.12, abs(q.x)));
              vec3 sc = mix(mix(col * 0.6 * hh.z, inC, hh.y), woodC * (0.8 + 0.4 * n1) * (1.0 - 0.3 * edgeMask(gridD(q.x, 0.2), 0.01, aa) * fine), counter);
              col = mix(col, sc, hh.x * coarse);
              col = mix(col, woodC, max(post, lintel) * mid);
              gBump += (max(post, lintel) * 0.03 + counter * hh.x * 0.02) * mid;
              lit = hh.y * (1.0 - counter) * 0.6 * step(0.5, hash12(vec2(bi, 5.0) + vSeed * 57.0)) * coarse;
            } else if (hasWin) {
              vec2 qw = q - vec2(0.0, cy - hw.y);
              vec2 qi;
              float arch = uCulture > 2.5 ? 1.0 : 0.0;
              float dep = m == 4.0 ? 0.17 : 0.1;
              vec3 hh = hole(qw, hw.x, hw.y * 2.0, arch, dep, qi);
              float ft = uCulture < 0.5 ? 0.065 : 0.075;
              float fr = hh.y * smoothstep(-ft - aa, -ft + aa, holeD(qi, hw.x, hw.y * 2.0, arch));
              // 窗棂：西式十字棂、东方方格、和式竖格（底层格子窗），伊斯兰细木格
              vec2 g = qi - vec2(0.0, hw.y);
              float bars = 0.0;
              if (uCulture < 0.5) bars = max(edgeMask(abs(g.x), 0.03, aa), edgeMask(abs(g.y - hw.y * 0.25), 0.03, aa));
              else if (uCulture < 1.5) bars = edgeMask(min(gridD(g.x, 0.2), gridD(g.y, 0.2)), 0.018, aa);
              else if (uCulture < 2.5) bars = edgeMask(gridD(g.x, ground ? 0.12 : 0.09), 0.02, aa);
              else bars = edgeMask(min(gridD(g.x + g.y, 0.16), gridD(g.x - g.y, 0.16)) * 0.7, 0.014, aa) * 0.85;
              bars *= fine;
              vec3 frameC = uCulture < 0.5 ? vec3(0.78, 0.76, 0.7) : uCulture < 1.5 ? vec3(0.33, 0.08, 0.05) : vec3(0.16, 0.11, 0.07);
              vec3 gc = glassC(qi.y / (hw.y * 2.0), seedW);
              // 内凹的窗洞上沿有一道阴影
              gc *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, 0.28, hw.y * 2.0 - qi.y));
              // 和式底层的格子窗、东方与伊斯兰的木格：格里透出的是暗的室内，不是玻璃
              if (uCulture > 0.5) gc = mix(gc, vec3(0.04, 0.035, 0.03), 0.6);
              // 东亚的窗糊纸：一部分窗是亮的纸面
              if (uCulture > 0.5 && uCulture < 2.5 && seedW > 0.45) gc = mix(gc, vec3(0.62, 0.58, 0.48), 0.75);
              vec3 wc = mix(gc, frameC, max(fr, bars));
              vec3 rev = col * hh.z;
              col = mix(col, mix(rev, wc, hh.y), hh.x * coarse);
              gGlass = hh.y * (1.0 - max(fr, bars)) * coarse * (uCulture < 0.5 ? 1.0 : 0.3);
              gBump += (0.02 * fr + 0.012 * bars * hh.y) * mid;
              // 窗台（西式、伊斯兰）与台下的阴影，窗楣
              if (uCulture < 0.5 || uCulture > 2.5) {
                float sillY = cy - hw.y;
                float sill = (1.0 - smoothstep(hw.x + 0.08 - aa, hw.x + 0.08, abs(px))) * (1.0 - smoothstep(0.0, aa, abs(py - sillY + 0.045) - 0.045));
                float under = (1.0 - smoothstep(hw.x + 0.08 - aa, hw.x + 0.08, abs(px))) * smoothstep(sillY - 0.32, sillY - 0.09, py) * (1.0 - step(sillY - 0.09, py));
                col = mix(col, vec3(0.62, 0.6, 0.55), sill * mid);
                col *= 1.0 - 0.3 * under * mid;
                gBump += sill * 0.05 * mid;
                if (uCulture < 0.5) {
                  float topY = cy + hw.y;
                  float lintel = (1.0 - smoothstep(hw.x + 0.1 - aa, hw.x + 0.1, abs(px))) * (1.0 - smoothstep(0.0, aa, abs(py - topY - 0.08) - 0.08));
                  // 木骨架墙的窗楣是梁，不另画石过梁
                  lintel *= m == 6.0 ? 0.0 : mid;
                  col = mix(col, vec3(0.6, 0.58, 0.52), lintel);
                  gBump += lintel * 0.02;
                }
              }
              // 百叶窗（西式民居一半的人家有，按户上色），窗两侧各一扇
              if (uCulture < 0.5 && hash12(vec2(vSeed, 2.3)) > 0.45 && m != 4.0) {
                float sx = abs(px) - hw.x - 0.02;
                float sh = step(0.0, sx) * (1.0 - step(hw.x, sx)) * (1.0 - smoothstep(hw.y - aa, hw.y, abs(py - cy)));
                float hs = hash12(vec2(vSeed, 5.1));
                vec3 shC = hs < 0.3 ? vec3(0.12, 0.22, 0.13) : hs < 0.55 ? vec3(0.12, 0.17, 0.26) : hs < 0.8 ? vec3(0.32, 0.08, 0.06) : vec3(0.26, 0.17, 0.1);
                float slat = edgeMask(abs(fract(py / 0.07) - 0.5) * 0.07, 0.008, aa) * fine;
                col = mix(col, shC * (1.0 - 0.35 * slat), sh * mid);
                gBump += sh * (0.025 - slat * 0.01) * mid;
              }
              // 夜里约四成的窗亮着灯
              lit = hh.y * (1.0 - max(fr, bars) * 0.6) * step(0.58, hash12(vec2(bi, fl) + vSeed * 57.0)) * coarse;
            }
            // 远景：整面墙按开窗率压暗一点，窗灯退成整面墙的微光
            if (hasWin) {
              col *= mix(0.88, 1.0, coarse);
              lit = mix(0.06, lit, coarse);
            }
          }
        } else if (win && nb > 0.0) {
          col *= 0.9;
          lit = 0.05;
        }
      } else if (sty == 3.0 || sty == 4.0) {
        // 教堂的尖拱长窗（每开间一扇）；高侧窗只占墙顶一段
        if (win && nb > 0.0 && H > 4.5) {
          float wh = sty == 4.0 ? clamp(H * 0.26, 2.2, 7.0) : clamp(H * 0.55, 2.4, 14.0);
          float y1 = H - max(0.9, H * 0.07);
          float hwv = min(bw * 0.24, 0.5 + wh * 0.11);
          vec2 q = vec2(px, y - (y1 - wh));
          vec2 qi;
          vec3 hh = hole(q, hwv, wh, 1.0, 0.3, qi);
          float dI = holeD(qi, hwv, wh, 1.0);
          float fr = hh.y * smoothstep(-0.07 - aa, -0.07 + aa, dI);
          // 花窗：中梃、横档与铅条分出的小格，各格的彩色玻璃
          float mull = max(edgeMask(abs(qi.x), 0.035, aa), edgeMask(gridD(qi.y, 1.1), 0.025, aa));
          vec2 cellI = floor(vec2(qi.x / 0.22 + 0.5, qi.y / 0.3));
          float lead = edgeMask(min(gridD(qi.x, 0.22), gridD(qi.y + 0.15, 0.3)), 0.008, aa) * fine;
          float hc = hash12(cellI + vSeed * 3.0);
          vec3 stain = hc < 0.3 ? vec3(0.05, 0.08, 0.22) : hc < 0.55 ? vec3(0.22, 0.04, 0.05) : hc < 0.75 ? vec3(0.2, 0.15, 0.04) : hc < 0.9 ? vec3(0.04, 0.14, 0.09) : vec3(0.25, 0.24, 0.22);
          vec3 gc = mix(glassC(qi.y / wh, seedW) * 0.7, stain * 0.55, 0.45 * fine + 0.2);
          gc *= 1.0 - 0.5 * lead;
          vec3 stoneC = col * 1.08;
          vec3 wc = mix(gc, stoneC, max(fr, mull * mid));
          col = mix(col, mix(col * 0.95 * hh.z, wc, hh.y), hh.x * coarse);
          // 窗套：洞口外一圈线脚，窗下的腰线
          float mould = edgeMask(abs(holeD(q, hwv, wh, 1.0) - 0.09), 0.05, aa) * (1.0 - hh.x);
          float course = edgeMask(abs(y - (y1 - wh - 0.4)), 0.08, aa);
          col *= 1.0 + 0.1 * (mould + course) * mid;
          gBump += (mould * 0.03 + course * 0.03) * mid;
          gGlass = hh.y * (1.0 - max(fr, mull)) * coarse * 0.7;
          lit = hh.y * (1.0 - max(fr, mull)) * 0.5 * coarse;
          col *= mix(0.93, 1.0, coarse);
        }
      } else if (sty == 5.0) {
        // 正立面：居中的大门洞（层层收进的尖拱门）与其上的玫瑰窗
        if (hasL && H > 4.0) {
          float cx = x - L * 0.5;
          float dw = min(L * 0.17, 2.4);
          float dhh = min(dw * 2.5, H * 0.5);
          vec2 q = vec2(cx, y - 0.2);
          vec2 qi;
          vec3 hh = hole(q, dw, dhh, 1.0, 0.8, qi);
          float dO = holeD(q, dw, dhh, 1.0);
          // 门洞外的几道拱券线脚
          float arch = (1.0 - hh.x) * (1.0 - smoothstep(0.75, 0.8, dO));
          float rings = edgeMask(gridD(dO, 0.26), 0.04, aa) * arch * mid;
          vec3 doorC = vec3(0.16, 0.09, 0.05) * (0.85 + 0.3 * n1);
          float planks = edgeMask(gridD(qi.x, 0.24), 0.01, aa) * fine;
          float hinge = edgeMask(gridD(qi.y - 0.5, 1.3), 0.03, aa) * step(abs(qi.x), dw * 0.8) * fine;
          vec3 dc = doorC * (1.0 - 0.35 * planks);
          dc = mix(dc, vec3(0.05, 0.05, 0.055), max(hinge, edgeMask(abs(qi.x), 0.012, aa) * fine));
          // 门楣以上是石雕的山花（浅色）
          dc = mix(dc, col * 1.12, smoothstep(dhh * 0.62 - aa, dhh * 0.62 + aa, qi.y));
          col = mix(col, mix(col * 0.7 * hh.z, dc, hh.y), hh.x * coarse);
          col *= 1.0 + (0.14 * rings - 0.12 * arch * (1.0 - rings)) * mid;
          gBump += rings * 0.04;
          // 玫瑰窗
          float rr = min(min(L * 0.21, H * 0.15), 4.2);
          float ry = max(dhh + 0.2 + rr + 1.0, H * 0.66);
          if (rr > 0.7 && ry + rr + 0.5 < H) {
            vec2 c = vec2(cx, y - ry);
            vec2 ci = c - clamp(gPar * 0.4, vec2(-rr * 0.5), vec2(rr * 0.5));
            float dR = length(c) - rr;
            float dRi = length(ci) - rr;
            float inR = 1.0 - smoothstep(-aa, aa, dR);
            float pane = inR * (1.0 - smoothstep(-aa, aa, dRi));
            float ang = atan(ci.y, ci.x);
            float rad = length(ci);
            float spokes = edgeMask(abs(fract(ang / 0.5236 + 0.5) - 0.5) * 0.5236 * rad, 0.03, aa) * step(rr * 0.22, rad);
            float hoops = max(edgeMask(abs(rad - rr * 0.22), 0.04, aa), max(edgeMask(abs(rad - rr * 0.62), 0.03, aa), smoothstep(-0.1 - aa, -0.1 + aa, dRi)));
            float hc = hash12(vec2(floor(ang / 0.5236), floor(rad / (rr * 0.4))) + vSeed * 3.0);
            vec3 stain = hc < 0.35 ? vec3(0.05, 0.08, 0.24) : hc < 0.65 ? vec3(0.24, 0.04, 0.05) : hc < 0.85 ? vec3(0.22, 0.16, 0.04) : vec3(0.05, 0.15, 0.1);
            vec3 wc = mix(stain * (0.7 + 0.5 * seedW), col * 1.1, max(spokes, hoops) * mix(0.6, 1.0, mid));
            col = mix(col, mix(col * 0.55, wc, pane), inR * coarse);
            float mould = edgeMask(abs(dR - 0.12), 0.07, aa) * (1.0 - inR);
            col *= 1.0 + 0.12 * mould * mid;
            gBump += mould * 0.03 * mid;
            gGlass = pane * (1.0 - max(spokes, hoops)) * 0.7 * coarse;
            lit = gGlass * 0.6;
          }
          lit = max(lit, 0.0);
        }
      } else if (sty == 6.0) {
        // 钟楼：顶层每面一对百叶钟窗，塔身隔层一扇窄窗
        if (hasL && H > 6.0) {
          float cx = x - L * 0.5;
          float bh = clamp(H * 0.2, 2.2, 5.5);
          float y0 = H - bh - max(0.9, H * 0.05);
          float hwv = min(L * 0.13, 0.75);
          vec2 q = vec2(abs(cx) - max(L * 0.2, hwv + 0.2), y - y0);
          vec2 qi;
          vec3 hh = hole(q, hwv, bh, 1.0, 0.5, qi);
          float louvre = edgeMask(gridD(qi.y, 0.34), 0.07, aa) * fadeP(0.34);
          vec3 lc = mix(vec3(0.035, 0.03, 0.03), vec3(0.17, 0.13, 0.1), louvre);
          col = mix(col, mix(col * 0.75 * hh.z, lc, hh.y), hh.x * coarse);
          float mould = edgeMask(abs(holeD(q, hwv, bh, 1.0) - 0.08), 0.05, aa) * (1.0 - hh.x);
          float course = max(edgeMask(abs(y - (y0 - 0.5)), 0.09, aa), edgeMask(abs(y - (H - 0.35)), 0.12, aa));
          col *= 1.0 + 0.1 * (mould + course) * mid;
          gBump += (mould + course) * 0.03 * mid;
          // 塔身的窄窗
          float fy = y / 5.5;
          vec2 qs = vec2(cx, fract(fy) * 5.5 - 2.6);
          if (y < y0 - 2.0 && floor(fy) >= 1.0) {
            vec2 qj;
            vec3 hs = hole(qs, 0.16, 1.2, 1.0, 0.35, qj);
            col = mix(col, mix(col * 0.75 * hs.z, vec3(0.03), hs.y), hs.x * coarse);
          }
        }
      } else if (sty == 7.0) {
        // 敞廊：每开间一个落地的拱洞，里面是暗的廊子
        if (hasL && H > 2.4) {
          float ah = min(H - 0.55, uCulture > 2.5 ? 4.2 : 3.4);
          float hwv = bw * 0.5 - (uCulture > 2.5 ? 0.3 : 0.26);
          float arch = uCulture > 2.5 ? (hash12(vec2(vSeed, 4.4)) > 0.5 ? 3.0 : 1.0) : uCulture < 0.5 ? 2.0 : 0.0;
          vec2 q = vec2(px, y - 0.12);
          vec2 qi;
          vec3 hh = hole(q, hwv, ah, arch, 2.2, qi);
          // 廊内：暗处，地面受光的一截，里墙
          vec3 inC = mix(vec3(0.05, 0.045, 0.04), col * 0.42, smoothstep(ah * 0.75, 0.0, qi.y) * 0.5);
          vec3 flr = col * 0.62;
          vec3 rev = hh.z > 0.9 ? flr : col * 0.72 * hh.z;
          col = mix(col, mix(rev, inC, hh.y), hh.x * coarse);
          float dO = holeD(q, hwv, ah, arch);
          float vous = edgeMask(abs(dO - 0.13), 0.09, aa) * (1.0 - hh.x) * step(ah * 0.45, q.y);
          col *= 1.0 + 0.09 * vous * mid;
          // 柱头：起拱处的一道线
          float capL = edgeMask(abs(q.y - (ah - hwv * (arch > 1.5 ? 1.0 : 0.9))), 0.06, aa) * (1.0 - hh.x) * step(hwv - 0.02, abs(px));
          col *= 1.0 + 0.1 * capL * mid;
          gBump += (vous * 0.02 + capL * 0.03) * mid;
          col *= mix(0.72, 1.0, coarse);
          lit = hh.y * 0.12 * coarse;
        }
      } else if (sty == 8.0) {
        // 殿堂：柱、额枋，开间里落地的槅扇（开窗的面）或素壁
        if (hasL) {
          bool east = uCulture < 1.5;
          vec3 colC = east ? vec3(0.36, 0.055, 0.035) : vec3(0.17, 0.11, 0.07);
          vec3 beamC = east ? vec3(0.07, 0.2, 0.2) : vec3(0.2, 0.13, 0.085);
          float kb = fadeP(1.2);
          float cw = east ? 0.2 : 0.14;
          float post = max(edgeMask(abs(x - bi * bw), cw, aa), edgeMask(abs(x - (bi + 1.0) * bw), cw, aa));
          float bmH = east ? 0.62 : 0.34;
          float beam = smoothstep(H - bmH - aa, H - bmH + aa, y);
          float sill = 1.0 - smoothstep(0.22 - aa, 0.22 + aa, y);
          vec3 infill = col;
          float leafLit = 0.0;
          float hDoor = H - bmH;
          if (win && hDoor > 1.6) {
            // 槅扇：每开间四扇，上段格心（糊纸，夜里透光）、下段裙板
            float lw = (bw - 2.0 * cw) / 4.0;
            float lx = x - bi * bw - cw;
            float li = floor(lx / lw);
            float lpx = lx - (li + 0.5) * lw;
            float skirt = east ? min(1.05, hDoor * 0.36) : min(0.7, hDoor * 0.25);
            float stile = max(edgeMask(abs(abs(lpx) - lw * 0.5), 0.05, aa), max(edgeMask(abs(y - skirt), 0.05, aa), edgeMask(abs(y - hDoor + 0.06), 0.07, aa)));
            float lat = east ? edgeMask(min(gridD(lpx + y, 0.2), gridD(lpx - y, 0.2)) * 0.7, 0.012, aa) : edgeMask(min(gridD(lpx, 0.16), gridD(y, 0.3)), 0.011, aa);
            lat *= fadeP(0.16);
            vec3 paper = east ? vec3(0.5, 0.42, 0.3) : vec3(0.78, 0.74, 0.64);
            vec3 woodC = east ? vec3(0.32, 0.06, 0.04) : vec3(0.2, 0.13, 0.085);
            vec3 heart = mix(paper * (0.75 + 0.3 * seedW), woodC * 0.8, max(lat, 0.3 * (1.0 - fadeP(0.16))));
            vec3 leaf = y > skirt ? heart : woodC * (0.9 + 0.2 * n1);
            leaf = mix(leaf, woodC * 0.7, stile * mid);
            infill = mix(mix(paper, woodC, 0.55), leaf, fadeP(0.5));
            gBump += (stile * 0.02 - (1.0 - stile) * 0.01 * step(skirt, y)) * mid;
            leafLit = step(skirt, y) * (1.0 - max(lat, stile)) * 0.5;
          } else if (!east) {
            infill = vec3(0.82, 0.79, 0.71) * (0.92 + 0.14 * n1);
          }
          vec3 bc = beamC;
          if (east) {
            // 额枋彩画：青绿地，箍头与枋心的金线
            float seg = gridD(x - bi * bw - bw * 0.5, bw);
            float gold = max(edgeMask(abs(seg - bw * 0.3), 0.03, aa), edgeMask(abs(y - (H - bmH * 0.5)), 0.02, aa) * step(seg, bw * 0.3));
            bc = mix(beamC * (0.8 + 0.5 * step(seg, bw * 0.3)), vec3(0.6, 0.45, 0.14), gold * fine);
            bc = mix(bc, vec3(0.1, 0.16, 0.34), step(bw * 0.3, seg) * 0.6);
          }
          vec3 hc = mix(infill, colC * (0.85 + 0.3 * n1), post * mix(0.35, 1.0, kb));
          hc = mix(hc, bc, beam);
          hc = mix(hc, east ? vec3(0.45, 0.44, 0.42) : colC, sill * (1.0 - post));
          col = hc * grime;
          gBump += (post * 0.05 + beam * 0.03) * kb;
          lit = leafLit * (1.0 - post) * (1.0 - beam) * coarse;
          gRough = 0.6;
        }
      } else if (sty == 9.0) {
        // 射孔与小窗：稀疏的窄窗；和式（天守、橹）是每开间一扇带竖格的小窗
        if (win && nb > 0.0 && coarse > 0.0) {
          bool wa = uCulture > 1.5 && uCulture < 2.5;
          float wallTop = H - fl * storey;
          vec2 hw = wa ? vec2(0.42, 0.3) : uCulture > 2.5 ? vec2(0.2, 0.45) : vec2(0.11, 0.55);
          float cy = wa ? min(1.7, wallTop - 0.75) : 1.2;
          bool has = (wa || seedW > 0.5) && cy + hw.y * 2.0 + 0.2 < wallTop && cy > 0.4 && bw > hw.x * 2.0 + 0.4;
          if (has) {
            vec2 q = vec2(px, py - cy);
            vec2 qi;
            vec3 hh = hole(q, hw.x, hw.y * 2.0, uCulture > 2.5 ? 1.0 : 0.0, wa ? 0.2 : 0.45, qi);
            float bars = wa ? edgeMask(gridD(qi.x, 0.14), 0.025, aa) * fine : 0.0;
            vec3 ic = mix(vec3(0.03, 0.028, 0.025), wa ? vec3(0.13, 0.1, 0.07) : vec3(0.1), bars);
            col = mix(col, mix(col * 0.72 * hh.z, ic, hh.y), hh.x * coarse);
            if (!wa && uCulture < 0.5) {
              float sp = edgeMask(abs(holeD(q, hw.x, hw.y * 2.0, 0.0) - 0.06), 0.05, aa) * (1.0 - hh.x);
              col *= 1.0 + 0.08 * sp * mid;
            }
            lit = hh.y * (1.0 - bars) * step(0.72, hash12(vec2(bi, fl) + vSeed * 57.0)) * coarse;
          }
        }
      } else if (sty == 10.0) {
        // 伊旺：整面墙一个尖拱大龛，龛口一圈釉面砖的边饰，龛里是暗处与后墙的门
        if (hasL && H > 3.0) {
          float cx = x - L * 0.5;
          float hwv = L * 0.33;
          float ah = min(H * 0.84, hwv * 3.2);
          vec2 q = vec2(cx, y - 0.1);
          vec2 qi;
          vec3 hh = hole(q, hwv, ah, 1.0, min(3.0, L * 0.28), qi);
          float dO = holeD(q, hwv, ah, 1.0);
          vec3 tileA = vec3(0.07, 0.25, 0.4);
          vec3 tileB = vec3(0.75, 0.68, 0.45);
          // 边饰：龛口外一圈蓝地的带，带里是连续的小纹
          float band = (1.0 - hh.x) * (1.0 - smoothstep(0.62, 0.66, dO)) * smoothstep(0.08, 0.12, dO);
          float motif = edgeMask(min(gridD(x + y, 0.3), gridD(x - y, 0.3)) * 0.7, 0.02, aa) * fadeP(0.3);
          col = mix(col, mix(tileA, tileB, motif * 0.8), band * mix(0.7, 1.0, mid));
          // 外框：顶上一道横带
          float top = smoothstep(H - 0.9, H - 0.86, y) * (1.0 - smoothstep(H - 0.24, H - 0.2, y));
          col = mix(col, mix(tileA * 1.2, tileB, edgeMask(gridD(x, 0.5), 0.1, aa) * fadeP(0.5)), top * 0.85);
          // 龛内：上部是钟乳拱的明暗，后墙正中一扇门
          vec3 inC = mix(col * 0.5, vec3(0.06, 0.055, 0.05), smoothstep(0.0, ah, qi.y));
          float mq = vnoise(vec2(qi.x * 3.0, qi.y * 3.0)) * step(ah * 0.55, qi.y);
          inC *= 1.0 + 0.5 * mq * mid;
          float dd = holeD(vec2(qi.x, qi.y), hwv * 0.32, ah * 0.42, 1.0);
          inC = mix(inC, vec3(0.05, 0.035, 0.025), 1.0 - smoothstep(-aa, aa, dd));
          vec3 rev = hh.z > 0.9 ? col * 0.8 : col * 0.6 * hh.z;
          col = mix(col, mix(rev, inC, hh.y), hh.x);
          gRough = mix(0.82, 0.4, band);
          lit = 0.0;
        }
      }
      gLit = lit;
      diffuseColor.rgb = col;
    } else {
      // 其余的面（棱柱的顶、台面、脊、塔刹）：轻微的斑驳
      diffuseColor.rgb = col * (0.93 + 0.12 * n1);
      if (m == 26.0) gRough = 0.6;
    }
  }
`

type Uniforms = Record<string, THREE.IUniform>

/** 建筑：成长升降（以地基为支点压缩高度）、sRGB 顶点色、墙面与屋面的纹理、窗与门、凹凸与夜里的窗灯 */
export function patchBuilding(mat: THREE.Material, u: Uniforms, depth: boolean) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u)
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${LIFE_GLSL}\nattribute vec3 aLife;\n${depth ? '' : 'attribute float aFace;\nattribute vec3 aUv;\nvarying vec3 vLocal;\nvarying vec3 vLocalN;\nvarying float vFace;\nvarying float vBase;\nvarying vec3 vUv;\nvarying float vSeed;\nvarying vec3 vCam;'}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float lk = lifeK(aLife.xy);
        ${depth ? '' : 'vLocal = transformed; vLocalN = normal; vFace = aFace; vBase = aLife.z; vUv = aUv; vSeed = fract(sin(aLife.z * 12.9898 + aLife.x * 0.0731) * 43758.5453);'}
        if (lk <= 0.0) transformed = vec3(0.0);
        else transformed.y = aLife.z + (transformed.y - aLife.z) * lk;`,
      )
    if (depth) return
    sh.vertexShader = sh.vertexShader
      .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = pow(vColor.rgb, vec3(2.2));')
      // 顶点指向镜头的方向（模型空间，只用方向）：洞口的视差按它算
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCam = -(transpose(mat3(modelViewMatrix)) * mvPosition.xyz);')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_BODY}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (gRough >= 0.0) roughnessFactor = gRough;\nroughnessFactor = mix(roughnessFactor, 0.18, gGlass);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = max(metalnessFactor, gMetal);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = bumpNormal(-vViewPosition, normal, gBump * uMeter);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.62, 0.28) * gLit * uNight * 2.4;')
  }
  mat.customProgramCacheKey = () => (depth ? 'town-bld-depth-3' : 'town-bld-3')
}
