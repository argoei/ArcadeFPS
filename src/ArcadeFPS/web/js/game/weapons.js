// game/weapons.js —— 武器定义与开火逻辑。
//
// 设计原则：五种武器的差异必须能被玩家在**一秒内**感知，
// 因此差异放在四个可观测维度上，而不是藏在数值表里：
//   射速（节奏）、后坐力（镜头/散布）、毁伤（命中反馈）、弹道（视觉）。
//
// 单位约定：伤害为「血量点」，敌人血量 100（普通）/ 260（壮汉）。
// 射速用 RPM（每分钟发射数）而不是秒，因为街机射击的习惯单位是"发/秒"，
// 但配置文件用 RPM 更直观，换算只在 shoot() 里做一次。

import { weaponModel } from '../render/geometry.js';
import { clamp } from '../core/math.js';

export const WEAPONS = {
  pistol: {
    key: 'pistol',
    name: '手枪',
    en: 'PISTOL',
    auto: true,               // 按住持续开火
    rpm: 780,
    damage: 50,               // 两枪杀一个普通敌人（100 血）
    pellets: 1,
    spread: 0.007,            // 基础散布（弧度）
    spreadMove: 0.030,        // 移动时额外散布
    recoil: { pitch: 1.5, yaw: 0.5, kick: 0.9, recover: 7.0 },
    magazine: 12,
    reloadTime: 1.05,
    muzzleScale: 0.85,
    ammoType: 'bullet',
    sound: 'pistol',
    tracerEvery: 1,
    crosshairSpread: 0.4,
  },

  rifle: {
    key: 'rifle',
    name: '步枪',
    en: 'RIFLE',
    auto: true,               // 按住连发
    rpm: 780,
    damage: 100,              // 一枪杀一个普通敌人
    pellets: 1,
    spread: 0.012,
    spreadMove: 0.038,
    recoil: { pitch: 1.05, yaw: 0.62, kick: 0.75, recover: 9.0 },
    magazine: 30,
    reloadTime: 1.55,
    muzzleScale: 1.0,
    ammoType: 'bullet',
    sound: 'rifle',
    tracerEvery: 3,           // 每 3 发一条曳光弹：既是街机视觉语言，也降低了透明物体的填充开销
    crosshairSpread: 1.0,
  },

  shotgun: {
    key: 'shotgun',
    name: '喷火器',
    en: 'FLAMETHROWER',
    auto: true,
    rpm: 780,                 // 每秒 10 次 tick：按住约 6 秒喷完一箱燃料（共 ~300 体素火龙）
    damage: 4,                // 每 tick 灼烧伤害（锥形判定），近距离持续掉血
    pellets: 0,
    spread: 0.0,
    spreadMove: 0.0,
    recoil: { pitch: 0.5, yaw: 0.2, kick: 0.3, recover: 8.0 },
    magazine: 60,             // 燃料罐
    reloadTime: 2.1,
    muzzleScale: 1.5,
    ammoType: 'flame',
    sound: 'shotgun',
    tracerEvery: 0,
    crosshairSpread: 1.4,
  },

  grenade: {
    key: 'grenade',
    name: '手榴弹',
    en: 'GRENADE',
    auto: true,
    rpm: 780,
    throwSpeed: 17,
    fuse: 2.1,               // 引信秒数
    damage: 150,             // 爆心伤害
    radius: 7.5,             // 杀伤半径
    falloff: 0.55,           // 边缘伤害系数（线性衰减到这个值）
    explosionScale: 1.0,
    magazine: 5,
    reloadTime: 1.2,
    muzzleScale: 0,
    ammoType: 'grenade',
    sound: 'throw',
    bounce: 0.42,            // 弹跳系数
    friction: 0.72,
    crosshairSpread: 0.2,
    // 投掷物同样需要 recoil 与 spread 字段：
    // WeaponState.tick 每帧无条件读 w.recoil.recover，fire() 读 w.recoil.pitch，
    // 缺字段会让 recoilPitch 变 NaN 并永久污染视角。投掷的"后坐"表现为手臂前送。
    recoil: { pitch: 3.2, yaw: 0.9, kick: 1.8, recover: 6.0 },
    spread: 0.004,
    spreadMove: 0.006,
  },

  rocket: {
    key: 'rocket',
    name: '火箭筒',
    en: 'ROCKET',
    auto: true,
    rpm: 780,
    rocketSpeed: 34,
    damage: 260,             // 直接命中几乎必杀
    splashDamage: 180,
    radius: 10.5,
    falloff: 0.35,
    explosionScale: 1.85,
    magazine: 1,
    reloadTime: 1.3,   // 提速一倍（原 2.6s），装填更快
    muzzleScale: 2.0,
    ammoType: 'rocket',
    sound: 'rocket',
    crosshairSpread: 0.8,
    // 同上：火箭筒也必须有 recoil/spread，否则切枪后视角被 NaN 污染
    recoil: { pitch: 7.5, yaw: 1.6, kick: 4.2, recover: 4.2 },
    spread: 0.01,
    spreadMove: 0.012,
  },

  builder: {
    key: 'builder',
    name: '建造枪',
    en: 'BUILDER',
    auto: true,
    rpm: 780,
    throwSpeed: 12,          // 平抛初速：眼高落到地面约 4.5 格（枪口前 4~5 格）
    damage: 0,
    pellets: 0,
    spread: 0,
    spreadMove: 0,
    recoil: { pitch: 0.8, yaw: 0.3, kick: 0.5, recover: 7.0 },
    magazine: 24,
    reloadTime: 1.8,
    muzzleScale: 0.8,
    ammoType: 'block',
    sound: 'shotgun',
    tracerEvery: 0,
    crosshairSpread: 0.8,
  },
};

