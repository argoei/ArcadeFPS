// game/enemies.js —— 敌人：生成、行为、命中判定、死亡。
//
// 行为要求（来自规格）：在玩家前方一定范围内随机生成，具备左右横向移动
// 并逐步向玩家扑近的行为逻辑，被击杀后计入总数。
//
// 实现取舍说明：
//   · 「扑近」用的是**分离力 + 转向力**的转向行为（steering），
//     而不是"直接朝玩家直线走"。直���会让一群敌人叠成一个点，
//     加上分离力之后它们会自动散开成包围圈 —— 这既是街机射击该有的观感，
//     也让霰弹枪/火箭筒的范围杀伤变得有意义（能一次打到多个）。
//   · 横向移动不是随机的抖动，而是各自持有一个正弦侧向速度 + 随机相位，
//     叠加在扑近速度上。这样"左右横移"可读、可预测，玩家能预判提前量。

import { makeRng, clamp, lerp, TAU, rayAabb, raySphere } from '../core/math.js';

export const ENEMY_TYPES = {
  grunt: {
    key: 'grunt', name: '感染者',
    health: 100, speed: 1.84, radius: 0.42, height: 1.85,   // 全体降速 20%（原 2.3）
    damage: 9, attackRange: 1.5, attackCooldown: 1.05,
    score: 1,
    colors: { body: [0.32, 0.34, 0.30], head: [0.55, 0.50, 0.44], limb: [0.26, 0.27, 0.25] },
    limbScale: 1.0,
  },
  brute: {
    key: 'brute', name: '重装',
    health: 260, speed: 1.24, radius: 0.62, height: 2.35,   // 降速 20%（原 1.55）
    damage: 22, attackRange: 1.9, attackCooldown: 1.5,
    score: 1,   // 击杀计数按"敌人个数"算，与类型无关（规格要求"计入总数"）
    colors: { body: [0.40, 0.26, 0.22], head: [0.50, 0.36, 0.30], limb: [0.30, 0.20, 0.17] },
    limbScale: 1.35,
  },
  runner: {
    key: 'runner', name: '疾行者',
    health: 62, speed: 3.28, radius: 0.36, height: 1.72,    // 降速 20%（原 4.1）
    damage: 6, attackRange: 1.4, attackCooldown: 0.78,
    score: 1,
    colors: { body: [0.22, 0.30, 0.34], head: [0.42, 0.50, 0.55], limb: [0.18, 0.24, 0.28] },
    limbScale: 0.9,
  },
  // 掷石者：灰棕石系，中等偏瘦，远程投掷石块（抛物线砸玩家），近身仍啃咬
  lobber: {
    key: 'lobber', name: '掷石者',
    health: 90, speed: 1.52, radius: 0.44, height: 1.9,     // 降速 20%（原 1.9）
    damage: 10, attackRange: 1.5, attackCooldown: 1.1,
    rangeDamage: 16, rangeMin: 4, rangeMax: 14, rangeCooldown: 2.2,
    score: 1,
    colors: { body: [0.45, 0.40, 0.34], head: [0.58, 0.52, 0.44], limb: [0.36, 0.32, 0.27] },
    limbScale: 1.05,
  },
  // 喷火者：橙红火系，矮壮，中距离喷火（锥形持续伤害），近身仍啃咬
  flamer: {
    key: 'flamer', name: '喷火者',
    health: 130, speed: 1.6, radius: 0.5, height: 1.75,     // 降速 20%（原 2.0）
    damage: 14, attackRange: 1.5, attackCooldown: 1.2,
    rangeDamage: 11, rangeMin: 2, rangeMax: 8, rangeCooldown: 0.55,
    score: 1,
    colors: { body: [0.52, 0.22, 0.12], head: [0.95, 0.55, 0.2], limb: [0.42, 0.16, 0.1] },
    limbScale: 1.2,
  },
};

let NEXT_ID = 1;

