/**
 * 地形高度函数（GLSL，顶点与片元共用）：
 * - 三次 B 样条插值高度图（9 次双线性采样）：比线性插值平滑，且权重全为正、不会过冲，
 *   海岸陡变处不会出现 Catmull-Rom 那样的凹凸"蛋格纹"
 * - 侵蚀噪声（Clay John 的 eroded terrain noise 思路）：沿大尺度坡向排布的条纹逐层叠加，
 *   形成顺坡而下的冲沟、刃脊与碎石坡；导数解析求得，直接用作法线
 * 依赖 NOISE_GLSL（hash12）。
 */
export const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeight;
uniform vec2 uHSize;   // 高度图尺寸 (W, H)
uniform vec2 uMapSize; // 地图世界尺寸 (SX, SZ)
uniform float uDetailKm;

vec2 hTexel(vec2 xz) {
  return (xz / uMapSize + 0.5) * (uHSize - 1.0) + 0.5;
}

float bicubicHeight(vec2 xz) {
  vec2 samplePos = hTexel(xz);
  vec2 tp1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - tp1;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  // 均匀三次 B 样条权重
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (tp1 - 1.0 + w1 / g0) / uHSize;
  vec2 h1 = (tp1 + 1.0 + w3 / g1) / uHSize;
  return (texture(uHeight, vec2(h0.x, h0.y)).r * g0.x + texture(uHeight, vec2(h1.x, h0.y)).r * g1.x) * g0.y
       + (texture(uHeight, vec2(h0.x, h1.y)).r * g0.x + texture(uHeight, vec2(h1.x, h1.y)).r * g1.x) * g1.y;
}

vec2 hash22(vec2 p) {
  return vec2(hash12(p), hash12(p + 17.31));
}

/** 单层侵蚀条纹：返回 (高度, d/dx, d/dy)，条纹沿 dir 方向变化 */
vec3 erosionOct(vec2 p, vec2 dir) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  const float F = 6.2831853;
  vec3 va = vec3(0.0);
  float wt = 0.0;
  for (int i = -2; i <= 1; i++) {
    for (int j = -2; j <= 1; j++) {
      vec2 o = vec2(float(i), float(j));
      vec2 h = hash22(ip - o) * 0.5;
      vec2 pp = fp + o - h;
      float d = dot(pp, pp);
      float w = exp(-d * 2.0);
      wt += w;
      float mag = dot(pp, dir);
      va += vec3(cos(mag * F), -sin(mag * F) * dir) * w;
    }
  }
  return va / wt;
}

/**
 * 多层侵蚀噪声。grad 为大尺度坡度（高度对世界坐标的导数，已乘垂直比例），
 * 每层把上一层的导数叠加进坡向，冲沟因此会分叉、汇合。返回 (h, dh/dx, dh/dz)。
 */
vec3 erosionNoise(vec2 p, vec2 grad, int octaves, float freq) {
  vec3 h = vec3(0.0);
  float a = 0.5;
  float f = freq;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    // 等高线方向（与坡向垂直），条纹沿它变化 → 条纹本身顺坡延伸
    vec2 dir = vec2(grad.y, -grad.x) + h.zy * vec2(1.0, -1.0) * 0.35;
    vec3 e = erosionOct(p * f, dir);
    h += vec3(e.x, e.yz * f) * a;
    a *= 0.45;
    f *= 2.1;
  }
  return h;
}

/** 细节幅度（km）：山地强、平原弱、海岸为零 */
float detailAmp(float h, float slope) {
  if (h <= 0.0) return 0.0;
  return smoothstep(0.02, 0.3, h) * (0.02 + 0.34 * smoothstep(0.25, 3.0, h)) * (0.08 + 0.92 * smoothstep(0.08, 0.6, slope)) * uDetailKm;
}

float terrainHeight(vec2 xz) {
  return bicubicHeight(xz);
}
`