export const WEAPON_ORDER = ['pistol', 'rifle', 'shotgun', 'grenade', 'rocket', 'builder'];

// 契约守卫：fire() 无条件读 recoil.*，tick() 无条件读 recoil.recover、
// currentSpread() 无条件读 spread/spreadMove。缺字段不会报错，只会算出 NaN
// 并把视角永久污染（表现为转不动鼠标），极难定位，故在加载期硬失败。
for (const key of WEAPON_ORDER) {
  const w = WEAPONS[key];
  const missing = [];
  if (!w.recoil) missing.push('recoil');
  else for (const f of ['pitch', 'yaw', 'kick', 'recover']) {
    if (typeof w.recoil[f] !== 'number') missing.push('recoil.' + f);
  }
  for (const f of ['spread', 'spreadMove', 'rpm', 'magazine', 'reloadTime', 'crosshairSpread']) {
    if (typeof w[f] !== 'number') missing.push(f);
  }
  if (missing.length) {
    throw new Error(`WEAPONS["${key}"] 缺少字段: ${missing.join(', ')}`);
  }
}

/**
 * 武器运行时状态。切枪时保留各武器的独立弹药，
 * 这是街机射击的关键手感：换回来时不该重装。
 */
export class WeaponState {
  constructor() {
    this.index = 0;
    this.ammo = {};
    for (const k of WEAPON_ORDER) this.ammo[k] = WEAPONS[k].magazine;
    this.cooldown = 0;        // 距下次可开火的剩余秒数
    this.reloading = 0;       // 装填剩余秒数
    this.recoilPitch = 0;     // 当前累积后坐（视觉上抬枪）
    this.recoilYaw = 0;
    this.recoilVel = 0;       // 用于弹簧回正
    this.switchCooldown = 0;
    this.lastShotFlash = 0;
    this.infiniteAmmo = false;  // 彩蛋模式：无限弹药 + 无需换弹
  }

  get current() { return WEAPONS[WEAPON_ORDER[this.index]]; }

  /** 右键循环切枪。返回新武器的 key。 */
  cycle(dir = 1) {
    if (this.switchCooldown > 0) return null;
    this.index = (this.index + dir + WEAPON_ORDER.length) % WEAPON_ORDER.length;
    this.switchCooldown = 0.32;     // 换枪硬直，避免滚轮式狂切
    this.reloading = 0;
    return this.current.key;
  }

  /** 数字键直选武器（1~6）。同槽位重复按下不重复触发硬直。 */
  select(slot) {
    if (slot < 0 || slot >= WEAPON_ORDER.length) return null;
    if (slot === this.index) return null;          // 已是该武器
    if (this.switchCooldown > 0) return null;
    this.index = slot;
    this.switchCooldown = 0.32;
    this.reloading = 0;
    return this.current.key;
  }

  canFire() {
    return this.cooldown <= 0 && (this.infiniteAmmo || this.reloading <= 0) && this.switchCooldown <= 0;
  }