export class Enemy {
  constructor(type, x, y, z, rng) {
    const def = ENEMY_TYPES[type];
    this.id = NEXT_ID++;
    this.type = type;
    this.def = def;
    this.x = x; this.y = y; this.z = z;
    this.vx = 0; this.vz = 0;
    this.vy = 0;                    // 垂直速度（跳跃上平台用）
    this.onGround = true;           // 是否站在地面/平台上
    this.yaw = rng() * TAU;
    this.health = def.health;
    this.maxHealth = def.health;

    // 行为参数
    this.strafePhase = rng() * TAU;
    this.strafeDir = rng() < 0.5 ? -1 : 1;
    this.strafeTimer = 1.2 + rng() * 2.4;   // 每隔一段时间换一次横向方向
    this.strafeAmp = 0.55 + rng() * 0.85;
    this.rangeTimer = 1.0 + rng() * 1.0;     // 远程攻击冷却
    this.rockTimer = 0;                      // 掷石者石块飞行计时（>0 表示石块在空中）
    this.rockPos = null;                     // 石块当前位置（实体方块渲染用）
    this.flameBurst = 0;                     // 喷火者持续喷射剩余时间
    this.attackTimer = rng() * 0.6;
    this.hitFlash = 0;
    this.phase = rng() * TAU;              // 走路摆腿相位

    // 死亡动画
    this.dying = 0;
    this.dead = false;
    this.deathFallAxis = rng() < 0.5 ? 0 : 1;
    this.fadeOut = 0;

    // 受击时的击退速度
    this.knockX = 0; this.knockZ = 0;
  }

  get pos() { return [this.x, this.y, this.z]; }
  get alive() { return !this.dead && this.dying === 0; }

  /** 命中盒：身体一个胶囊近似（用两段球 + 头球），脚下一段做地面判定。 */
  bounds(out) {
    const h = this.def.height;
    out[0] = this.x - this.def.radius; out[1] = this.y; out[2] = this.z - this.def.radius;
    out[3] = this.x + this.def.radius; out[4] = this.y + h; out[5] = this.z + this.def.radius;
    return out;
  }

  /** 返回命中距离，未命中返回 -1。头部判定优先且伤害加成。 */
  raycastHit(ro, rd) {
    if (!this.alive) return -1;
    const r = this.def.radius;
    const h = this.def.height;

    // 头部球（打头伤害 ×2.2，这是老式街机射击的核心技巧）
    const headY = this.y + h * 0.88;
    const headR = r * 0.55;
    const tHead = raySphere(ro, rd, [this.x, headY, this.z], headR);
    const th = tHead >= 0 ? tHead : Infinity;

    // 躯干：三个球近似，比精确胶囊便宜且视觉上无差别
    let tBody = Infinity;
    for (let i = 0; i < 3; i++) {
      const cy = this.y + h * (0.32 + i * 0.20);
      const t = raySphere(ro, rd, [this.x, cy, this.z], r * (1.0 - i * 0.08));
      if (t >= 0 && t < tBody) tBody = t;
    }
    // 腿部
    for (let i = 0; i < 2; i++) {
      const cx = this.x + (i ? r * 0.3 : -r * 0.3);
      const t = raySphere(ro, rd, [cx, this.y + h * 0.14, this.z], r * 0.5);
      if (t >= 0 && t < tBody) tBody = t;
    }

    if (th < tBody) return th;
    return tBody < Infinity ? tBody : -1;
  }

  applyDamage(amount, dirX, dirZ, headshot) {
    if (!this.alive) return false;
    const dmg = amount * (headshot ? 2.2 : 1);
    this.health -= dmg;
    this.hitFlash = 1;
    // 击退：伤害越大推得越远，但有上限，避免霰弹枪把敌人轰出场景
    const kb = clamp(dmg * 0.03, 0, 3.2);
    this.knockX += dirX * kb;
    this.knockZ += dirZ * kb;

    if (this.health <= 0) {
      this.dying = 1.0;   // 死亡动画时长（秒）
      return true;        // 返回 true 表示这一发击杀了它
    }
    return false;
  }

  /** 范围伤害：用于爆炸。按距离线性衰减。 */
  applySplash(center, radius, maxDamage, falloff) {
    if (!this.alive) return false;
    const dx = this.x - center[0], dy = (this.y + this.def.height * 0.5) - center[1], dz = this.z - center[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > radius) return false;
    const t = 1 - d / radius;
    const dmg = maxDamage * lerp(falloff, 1, t);
    // 爆炸没有明确的方向：用径向方向作为击退
    const inv = 1 / Math.max(d, 0.001);
    return this.applyDamage(dmg, dx * inv, dz * inv, false);
  }
}

