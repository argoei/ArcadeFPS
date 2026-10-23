// render/particles.js —— CPU 模拟的粒子池 + 天气系统。
//
// 为什么不上 GPU transform feedback / compute：本作粒子上限 3600、
// 每帧 CPU 更新成本约 0.3ms，够用；而 GPU 路径需要额外的 FBO 与同步点，
// 在 WebView2 这类嵌入宿主里调试成本高得多。这个取舍是明确的取舍，不是偷懒。

import { makeRng, clamp, lerp, TAU } from '../core/math.js';

const MAX = 3600;

export class ParticleSystem {
  constructor(seed = 1) {
    this.rng = makeRng(seed);
    // 结构化数组（SoA）而非对象数组：3600 个对象的 GC 压力在 60fps 下会
    // 造成可感知的周期性卡顿，而 SoA 完全没有这个问题。
    this.n = 0;
    this.px = new Float32Array(MAX); this.py = new Float32Array(MAX); this.pz = new Float32Array(MAX);
    this.vx = new Float32Array(MAX); this.vy = new Float32Array(MAX); this.vz = new Float32Array(MAX);
    this.life = new Float32Array(MAX); this.maxLife = new Float32Array(MAX);
    this.size = new Float32Array(MAX); this.size1 = new Float32Array(MAX);
    this.r = new Float32Array(MAX); this.g = new Float32Array(MAX); this.b = new Float32Array(MAX);
    this.a = new Float32Array(MAX);
    this.rot = new Float32Array(MAX); this.rotV = new Float32Array(MAX);
    this.drag = new Float32Array(MAX);
    this.grav = new Float32Array(MAX);
    this.kind = new Uint8Array(MAX);      // 0=smoke 1=fire 2=spark 3=debris 4=weather
    this.additive = new Uint8Array(MAX);
    this.alive = new Uint8Array(MAX);
    this.renderList = [];
  }

  clear() { this.alive.fill(0); this.n = 0; }

  _alloc() {
    // 优先复用已死的槽位；全满则覆盖最老的（环形近似）。
    if (this.n < MAX) return this.n++;
    let oldest = 0, best = Infinity;
    for (let i = 0; i < MAX; i += 7) {   // 抽样比较，避免 O(n) 扫描变成新瓶颈
      if (this.life[i] < best) { best = this.life[i]; oldest = i; }
    }
    return oldest;
  }

  spawn(opts) {
    const i = this._alloc();
    this.px[i] = opts.x; this.py[i] = opts.y; this.pz[i] = opts.z;
    this.vx[i] = opts.vx || 0; this.vy[i] = opts.vy || 0; this.vz[i] = opts.vz || 0;
    this.maxLife[i] = opts.life;
    this.life[i] = opts.life;
    this.size[i] = opts.size;
    this.size1[i] = opts.size1 ?? opts.size;
    this.r[i] = opts.color[0]; this.g[i] = opts.color[1]; this.b[i] = opts.color[2];
    this.a[i] = opts.alpha ?? 1;
    this.rot[i] = opts.rot ?? this.rng() * TAU;
    this.rotV[i] = opts.rotV ?? 0;
    this.drag[i] = opts.drag ?? 0.0;
    this.grav[i] = opts.grav ?? 0;
    this.kind[i] = opts.kind ?? 0;
    this.additive[i] = opts.additive ? 1 : 0;
    this.alive[i] = 1;
  }

