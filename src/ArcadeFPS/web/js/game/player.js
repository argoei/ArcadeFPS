// game/player.js —— 第一人称玩家控制器。
//
// 视角与移动分离：yaw/pitch 是"意图"（鼠标累积），实际朝向 = intent + recoil。
// 后坐不直接改意图，而是叠加一层 recoil 偏移，这样后坐自然回正后
// 准星会回到原来的瞄准位置 —— 街机射击必须是"后坐不损失精度"的，
// 否则连射时玩家会越打越偏，那是主机游戏的体验，不是街机的。

import { clamp, lerp, v3, m4 } from '../core/math.js';

const EYE_HEIGHT = 1.68;
const CROUCH_HEIGHT = 1.05;
const RADIUS = 0.34;

export class Player {
  constructor() {
    this.pos = v3.create(0, EYE_HEIGHT, 0);   // pos 是**脚底**位置，相机再往上加眼高
    this.vel = v3.create();
    this.yaw = 0;
    this.pitch = 0;

    this.health = 100;
    this.maxHealth = 100;
    this.armor = 0;

    this.onGround = true;
    this.crouch = false;
    this.sprinting = false;
    this.eyeHeight = EYE_HEIGHT;

    this.bobPhase = 0;
    this.bobAmount = 0;
    this.landShock = 0;
    this.damageFlash = 0;
    this.regenDelay = 0;

    // 摄像机最终矩阵每帧由 syncCamera 写入
    this.eye = v3.create();
    this.viewTarget = v3.create();
    this.forward = v3.create();
    this.right = v3.create();
    this.up = v3.create(0, 1, 0);
    this.roll = 0;

    this.killGoal = 30;
    this.alive = true;
  }

  get healthPct() { return clamp(this.health / this.maxHealth, 0, 1); }