/**
 * 敌人群。负责生成节流、行为更新、生成点选取。
 */
export class EnemyManager {
  constructor(scene, particles, rng) {
    this.scene = scene;
    this.particles = particles;
    this.rng = rng;
    this.list = [];
    this.kills = 0;
    this.totalSpawned = 0;
    // 当前持有攻击名额的敌人 id。跨帧稳定，只在持有者死亡时轮换。
    this.attackers = [];

    // 生成节奏：持续、随机、均衡。同时存活上限 6；生成间隔 1.0~2.0s（平均 1.5s），
    // 单次生成 1 个。间隔缩短后补充跟得上击杀，玩家能一路杀满 30 个过关，
    // 不会出现"杀完一波迟迟不见下一波"的空窗感。
    this.baseMax = 6;
    this.spawnIntervalMin = 1.0;
    this.spawnIntervalMax = 2.0;
    this.spawnTimer = 1.0;
    this.spawnMultiplier = 1;    // 彩蛋模式：敌人数量翻倍（maxAlive ×2，生成间隔 ÷2）
    // 满员死锁兜底：alive 达到上限且长期无击杀时，回收最远的敌人腾出名额。
    // 否则玩家火力不足清不掉满屏高血量敌人（brute 260 血），alive==maxAlive 恒成立，
    // 刷新永久停止 → kills 停滞 → 凑不满过关数（实测"十几杀后不再刷新"的根因）。
    this.age = 0;
    this.lastKillAt = 0;
    this.frozen = false;   // FREEZE 彩蛋：全场敌人原地不动（翻转式开关）
  }

  reset() {
    this.list.length = 0;
    this.kills = 0;
    this.totalSpawned = 0;
    this.spawnTimer = 1.0;
    this.attackers.length = 0;
  }

  /** 清空全部敌人（调试 / 截图核对画面时用）。 */
  clear() {
    this.list.length = 0;
    this.attackers.length = 0;
    this.spawnTimer = this.spawnIntervalMin;
  }

  /** 按 id 找敌人（攻击名额轮换用；列表规模 <= 30，线性扫描足够）。 */
  byId(id) {
    for (const e of this.list) if (e.id === id) return e;
    return null;
  }

  /** 当前同时存活上限，随击杀数缓慢增长并封顶（避免后期敌人过多）。 */
  get maxAlive() {
    // 上限 15→10、增速 0.3→0.2：kills>12 后重甲/疾行者占比升高，满员 15 个的
    // 血量池约 2000+，玩家火力清不动就满员死锁（不再刷新）。
    return Math.min(this.baseMax + Math.floor(this.kills * 0.2), 10) * this.spawnMultiplier;
  }

  get aliveCount() {
    let n = 0;
    for (const e of this.list) if (e.alive) n++;
    return n;
  }

