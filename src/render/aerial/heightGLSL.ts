/**
 * 地形高度函数（GLSL，顶点与片元共用）：
 * - 双三次 Catmull-Rom 插值高度图（9 次双线性采样），比线性插值平滑，没有网格折痕
 * - 叠加脊状分形位移：比高度图更细的山脊与冲沟，山地强、平原弱、海岸处为零（不改岸线）
 * 依赖 NOISE_GLSL。
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
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 o12 = w2 / w12;
  vec2 tp0 = (tp1 - 1.0) / uHSize;
  vec2 tp3 = (tp1 + 2.0) / uHSize;
  vec2 tp12 = (tp1 + o12) / uHSize;
  float r = 0.0;
  r += texture(uHeight, vec2(tp0.x, tp0.y)).r * w0.x * w0.y;
  r += texture(uHeight, vec2(tp12.x, tp0.y)).r * w12.x * w0.y;
  r += texture(uHeight, vec2(tp3.x, tp0.y)).r * w3.x * w0.y;
  r += texture(uHeight, vec2(tp0.x, tp12.y)).r * w0.x * w12.y;
  r += texture(uHeight, vec2(tp12.x, tp12.y)).r * w12.x * w12.y;
  r += texture(uHeight, vec2(tp3.x, tp12.y)).r * w3.x * w12.y;
  r += texture(uHeight, vec2(tp0.x, tp3.y)).r * w0.x * w3.y;
  r += texture(uHeight, vec2(tp12.x, tp3.y)).r * w12.x * w3.y;
  r += texture(uHeight, vec2(tp3.x, tp3.y)).r * w3.x * w3.y;
  return r;
}

/** 亚网格细节：脊状分形，单位 km */
float detailKm(vec2 p, float h) {
  if (h <= 0.0) return 0.0;
  float amp = smoothstep(0.015, 0.3, h) * (0.03 + 0.16 * smoothstep(0.25, 3.0, h)) * uDetailKm;
  float s = 0.0, a = 0.5;
  vec2 q = p * 3.2;
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    float n = 1.0 - abs(vnoise(q) * 2.0 - 1.0);
    s += n * n * a;
    q = rot * q * 2.07 + 13.7;
    a *= 0.5;
  }
  return amp * (s - 0.4) * 1.7;
}

float terrainHeight(vec2 xz) {
  float h = bicubicHeight(xz);
  return h + detailKm(xz, h);
}
`
