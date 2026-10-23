// render/shaders.js —— 全部 GLSL。集中一处，便于对照 uniform 布局与实例属性布局。
//
// 实例属性布局（core/gl.js INSTANCE_FLOATS = 23）与此处的声明严格对应：
//   location 3..6  mat4 模型矩阵（分 4 个 vec4）
//   location 7     vec4 (rgb=albedo, a=roughness)

export const INSTANCE_ATTR = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec4 aM0;
layout(location = 4) in vec4 aM1;
layout(location = 5) in vec4 aM2;
layout(location = 6) in vec4 aM3;
layout(location = 7) in vec4 aColorRough;

mat4 instanceMatrix() {
  return mat4(aM0, aM1, aM2, aM3);
}
`;

/* ------------------------------------------------------------ 主几何 */

export const GEOM_VS = `#version 300 es
precision highp float;
${INSTANCE_ATTR}
uniform mat4 uViewProj;
uniform vec3 uCameraPos;

out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out vec3 vColor;
out float vEmissive;   // 复用 aColorRough.a（原 roughness），Minecraft 风格无高光，改成自发光强度

void main() {
  mat4 M = instanceMatrix();
  vec4 wp = M * vec4(aPos, 1.0);
  vWorld = wp.xyz;
  // 假设实例矩阵不含非等比缩放（本作所有实例都满足），法线直接乘左上 3x3 即可
  vNormal = normalize(mat3(M) * aNormal);
  vUV = aUV;
  vColor = aColorRough.rgb;
  vEmissive = aColorRough.a;
  gl_Position = uViewProj * wp;
}`;

export const GEOM_FS = `#version 300 es
precision highp float;

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
in vec3 vColor;
in float vEmissive;

uniform sampler2D uAlbedo;
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform float uFogFalloff;

out vec4 fragColor;

void main() {
  vec4 tex = texture(uAlbedo, vUV);
  vec3 albedo = vColor * tex.rgb;

  // Minecraft 面光照：面朝向决定亮度，这是体素风立体的灵魂。
  // 顶面最亮、底面最暗、±X / ±Z 侧面取不同值让侧面也有方向感。
  vec3 N = normalize(vNormal);
  float shade;
  if (N.y > 0.5)      shade = 1.0;   // 顶面
  else if (N.y < -0.5) shade = 0.5;  // 底面
  else if (abs(N.x) > 0.5) shade = 0.6;  // ±X 侧面
  else                 shade = 0.8;  // ±Z 侧面

  // 自发光：叠加到暗面也不熄灭（火把/岩浆/发光准星）。emissive 越大越亮。
  vec3 color = albedo * (shade + vEmissive);

  // 距离雾：Minecraft 的经典景深。发光方块不参与雾（远处火把依然可见）。
  float dist = length(uCameraPos - vWorld);
  float fogAmt = vEmissive > 0.01 ? 0.0 : (1.0 - exp(-dist * uFogFalloff));
  color = mix(color, uFogColor, clamp(fogAmt, 0.0, 1.0));

  fragColor = vec4(color, 1.0);
}`;

/* ------------------------------------------------------------ 阴影深度 */

export const SHADOW_VS = `#version 300 es
precision highp float;
${INSTANCE_ATTR}
uniform mat4 uLightViewProj;
void main() {
  gl_Position = uLightViewProj * (instanceMatrix() * vec4(aPos, 1.0));
}`;

export const SHADOW_FS = `#version 300 es
precision highp float;
void main() {}`;

/* ------------------------------------------------------------ 天空穹顶 */

export const SKY_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
out vec3 vDir;
void main() {
  vec4 near = uInvViewProj * vec4(aPos, -1.0, 1.0);
  vec4 far  = uInvViewProj * vec4(aPos,  1.0, 1.0);
  vDir = normalize(far.xyz / far.w - near.xyz / near.w);
  gl_Position = vec4(aPos, 1.0, 1.0);   // 永远在最远平面
}`;