  update(dt, wind) {
    const wx = wind ? wind[0] : 0, wz = wind ? wind[2] : 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alive[i] = 0; continue; }
      const k = this.kind[i];
      // 阻力：0.94^(dt*60) 形式是为了让"每秒衰减率"与帧率无关，
      // 直接写 v *= 0.94 会导致高帧率下粒子飞得更远（这是很常见的 bug）。
      const d = Math.pow(this.drag[i], dt * 60);
      this.vx[i] *= d; this.vy[i] *= d; this.vz[i] *= d;
      this.vy[i] -= this.grav[i] * dt;
      if (k === 4) { this.vx[i] += wx * dt; this.vz[i] += wz * dt; }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.rotV[i] * dt;
    }
  }

  /** 打包成渲染列表。alpha 曲线按类型区分：烟要"先涨后消"，火要"瞬亮后衰"。 */
  buildRenderList(out) {
    out.length = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const t = 1 - this.life[i] / this.maxLife[i];   // 0=刚生 1=将死
      const k = this.kind[i];
      let a = this.a[i], s = this.size[i];
      if (k === 0) {                    // 烟：淡入再淡出，尺寸持续变大
        a *= Math.sin(Math.min(t, 1) * Math.PI) * 0.9 + 0.1;
        s = lerp(this.size[i], this.size1[i], t);
      } else if (k === 1) {             // 火：瞬间最亮后快速衰减
        a *= (1 - t) * (1 - t);
        s = lerp(this.size[i], this.size1[i], t * 0.8);
      } else if (k === 2) {             // 火花：几乎线性衰减
        a *= (1 - t);
      } else if (k === 3) {             // 碎片：全程可见，末尾淡出
        a *= clamp((1 - t) * 3, 0, 1);
      } else if (k === 4) {             // 天气：两端淡入淡出，避免突现
        a *= Math.sin(Math.min(t, 1) * Math.PI);
      }
      if (a < 0.004) continue;
      out.push({
        pos: [this.px[i], this.py[i], this.pz[i]],
        color: [this.r[i], this.g[i], this.b[i]],
        alpha: a, size: s, rot: this.rot[i],
        additive: this.additive[i] === 1,
      });
    }
    return out;
  }

  /* -------------------------------------------------------- 预设效果 */

  /** 枪口火光：核心亮斑 + 星形碎片 + 一缕烟。 */
  muzzleFlash(x, y, z, dx, dy, dz, scale = 1) {
    const R = this.rng;
    this.spawn({
      x, y, z, vx: dx * 2, vy: dy * 2, vz: dz * 2,
      life: 0.055, size: 0.55 * scale, size1: 0.95 * scale,
      color: [1.0, 0.92, 0.62], alpha: 1, kind: 1, additive: true, drag: 0.5,
    });
    const flash = 4 + Math.floor(3 * scale);
    for (let i = 0; i < flash; i++) {
      const sp = (5 + R() * 11) * scale;
      this.spawn({
        x, y, z,
        vx: dx * sp + (R() - 0.5) * sp * 0.7,
        vy: dy * sp + (R() - 0.5) * sp * 0.7 + 1.2,
        vz: dz * sp + (R() - 0.5) * sp * 0.7,
        life: 0.06 + R() * 0.11,
        size: 0.09 * scale, size1: 0.02,
        color: [1, 0.78 + R() * 0.2, 0.34], alpha: 1,
        kind: 2, additive: true, drag: 0.86, grav: 5,
      });
    }
    for (let i = 0; i < 2; i++) {
      this.spawn({
        x: x + dx * 0.3, y: y + dy * 0.3, z: z + dz * 0.3,
        vx: dx * 2.6 + (R() - 0.5), vy: dy * 2.6 + 0.6 + R() * 0.5, vz: dz * 2.6 + (R() - 0.5),
        life: 0.45 + R() * 0.3,
        size: 0.2 * scale, size1: 0.85 * scale,
        color: [0.55, 0.52, 0.48], alpha: 0.34,
        kind: 0, additive: false, drag: 0.9, rotV: (R() - 0.5) * 2.4,
      });
    }
  }

  /** 弹着点：火花 + 碎屑 + 灰尘。dir 用于让火花朝弹道反方向飞。 */
  impact(x, y, z, nx, ny, nz, surface = 'concrete') {
    const R = this.rng;
    const tint = surface === 'metal' ? [1.0, 0.9, 0.7]
               : surface === 'wood'  ? [0.85, 0.6, 0.35]
               : [0.95, 0.85, 0.7];
    for (let i = 0; i < 9; i++) {
      const sp = 2.5 + R() * 6;
      this.spawn({
        x, y, z,
        vx: nx * sp + (R() - 0.5) * sp * 0.9,
        vy: ny * sp + R() * sp * 0.6 + 0.6,
        vz: nz * sp + (R() - 0.5) * sp * 0.9,
        life: 0.18 + R() * 0.26,
        size: 0.055 + R() * 0.04, size1: 0.01,
        color: tint, alpha: 1, kind: 2, additive: true, drag: 0.9, grav: 9,
      });
    }
    for (let i = 0; i < 5; i++) {
      this.spawn({
        x, y, z,
        vx: nx * 1.2 + (R() - 0.5) * 1.6,
        vy: ny * 1.2 + R() * 0.9,
        vz: nz * 1.2 + (R() - 0.5) * 1.6,
        life: 0.5 + R() * 0.4,
        size: 0.16 + R() * 0.12, size1: 0.7,
        color: [0.5, 0.48, 0.45], alpha: 0.4,
        kind: 0, additive: false, drag: 0.88, rotV: (R() - 0.5) * 3,
      });
    }
    // 碎屑（不发光，被光照亮）
    for (let i = 0; i < 4; i++) {
      this.spawn({
        x, y, z,
        vx: nx * 3 + (R() - 0.5) * 4,
        vy: ny * 3 + R() * 3.5,
        vz: nz * 3 + (R() - 0.5) * 4,
        life: 0.7 + R() * 0.5,
        size: 0.045, size1: 0.045,
        color: [0.32, 0.29, 0.26], alpha: 0.95,
        kind: 3, additive: false, drag: 0.96, grav: 12,
      });
    }
  }

  /** 血雾：暗红粒子 + 地面血迹贴花由调用方负责。 */
  blood(x, y, z, dx, dy, dz) {
    const R = this.rng;
    for (let i = 0; i < 14; i++) {
      const sp = 1.8 + R() * 4.5;
      this.spawn({
        x, y, z,
        vx: dx * sp + (R() - 0.5) * sp * 0.8,
        vy: dy * sp + R() * sp * 0.7,
        vz: dz * sp + (R() - 0.5) * sp * 0.8,
        life: 0.32 + R() * 0.4,
        size: 0.05 + R() * 0.07, size1: 0.02,
        color: [0.42, 0.04, 0.05], alpha: 0.95,
        kind: 3, additive: false, drag: 0.9, grav: 8,
      });
    }
    for (let i = 0; i < 3; i++) {
      this.spawn({
        x, y, z,
        vx: (R() - 0.5) * 0.8, vy: R() * 0.5, vz: (R() - 0.5) * 0.8,
        life: 0.55 + R() * 0.4,
        size: 0.2 + R() * 0.2, size1: 0.9,
        color: [0.3, 0.03, 0.03], alpha: 0.3,
        kind: 0, additive: false, drag: 0.9,
      });
    }
  }

  /** 爆炸：火球 + 冲击波尘环 + 火花 + 碎片。scale 区分手榴弹与火箭筒。 */
  explosion(x, y, z, scale = 1, groundY = null) {
    const R = this.rng;
    const S = scale;

    // 核心火球：4 层不同寿命，靠"亮度叠加"造出体积感
    const coreColors = [[1,0.98,0.86], [1,0.72,0.28], [0.9,0.32,0.08], [0.72,0.16,0.05]];
    for (let layer = 0; layer < 4; layer++) {
      const cnt = Math.floor((20 - layer * 4) * S);
      for (let i = 0; i < cnt; i++) {
        const sp = (2.5 + R() * 7) * S * (1 - layer * 0.22);
        const th = R() * TAU, ph = Math.acos(2 * R() - 1);
        this.spawn({
          x, y, z,
          vx: Math.sin(ph) * Math.cos(th) * sp,
          vy: Math.cos(ph) * sp + 1.4 * S,
          vz: Math.sin(ph) * Math.sin(th) * sp,
          life: (0.15 + layer * 0.09) * (0.7 + R() * 0.7) * S,
          size: (0.95 - layer * 0.18) * S, size1: (2.1 - layer * 0.4) * S,
          color: coreColors[layer], alpha: 1,
          kind: 1, additive: true, drag: 0.82,
        });
      }
    }

    // 冲击波环：一道快速向外扩散的亮白环，冲击波的核心视觉
    const ringN = Math.floor(16 * S);
    for (let i = 0; i < ringN; i++) {
      const a = (i / ringN) * TAU;
      this.spawn({
        x, y, z,
        vx: Math.cos(a) * 13 * S, vy: 0, vz: Math.sin(a) * 13 * S,
        life: 0.2 * S,
        size: 0.22 * S, size1: 0.22 * S,
        color: [1, 0.95, 0.82], alpha: 0.75,
        kind: 1, additive: true, drag: 0.9,
      });
    }

    // 火花
    for (let i = 0; i < Math.floor(42 * S); i++) {
      const sp = (7 + R() * 16) * S;
      const th = R() * TAU, ph = Math.acos(2 * R() - 1);
      this.spawn({
        x, y, z,
        vx: Math.sin(ph) * Math.cos(th) * sp,
        vy: Math.cos(ph) * sp + 2,
        vz: Math.sin(ph) * Math.sin(th) * sp,
        life: 0.35 + R() * 0.65,
        size: 0.09 * S, size1: 0.015,
        color: [1, 0.85 + R() * 0.15, 0.4], alpha: 1,
        kind: 2, additive: true, drag: 0.93, grav: 7,
      });
    }

    // 烟团：向上飘并膨胀，是爆炸"体积感"的主要来源
    for (let i = 0; i < Math.floor(30 * S); i++) {
      const sp = (1.2 + R() * 3.4) * S;
      const th = R() * TAU;
      this.spawn({
        x: x + Math.cos(th) * 0.3 * S, y: y + R() * 0.5 * S, z: z + Math.sin(th) * 0.3 * S,
        vx: Math.cos(th) * sp, vy: 1.2 + R() * 2.2, vz: Math.sin(th) * sp,
        life: 1.1 + R() * 1.5,
        size: (0.7 + R() * 0.6) * S, size1: (3.0 + R() * 2.4) * S,
        color: [0.24, 0.22, 0.21], alpha: 0.62,
        kind: 0, additive: false, drag: 0.94, rotV: (R() - 0.5) * 1.5,
      });
    }

    // 贴地冲击波尘环：只在地面附近生成，向外平铺
    if (groundY !== null) {
      const ringN = Math.floor(45 * S);
      for (let i = 0; i < ringN; i++) {
        const a = (i / ringN) * TAU + R() * 0.2;
        const sp = (5 + R() * 5) * S;
        this.spawn({
          x: x + Math.cos(a) * 0.4, y: groundY + 0.06 + R() * 0.2, z: z + Math.sin(a) * 0.4,
          vx: Math.cos(a) * sp, vy: 0.6 + R() * 1.2, vz: Math.sin(a) * sp,
          life: 0.7 + R() * 0.6,
          size: 0.5 * S, size1: 1.9 * S,
          color: [0.42, 0.38, 0.34], alpha: 0.5,
          kind: 0, additive: false, drag: 0.9, rotV: (R() - 0.5) * 2,
        });
      }
    }

    // 碎片（混凝土/砖块）
    for (let i = 0; i < Math.floor(22 * S); i++) {
      const sp = (5 + R() * 11) * S;
      const th = R() * TAU, ph = Math.acos(2 * R() - 1);
      this.spawn({
        x, y, z,
        vx: Math.sin(ph) * Math.cos(th) * sp,
        vy: Math.cos(ph) * sp + 3,
        vz: Math.sin(ph) * Math.sin(th) * sp,
        life: 1.0 + R() * 0.8,
        size: 0.07 * S, size1: 0.07 * S,
        color: [0.3, 0.28, 0.25], alpha: 1,
        kind: 3, additive: false, drag: 0.985, grav: 14,
      });
    }
  }

  /** 火箭尾焰：尾烟 + 多层亮火，拖出明显火舌。dx/dy/dz 会被归一化为方向（历史 bug：
   *  调用方曾传入速度值(模长34)，粒子速度被放大 34 倍 → 一帧飞出视野，尾焰"从未显示"。 */
  rocketTrail(x, y, z, dx, dy, dz) {
    const R = this.rng;
    const dl = Math.hypot(dx, dy, dz);
    if (dl > 1e-3) { dx /= dl; dy /= dl; dz /= dl; }
    // 尾烟：向后缓慢飘（火箭 34m/s 前飞，粒子近乎留在原地被甩在身后形成烟迹）
    for (let i = 0; i < 3; i++) {
      this.spawn({
        x, y, z,
        vx: -dx * (2 + R() * 3) + (R() - 0.5) * 1.2,
        vy: -dy * (2 + R() * 3) + (R() - 0.5) * 1.2 + 0.4,
        vz: -dz * (2 + R() * 3) + (R() - 0.5) * 1.2,
        life: 0.3 + R() * 0.35,
        size: 0.42, size1: 1.2,
        color: [0.55, 0.5, 0.46], alpha: 0.55,
        kind: 0, additive: false, drag: 0.92, rotV: (R() - 0.5) * 4,
      });
    }
    // 尾焰：白炽核心 + 橙红外焰，紧贴火箭尾部
    for (let i = 0; i < 8; i++) {
      const hot = i < 2;
      this.spawn({
        x, y, z,
        vx: -dx * (1 + R() * 2) + (R() - 0.5) * 1.0,
        vy: -dy * (1 + R() * 2) + (R() - 0.5) * 1.0,
        vz: -dz * (1 + R() * 2) + (R() - 0.5) * 1.0,
        life: hot ? 0.1 + R() * 0.07 : 0.16 + R() * 0.12,
        size: hot ? 0.55 : 0.4 + R() * 0.25, size1: hot ? 1.3 : 0.9,
        color: hot ? [1, 0.85, 0.42] : [1, 0.5, 0.14], alpha: 1,
        kind: 1, additive: true, drag: 0.82,
      });
    }
  }

  /** 弹壳落地（抛壳）。 */
  shell(x, y, z, dx, dy, dz) {
    const R = this.rng;
    this.spawn({
      x, y, z,
      vx: dx * (2 + R() * 2) + (R() - 0.5),
      vy: dy * (2 + R() * 2) + 2.4 + R(),
      vz: dz * (2 + R() * 2) + (R() - 0.5),
      life: 1.4, size: 0.035, size1: 0.035,
      color: [0.82, 0.66, 0.28], alpha: 1,
      kind: 3, additive: false, drag: 0.99, grav: 16,
      rotV: (R() - 0.5) * 26,
    });
  }
}

