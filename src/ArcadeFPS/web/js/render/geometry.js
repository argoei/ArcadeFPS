// render/geometry.js —— 程序化几何。全部在运行时用代码生成，不依赖任何外部模型文件，
// 这样"可直接运行"才成立（没有资源丢失、没有路径问题、离线可用）。

import { makeRng, TAU } from '../core/math.js';

/** 网格累加器：按 pos3+nrm3+uv2 布局写入。 */
class MeshBuilder {
  constructor() { this.verts = []; this.indices = []; this.base = 0; }

  push(px, py, pz, nx, ny, nz, u, v) {
    this.verts.push(px, py, pz, nx, ny, nz, u, v);
  }

  tri(a, b, c) { this.indices.push(a, b, c); }

  /** 四边形（逆时针，法线朝外）。 */
  quad(p0, p1, p2, p3, n, uvScale = 1) {
    const base = this.base;
    const uv = [[0, 0], [uvScale, 0], [uvScale, uvScale], [0, uvScale]];
    const pts = [p0, p1, p2, p3];
    for (let i = 0; i < 4; i++) this.push(pts[i][0], pts[i][1], pts[i][2], n[0], n[1], n[2], uv[i][0], uv[i][1]);
    this.tri(base, base + 1, base + 2);
    this.tri(base, base + 2, base + 3);
    this.base += 4;
  }

  data() { return new Float32Array(this.verts); }
  idx() { return new Uint32Array(this.indices); }
}

/**
 * 立方体。size=[x,y,z]，中心在原点。
 * 这是场景里用量最大的几何（一半以上的 draw call 是它），UV 按面尺寸缩放，
 * 让不同大小的箱子贴图密度一致 —— 这是"写实"最省力也最有效的一招。
 */
export function box(sx = 1, sy = 1, sz = 1) {
  const b = new MeshBuilder();
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const uvS = Math.max(sx, sz);   // 让侧面与正面纹理密度接近
  // +X
  b.quad([hx,-hy, hz],[hx,-hy,-hz],[hx, hy,-hz],[hx, hy, hz],[1,0,0], uvS);
  // -X
  b.quad([-hx,-hy,-hz],[-hx,-hy, hz],[-hx, hy, hz],[-hx, hy,-hz],[-1,0,0], uvS);
  // +Y
  b.quad([-hx, hy, hz],[ hx, hy, hz],[ hx, hy,-hz],[-hx, hy,-hz],[0,1,0], uvS);
  // -Y
  b.quad([-hx,-hy,-hz],[ hx,-hy,-hz],[ hx,-hy, hz],[-hx,-hy, hz],[0,-1,0], uvS);
  // +Z
  b.quad([-hx,-hy, hz],[ hx,-hy, hz],[ hx, hy, hz],[-hx, hy, hz],[0,0,1], uvS);
  // -Z
  b.quad([ hx,-hy,-hz],[-hx,-hy,-hz],[-hx, hy,-hz],[ hx, hy,-hz],[0,0,-1], uvS);
  return { data: b.data(), indices: b.idx() };
}

/** 平面（地面/墙面），XZ 或 XY 朝向。 */
export function plane(w = 1, d = 1, uvScale = 1, axis = 'y', flip = false) {
  const b = new MeshBuilder();
  const hw = w / 2, hd = d / 2;
  const n = flip ? -1 : 1;
  if (axis === 'y') {
    const ny = flip ? -1 : 1;
    const p = flip
      ? [[-hw, 0, hd], [hw, 0, hd], [hw, 0, -hd], [-hw, 0, -hd]]
      : [[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd]];
    b.quad(p[0], p[1], p[2], p[3], [0, ny, 0], uvScale);
  } else {
    const nz = flip ? -1 : 1;
    const p = flip
      ? [[-hw, -hd, 0], [hw, -hd, 0], [hw, hd, 0], [-hw, hd, 0]]
      : [[-hw, hd, 0], [hw, hd, 0], [hw, -hd, 0], [-hw, -hd, 0]];
    b.quad(p[0], p[1], p[2], p[3], [0, 0, nz], uvScale);
  }
  return { data: b.data(), indices: b.idx() };
}

