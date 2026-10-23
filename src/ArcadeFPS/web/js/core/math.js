// core/math.js —— 线性代数与工具函数。零依赖，供渲染与玩法各模块共用。
// 约定：矩阵为列主序 Float32Array(16)，与 WebGL uniformMatrix4fv(transpose=false) 一致。

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** 确定性随机（mulberry32）。场景与天气随机搭配必须可复现，
 *  否则"进同一个场景看到同一批敌人"这条体验无法调试。 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ vec3 */

export const v3 = {
  create: (x = 0, y = 0, z = 0) => new Float32Array([x, y, z]),
  set: (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
  sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
  addScaled: (o, a, b, s) => {
    o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o;
  },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  cross: (o, a, b) => {
    const x = a[1] * b[2] - a[2] * b[1];
    const y = a[2] * b[0] - a[0] * b[2];
    const z = a[0] * b[1] - a[1] * b[0];
    o[0] = x; o[1] = y; o[2] = z; return o;
  },
  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l < 1e-8) { o[0] = 0; o[1] = 0; o[2] = 0; return o; }
    o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; return o;
  },
  lerp: (o, a, b, t) => {
    o[0] = a[0] + (b[0] - a[0]) * t;
    o[1] = a[1] + (b[1] - a[1]) * t;
    o[2] = a[2] + (b[2] - a[2]) * t;
    return o;
  },
};

/* ------------------------------------------------------------------ mat4 */

export const m4 = {
  create: () => {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  identity: (o) => {
    o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o;
  },
  copy: (o, a) => { o.set(a); return o; },

  multiply: (o, a, b) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let i = 0; i < 4; i++) {
      const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
      o[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      o[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      o[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      o[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return o;
  },

  /** 透视投影。fovY 为垂直视场角（弧度），WebGL 深度范围是 [-1,1]。 */
  perspective: (o, fovY, aspect, near, far) => {
    const f = 1 / Math.tan(fovY / 2);
    o.fill(0);
    o[0] = f / aspect;
    o[5] = f;
    o[11] = -1;
    const nf = 1 / (near - far);
    o[10] = (far + near) * nf;
    o[14] = 2 * far * near * nf;
    return o;
  },

  lookAt: (o, eye, center, up) => {
    const zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let zl = Math.hypot(zx, zy, zz) || 1;
    const z0 = zx / zl, z1 = zy / zl, z2 = zz / zl;
    let x0 = up[1] * z2 - up[2] * z1;
    let x1 = up[2] * z0 - up[0] * z2;
    let x2 = up[0] * z1 - up[1] * z0;
    const xl = Math.hypot(x0, x1, x2) || 1;
    x0 /= xl; x1 /= xl; x2 /= xl;
    const y0 = z1 * x2 - z2 * x1;
    const y1 = z2 * x0 - z0 * x2;
    const y2 = z0 * x1 - z1 * x0;
    o[0] = x0; o[1] = y0; o[2] = z0; o[3] = 0;
    o[4] = x1; o[5] = y1; o[6] = z1; o[7] = 0;
    o[8] = x2; o[9] = y2; o[10] = z2; o[11] = 0;
    o[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    o[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    o[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    o[15] = 1;
    return o;
  },

  /** 由位置 / 欧拉角(yaw,pitch,roll) / 缩放合成。玩法层最常用的一条路径。 */
  compose: (o, px, py, pz, yaw, pitch, roll, sx, sy, sz) => {
    const cy = Math.cos(yaw), sy_ = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    // R = Ry * Rx * Rz
    const m00 = cy * cr + sy_ * sp * sr;
    const m01 = cp * sr;
    const m02 = -sy_ * cr + cy * sp * sr;
    const m10 = -cy * sr + sy_ * sp * cr;
    const m11 = cp * cr;
    const m12 = sy_ * sr + cy * sp * cr;
    const m20 = sy_ * cp;
    const m21 = -sp;
    const m22 = cy * cp;
    o[0] = m00 * sx; o[1] = m01 * sx; o[2] = m02 * sx; o[3] = 0;
    o[4] = m10 * sy; o[5] = m11 * sy; o[6] = m12 * sy; o[7] = 0;
    o[8] = m20 * sz; o[9] = m21 * sz; o[10] = m22 * sz; o[11] = 0;
    o[12] = px; o[13] = py; o[14] = pz; o[15] = 1;
    return o;
  },

  translation: (o, x, y, z) => {
    m4.identity(o); o[12] = x; o[13] = y; o[14] = z; return o;
  },
  scaling: (o, x, y, z) => {
    o.fill(0); o[0] = x; o[5] = y; o[10] = z; o[15] = 1; return o;
  },
  rotationY: (o, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    o.fill(0); o[0] = c; o[2] = -s; o[5] = 1; o[8] = s; o[10] = c; o[15] = 1; return o;
  },
  rotationX: (o, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    o.fill(0); o[0] = 1; o[5] = c; o[6] = s; o[9] = -s; o[10] = c; o[15] = 1; return o;
  },
  rotationZ: (o, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    o.fill(0); o[0] = c; o[1] = s; o[4] = -s; o[5] = c; o[10] = 1; o[15] = 1; return o;
  },

  invert: (o, a) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return m4.identity(o);
    det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  },
};

/** 法线矩阵 = 模型矩阵左上 3x3 的逆转置，写回 mat3（9 元素）。 */
export function normalMat3(o, m) {
  const inv = m4.invert(m4.create(), m);
  // 转置左上 3x3
  o[0] = inv[0]; o[1] = inv[4]; o[2] = inv[8];
  o[3] = inv[1]; o[4] = inv[5]; o[5] = inv[9];
  o[6] = inv[2]; o[7] = inv[6]; o[8] = inv[10];
  return o;
}

/* ------------------------------------------------------------------ 射线 */

/** 射线与轴对齐包围盒求交。命中返回 t（未命中返回 -1）。
 *  敌人命中判定与场景遮挡判定共用它，保证两条判据一致。 */
export function rayAabb(ro, rd, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const inv = 1 / (rd[i] || 1e-9);
    let t1 = (min[i] - ro[i]) * inv;
    let t2 = (max[i] - ro[i]) * inv;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmax < tmin) return -1;
  }
  return tmin >= 0 ? tmin : (tmax >= 0 ? 0 : -1);
}

/** 射线与球求交，返回最近的非负 t。爆炸范围判定用它。 */
export function raySphere(ro, rd, center, radius) {
  const ox = ro[0] - center[0], oy = ro[1] - center[1], oz = ro[2] - center[2];
  const b = ox * rd[0] + oy * rd[1] + oz * rd[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const h = b * b - c;
  if (h < 0) return -1;
  const s = Math.sqrt(h);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  const t1 = -b + s;
  return t1 >= 0 ? t1 : -1;
}