export const SKY_FS = `#version 300 es
precision highp float;
in vec3 vDir;
uniform sampler2D uSky;
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform float uTime;
out vec4 fragColor;
void main() {
  vec3 d = normalize(vDir);
  // 方位角映射到 u，俯仰映射到 v（半球）
  float u = atan(d.z, d.x) / 6.2831853 + 0.5;
  float v = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = texture(uSky, vec2(u, v)).rgb;
  // 地平线附近并入雾色，避免天地接缝出现硬边
  float horizon = 1.0 - smoothstep(0.0, 0.14, abs(d.y));
  c = mix(c, uFogColor, horizon * 0.75);
  // 不在这里做色调映射：整帧（含天空）统一在 POST_FS 里过一次 ACES，
  // 天空若自己先映射一遍就会被二次映射，反而更平。
  fragColor = vec4(c, 1.0);
}`;

/* ------------------------------------------------------------ 粒子（爆炸/烟/火/雨雪） */

export const PARTICLE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;     // 单位四边形 [-0.5,0.5]
layout(location = 1) in vec3 aPos;
layout(location = 2) in vec4 aColor;     // rgb + alpha
layout(location = 3) in vec3 aParams;    // size, rot, frame
uniform mat4 uViewProj;
uniform vec3 uRight;
uniform vec3 uUp;
out vec2 vUV;
out vec4 vColor;
void main() {
  float s = aParams.x;
  float c = cos(aParams.y), sn = sin(aParams.y);
  vec2 q = vec2(aCorner.x * c - aCorner.y * sn, aCorner.x * sn + aCorner.y * c) * s;
  vec3 world = aPos + uRight * q.x + uUp * q.y;
  vUV = aCorner + 0.5;
  vColor = aColor;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

export const PARTICLE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTex;
uniform float uAdditive;
out vec4 fragColor;
void main() {
  vec4 t = texture(uTex, vUV);
  vec3 c = t.rgb * vColor.rgb;
  float a = t.a * vColor.a;
  if (a < 0.01) discard;
  if (uAdditive > 0.5) {
    fragColor = vec4(c * a, a);          // 加法混合：c*a 而非 c*a*a，避免中心过曝两次
  } else {
    fragColor = vec4(c * a, a);
  }
}`;

/* ------------------------------------------------------------ 贴花（弹孔/血迹/地面污渍） */

export const DECAL_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec3 aWorld;
layout(location = 2) in vec3 aRight;
layout(location = 3) in vec3 aUp;
layout(location = 4) in vec4 aColor;
uniform mat4 uViewProj;
out vec2 vUV;
out vec4 vColor;
void main() {
  vec3 world = aWorld + aRight * aPos.x + aUp * aPos.y;
  vUV = aPos + 0.5;
  vColor = aColor;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

export const DECAL_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTex;
out vec4 fragColor;
void main() {
  vec4 t = texture(uTex, vUV);
  float a = t.a * vColor.a;
  if (a < 0.02) discard;
  fragColor = vec4(t.rgb * vColor.rgb, a);
}`;

/* ------------------------------------------------------------ 后处理 */

export const POST_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const POST_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform float uDamage;      // 受伤红闪
uniform float uFlash;       // 场景切换白闪
uniform float uSaturation;
out vec4 fragColor;

void main() {
  vec3 col = texture(uScene, vUV).rgb;
  col = mix(col, vec3(1.0), uFlash);

  // 饱和度（像素风的鲜艳感靠这个拉满）
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uSaturation);

  // 受伤红闪只压暗 G/B，保留结构
  col = mix(col, vec3(col.r * 1.15, col.g * 0.35, col.b * 0.35), uDamage);

  fragColor = vec4(col, 1.0);
}`;

/** 亮部提取 + 分离高斯（两次单通道简化版，性能与观感折中）。 */
export const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform float uThreshold;
out vec4 fragColor;
void main() {
  vec3 c = texture(uScene, vUV).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(0.0, lum - uThreshold) / max(lum, 0.0001);
  fragColor = vec4(c * k, 1.0);
}`;

export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;      // (1/w, 0) 或 (0, 1/h)
out vec4 fragColor;
void main() {
  // 9 抽头高斯，权重来自预积分系数
  vec3 sum = texture(uTex, vUV).rgb * 0.2270270270;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  sum += (texture(uTex, vUV + o1).rgb + texture(uTex, vUV - o1).rgb) * 0.3162162162;
  sum += (texture(uTex, vUV + o2).rgb + texture(uTex, vUV - o2).rgb) * 0.0702702703;
  fragColor = vec4(sum, 1.0);
}`;