/** 圆柱（柱子/桶/枪管/树干）。 */
export function cylinder(rTop = 0.5, rBot = 0.5, h = 1, seg = 12, capped = true) {
  const b = new MeshBuilder();
  const hh = h / 2;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU;
    const a1 = ((i + 1) / seg) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const u0 = i / seg, u1 = (i + 1) / seg;
    const base = b.base;
    b.push(c0 * rBot, -hh, s0 * rBot, c0, 0, s0, u0, 0);
    b.push(c1 * rBot, -hh, s1 * rBot, c1, 0, s1, u1, 0);
    b.push(c1 * rTop, hh, s1 * rTop, c1, 0, s1, u1, 1);
    b.push(c0 * rTop, hh, s0 * rTop, c0, 0, s0, u0, 1);
    b.tri(base, base + 1, base + 2);
    b.tri(base, base + 2, base + 3);
    b.base += 4;

    if (capped) {
      if (rTop > 0) {
        const t = b.base;
        b.push(0, hh, 0, 0, 1, 0, 0.5, 0.5);
        b.push(c0 * rTop, hh, s0 * rTop, 0, 1, 0, 0, 0);
        b.push(c1 * rTop, hh, s1 * rTop, 0, 1, 0, 1, 0);
        b.tri(t, t + 1, t + 2); b.base += 3;
      }
      if (rBot > 0) {
        const t = b.base;
        b.push(0, -hh, 0, 0, -1, 0, 0.5, 0.5);
        b.push(c1 * rBot, -hh, s1 * rBot, 0, -1, 0, 1, 0);
        b.push(c0 * rBot, -hh, s0 * rBot, 0, -1, 0, 0, 0);
        b.tri(t, t + 1, t + 2); b.base += 3;
      }
    }
  }
  return { data: b.data(), indices: b.idx() };
}

/** UV 球。爆炸火球、敌人头部、灯泡都用它。 */
export function sphere(r = 0.5, seg = 16, rings = 12) {
  const b = new MeshBuilder();
  for (let y = 0; y < rings; y++) {
    const t0 = (y / rings) * Math.PI;
    const t1 = ((y + 1) / rings) * Math.PI;
    for (let x = 0; x < seg; x++) {
      const p0 = (x / seg) * TAU;
      const p1 = ((x + 1) / seg) * TAU;
      const pt = (t, p) => {
        const st = Math.sin(t);
        return [st * Math.cos(p), Math.cos(t), st * Math.sin(p)];
      };
      const a = pt(t0, p0), bb = pt(t1, p0), c = pt(t1, p1), d = pt(t0, p1);
      const base = b.base;
      b.push(a[0]*r, a[1]*r, a[2]*r, a[0], a[1], a[2], x/seg, y/rings);
      b.push(bb[0]*r, bb[1]*r, bb[2]*r, bb[0], bb[1], bb[2], x/seg, (y+1)/rings);
      b.push(c[0]*r, c[1]*r, c[2]*r, c[0], c[1], c[2], (x+1)/seg, (y+1)/rings);
      b.push(d[0]*r, d[1]*r, d[2]*r, d[0], d[1], d[2], (x+1)/seg, y/rings);
      b.tri(base, base+1, base+2);
      b.tri(base, base+2, base+3);
      b.base += 4;
    }
  }
  return { data: b.data(), indices: b.idx() };
}

/** 圆锥（树冠/屋顶/路障）。 */
export function cone(r = 0.5, h = 1, seg = 12) {
  return cylinder(0.001, r, h, seg, true);
}

/** 环（爆炸冲击波、血迹光环）。平面朝上。 */
export function ring(rInner = 0.8, rOuter = 1, seg = 24) {
  const b = new MeshBuilder();
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const base = b.base;
    b.push(c0*rInner, 0, s0*rInner, 0,1,0, i/seg, 0);
    b.push(c0*rOuter, 0, s0*rOuter, 0,1,0, i/seg, 1);
    b.push(c1*rOuter, 0, s1*rOuter, 0,1,0, (i+1)/seg, 1);
    b.push(c1*rInner, 0, s1*rInner, 0,1,0, (i+1)/seg, 0);
    b.tri(base, base+1, base+2);
    b.tri(base, base+2, base+3);
    b.base += 4;
  }
  return { data: b.data(), indices: b.idx() };
}

/**
 * 敌人骨架：Minecraft 方块人（Steve 比例）—— 大头 0.5 立方、身体扁平、
 * 方四肢 0.25 见方。总高约 1.8m，与玩家眼高一致，碰撞盒匹配。
 * 返回部件列表，每个部件自带局部变换，由 gameplay 层逐帧驱动。
 */