  /**
   * 选一个玩家前方、且不在视线正中贴脸的位置生成。
   * 前方 = 相对玩家朝向的角度扇区内，这样玩家不需要转身就能看到威胁。
   */
  spawn(playerPos, playerYaw) {
    // 上限守卫：spawn 是 public 方法，不能只靠 update() 里的 spawnTimer 检查。
    // 直接调 spawn 会绕过上限（实测连调 50 次生成 50 个，远超 maxAlive=8）。
    if (this.aliveCount >= this.maxAlive) return null;

    const pts = this.scene.spawnPoints;
    if (!pts || !pts.length) return null;
    // 入参守卫：位置必须是长度为 3 的数组，否则下面 hypot 会得到 NaN，
    // 而 NaN 与任何阈值的比较恒为 false，会让所有生成点被静默丢弃。
    if (!playerPos || playerPos.length < 3) {
      throw new Error('EnemyManager.spawn: playerPos must be [x,y,z]');
    }

    let best = null, bestScore = -Infinity;
    const tries = 16;   // 增加采样次数，降低"全部失败"概率
    for (let i = 0; i < tries; i++) {
      const p = pts[(Math.random() * pts.length) | 0];
      const dx = p[0] - playerPos[0], dz = p[2] - playerPos[2];
      const dist = Math.hypot(dx, dz);
      if (dist < 6) continue;                     // 太近的生成点跳过，避免凭空出现在脸上
      // 注意：**去掉 dist>34 上限**。地图最大距离仅 ~35m，这个上限会让玩家走到
      // 地图边缘时几乎全部生成点都被排除，spawn 返回 null → 敌人"杀完不再出现"、
      // 永远达不到 30 击杀（实测根因）。

      // 偏好"在玩家视野前方"的点。
      // Player 的前方向量是 (-sin yaw, 0, -cos yaw)，对应 atan2(dx,dz) = yaw + PI，
      // 所以这里要比较 (ang - yaw) 与 PI，而不是与 0。
      const ang = Math.atan2(dx, dz);
      let da = ang - playerYaw - Math.PI;
      while (da > Math.PI) da -= TAU;
      while (da < -Math.PI) da += TAU;
      const inFront = Math.cos(da);               // 1 = 正前方
      const score = inFront * 1.6 + (dist / 40) * 0.5 + Math.random() * 0.4;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) {
      // fallback：采样全失败（玩家在地图死角），退化为"最近的非贴脸生成点"，
      // 保证玩家把敌人杀完后，下一波一定能出现。
      let fb = null, minD = Infinity;
      for (const p of pts) {
        const d = Math.hypot(p[0] - playerPos[0], p[2] - playerPos[2]);
        if (d >= 4 && d < minD) { minD = d; fb = p; }
      }
      if (!fb) return null;
      best = fb;
    }

    // 类型权重：随时间推移，疾行者/远程兵种比例升高（后段更紧张）。
    // 掷石者/喷火者减半（用户反馈远程兵种过多）：14%→7%（后段）、12%→6%（前段）。
    const r = Math.random();
    let type = 'grunt';
    if (this.kills > 12) {
      if (r < 0.26) type = 'runner';
      else if (r < 0.36) type = 'brute';
      else if (r < 0.43) type = 'lobber';
      else if (r < 0.50) type = 'flamer';
    } else {
      if (r < 0.16) type = 'runner';
      else if (r < 0.24) type = 'brute';
      else if (r < 0.30) type = 'lobber';
      else if (r < 0.36) type = 'flamer';
    }

    const e = new Enemy(type, best[0], best[1], best[2], this.rng);
    // 初始朝向朝向玩家，避免第一帧"背对玩家"的突兀
    e.yaw = Math.atan2(playerPos[0] - best[0], playerPos[2] - best[2]);
    this.list.push(e);
    this.totalSpawned++;
    return e;
  }