  /** 当前弹匣是否有弹（彩蛋模式下恒有）。 */
  hasAmmo() { return this.infiniteAmmo || this.ammo[this.current.key] > 0; }

  /**
   * 尝试开火。返回开火结果描述（null 表示未开火）。
   * 消耗弹匣、进入冷却、累积后坐都在这里做，是唯一改动弹药状态的地方。
   */
  fire() {
    if (!this.canFire()) return null;
    if (!this.hasAmmo()) {
      this.startReload();
      return null;
    }
    const w = this.current;
    if (!this.infiniteAmmo) this.ammo[w.key]--;   // 彩蛋模式不扣弹
    this.cooldown = 60 / w.rpm;

    this.recoilPitch += w.recoil.pitch;
    this.recoilYaw += (Math.random() - 0.5) * 2 * w.recoil.yaw;
    this.lastShotFlash = 1;

    return { weapon: w, consumed: this.infiniteAmmo ? 0 : 1 };
  }

  startReload() {
    if (this.infiniteAmmo) return false;   // 彩蛋模式无需换弹
    const w = this.current;
    if (this.reloading > 0) return false;
    if (this.ammo[w.key] >= w.magazine) return false;
    this.reloading = w.reloadTime;
    return true;
  }

  finishReload() {
    this.ammo[this.current.key] = this.current.magazine;
  }

  /** 无敌弹药：手榴弹/火箭筒打空后自动补，避免玩家卡死。 */
  tick(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.switchCooldown > 0) this.switchCooldown -= dt;
    if (this.lastShotFlash > 0) this.lastShotFlash = Math.max(0, this.lastShotFlash - dt * 12);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) { this.reloading = 0; this.finishReload(); }
    }
    // 后坐回正：临界阻尼弹簧。
    // 这里用**解析解**而不是显式欧拉：显式积分的稳定条件是 dt < 2/omega，
    // 而主循环在软件光栅化 / 掉帧时 dt 可达 0.05~0.2，会直接过冲，
    // 把 recoilPitch 打成负数再被 clamp 归零 —— 表现为"低帧率下完全没有后坐"。
    // 临界阻尼系统 x'' + 2ωx' + ω²x = 0 的闭式解对任意 dt 都稳定：
    //   v(t) = (v0 + ω(x0 + v0 t)) e^{-ωt}
    //   x(t) = (x0 + (v0 + ω x0) t) e^{-ωt}
    const w = this.current;
    const omega = w.recoil.recover;                // 越大回正越快
    const e = Math.exp(-omega * dt);
    const x0 = this.recoilPitch, v0 = this.recoilVel;
    this.recoilVel = (v0 + omega * (x0 + v0 * dt)) * e;
    this.recoilPitch = clamp((x0 + (v0 + omega * x0) * dt) * e, 0, 22);
    this.recoilYaw *= Math.pow(0.004, dt);
    this.recoilYaw = clamp(this.recoilYaw, -5, 5);
    // 非有限值守卫：任何 NaN 都会让视角永久锁死（鼠标转不动），代价极大
    if (!Number.isFinite(this.recoilPitch) || !Number.isFinite(this.recoilYaw) ||
        !Number.isFinite(this.recoilVel)) {
      this.recoilPitch = 0; this.recoilYaw = 0; this.recoilVel = 0;
    }
  }

  /** 当前散布角（弧度）。移动速度越大越散 —— 迫使玩家站定射击。 */
  currentSpread(moveSpeed) {
    const w = this.current;
    return w.spread + w.spreadMove * clamp(moveSpeed / 5.2, 0, 1.6);
  }
}

/** 取武器的模型部件描述（供 viewmodel 渲染）。 */
export function modelFor(kind) { return weaponModel(kind); }

/** 供 HUD 显示的一行摘要。 */
export function weaponStatLine(key) {
  const w = WEAPONS[key];
  if (w.ammoType === 'grenade') return `杀伤半径 ${w.radius}m · 引信 ${w.fuse}s`;
  if (w.ammoType === 'rocket') return `杀伤半径 ${w.radius}m · 装填 ${w.reloadTime}s`;
  if (w.ammoType === 'flame') return `灼烧 ${w.damage}/tick · 燃料 ${w.magazine}`;
  if (w.pellets > 1) return `${w.pellets} 弹丸 · ${w.damage}×${w.pellets}`;
  return `${w.damage} 伤害 · ${Math.round(w.rpm)} RPM`;
}