export function humanoidParts() {
  return [
    { name: 'head',  mesh: 'box', size: [0.50, 0.50, 0.50], offset: [0, 1.55, 0] },
    { name: 'face',  mesh: 'box', size: [0.30, 0.20, 0.04], offset: [0, 1.53, 0.26] },  // 眼睛/嘴深色区
    { name: 'torso', mesh: 'box', size: [0.50, 0.75, 0.26], offset: [0, 0.925, 0] },
    { name: 'armL',  mesh: 'box', size: [0.25, 0.75, 0.25], offset: [-0.375, 0.925, 0] },
    { name: 'armR',  mesh: 'box', size: [0.25, 0.75, 0.25], offset: [ 0.375, 0.925, 0] },
    { name: 'legL',  mesh: 'box', size: [0.25, 0.75, 0.25], offset: [-0.125, 0.375, 0] },
    { name: 'legR',  mesh: 'box', size: [0.25, 0.75, 0.25], offset: [ 0.125, 0.375, 0] },
  ];
}

/* 枪械视图模型的公共部件色板。面光照（顶1.0/侧0.6~0.8/底0.5）会把颜色压暗，
 * 所以这里整体调亮，保证武器在体素风下仍清晰可辨。 */
export const GUN_MATERIALS = {
  steel:  { c: [0.48, 0.50, 0.54], rough: 0.28 },   // 枪钢：亮灰
  dark:   { c: [0.26, 0.26, 0.29], rough: 0.72 },   // 聚合物：深灰
  grip:   { c: [0.38, 0.30, 0.20], rough: 0.86 },   // 握把：棕
  wood:   { c: [0.56, 0.38, 0.20], rough: 0.66 },   // 木质托：亮木色
  accent: { c: [0.88, 0.56, 0.16], rough: 0.55 },   // 点缀色：亮琥珀
  olive:  { c: [0.38, 0.44, 0.28], rough: 0.78 },   // 军绿
  glove:  { c: [0.52, 0.46, 0.34], rough: 0.88 },   // 战术手套
  sleeve: { c: [0.42, 0.44, 0.38], rough: 0.92 },   // 袖口
  glow:   { c: [1.0, 0.45, 0.15], rough: 0.4, em: 2.2 },   // 发光准星
  lens:   { c: [0.30, 0.62, 0.88], rough: 0.15, em: 0.9 }, // 瞄具镜片
};

/** 右手（握把侧）与左手（护木侧）。第一人称武器的存在感一半靠手。 */
function hands(rightGrip, leftGuard) {
  const parts = [];
  // 右手：腕 → 掌 → 指
  parts.push(
    { s: [0.10, 0.10, 0.20], o: [rightGrip[0] + 0.02, rightGrip[1] - 0.10, rightGrip[2] + 0.14], k: 'sleeve' },
    { s: [0.115, 0.14, 0.13], o: [rightGrip[0], rightGrip[1] + 0.01, rightGrip[2] + 0.02], k: 'glove' },
    { s: [0.105, 0.07, 0.11], o: [rightGrip[0] - 0.005, rightGrip[1] + 0.09, rightGrip[2] - 0.01], k: 'glove' },
  );
  if (leftGuard) {
    parts.push(
      { s: [0.10, 0.10, 0.18], o: [leftGuard[0] - 0.10, leftGuard[1] - 0.12, leftGuard[2] + 0.16], k: 'sleeve' },
      { s: [0.12, 0.13, 0.14], o: [leftGuard[0] - 0.005, leftGuard[1] - 0.10, leftGuard[2] + 0.02], k: 'glove' },
      { s: [0.11, 0.06, 0.13], o: [leftGuard[0], leftGuard[1] - 0.035, leftGuard[2] - 0.03], k: 'glove' },
    );
  }
  return parts;
}

/**
 * 枪械视图模型。返回部件列表：s=尺寸, o=偏移(枪身局部，-Z 指向枪口),
 * k=色板键。对比参考图：武器占画面下 1/3、分件清晰、有双手 ——
 * "每个部件 3~4 个灰盒子"是画不出这种东西的，所以这里每把 12~15 件。
 */