  /**
   * 更新全部敌人。
   * @param onKill 回调：每击杀一个调用一次（含击杀位置与类型）
   */
  update(dt, player, obstacles, onKill, onPlayerHit) {
    const pp = player.pos;
    const px = pp[0], py = pp[1], pz = pp[2];
    this.age += dt;

    // 生成：持续、随机、均衡。有空间就按随机间隔（2.0~3.5s）生成 1 个；
    // 达到上限时 timer 归零，玩家杀敌腾出空间后立刻补上，不留长时间空窗。
    this.spawnTimer -= dt;
    let alive = this.aliveCount;
    let maxAlive = this.maxAlive;
    // 满员死锁兜底 v2：满员且 8 秒无任何击杀 → 每 2.5 秒回收一个离玩家最远的敌人
    // 换成新鲜敌人（换血），直到玩家重新开始击杀。
    // 旧版 20 秒才回收 1 个：后段敌群血厚（brute 260）清不动时，玩家长时间
    // 看不到新敌人——实测"杀到 10 多个不再刷"的感知根因。
    if (alive >= maxAlive && this.list.length > 0) {
      const idle = this.age - this.lastKillAt;
      if (idle > 8) {
        this.recycleTimer = (this.recycleTimer || 0) - dt;
        if (this.recycleTimer <= 0) {
          let far = null, fd = -1;
          for (const e of this.list) {
            if (!e.alive) continue;
            const d = (e.x - px) ** 2 + (e.z - pz) ** 2;
            if (d > fd) { fd = d; far = e; }
          }
          if (far) {
            far.dying = 0.01; far.fadeOut = 0.4;   // 快速淡出，不计击杀
            this.recycleTimer = 2.5;               // 2.5 秒后继续换下一个
          }
        }
      } else {
        this.recycleTimer = 0;
      }
    }
    if (alive < maxAlive) {
      if (this.spawnTimer <= 0) {
        const ok = this.spawn(pp, player.yaw);
        // 随机间隔，彩蛋模式 ÷2（敌人翻倍 = 更快生成 + 更多存活）
        this.spawnTimer = (this.spawnIntervalMin +
          Math.random() * (this.spawnIntervalMax - this.spawnIntervalMin)) / this.spawnMultiplier;
        if (!ok) this.spawnTimer = 0.3;   // 生成点全失败时短时间重试
      }
    } else {
      this.spawnTimer = 0;   // 达到上限：保持就绪，腾出空间立刻补

    }
    // FREEZE 彩蛋：冻结期间暂停生成（否则冻结的敌人会堆满名额）
    if (this.frozen) this.spawnTimer = Math.max(this.spawnTimer, 0.2);

    /* ---- 攻击名额 ----
       街机射击的经典设计：同时只有固定数量的敌人能贴身进攻，其余在外围游走。
       否则 8 个敌人全部贴脸时 DPS 约68，玩家 1.5 秒就被围死，完全没有开枪的空间。

       关键：**名额必须跨帧稳定**。早先按"离玩家距离"每帧重排，结果所有敌人挤在
       0.06~1.09m 时排序在帧间反复抖动，攻击者身份不断轮换，
       实测 8 个敌人里有 6 个都打到了玩家，名额形同虚设。
       现在改为：持有者按 id 顺序排队，只有当前持有者死亡才轮换，
       保证任一时刻攻击者集合稳定，人数严格 <= MAX_ATTACKERS。*/
    const MAX_ATTACKERS = 2;
    if (alive > MAX_ATTACKERS) {
      // 持有者已死或空缺时才重新分配，避免每帧抖动
      const held = this.attackers.filter(id => this.byId(id)?.alive);
      if (held.length < MAX_ATTACKERS) {
        const heldSet = new Set(held);
        const cands = this.list.filter(e => e.alive && !heldSet.has(e));
        // 按 id 升序补位：顺序稳定，不受位置抖动影响
        cands.sort((a, b) => a.id - b.id);
        for (const e of cands) {
          if (held.length >= MAX_ATTACKERS) break;
          held.push(e.id);
        }
      }
      this.attackers = held;
    } else {
      this.attackers = [];
    }
    const attackSlots = new Set();
    for (const id of this.attackers) {
      const e = this.byId(id);
      if (e) attackSlots.add(e);
    }

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];