/* ------------------------------------------------------------ 天气 */

/** 天气定义。fogVisibility = 可视距离（米），进场景时随机搭配光照 + 天气。 */
export const WEATHERS = {
  clear: {
    key: 'clear', label: '晴', rain: 0, snow: 0, fogBoost: 0,
    // 参考图氛围：饱和的蓝天 + 暖阳。skyTop 提饱和、horizon 提亮做大气透视
    skyTop: [44, 104, 200], skyHorizon: [158, 196, 228], skyBottom: [206, 208, 200],
    cloudiness: 0.30, windStrength: 0.4,
    sunColor: [1.5, 1.30, 1.02], ambientSky: [0.34, 0.40, 0.50], ambientGround: [0.15, 0.13, 0.11],
    fogColor: [150, 168, 190], fogVisibility: 220, sunElev: 0.62, exposure: 1.05,
  },
  overcast: {
    key: 'overcast', label: '阴', rain: 0, snow: 0, fogBoost: 0.5,
    skyTop: [96, 104, 116], skyHorizon: [156, 158, 162], skyBottom: [140, 140, 138],
    cloudiness: 0.85, windStrength: 0.8,
    sunColor: [0.62, 0.63, 0.66], ambientSky: [0.34, 0.35, 0.38], ambientGround: [0.15, 0.15, 0.14],
    fogColor: [124, 128, 136], fogVisibility: 70, sunElev: 0.5, exposure: 1.0,
  },
  rain: {
    key: 'rain', label: '雨', rain: 1, snow: 0, fogBoost: 0.9,
    skyTop: [56, 60, 70], skyHorizon: [92, 96, 104], skyBottom: [78, 80, 84],
    cloudiness: 0.95, windStrength: 1.4,
    sunColor: [0.42, 0.44, 0.50], ambientSky: [0.24, 0.26, 0.30], ambientGround: [0.10, 0.10, 0.10],
    fogColor: [72, 78, 90], fogVisibility: 45, sunElev: 0.42, exposure: 0.95,
  },
  storm: {
    key: 'storm', label: '雷雨', rain: 1.8, snow: 0, fogBoost: 1.2,
    skyTop: [30, 32, 40], skyHorizon: [58, 60, 68], skyBottom: [44, 46, 50],
    cloudiness: 1.0, windStrength: 2.0,
    sunColor: [0.30, 0.32, 0.38], ambientSky: [0.18, 0.19, 0.24], ambientGround: [0.07, 0.07, 0.08],
    fogColor: [44, 48, 58], fogVisibility: 35, sunElev: 0.4, exposure: 0.88,
    lightning: true,
  },
  snow: {
    key: 'snow', label: '雪', rain: 0, snow: 1, fogBoost: 1.1,
    skyTop: [128, 140, 158], skyHorizon: [190, 196, 202], skyBottom: [214, 218, 220],
    cloudiness: 0.7, windStrength: 0.9,
    sunColor: [0.78, 0.82, 0.90], ambientSky: [0.42, 0.46, 0.52], ambientGround: [0.24, 0.24, 0.25],
    fogColor: [172, 180, 190], fogVisibility: 50, sunElev: 0.48, exposure: 1.0,
  },
  fog: {
    key: 'fog', label: '雾', rain: 0, snow: 0, fogBoost: 3.2,
    skyTop: [148, 152, 156], skyHorizon: [178, 180, 180], skyBottom: [166, 166, 164],
    cloudiness: 0.5, windStrength: 0.2,
    sunColor: [0.72, 0.74, 0.76], ambientSky: [0.40, 0.41, 0.42], ambientGround: [0.20, 0.20, 0.19],
    fogColor: [158, 162, 164], fogVisibility: 20, sunElev: 0.55, exposure: 1.0,
  },
  dusk: {
    key: 'dusk', label: '黄昏', rain: 0, snow: 0, fogBoost: 0.4,
    skyTop: [42, 46, 84], skyHorizon: [186, 108, 72], skyBottom: [92, 62, 52],
    cloudiness: 0.4, windStrength: 0.5,
    sunColor: [1.5, 0.82, 0.46], ambientSky: [0.26, 0.26, 0.36], ambientGround: [0.16, 0.11, 0.09],
    fogColor: [112, 82, 70], fogVisibility: 85, sunElev: 0.16, exposure: 1.1,
  },
  night: {
    key: 'night', label: '夜', rain: 0, snow: 0, fogBoost: 0.5,
    skyTop: [8, 10, 22], skyHorizon: [22, 26, 44], skyBottom: [16, 18, 26],
    cloudiness: 0.3, windStrength: 0.6,
    sunColor: [0.24, 0.28, 0.42], ambientSky: [0.10, 0.12, 0.20], ambientGround: [0.05, 0.05, 0.06],
    fogColor: [30, 36, 52], fogVisibility: 60, sunElev: 0.75, exposure: 1.35,
  },
};