export function weaponModel(kind) {
  const K = (s, o, k) => ({ s, o, k });
  let M;

  switch (kind) {
    case 'pistol':
      M = [
        // 套筒（分两段：后段哑光、前段枪钢，模拟刻槽反光差）
        K([0.095, 0.115, 0.20], [0, 0.045, 0.06], 'dark'),
        K([0.095, 0.115, 0.26], [0, 0.045, -0.13], 'steel'),
        // 下机匣
        K([0.09, 0.09, 0.34], [0, -0.035, -0.02], 'dark'),
        // 枪口
        K([0.05, 0.05, 0.05], [0, 0.05, -0.28], 'steel'),
        // 握把（倾角用两段叠出）
        K([0.085, 0.16, 0.115], [0, -0.13, 0.115], 'grip'),
        K([0.085, 0.07, 0.10], [0, -0.215, 0.16], 'grip'),
        // 扳机护圈 + 弹匣底垫
        K([0.065, 0.026, 0.11], [0, -0.085, 0.03], 'dark'),
        K([0.075, 0.03, 0.10], [0, -0.165, 0.13], 'dark'),
        // 准星：前后照门 + 发光点
        K([0.018, 0.03, 0.02], [0, 0.115, -0.24], 'dark'),
        K([0.045, 0.026, 0.03], [0, 0.112, 0.15], 'dark'),
        K([0.016, 0.016, 0.012], [0, 0.118, -0.245], 'glow'),
      ];
      M.push(...hands([0.0, -0.14, 0.10], null));
      break;

    case 'rifle':
      M = [
        // 机匣
        K([0.095, 0.15, 0.36], [0, 0, 0], 'steel'),
        // 上导轨
        K([0.085, 0.025, 0.5], [0, 0.088, -0.08], 'dark'),
        // 护木（带侧槽）
        K([0.085, 0.09, 0.36], [0, 0.005, -0.36], 'dark'),
        K([0.092, 0.02, 0.30], [0, -0.04, -0.36], 'steel'),
        // 枪管 + 消焰器
        K([0.04, 0.04, 0.30], [0, 0.02, -0.62], 'steel'),
        K([0.065, 0.065, 0.10], [0, 0.02, -0.76], 'dark'),
        // 弹匣（两段叠出弧度）
        K([0.065, 0.16, 0.11], [0, -0.155, -0.06], 'dark'),
        K([0.06, 0.07, 0.10], [0, -0.265, -0.02], 'dark'),
        // 握把 + 扳机护圈
        K([0.065, 0.15, 0.095], [0, -0.13, 0.16], 'grip'),
        K([0.06, 0.024, 0.12], [0, -0.085, 0.08], 'dark'),
        // 枪托
        K([0.06, 0.11, 0.30], [0, -0.02, 0.34], 'dark'),
        K([0.065, 0.14, 0.05], [0, -0.045, 0.50], 'olive'),
        // 瞄具：镜筒 + 镜片 + 前准星
        K([0.05, 0.05, 0.17], [0, 0.135, -0.02], 'steel'),
        K([0.042, 0.042, 0.012], [0, 0.135, 0.068], 'lens'),
        K([0.016, 0.045, 0.016], [0, 0.105, -0.50], 'dark'),
        // 拉机柄
        K([0.035, 0.018, 0.07], [0.06, 0.045, 0.09], 'steel'),
        // 点缀条
        K([0.098, 0.028, 0.10], [0, 0.045, -0.20], 'accent'),
      ];
      M.push(...hands([0.0, -0.14, 0.155], [-0.01, -0.055, -0.30]));
      break;

    case 'shotgun':
      M = [
        // 机匣
        K([0.10, 0.14, 0.30], [0, 0, 0.02], 'steel'),
        // 枪管 + 下方弹管
        K([0.05, 0.05, 0.44], [0, 0.035, -0.44], 'steel'),
        K([0.042, 0.042, 0.40], [0, -0.045, -0.40], 'steel'),
        // 护木泵（木质，两段做抓槽）
        K([0.085, 0.085, 0.16], [0, -0.045, -0.40], 'wood'),
        K([0.09, 0.02, 0.10], [0, -0.045, -0.40], 'dark'),
        // 托腮板 + 木质枪托
        K([0.06, 0.10, 0.26], [0, -0.03, 0.28], 'wood'),
        K([0.07, 0.15, 0.05], [0, -0.055, 0.42], 'wood'),
        // 握把
        K([0.07, 0.13, 0.09], [0, -0.12, 0.14], 'wood'),
        // 珠状准星
        K([0.02, 0.02, 0.02], [0, 0.075, -0.65], 'glow'),
        // 点缀
        K([0.102, 0.026, 0.08], [0, 0.065, 0.05], 'accent'),
      ];
      M.push(...hands([0.0, -0.13, 0.13], [0.0, -0.09, -0.40]));
      break;

    case 'grenade':
      M = [
        // 弹体（分三层叠出弧度）
        K([0.115, 0.115, 0.115], [0, -0.02, 0], 'olive'),
        K([0.10, 0.06, 0.10], [0, 0.055, 0], 'olive'),
        K([0.085, 0.05, 0.085], [0, -0.095, 0], 'olive'),
        // 铸纹
        K([0.118, 0.02, 0.02], [0, -0.02, 0], 'dark'),
        K([0.02, 0.118, 0.02], [0, -0.02, 0], 'dark'),
        // 引信头 + 保险杆
        K([0.045, 0.05, 0.045], [0, 0.105, 0], 'steel'),
        K([0.015, 0.09, 0.05], [0.03, 0.07, 0.02], 'accent'),
        // 拉环
        K([0.05, 0.012, 0.012], [-0.05, 0.12, 0], 'steel'),
        K([0.012, 0.04, 0.012], [-0.07, 0.10, 0], 'steel'),
      ];
      M.push(...hands([0.0, -0.09, 0.06], null));
      break;

    case 'rocket':
      M = [
        // 发射筒（分段：中段哑光、两端枪钢）
        K([0.15, 0.15, 0.9], [0, 0.02, 0], 'dark'),
        K([0.155, 0.155, 0.22], [0, 0.02, -0.50], 'steel'),
        K([0.155, 0.155, 0.18], [0, 0.02, 0.42], 'steel'),
        // 前扩口 + 后喷口
        K([0.19, 0.19, 0.09], [0, 0.02, -0.62], 'steel'),
        K([0.11, 0.11, 0.10], [0, 0.02, 0.55], 'dark'),
        // 光学前握把 + 后握把
        K([0.05, 0.11, 0.05], [-0.02, -0.115, -0.34], 'grip'),
        K([0.05, 0.13, 0.05], [0.02, -0.125, 0.14], 'grip'),
        // 肩托
        K([0.05, 0.10, 0.16], [0, -0.03, 0.56], 'olive'),
        // 简易瞄具
        K([0.04, 0.07, 0.04], [0, 0.135, -0.18], 'dark'),
        K([0.016, 0.016, 0.012], [0, 0.15, -0.18], 'glow'),
        // 警示条
        K([0.152, 0.03, 0.07], [0, -0.055, -0.28], 'accent'),
      ];
      M.push(...hands([0.02, -0.12, 0.13], [-0.02, -0.11, -0.34]));
      break;

    default:
      M = weaponModel('pistol');
  }
  return M;
}

