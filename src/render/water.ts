import * as THREE from 'three'

/**
 * 水面着色器：按真实水深（km，不受垂直夸张影响）混合浅滩青绿与深海蓝，
 * 动态法线的涟漪、菲涅尔天空反射、太阳高光、近岸浪花。
 * 海洋与湖泊共用一张网格，湖泊水面高于海平面。
 */
export function createWaterMaterial(heightTex: THREE.Texture, tempTex: THREE.Texture, vScale: number, size: THREE.Vector2) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    fog: false,
    uniforms: {
      uHeight: { value: heightTex },
      uTemp: { value: tempTex },
      uVScale: { value: vScale },
      uSize: { value: size },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.6, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uSkyTop: { value: new THREE.Color('#5d7fa3') },
      uSkyHorizon: { value: new THREE.Color('#c9d6df') },
      uShallow: { value: new THREE.Color('#2b8a92') },
      uMid: { value: new THREE.Color('#15526c') },
      uDeep: { value: new THREE.Color('#0a2440') },
      uLake: { value: new THREE.Color('#2c6f78') },
      uLight: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec2 vUv;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uHeight;
      uniform sampler2D uTemp;
      uniform float uVScale;
      uniform vec2 uSize;
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyTop;
      uniform vec3 uSkyHorizon;
      uniform vec3 uShallow;
      uniform vec3 uMid;
      uniform vec3 uDeep;
      uniform vec3 uLake;
      uniform float uLight;
      varying vec3 vWorld;
      varying vec2 vUv;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float waves(vec2 p) {
        float t = uTime;
        float h = 0.0;
        h += vnoise(p * 2.2 + vec2(t * 0.22, t * 0.13)) * 0.5;
        h += vnoise(p * 4.7 - vec2(t * 0.31, -t * 0.18)) * 0.25;
        h += vnoise(p * 9.3 + vec2(-t * 0.4, t * 0.35)) * 0.125;
        return h;
      }

      void main() {
        vec2 uv = vec2(vWorld.x / uSize.x + 0.5, vWorld.z / uSize.y + 0.5);
        float terrain = texture2D(uHeight, uv).r;
        float level = vWorld.y / uVScale;
        float depth = level - terrain;
        if (depth < 0.0) discard;
        bool lake = level > 0.002;

        // 涟漪法线
        vec2 p = vWorld.xz * 1.6;
        float e = 0.04;
        float h0 = waves(p);
        float hx = waves(p + vec2(e, 0.0));
        float hz = waves(p + vec2(0.0, e));
        vec3 n = normalize(vec3(-(hx - h0) / e * 0.045, 1.0, -(hz - h0) / e * 0.045));

        vec3 V = normalize(cameraPosition - vWorld);
        vec3 L = normalize(uSunDir);

        // 水体颜色：深度越大越暗越蓝
        float dk = depth;
        vec3 body = mix(uShallow, uMid, smoothstep(0.0, 0.1, dk));
        body = mix(body, uDeep, smoothstep(0.12, 2.5, dk));
        if (lake) body = mix(uLake * 1.1, uLake * 0.55, smoothstep(0.0, 0.25, dk));
        float diff = max(dot(vec3(0, 1, 0), L), 0.0) * 0.7 + 0.3;
        body *= diff * uLight;

        // 菲涅尔 + 天空反射
        vec3 R = reflect(-V, n);
        vec3 sky = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.6, R.y));
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 col = mix(body, sky * uLight, fres * 0.85);

        // 太阳高光
        vec3 Hh = normalize(L + V);
        float spec = pow(max(dot(n, Hh), 0.0), 600.0) * 1.6 + pow(max(dot(n, Hh), 0.0), 40.0) * 0.08;
        col += uSunColor * spec * smoothstep(-0.05, 0.2, L.y);

        // 近岸浪花：沿等深线推进的白色细带
        float shore = smoothstep(0.018, 0.0, dk);
        float band = smoothstep(0.55, 1.0, sin(dk * 900.0 - uTime * 1.6 + vnoise(p * 3.0) * 6.0) * 0.5 + 0.5);
        float foam = shore * (0.35 + 0.65 * band) * (0.6 + 0.4 * vnoise(p * 12.0 + uTime));
        if (lake) foam *= 0.12;
        col = mix(col, vec3(0.93, 0.96, 0.97) * uLight, clamp(foam, 0.0, 0.85));

        // 海冰 / 冰封湖面：年均温足够低的水面结冰，边缘破碎成浮冰
        float T = texture2D(uTemp, uv).r;
        float floe = vnoise(vWorld.xz * 3.0) * 0.6 + vnoise(vWorld.xz * 9.0) * 0.4;
        float ice = smoothstep(-6.5, -9.5, T + (floe - 0.5) * 5.0);
        vec3 iceCol = mix(vec3(0.78, 0.86, 0.9), vec3(0.95, 0.97, 0.98), floe) * (max(L.y, 0.0) * 0.6 + 0.45) * uLight;

        // 透明度：浅处透出海底
        float alpha = mix(0.5, 0.97, smoothstep(0.0, 0.06, dk));
        alpha = max(alpha, fres * 0.9);
        alpha = max(alpha, foam);
        col = mix(col, iceCol, ice);
        alpha = mix(alpha, 1.0, ice);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
}
