import * as THREE from 'three'
import { NOISE_GLSL } from './aerial/glsl'
import { BAKED_GLSL } from './aerial/bake'

/**
 * 水体着色器（按光学吸收建模）：
 * - 光线穿过水层往返两次，按 Beer–Lambert 定律逐通道衰减（红光最先被吸收），
 *   于是浅滩白沙上是明亮的青绿、陆架是湖蓝、深海是藏青——不需要手调色带
 * - 海底颜色取自地表贴图，并在浅水里叠加珊瑚礁/海草暗斑
 * - 多层动态法线、菲涅尔天空反射、太阳高光带
 * - 碎浪：沿岸推进的白色浪线 + 礁缘碎浪 + 外海零星白浪
 * - 云影、空气透视（雾）、海冰
 * 海洋、湖泊与地图外延伸到地平线的外海共用这一材质。
 */
export function createWaterMaterial(
  heightTex: THREE.Texture,
  tempTex: THREE.Texture,
  colorTex: THREE.Texture,
  vScale: number,
  size: THREE.Vector2,
  hSize: THREE.Vector2,
) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    uniforms: {
      uHeight: { value: heightTex },
      uBaked: { value: null as THREE.Texture | null },
      uGSize: { value: new THREE.Vector2(hSize.x, hSize.y) },
      uBMapSize: { value: size },
      uTemp: { value: tempTex },
      uColor: { value: colorTex },
      uVScale: { value: vScale },
      uSize: { value: size },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.6, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uSkyTop: { value: new THREE.Color('#3f6fa8') },
      uSkyHorizon: { value: new THREE.Color('#bcd3e6') },
      uDeep: { value: new THREE.Color('#0a3470') },
      uLake: { value: new THREE.Color('#1f5560') },
      uLight: { value: 1 },
      uFogColor: { value: new THREE.Color('#bcd3e6') },
      uFogDensity: { value: 0 },
      uCloud: { value: null as THREE.Texture | null },
      uCloudRect: { value: new THREE.Vector4(-100, -100, 200, 200) },
      uCloudY: { value: 3 },
      uCloudOn: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTemp;
      uniform sampler2D uColor;
      uniform float uVScale;
      uniform vec2 uSize;
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyTop;
      uniform vec3 uSkyHorizon;
      uniform vec3 uDeep;
      uniform vec3 uLake;
      uniform float uLight;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform sampler2D uCloud;
      uniform vec4 uCloudRect;
      uniform float uCloudY;
      uniform float uCloudOn;
      varying vec3 vWorld;
      ${NOISE_GLSL}
      ${BAKED_GLSL}

      float waves(vec2 p, float lod) {
        float t = uTime;
        float h = 0.0;
        h += vnoise(p * 1.3 + vec2(t * 0.12, t * 0.07)) * 0.5;
        h += vnoise(p * 3.1 - vec2(t * 0.2, -t * 0.13)) * 0.25;
        h += vnoise(p * 7.7 + vec2(-t * 0.33, t * 0.27)) * 0.14 * lod;
        h += vnoise(p * 17.0 + vec2(t * 0.5, t * 0.41)) * 0.07 * lod;
        return h;
      }

      void main() {
        vec2 uv = vec2(vWorld.x / uSize.x + 0.5, vWorld.z / uSize.y + 0.5);
        bool outside = uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
        float terrain = outside ? -4.5 : bakedAt(vWorld.xz).x;
        float level = vWorld.y / uVScale;
        float depth = level - terrain;
        if (depth < 0.0) discard;
        bool lake = level > 0.002;
        // 米；颜色用的视觉水深压缩了陆架，让环礁浅滩呈现青绿
        float dm = depth * 1000.0 * (lake ? 1.0 : 0.42);

        vec2 P = vWorld.xz;
        float fw = length(fwidth(P));
        float lod = 1.0 - smoothstep(0.01, 0.05, fw);

        // 涟漪法线
        vec2 p = P * 2.2;
        float e = 0.03;
        float h0 = waves(p, lod);
        float hx = waves(p + vec2(e, 0.0), lod);
        float hz = waves(p + vec2(0.0, e), lod);
        vec3 n = normalize(vec3(-(hx - h0) / e * 0.05, 1.0, -(hz - h0) / e * 0.05));

        vec3 V = normalize(cameraPosition - vWorld);
        vec3 L = normalize(uSunDir);
        float sunUp = smoothstep(-0.05, 0.25, L.y);

        // 云影
        float cs = 1.0;
        if (uCloudOn > 0.5) {
          vec2 cp = P + L.xz / max(L.y, 0.08) * (uCloudY - vWorld.y);
          cs = 1.0 - 0.6 * smoothstep(0.05, 0.6, texture2D(uCloud, (cp - uCloudRect.xy) / uCloudRect.zw).r);
        }

        // —— 水体：海底经吸收后的颜色 + 水的散射色 ——
        vec3 bed = outside ? vec3(0.0) : texture2D(uColor, uv).rgb;
        // 浅水里的礁盘与海草：大块暗斑，边缘破碎
        float reef = smoothstep(0.52, 0.62, fbm5(P * 2.4 + 3.0)) * (1.0 - smoothstep(4.0, 45.0, dm)) * smoothstep(1.5, 4.0, dm);
        bed = mix(bed, bed * vec3(0.35, 0.42, 0.36), reef * 0.85);
        float grass = smoothstep(0.55, 0.7, fbm3(P * 6.0 - 9.0)) * smoothstep(6.0, 15.0, dm) * (1.0 - smoothstep(25.0, 60.0, dm));
        bed = mix(bed, bed * vec3(0.45, 0.55, 0.42), grass * 0.5);
        // 极浅处是湿沙，偏暗；沙滩只在部分岸段出现
        bed *= mix(0.72, 1.0, smoothstep(0.0, 2.5, dm));
        float beachy = smoothstep(0.35, 0.6, fbm3(P * 1.7 + 11.0));
        bed = mix(bed * vec3(0.8, 0.85, 0.82), bed, beachy);
        // 光在水中往返的衰减（每米）
        vec3 absorb = lake ? vec3(0.16, 0.07, 0.06) : vec3(0.1, 0.03, 0.016);
        vec3 T = exp(-absorb * dm * 2.0);
        vec3 scatter = lake ? uLake : uDeep;
        float diff = (max(L.y, 0.0) * 0.8 + 0.2) * cs;
        vec3 body = bed * T * diff * 1.08 + scatter * (1.0 - T) * (0.6 + 0.4 * cs);
        // 浅水的阳光焦散
        float caust = pow(abs(sin(P.x * 38.0 + h0 * 9.0) * sin(P.y * 41.0 - hx * 9.0)), 6.0) * (1.0 - smoothstep(1.0, 8.0, dm)) * lod;
        body += vec3(0.9, 1.0, 0.95) * caust * 0.12 * cs;
        body *= uLight;

        // —— 反射 ——
        vec3 R = reflect(-V, n);
        vec3 sky = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.5, R.y));
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 col = mix(body, sky * uLight, fres * 0.85);
        vec3 Hh = normalize(L + V);
        float nh = max(dot(n, Hh), 0.0);
        float spec = pow(nh, 900.0) * 3.5 + pow(nh, 120.0) * 0.35 + pow(nh, 14.0) * 0.04;
        col += uSunColor * spec * sunUp * cs;

        // —— 碎浪 ——
        float shoreFoam = 0.0;
        if (!outside) {
          // 沿岸：一道道向岸推进的浪线
          float band = sin(dm * 1.4 - uTime * 1.3 + fbm3(P * 3.0) * 8.0);
          float breakZone = 1.0 - smoothstep(0.0, lake ? 0.8 : 2.2, dm);
          shoreFoam = breakZone * (smoothstep(0.6, 0.95, band) * 0.6 + (1.0 - smoothstep(0.0, 0.5, dm)) * 0.6);
          shoreFoam *= smoothstep(0.35, 0.65, fbm3(P * 7.0 + vec2(uTime * 0.08, 0.0)));
          // 迎浪岸段碎浪强、背风湾里几乎没有
          shoreFoam *= smoothstep(0.3, 0.7, fbm3(P * 0.9 - 5.0));
          // 礁缘碎浪
          shoreFoam += reef * smoothstep(0.7, 0.85, fbm3(P * 5.0 + uTime * 0.1)) * 0.2 * (1.0 - smoothstep(2.0, 8.0, dm));
          shoreFoam *= 0.55 + 0.45 * fbm3(P * 26.0 + vec2(uTime * 0.3, 0.0));
          if (lake) shoreFoam *= 0.25;
        }
        // 外海白浪
        float caps = 0.0;
        float foam = clamp(shoreFoam + caps, 0.0, 1.0);
        col = mix(col, vec3(0.95, 0.97, 0.98) * uLight * (0.6 + 0.4 * cs), foam * 0.9);

        // 海冰
        if (!outside) {
          float Tc = texture2D(uTemp, uv).r;
          float floe = vnoise(P * 3.0) * 0.6 + vnoise(P * 9.0) * 0.4;
          float ice = smoothstep(-6.5, -9.5, Tc + (floe - 0.5) * 5.0);
          vec3 iceCol = mix(vec3(0.78, 0.86, 0.9), vec3(0.95, 0.97, 0.98), floe) * (max(L.y, 0.0) * 0.6 + 0.45) * uLight;
          col = mix(col, iceCol, ice);
        }

        // 岸边与沙滩柔和衔接
        float alpha = smoothstep(0.0, 0.6, dm);
        alpha = max(alpha, foam);

        // 空气透视
        float dist = length(cameraPosition - vWorld);
        float fog = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
        col = mix(col, uFogColor, fog);

        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
}