      if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 6);

      if (e.dying > 0) {
        e.dying -= dt;
        if (e.dying <= 0) { e.fadeOut = 0.7; }
      }
      if (e.fadeOut > 0) {
        e.fadeOut -= dt;
        if (e.fadeOut <= 0) { this.list.splice(i, 1); continue; }
      }
      if (!e.alive) continue;
      // FREEZE 彩蛋：冻结的敌人原地不动（跳过全部 AI；仍可被射击，死亡淡出照常）
      if (this.frozen) continue;

      /* ---- 转向行为 ---- */
      const dx = px - e.x, dz = pz - e.z;
      const dist = Math.hypot(dx, dz);
      const toX = dx / Math.max(dist, 0.001);
      const toZ = dz / Math.max(dist, 0.001);

      // 1) 主动追击：出现后立即锁定玩家，持续直线逼近（移除战术状态机的延迟/撤退/包抄）
      let approach = e.def.speed * clamp(1 + (24 - dist) * 0.06, 0.6, 1.6);
      // 远程敌人射程外赶路提速：否则从 30m 外以 1.2m/s 爬过来要 13 秒，
      // 玩家根本等不到它进射程开火（实测根因：15 秒内只喷了 2 次火）。
      if (e.def.rangeDamage && dist > e.def.rangeMax) {
        approach = e.def.speed * clamp(1 + (24 - dist) * 0.06, 1.0, 1.6) * 1.35;
      }
      let ax = toX * approach;
      let az = toZ * approach;

      // 2) 迂回路线：左右正弦摆动，持续逼近的同时走曲线（替代复杂 flank 包抄）
      e.strafeTimer -= dt;
      if (e.strafeTimer <= 0) {
        e.strafeTimer = 1.2 + Math.random() * 2.4;
        e.strafeDir *= -1;
      }
      // 侧向 = 目标方向右转 90°
      const rx = toZ, rz = -toX;
      e.strafePhase += dt * (2.0 + e.strafeAmp);
      const sideVel = Math.cos(e.strafePhase) * e.strafeAmp * 1.5 * e.strafeDir;
      ax += rx * sideVel;
      az += rz * sideVel;

      // 2.5) 远程敌人（掷石者/喷火者）在攻击范围内保持距离，不逼近到近战
      if (e.def.rangeDamage && dist <= e.def.rangeMax) {
        const hold = approach * 0.9;
        if (dist < e.def.rangeMin + 1.0) {
          // 太近：后退拉开距离，避免进入近战
          ax = -toX * hold;
          az = -toZ * hold;
        } else if (dist > e.def.rangeMax - 0.5) {
          // 太远：缓慢逼近进入射程
          ax = toX * hold;
          az = toZ * hold;
        } else {
          // 射程内：横向徘徊为主 + 少量逼近。纯侧向会卡在障碍前原地横移
          // （实测：跳跃登平台测试 maxY=0，敌人在 7m 处徘徊不翻平台）；
          // 逼近分量让遇障时自然触发跳跃/绕行，太近仍有后退分支兜底。
          ax = rx * sideVel * 1.5 + toX * approach * 0.25;
          az = rz * sideVel * 1.5 + toZ * approach * 0.25;
        }
      }

      // 3) 分离力：彼此推开。这一项是"一群敌人不叠成一个点"的唯一原因
      for (const o of this.list) {
        if (o === e || !o.alive) continue;
        const ox = e.x - o.x, oz = e.z - o.z;
        const od2 = ox * ox + oz * oz;
        const minD = e.def.radius + o.def.radius;
        if (od2 > 0.0001 && od2 < minD * minD) {
          const od = Math.sqrt(od2);
          const push = (minD - od) / minD * 9.0;
          ax += (ox / od) * push;
          az += (oz / od) * push;
        }
      }

      // 4) 障碍规避：先尝试跳跃上平台，跳不上去才沿墙滑动
      const step = 0.42;
      // 关键：用「身体中部高度」探测前方，而非脚下(e.y)。否则敌人跳上山丘顶部后
      // (y=1)，probe 用脚下 y 仍落在山丘盒内，被反复判为"前方有障碍"→偏转/后退，
      // 卡在山丘上不再逼近玩家，远程攻击（尤其喷火者 rangeMax=6.5）永远不触发。
      const probeY = e.y + e.def.height * 0.5;
      const probe = [e.x + ax * step / Math.max(Math.hypot(ax, az), 0.001), probeY, e.z + az * step / Math.max(Math.hypot(ax, az), 0.001)];
      if (sceneBlocked(obstacles, probe, e.def.radius)) {
        // 跳跃：前方障碍顶面可跳上（高度差 <= 1.1 方块）且在地面 → 跳上去
        const top = obstacleTopAt(obstacles, probe[0], probe[2], e.y, 1.15, e.def.radius);
        if (top !== null && e.onGround) {
          e.vy = 8.5;             // 与玩家同款起跳初速，可越过 1 方块
          e.onGround = false;
          // 不偏转，继续朝障碍走，跳跃后落到顶面
        } else {
          // 试另一侧：45° 偏转，比"停下"更自然
          const c = Math.cos(0.9), s = Math.sin(0.9);
          const nx = toX * c + toZ * s, nz = -toX * s + toZ * c;
          if (!sceneBlocked(obstacles, [e.x + nx * step, probeY, e.z + nz * step], e.def.radius)) {
            ax = nx; az = nz;
          } else {
            const m = Math.cos(0.9), n = -Math.sin(0.9);
            const bx = toX * m + toZ * n, bz = -toX * n + toZ * m;
            if (!sceneBlocked(obstacles, [e.x + bx * step, probeY, e.z + bz * step], e.def.radius)) {
              ax = bx; az = bz;
            } else {
              ax = -toX * 0.4; az = -toZ * 0.4;   // 前方完全堵死：后退拉开距离
            }
          }
        }
      }

      // 积分（带阻尼，避免抖动）
      e.vx = lerp(e.vx, ax, clamp(dt * 9, 0, 1));
      e.vz = lerp(e.vz, az, clamp(dt * 9, 0, 1));

      e.x += (e.vx + e.knockX) * dt;
      e.z += (e.vz + e.knockZ) * dt;
      e.knockX *= Math.pow(0.02, dt);
      e.knockZ *= Math.pow(0.02, dt);

      // 垂直移动：跳跃 + 重力 + 落地
      // 关键修复：onGround=true 时也要检测脚下是否仍有支撑。敌人生成在山丘顶部（y>0）
      // 后走到边缘，旧逻辑不检测脚下 → 悬空 → 玩家平视打不到、敌人永远不死、
      // alive 累积到 maxAlive → spawn 停止，表现为"敌人出现若干次后不再出现"。
      if (e.onGround) {
        let supported = e.y <= 0.05;   // 站在地面(y=0)算有支撑
        for (const o of obstacles) {
          if (e.x > o.min[0] - e.def.radius && e.x < o.max[0] + e.def.radius &&
              e.z > o.min[2] - e.def.radius && e.z < o.max[2] + e.def.radius &&
              Math.abs(e.y - o.max[1]) < 0.06) {
            supported = true; break;
          }
        }
        if (!supported) e.onGround = false;   // 脚下空了 → 进入掉落
      }
      if (!e.onGround) {
        e.vy -= 19.6 * dt;
        let ny = e.y + e.vy * dt;
        let floorY = 0;
        if (e.vy < 0) {
          for (const o of obstacles) {
            if (e.x > o.min[0] - e.def.radius && e.x < o.max[0] + e.def.radius &&
                e.z > o.min[2] - e.def.radius && e.z < o.max[2] + e.def.radius &&
                e.y >= o.max[1] - 0.01 && ny < o.max[1]) {
              if (o.max[1] > floorY) floorY = o.max[1];
            }
          }
        }
        if (ny <= floorY) {
          e.y = floorY;
          e.vy = 0;
          e.onGround = true;
        } else {
          e.y = ny;
        }
      }

      // 朝向玩家（平滑转头）
      const targetYaw = Math.atan2(dx, dz);
      let dy = targetYaw - e.yaw;
      while (dy > Math.PI) dy -= TAU;
      while (dy < -Math.PI) dy += TAU;
      e.yaw += dy * clamp(dt * 7, 0, 1);

      e.phase += dt * (2.2 + Math.hypot(e.vx, e.vz) * 1.4);

      /* ---- 远程攻击（掷石者投石 / 喷火者喷火） ---- */
      // 高度限制：玩家高出敌人 3m 以上（高塔上）时，抛掷/水平喷火均无法够到，
      // 远程兵种改为逼近（不攻击）。dist 仅为水平距离，必须叠加高度判定。
      const heightGap = py - e.y;
      if (e.def.rangeDamage && heightGap <= 3 && dist >= e.def.rangeMin && dist <= e.def.rangeMax) {
        e.rangeTimer -= dt;
        if (e.rangeTimer <= 0 && e.rockTimer <= 0 && !(e.flameBurst > 0)) {
          e.rangeTimer = e.def.rangeCooldown;
          if (e.type === 'lobber') {
            // 投石：前摇 0.5s，石块飞行 0.8s（实体方块由 game.js 渲染，粒子只做拖尾）
            e.attackWindup = 0.5;
            e.rockTimer = 0.8;
            e.rockFrom = [e.x, e.y + 1.4, e.z];
            e.rockTo = [px, py + 1.0, pz];
            e.rockPos = null;
          } else {
            // 喷火：0.75s 体素火舌（实体方块由 game.js 渲染，与石块同路径）+ 即时伤害
            e.attackWindup = 0.2;
            e.flameBurst = 0.75;
            const fdx = px - e.x, fdz = pz - e.z;
            const fd = Math.hypot(fdx, fdz) || 1;
            e.flameDir = [fdx / fd, fdz / fd];   // 火焰水平方向（渲染用）
            onPlayerHit?.(e.def.rangeDamage, e);
          }
        }
      }
      // 掷石者石块：更新当前位置（实体方块渲染用）+ 少量拖尾粒子
      if (e.rockTimer > 0) {
        e.rockTimer -= dt;
        const k = 1 - e.rockTimer / 0.8;   // 0→1 飞行进度
        const rx = lerp(e.rockFrom[0], e.rockTo[0], k);
        const ry = lerp(e.rockFrom[1], e.rockTo[1], k) + Math.sin(k * Math.PI) * 1.8;
        const rz = lerp(e.rockFrom[2], e.rockTo[2], k);
        e.rockPos = [rx, ry, rz];
        if (e.rockTimer <= 0) { onPlayerHit?.(e.def.rangeDamage, e); e.rockPos = null; }
      }
      // 喷火者：体素火舌期间持续朝向玩家；结束后清除方向标记
      if (e.flameBurst > 0) {
        e.flameBurst -= dt;
        const fdx = px - e.x, fdz = pz - e.z;
        const fd = Math.hypot(fdx, fdz) || 1;
        e.flameDir = [fdx / fd, fdz / fd];
        if (e.flameBurst <= 0) e.flameDir = null;
      }

      /* ---- 近战攻击 ---- */
      // 没有拿到名额的敌人只在身边徘徊，不造成伤害
      const hasSlot = this.attackers.length === 0 || attackSlots.has(e);
      if (hasSlot && dist < e.def.attackRange && e.attackTimer <= 0) {
        e.attackTimer = e.def.attackCooldown;
        // 攻击有前摇：起手 0.18s 无敌感缺失会显得"接触即扣血"很廉价
        e.attackWindup = 0.18;
        onPlayerHit?.(e.def.damage, e);
      }
      if (e.attackTimer > 0) e.attackTimer -= dt;
      if (e.attackWindup > 0) e.attackWindup -= dt;
    }
  }

  /** 射线对全体敌人求最近命中。 */
  raycast(ro, rd) {
    let bestT = -1, bestE = null, headshot = false;
    for (const e of this.list) {
      const t = e.raycastHit(ro, rd);
      if (t >= 0 && (bestT < 0 || t < bestT)) {
        bestT = t; bestE = e;
        // 判断是否打中头：命中点高于 80% 身高
        const hy = ro[1] + rd[1] * t;
        headshot = hy > e.y + e.def.height * 0.80;
      }
    }
    return { t: bestT, enemy: bestE, headshot };
  }

  /** 爆炸范围判定。返回本帧被击杀的敌人列表。 */
  splash(center, radius, damage, falloff) {
    const killed = [];
    for (const e of this.list) {
      if (!e.alive) continue;
      if (e.applySplash(center, radius, damage, falloff)) {
        killed.push(e);
      }
    }
    return killed;
  }

  registerKill(e, onKill) {
    this.kills++;
    this.lastKillAt = this.age;   // 供满员死锁兜底判断"多久没杀敌"
    onKill?.(e);
  }

  /** 清理已死实体，控制 list 长度（每帧遍历的成本与长度成正比）。 */
  compact() {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].dead) this.list.splice(i, 1);
    }
  }
}

/** 场景障碍（轴对齐盒）检测。返回 true 表示被挡。 */
function sceneBlocked(obstacles, p, radius) {
  if (!obstacles) return false;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (p[0] > o.min[0] - radius && p[0] < o.max[0] + radius &&
        p[1] > o.min[1] - radius && p[1] < o.max[1] + radius &&
        p[2] > o.min[2] - radius && p[2] < o.max[2] + radius) {
      return true;
    }
  }
  return false;
}

/** 找 (x,z) 处（含 radius 扩展，与 sceneBlocked 一致）、且在 baseY 之上、
 *  高度差 <= maxJump 的最高障碍顶面。返回顶面高度（可跳上），否则 null。
 *  用于敌人"跳跃上平台"的寻路判定。 */
function obstacleTopAt(obstacles, x, z, baseY, maxJump, radius) {
  let top = null;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (x > o.min[0] - radius && x < o.max[0] + radius &&
        z > o.min[2] - radius && z < o.max[2] + radius &&
        o.max[1] > baseY && o.max[1] - baseY <= maxJump) {
      if (top === null || o.max[1] > top) top = o.max[1];
    }
  }
  return top;
}
