import * as THREE from 'three'

/**
 * 天空穹顶：地平线的乳白雾霭 → 天顶的蔚蓝，太阳方向有光晕。
 * 夜里（uStars > 0）叠上程序化的星空（两层星点 + 一道淡淡的银河，微微闪烁），
 * uMoonK > 0 时在 uMoon 方向画出月轮与月晕。
 */
export function createSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color('#3f6fa8') },
      uHorizon: { value: new THREE.Color('#bcd3e6') },
      uSun: { value: new THREE.Vector3(0.5, 0.5, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uStars: { value: 0 },
      uMoon: { value: new THREE.Vector3(0, 1, 0) },
      uMoonK: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vDir = w.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * w;
        gl_Position.z = gl_Position.w; // 永远在最远处
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uSun;
      uniform vec3 uSunColor;
      uniform float uStars;
      uniform vec3 uMoon;
      uniform float uMoonK;
      uniform float uTime;
      varying vec3 vDir;
      float hash13(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
      }
      /** 一层星点：把方向放大到网格里，每格至多一颗星（位置、亮度、色温随机） */
      vec3 starLayer(vec3 d, float scale, float density) {
        vec3 p = d * scale;
        vec3 cell = floor(p);
        float h = hash13(cell);
        if (h > density) return vec3(0.0);
        vec3 c = cell + 0.2 + 0.6 * vec3(hash13(cell + 7.1), hash13(cell + 13.7), hash13(cell + 19.3));
        float r = length(p - c);
        // 星点约 1.5 像素宽，远近一致
        float w = max(length(fwidth(p)), 1e-4) * 0.9;
        float b = pow(hash13(cell + 3.3), 6.0) * 5.0 + 0.3;
        float tw = 0.75 + 0.25 * sin(uTime * (1.5 + 3.0 * hash13(cell + 5.5)) + h * 60.0);
        vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.88, 0.72), hash13(cell + 11.1));
        return tint * b * tw * exp(-r * r / (w * w));
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 col = mix(uHorizon, uTop, pow(smoothstep(0.0, 0.6, h), 0.7));
        // 地平线以下：海天之间的雾
        col = mix(col, uHorizon * 0.92, smoothstep(0.0, -0.08, d.y));
        float s = max(dot(d, normalize(uSun)), 0.0);
        col += uSunColor * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.18 + pow(s, 3.0) * 0.06);
        if (uStars > 0.0) {
          // 近地平线的星被大气吃掉
          float up = smoothstep(-0.02, 0.25, d.y);
          vec3 st = starLayer(d, 260.0, 0.22) * 0.2 + starLayer(d, 110.0, 0.12) * 0.45;
          // 银河：一条斜穿天空的大圆带，带里星更密、有一层淡淡的光
          float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.55, 0.76))) / 0.2, 2.0));
          st += starLayer(d, 420.0, 0.5) * 0.12 * band;
          st += vec3(0.004, 0.0045, 0.0065) * band * (0.6 + 0.4 * hash13(floor(d * 90.0)));
          // 月亮在天上时星光被冲淡
          col += st * uStars * up * (1.0 - 0.55 * uMoonK);
        }
        if (uMoonK > 0.0) {
          vec3 m = normalize(uMoon);
          float mu = dot(d, m);
          // 月轮（角半径约 1.2°）与月面的暗斑
          float disc = smoothstep(0.99975, 0.99979, mu);
          float mare = 0.82 + 0.18 * hash13(floor(d * 900.0));
          col += vec3(0.85, 0.9, 1.0) * disc * mare * 0.6 * uMoonK;
          col += vec3(0.25, 0.32, 0.5) * (pow(max(mu, 0.0), 600.0) * 0.08 + pow(max(mu, 0.0), 40.0) * 0.012) * uMoonK;
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), mat)
  mesh.frustumCulled = false
  mesh.renderOrder = -1
  return { mesh, mat }
}