  spawnAt(x, y, z, yaw = 0) {
    v3.set(this.pos, x, y, z);
    v3.set(this.vel, 0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = this.maxHealth;
    this.armor = 0;
    this.crouch = false;
    this.eyeHeight = EYE_HEIGHT;
    this.damageFlash = 0;
    this.landShock = 0;
    this.alive = true;
    this.syncCamera(0);
  }

  /** 鼠标增量。sensitivity 为弧度/像素。 */
  look(dx, dy, sensitivity) {
    if (!this.alive) return;
    this.yaw -= dx * sensitivity;
    this.pitch -= dy * sensitivity;
    // 限制俯仰到 ±88°，再多就穿帮（能看见自己的后脑勺/脚下反转）
    const lim = 88 * Math.PI / 180;
    this.pitch = clamp(this.pitch, -lim, lim);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /**
   * 移动与碰撞。
   * 碰撞用「胶囊近似为竖直圆柱 + 逐轴解算」：分轴求解是为了能贴墙滑行，
   * 一次性求解会让人物卡在墙角。
   */
  update(dt, input, obstacles, weaponState, bounds, ladders) {
    if (!this.alive) {
      // 死亡后视角缓缓下坠，是街机射击的标准反馈
      this.pitch = lerp(this.pitch, -0.35, clamp(dt * 2.2, 0, 1));
      this.eyeHeight = lerp(this.eyeHeight, 0.35, clamp(dt * 1.6, 0, 1));
      this.syncCamera(dt);
      return;
    }

    /* ---- 输入 -> 期望速度 ---- */
    const wantF = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const wantR = (input.right ? 1 : 0) - (input.left ? 1 : 0);

    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    // 前方 = (-sin, 0, -cos)：yaw=0 时朝 -Z
    const fx = -sinY, fz = -cosY;
    const rx = cosY, rz = -sinY;

    let dx = fx * wantF + rx * wantR;
    let dz = fz * wantF + rz * wantR;
    const len = Math.hypot(dx, dz);
    if (len > 0.0001) { dx /= len; dz /= len; }

    this.sprinting = input.sprint && wantF > 0 && !this.crouch;
    // 主角速度必须明显快于最快敌人（runner 4.1）：步行 5.0 快 22%，冲刺 8.0 快 95%。
    // 旧值步行 4.5 只快 9.7%，后退时会被 runner 追上。
    const speed = this.crouch ? 2.0 : this.sprinting ? 8.0 : 5.0;
    const targetVx = dx * speed * (wantF || wantR ? 1 : 0);
    const targetVz = dz * speed * (wantF || wantR ? 1 : 0);

    // 加速度模型：给一点惯性，但不至于"橡皮筋"
    const accel = this.onGround ? 42 : 9;
    this.vel[0] += (targetVx - this.vel[0]) * clamp(accel * dt / Math.max(speed, 1), 0, 1);
    this.vel[2] += (targetVz - this.vel[2]) * clamp(accel * dt / Math.max(speed, 1), 0, 1);

    /* ---- 梯子攀爬：在梯子范围内，上方向键（前进）向上爬、下方向键（后退）
       向下爬；都不按则缓慢下滑后停住。空格恢复跳跃语义（可跳离梯子）。 ---- */
    let climbing = false;
    if (ladders && ladders.length) {
      for (const L of ladders) {
        if (this.pos[0] > L.min[0] - 0.5 && this.pos[0] < L.max[0] + 0.5 &&
            this.pos[2] > L.min[2] - 0.5 && this.pos[2] < L.max[2] + 0.5 &&
            this.pos[1] < L.max[1] - 0.3 && this.pos[1] + 1.85 > L.min[1]) {
          climbing = true;
          break;
        }
      }
    }
    if (climbing) {
      // 攀爬时锁定水平移动：否则"上键"会驱动水平前进，玩家走出梯子范围摔落
      this.vel[0] = 0;
      this.vel[2] = 0;
      if (input.forward) this.vel[1] = 3.2;                    // 上：匀速上爬
      else if (input.back) this.vel[1] = -3.0;                 // 下：匀速下爬
      else this.vel[1] = Math.max(this.vel[1] - 14 * dt, -1.2); // 松开：阻尼缓滑后停
      this.onGround = false;
    } else if (input.jump && this.onGround) {
      this.vel[1] = 8.5;
      this.onGround = false;
    }

    /* ---- 重力与落地（攀爬时不施加重力） ---- */
    if (!climbing) {
      this.vel[1] -= 19.6 * dt;
      if (this.vel[1] < -40) this.vel[1] = -40;
    }
    this.onGround = false;

    /* ---- 逐轴移动 + 碰撞解算 ---- */
    this.moveAxis(0, this.vel[0] * dt, obstacles);
    this.moveAxis(2, this.vel[2] * dt, obstacles);

    let ny = this.pos[1] + this.vel[1] * dt;
    // 落地检测：地面 y=0 或脚下障碍顶面（山丘/岩石等方块）。
    // 取最高顶面，支持"跳上高一阶的台地"。旧版只判 ny<=0，玩家跳跃后会
    // 穿过方块顶面继续掉到 y=0 —— 表现为"陷入台地、移动不了"。
    let groundY = 0;
    if (this.vel[1] < 0) {
      for (const o of obstacles) {
        if (this.pos[0] > o.min[0] - RADIUS && this.pos[0] < o.max[0] + RADIUS &&
            this.pos[2] > o.min[2] - RADIUS && this.pos[2] < o.max[2] + RADIUS &&
            this.pos[1] >= o.max[1] - 0.02 && ny < o.max[1]) {
          if (o.max[1] > groundY) groundY = o.max[1];
        }
      }
    }
    if (ny <= groundY) {
      if (!this.onGround && this.vel[1] < -3) {
        this.landShock = clamp(-this.vel[1] / 22, 0, 1);
      }
      ny = groundY;
      this.vel[1] = 0;
      this.onGround = true;
    }
    this.pos[1] = ny;

    // 场景边界
    this.clampToBounds(bounds);

    /* ---- 蹲伏与视角高度 ---- */
    const targetH = this.crouch ? CROUCH_HEIGHT : EYE_HEIGHT;
    this.eyeHeight = lerp(this.eyeHeight, targetH, clamp(dt * 11, 0, 1));

    /* ---- 走路摇晃 ---- */
    const hspeed = Math.hypot(this.vel[0], this.vel[2]);
    this.bobAmount = lerp(this.bobAmount, this.onGround ? clamp(hspeed / 6, 0, 1) : 0, clamp(dt * 8, 0, 1));
    this.bobPhase += dt * hspeed * 1.85;

    /* ---- 生命值恢复 ---- */
    if (this.regenDelay > 0) this.regenDelay -= dt;
    else if (this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + dt * 4.5);
    }
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);

    /* ---- 武器后坐叠加到视角 ---- */
    this.syncCamera(dt);
  }