/** 建筑/道具的组合网格：把多个盒体烘进一个网格，
 *  用于"一个物件 = 一个实例"，比每个部件一个实例省 5~6 个 draw call。 */
export function mergedBoxes(list) {
  const parts = [];
  let vCount = 0;
  let iCount = 0;
  for (const item of list) {
    const g = box(item.s[0], item.s[1], item.s[2]);
    parts.push({ g, o: item.o || [0, 0, 0] });
    vCount += g.data.length;
    iCount += g.indices.length;
  }
  const out = new Float32Array(vCount);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0, base = 0;
  for (const { g, o } of parts) {
    for (let i = 0; i < g.data.length; i += 8) {
      out[vo + i]     = g.data[i]     + o[0];
      out[vo + i + 1] = g.data[i + 1] + o[1];
      out[vo + i + 2] = g.data[i + 2] + o[2];
      out[vo + i + 3] = g.data[i + 3];
      out[vo + i + 4] = g.data[i + 4];
      out[vo + i + 5] = g.data[i + 5];
      out[vo + i + 6] = g.data[i + 6];
      out[vo + i + 7] = g.data[i + 7];
    }
    for (let i = 0; i < g.indices.length; i++) idx[io + i] = g.indices[i] + base;
    vo += g.data.length;
    io += g.indices.length;
    base += g.data.length / 8;
  }
  return { data: out, indices: idx };
}
