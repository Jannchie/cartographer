import * as THREE from 'three'
import { NOISE_GLSL } from '../aerial/glsl'

/**
 * 建筑材质：在 MeshStandardMaterial 上补成长升降、墙面与屋面的纹理、窗与门，以及凹凸（扰动法线）。
 *
 * 顶点给出材质字节（mesh.ts 的 MAT，开窗的墙面加 WIN、开门的墙面加 DOOR）与立面坐标（沿墙米数、墙长、墙顶）：
 * - 墙面：抹灰、方石、砖、西式木构架、和式真壁、木板；窗按墙长均分开间、居中排布，层高 uStorey，
 *   开门的墙在底层居中的开间开门；窗与门的样式随文明（uCulture：0 西式、1 东方、2 和式、3 伊斯兰）
 * - 屋面：黏土瓦、石板瓦、东亚筒瓦；坐标取屋面自身的顺坡、横坡方向
 * - 凹凸：窗洞内凹、窗框与窗台外凸、砖石缝、瓦垄，按高度场的屏幕导数扰动法线；细节小于像素时淡出
 * 改 MAT 的编号要同步改 mesh.ts
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
  uniform float uNight;
  uniform float uStorey;
  uniform float uMeter;
  uniform float uCulture;
  ${NOISE_GLSL}

  /** 线宽 w 的抗锯齿边：d 为到边的距离（米），aa 为一个像素对应的米数 */
  float edgeMask(float d, float w, float aa) { return 1.0 - smoothstep(w - aa, w + aa, d); }
  /** 矩形内的有向距离（负值在内）：中心 c、半宽 h */
  float boxD(vec2 p, vec2 c, vec2 h) { vec2 q = abs(p - c) - h; return max(q.x, q.y); }
  /**
   * 尖拱洞口（伊斯兰）的有向距离：底边在 y0、拱顶在 y1、半宽 hw。
   * 起拱线以下是矩形；以上是两段圆弧的交（各自的圆心在起拱线上、偏向对侧，半径 1.3 倍半宽）
   */
  float archD(vec2 p, float hw, float y0, float y1) {
    float R = hw * 1.3;
    float rise = sqrt(R * R - (R - hw) * (R - hw));
    float spring = y1 - rise;
    float d = max(abs(p.x) - hw, y0 - p.y);
    if (p.y > spring) d = max(d, length(vec2(abs(p.x) + R - hw, p.y - spring)) - R);
    return d;
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
`

/** 片元：墙面、窗与门、屋面；写 bumpH（米）、glass（玻璃，压低粗糙度）与 winLit（夜里的窗灯） */
const FRAG_BODY = /* glsl */ `
  float bumpH = 0.0;
  float glass = 0.0;
  float winLit = 0.0;
  {
    float mf = floor(vFace * 255.0 + 0.5);
    bool win = mf >= 127.5;
    float m = win ? mf - 128.0 : mf;
    bool door = m >= 63.5;
    if (door) m -= 64.0;
    vec3 N = normalize(vLocalN);
    vec3 col = diffuseColor.rgb;
    // 一个像素对应的米数：细节按它淡出（远看不闪）
    float aa = max(length(fwidth(vLocal)) * 0.7, 1e-4);
    float fine = 1.0 - smoothstep(0.025, 0.07, aa);
    float mid = 1.0 - smoothstep(0.06, 0.2, aa);
    float coarse = 1.0 - smoothstep(0.18, 0.55, aa);
    float n1 = vnoise(vLocal.xz * 0.35 + vLocal.y * 0.2 + vSeed * 17.0);

    if (abs(N.y) < 0.35) {
      // —— 墙面：沿墙坐标 x（米）、离地高度 y ——
      vec2 tg = normalize(vec2(-N.z, N.x));
      float L = vUv.y;
      float x = L > 0.0 ? vUv.x : dot(vLocal.xz, tg);
      float y = vLocal.y - vBase - 0.6;
      vec2 p = vec2(x, y);
      float storey = uStorey;
      // 开间：按墙长均分（窗居中、两端留出墙垛）；没有墙长（山墙）时按 1.6 米
      float bay = uCulture < 0.5 ? 2.5 : uCulture < 1.5 ? 3.0 : uCulture < 2.5 ? 1.82 : 3.4;
      float nb = L > 0.0 ? max(1.0, floor(L / bay)) : 0.0;
      float bw = nb > 0.0 ? L / nb : 1.6;
      float bi = floor(x / bw);
      float px = x - (bi + 0.5) * bw;
      float fl = floor(y / storey);
      float py = y - fl * storey;
      float seedW = hash12(vec2(bi, fl) + vSeed * 31.7);

      // 墙面底色与纹理
      float grime = mix(0.78, 1.0, smoothstep(0.0, 1.8, y));
      if (m == 4.0 || (m == 6.0 && fl < 0.5)) {
        // 方整石：层高 0.42、块长 0.8
        vec3 ms = masonry(p, 0.42, 0.82, 0.035, aa);
        vec3 stoneC = m == 6.0 ? vec3(0.42, 0.39, 0.34) : col;
        col = mix(stoneC * mix(1.0, ms.x, mid), stoneC * 1.18, ms.y * mid);
        bumpH += ms.z * 0.006 * mid;
      } else if (m == 5.0) {
        // 砖：层高 0.11、块长 0.25
        vec3 ms = masonry(p, 0.11, 0.25, 0.014, aa);
        col = mix(col * mix(1.0, ms.x, fine), col * 1.25, ms.y * fine);
        bumpH += ms.z * 0.004 * fine;
      } else if (m == 10.0) {
        // 木板：竖向板缝，每块板明暗不一
        float pw = 0.22;
        float e = min(fract(x / pw), 1.0 - fract(x / pw)) * pw;
        float j = edgeMask(e, 0.012, aa) * mid;
        col *= (0.82 + 0.3 * hash12(vec2(floor(x / pw), vSeed * 13.0))) * (1.0 - 0.45 * j);
        bumpH -= j * 0.01;
      } else {
        // 抹灰、素墙的斑驳
        col *= 0.9 + 0.2 * (vnoise(p * 0.8 + vSeed * 9.0) * 0.65 + vnoise(p * 3.3) * 0.35);
      }
      if (m == 6.0 && fl > 0.5) {
        // 西式露明木骨架：开间两侧立柱、楼层与窗台窗楣的横梁，窗两侧的斜撑
        vec3 wood = vec3(0.13, 0.085, 0.055);
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
        t *= mid;
        col = mix(col * (0.95 + 0.1 * n1), wood * (0.8 + 0.4 * n1), t);
        bumpH += t * 0.03;
      }
      if (m == 7.0) {
        // 和式真壁：柱（每开间）、贯（腰、楣）与白壁，底层下段是深色的腰板
        vec3 wood = vec3(0.16, 0.11, 0.075);
        float t = max(edgeMask(abs(x - bi * bw), 0.08, aa), edgeMask(abs(x - (bi + 1.0) * bw), 0.08, aa));
        t = max(t, edgeMask(abs(py - 0.9), 0.06, aa));
        t = max(t, edgeMask(abs(py - (storey - 0.35)), 0.07, aa));
        float koshi = fl < 0.5 ? 1.0 - smoothstep(0.88, 0.9, py) : 0.0;
        float boards = edgeMask(min(fract(x / 0.18), 1.0 - fract(x / 0.18)) * 0.18, 0.01, aa) * koshi;
        col = mix(col, wood * (1.0 - 0.4 * boards), max(t, koshi) * mid);
        bumpH += t * 0.025 * mid;
      }
      col *= grime;

      // —— 窗与门 ——
      if ((win || door) && nb > 0.0) {
        bool hasDoor = door && fl < 0.5 && bi == floor(nb * 0.5);
        // 伊斯兰民居底层不开窗（内向的院落住宅），只开门
        bool ground = fl < 0.5;
        vec2 hw;
        float cy;
        if (uCulture < 0.5) { hw = vec2(0.46, 0.7); cy = 1.55; }
        else if (uCulture < 1.5) { hw = vec2(0.62, 0.6); cy = 1.55; }
        else if (uCulture < 2.5) { hw = ground ? vec2(0.72, 0.6) : vec2(0.55, 0.32); cy = ground ? 1.5 : 1.7; }
        else { hw = vec2(0.36, 0.62); cy = 1.75; }
        // 窗要整扇放得下：窗顶（连窗楣）低于墙顶（坡地上墙比整层高，顶上那截不开半扇窗）
        float wallTop = vUv.z - vBase - 0.6 - fl * storey;
        bool hasWin = win && !(uCulture > 2.5 && ground) && !hasDoor && bw > hw.x * 2.0 + 0.5 && cy + hw.y + 0.3 < wallTop;
        // 远看：整排窗的平均明暗
        float avg = hasWin ? 0.85 : 1.0;
        if (coarse > 0.0 && (hasWin || hasDoor)) {
          vec2 q = vec2(px, py);
          if (hasDoor) {
            // 门：门洞内凹；双扇木门，每扇上下两块凹进的门板；西式门头上是带棂的气窗；门框
            vec2 dh = uCulture < 0.5 ? vec2(0.58, 1.18) : uCulture < 2.5 ? vec2(0.8, 1.12) : vec2(0.55, 1.2);
            vec2 dc = vec2(0.0, dh.y);
            float d = boxD(q, dc, dh);
            // 伊斯兰的门顶是尖拱
            if (uCulture > 2.5) d = archD(q, dh.x, 0.0, dh.y * 2.0);
            float frame = edgeMask(abs(d), 0.07, aa);
            float inside = 1.0 - smoothstep(-aa, aa, d);
            float hd = hash12(vec2(vSeed, 7.7));
            vec3 doorC = hd < 0.4 ? vec3(0.15, 0.085, 0.045) : hd < 0.6 ? vec3(0.07, 0.12, 0.075) : hd < 0.8 ? vec3(0.2, 0.055, 0.04) : vec3(0.09, 0.11, 0.14);
            float leafTop = uCulture < 0.5 ? dh.y * 2.0 - 0.42 : dh.y * 2.0;
            // 门板：每扇（以门缝为界）上下两块，四周一圈凹线
            float lx = abs(px) - dh.x * 0.5;
            float pw2 = dh.x * 0.5 - 0.1;
            float pa = boxD(vec2(lx, py), vec2(0.0, 0.62), vec2(pw2, 0.38));
            float pb = boxD(vec2(lx, py), vec2(0.0, (1.12 + leafTop - 0.14) * 0.5), vec2(pw2, (leafTop - 0.14 - 1.12) * 0.5));
            float panel = 1.0 - smoothstep(-aa, aa, min(pa, pb));
            float groove = edgeMask(abs(min(pa, pb)), 0.012, aa) * fine;
            float seam = edgeMask(abs(px), 0.008, aa) * fine;
            vec3 dcol = doorC * (0.85 + 0.3 * n1) * (1.0 - 0.12 * panel) * (1.0 - 0.5 * max(groove, seam));
            if (py > leafTop) {
              // 气窗：玻璃加两道竖棂
              float tb = edgeMask(abs(abs(px) - dh.x * 0.33), 0.02, aa) * fine;
              dcol = mix(vec3(0.05, 0.06, 0.08) + 0.12 * smoothstep(leafTop, dh.y * 2.0, py), vec3(0.6, 0.58, 0.52), max(tb, edgeMask(abs(py - leafTop), 0.03, aa)));
            }
            col = mix(col, dcol, inside * coarse);
            col = mix(col, uCulture < 0.5 ? vec3(0.55, 0.5, 0.43) : vec3(0.12, 0.08, 0.05), frame * mid * (1.0 - inside * 0.5));
            bumpH += (-0.12 * inside + 0.03 * frame - 0.012 * panel * inside) * mid;
            // 门前的台阶
            float step0 = (1.0 - smoothstep(0.0, aa, py - 0.16)) * (1.0 - smoothstep(dh.x + 0.2 - aa, dh.x + 0.2, abs(px)));
            col = mix(col, vec3(0.45, 0.43, 0.4), step0 * mid);
            bumpH += step0 * 0.04 * mid;
          } else {
            vec2 c = vec2(0.0, cy);
            float d = boxD(q, c, hw);
            // 伊斯兰的窗顶是尖拱
            if (uCulture > 2.5) d = archD(q, hw.x, cy - hw.y, cy + hw.y);
            float ft = uCulture < 0.5 ? 0.065 : 0.075;
            float inside = 1.0 - smoothstep(-aa, aa, d);
            float glassIn = 1.0 - smoothstep(-aa, aa, d + ft);
            float frame = inside - glassIn;
            // 玻璃：映着天光（上亮下暗），每扇窗明暗不一；内凹的窗洞上沿有一道阴影
            float sky = smoothstep(cy - hw.y, cy + hw.y, py);
            vec3 gc = mix(vec3(0.035, 0.045, 0.06), vec3(0.32, 0.38, 0.46), (0.15 + 0.55 * sky) * (0.5 + 0.7 * seedW));
            gc *= 1.0 - 0.55 * (1.0 - smoothstep(0.0, 0.28, (cy + hw.y - ft) - py));
            // 窗棂：西式十字棂、东方方格、和式竖格（底层格子窗），伊斯兰细木格
            vec2 g = q - c;
            float bars = 0.0;
            if (uCulture < 0.5) bars = max(edgeMask(abs(g.x), 0.03, aa), edgeMask(abs(g.y - hw.y * 0.25), 0.03, aa));
            else if (uCulture < 1.5) { vec2 gg = abs(fract(g / 0.2) - 0.5) * 0.2; bars = edgeMask(min(gg.x, gg.y), 0.018, aa); }
            else if (uCulture < 2.5) bars = edgeMask(abs(fract(g.x / (ground ? 0.12 : 0.09)) - 0.5) * (ground ? 0.12 : 0.09), 0.02, aa);
            else { vec2 gg = abs(fract(g / 0.11 + vec2(0.0, floor(g.x / 0.11) * 0.5)) - 0.5) * 0.11; bars = edgeMask(min(gg.x, gg.y), 0.016, aa) * 0.85; }
            bars *= glassIn * fine;
            vec3 frameC = uCulture < 0.5 ? vec3(0.78, 0.76, 0.7) : uCulture < 1.5 ? vec3(0.33, 0.08, 0.05) : vec3(0.16, 0.11, 0.07);
            // 和式底层的格子窗、东方与伊斯兰的木格：格里透出的是暗的室内，不是玻璃
            if (uCulture > 0.5) gc = mix(gc, vec3(0.04, 0.035, 0.03), 0.6);
            vec3 wc = mix(gc, frameC, max(frame, bars));
            col = mix(col, wc, inside * coarse);
            glass = glassIn * (1.0 - bars) * coarse;
            bumpH += (-0.13 * glassIn + 0.02 * frame + 0.012 * bars) * mid;
            // 窗台（西式、伊斯兰）与台下的阴影，窗楣
            if (uCulture < 0.5 || uCulture > 2.5) {
              float sillY = cy - hw.y;
              float sill = (1.0 - smoothstep(hw.x + 0.08 - aa, hw.x + 0.08, abs(px))) * (1.0 - smoothstep(0.0, aa, abs(py - sillY + 0.045) - 0.045));
              float under = (1.0 - smoothstep(hw.x + 0.08 - aa, hw.x + 0.08, abs(px))) * smoothstep(sillY - 0.32, sillY - 0.09, py) * (1.0 - step(sillY - 0.09, py));
              col = mix(col, vec3(0.62, 0.6, 0.55), sill * mid);
              col *= 1.0 - 0.3 * under * mid;
              bumpH += sill * 0.05 * mid;
              if (uCulture < 0.5) {
                float topY = cy + hw.y;
                float lintel = (1.0 - smoothstep(hw.x + 0.1 - aa, hw.x + 0.1, abs(px))) * (1.0 - smoothstep(0.0, aa, abs(py - topY - 0.08) - 0.08));
                // 木骨架墙的窗楣是梁，不另画石过梁
                lintel *= m == 6.0 ? 0.0 : mid;
                col = mix(col, vec3(0.6, 0.58, 0.52), lintel);
                bumpH += lintel * 0.02;
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
              bumpH += sh * (0.025 - slat * 0.01) * mid;
            }
            // 夜里约四成的窗亮着灯
            winLit = glass * step(0.58, hash12(vec2(bi, fl) + vSeed * 57.0));
          }
        }
        // 远景：整面墙按开窗率压暗一点
        col *= mix(avg, 1.0, coarse);
        winLit = mix(hasWin ? 0.07 : 0.0, winLit, coarse);
      }
      diffuseColor.rgb = col;
    } else if (m == 1.0 || m == 2.0 || m == 9.0) {
      // —— 屋面：顺坡坐标（米，沿坡面量）与横坡坐标 ——
      vec2 dh = N.xz;
      float sl = length(dh);
      vec2 d = sl > 1e-3 ? dh / sl : vec2(0.0, 1.0);
      vec2 tr = vec2(-d.y, d.x);
      float along = dot(vLocal.xz, tr);
      float down = dot(vLocal.xz, d) / max(N.y, 0.3);
      float age = vnoise(vLocal.xz * 0.5 + vSeed * 5.0);
      if (m == 1.0) {
        // 黏土瓦：一垄一垄的弧形瓦，每排压住下一排，排缝下有阴影
        float rh = 0.34;
        float tw = 0.24;
        float fr = fract(down / rh);
        float row = floor(down / rh);
        float u = along / tw + hash12(vec2(row, 1.7)) * 0.15;
        float cfr = fract(u);
        float prof = sin(cfr * 3.14159);
        float sh = smoothstep(0.0, 0.16, fr);
        float tone = 0.8 + 0.34 * hash12(vec2(floor(u), row) + vSeed);
        col *= mix(1.0, tone * (0.72 + 0.28 * sh) * (0.86 + 0.18 * prof), mid);
        bumpH += (0.028 * prof * fine + 0.022 * fr) * mid;
      } else if (m == 9.0) {
        // 石板瓦：错缝的矩形薄片
        float rh = 0.2;
        float tw = 0.3;
        float row = floor(down / rh);
        float fr = fract(down / rh);
        float u = along / tw + row * 0.5;
        float e = min(fract(u), 1.0 - fract(u)) * tw;
        float j = edgeMask(e, 0.008, aa) * fine;
        float sh = smoothstep(0.0, 0.12, fr);
        float tone = 0.84 + 0.3 * hash12(vec2(floor(u), row) + vSeed);
        col *= mix(1.0, tone * (0.75 + 0.25 * sh) * (1.0 - 0.4 * j), mid);
        bumpH += 0.012 * fr * mid;
      } else {
        // 东亚筒瓦：板瓦沟与筒瓦垄顺坡而下，筒瓦每节有接缝
        float tw = 0.3;
        float c = fract(along / tw) - 0.5;
        float cover = 1.0 - smoothstep(0.17, 0.2, abs(c));
        float prof = cover > 0.0 ? cos(clamp(c / 0.2, -1.0, 1.0) * 1.5708) : -0.4 * cos(c * 3.14159);
        float joint = edgeMask(abs(fract(down / 0.36) - 0.5) * 0.36, 0.012, aa) * cover * fine;
        float gap = (1.0 - cover) * smoothstep(0.2, 0.3, abs(c));
        col *= mix(1.0, (cover > 0.0 ? 1.06 : 0.8) * (1.0 - 0.35 * joint) * (0.9 + 0.2 * hash12(vec2(floor(along / tw), floor(down / 0.36)) + vSeed)), mid);
        bumpH += (0.05 * prof - 0.01 * joint) * mid;
      }
      // 风化：零星的暗斑与青苔
      col *= mix(1.0, 0.82 + 0.25 * age, coarse);
      diffuseColor.rgb = col;
    } else if (m == 8.0) {
      // 平屋顶：灰泥面的斑驳
      diffuseColor.rgb = col * (0.88 + 0.22 * vnoise(vLocal.xz * 0.7 + vSeed * 3.0));
    } else {
      diffuseColor.rgb = col * (0.93 + 0.12 * n1);
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
        `#include <common>\n${LIFE_GLSL}\nattribute vec3 aLife;\n${depth ? '' : 'attribute float aFace;\nattribute vec3 aUv;\nvarying vec3 vLocal;\nvarying vec3 vLocalN;\nvarying float vFace;\nvarying float vBase;\nvarying vec3 vUv;\nvarying float vSeed;'}`,
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
    sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = pow(vColor.rgb, vec3(2.2));')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_BODY}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.18, glass);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = bumpNormal(-vViewPosition, normal, bumpH * uMeter);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.62, 0.28) * winLit * uNight * 2.4;')
  }
  mat.customProgramCacheKey = () => (depth ? 'town-bld-depth-2' : 'town-bld-2')
}
