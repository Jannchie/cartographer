import * as THREE from 'three'

/** 天空穹顶：地平线的乳白雾霭 → 天顶的蔚蓝，太阳方向有光晕 */
export function createSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color('#3f6fa8') },
      uHorizon: { value: new THREE.Color('#bcd3e6') },
      uSun: { value: new THREE.Vector3(0.5, 0.5, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
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
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 col = mix(uHorizon, uTop, pow(smoothstep(0.0, 0.6, h), 0.7));
        // 地平线以下：海天之间的雾
        col = mix(col, uHorizon * 0.92, smoothstep(0.0, -0.08, d.y));
        float s = max(dot(d, normalize(uSun)), 0.0);
        col += uSunColor * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.18 + pow(s, 3.0) * 0.06);
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