  moveAxis(axis, delta, obstacles) {
    if (delta === 0) return;
    const p = this.pos;
    const old = p[axis];
    p[axis] += delta;

    for (const o of obstacles) {
      // 竖直圆柱 vs AABB：水平两轴与竖直区间同时重叠才算撞
      if (p[0] > o.min[0] - RADIUS && p[0] < o.max[0] + RADIUS &&
          p[2] > o.min[2] - RADIUS && p[2] < o.max[2] + RADIUS &&
          p[1] + this.eyeHeight > o.min[1] + 0.05 &&
          p[1] < o.max[1] - 0.05) {
        // 自动上台阶（step up）：障碍顶面可跨过（半砖 0.5 高）时抬升，不必跳跃
        if (this.onGround && o.max[1] > p[1] && o.max[1] <= p[1] + 0.62) {
          p[1] = o.max[1];
          continue;
        }
        p[axis] = old;
        this.vel[axis] = 0;
        return;
      }
    }
  }

  clampToBounds(bounds) {
    if (!bounds) return;
    const [W, H, D] = bounds;
    const hw = W / 2 - 1.0, hd = D / 2 - 1.0;
    if (this.pos[0] > hw) { this.pos[0] = hw; this.vel[0] = 0; }
    if (this.pos[0] < -hw) { this.pos[0] = -hw; this.vel[0] = 0; }
    if (this.pos[2] > hd) { this.pos[2] = hd; this.vel[2] = 0; }
    if (this.pos[2] < -hd) { this.pos[2] = -hd; this.vel[2] = 0; }
  }

  /** 计算最终眼位与朝向（含后坐、摇晃、落地下沉）。 */
  syncCamera(dt) {
    const bobY = Math.sin(this.bobPhase * 2) * 0.042 * this.bobAmount;
    const bobX = Math.cos(this.bobPhase) * 0.036 * this.bobAmount;
    if (this.landShock > 0) this.landShock = Math.max(0, this.landShock - dt * 4.5);

    this.eye[0] = this.pos[0] + Math.cos(this.yaw) * bobX;
    this.eye[1] = this.pos[1] + this.eyeHeight + bobY - this.landShock * 0.28;
    this.eye[2] = this.pos[2] - Math.sin(this.yaw) * bobX;

    const pitch = this.pitch;
    const yaw = this.yaw;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const sy = Math.sin(yaw), cy = Math.cos(yaw);

    this.forward[0] = -sy * cp;
    this.forward[1] = sp;
    this.forward[2] = -cy * cp;

    v3.set(this.right, cy, 0, -sy);
    // 侧倾：横向移动时轻微倾斜，是"重量感"的重要来源
    this.roll = lerp(this.roll, 0, clamp(dt * 6, 0, 1));

    v3.addScaled(this.viewTarget, this.eye, this.forward, 1);
  }

  /** 受伤。返回是否致死。 */
  takeDamage(amount) {
    if (!this.alive) return false;
    // 入参守卫：NaN / 负数 / 非有限值直接忽略，否则 health 会被污染成 NaN
    // （实测 takeDamage(NaN) 后 hp=nan，且会连锁污染 regen/伤害判定）。
    if (!Number.isFinite(amount) || amount <= 0) return false;
    let dmg = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg * 0.65);
      this.armor -= absorbed;
      dmg -= absorbed;
    }
    this.health -= dmg;
    this.damageFlash = 1;
    this.regenDelay = 4.0;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      return true;
    }
    return false;
  }

  get moveSpeed() { return Math.hypot(this.vel[0], this.vel[2]); }
}