export const WEATHER_KEYS = Object.keys(WEATHERS);

/**
 * 天气粒子发射器。雨雪都靠"在相机周围的一个盒子里循环生成 + 向下飘"，
 * 不需要无限地图：玩家走出盒子就重定位到盒子另一侧。
 */
export class WeatherEmitter {
  constructor(particles, seed = 5) {
    this.p = particles;
    this.rng = makeRng(seed);
    this.active = null;
    this.acc = 0;
    this.flash = 0;
    this.nextStrike = 0;
  }

  setWeather(w) { this.active = w; }

  /** 每帧调用。camPos 为相机位置，weather 为当前天气定义。 */
  update(dt, camPos, wind) {
    const w = this.active;
    if (!w) return;

    // 雷击：随机间隔，全屏短暂提亮
    if (w.lightning) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.flash = 1;
        this.nextStrike = 5 + this.rng() * 12;
      }
      this.flash = Math.max(0, this.flash - dt * 5.5);
    }

    const rate = (w.rain * 900 + w.snow * 260) * dt;
    this.acc += rate;
    const R = this.rng;
    const boxR = 26;
    while (this.acc >= 1) {
      this.acc -= 1;
      const isSnow = w.snow > 0 && (w.rain === 0 || R() < w.snow / (w.rain + w.snow));
      const x = camPos[0] + (R() - 0.5) * boxR * 2;
      const z = camPos[2] + (R() - 0.5) * boxR * 2;
      if (isSnow) {
        this.p.spawn({
          x, y: camPos[1] + 9 + R() * 6, z,
          vx: (R() - 0.5) * 0.5, vy: -0.55 - R() * 0.45, vz: (R() - 0.5) * 0.5,
          life: 16, size: 0.045 + R() * 0.055, size1: 0.045,
          color: [0.96, 0.97, 1.0], alpha: 0.75, kind: 4, additive: false,
          drag: 0.995,
        });
      } else {
        // 雨滴拉长：用速度方向暗示，比做真实拉伸便宜得多
        this.p.spawn({
          x, y: camPos[1] + 10 + R() * 8, z,
          vx: (R() - 0.5) * 0.8, vy: -16 - R() * 8, vz: (R() - 0.5) * 0.8,
          life: 1.3, size: 0.03 + R() * 0.02, size1: 0.02,
          color: [0.72, 0.78, 0.86], alpha: 0.42, kind: 4, additive: false,
          drag: 1.0,
        });
      }
    }
  }
}
