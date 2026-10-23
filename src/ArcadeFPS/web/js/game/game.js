// game/game.js —— 主循环与玩法编排。把渲染、输入、玩家、敌人、武器、
// 场景、粒子、HUD 串起来；两种模式（壁纸 / 游戏）在这里分流。

import * as G from '../core/gl.js';
import { Renderer } from '../render/renderer.js';
import * as Geo from '../render/geometry.js';
import { box, humanoidParts, weaponModel, GUN_MATERIALS, mergedBoxes, sphere, cylinder } from '../render/geometry.js';
import { buildTextureLibrary, buildSky } from '../render/textures.js';
import { ParticleSystem, WeatherEmitter, WEATHERS } from '../render/particles.js';
import { Player } from './player.js';
import { EnemyManager } from './enemies.js';
import { WeaponState, WEAPONS, WEAPON_ORDER } from './weapons.js';
import { SCENES, buildScene, pickWeather, nextScene, weatherPoolFor } from './scenes.js';
import { Hud } from './hud.js';
import { clamp, lerp, makeRng, rayAabb, TAU, v3, m4 } from '../core/math.js';

const cfg = new URLSearchParams(location.search);
const MODE = cfg.get('mode') === 'wallpaper' ? 'wallpaper' : 'game';
const KILL_GOAL = parseInt(cfg.get('killGoal') || '30', 10);

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.mode = MODE;
    this.killGoal = KILL_GOAL;

    const quality = cfg.get('quality') ||
      (MODE === 'wallpaper' ? 'medium' : 'high');

    this.renderer = new Renderer(canvas, quality);
    this.particles = new ParticleSystem(7);
    this.weatherFx = new WeatherEmitter(this.particles, 11);
    this.textures = buildTextureLibrary(this.renderer.gl, G.textureFromImage);
    this.skyCache = {};

    this.renderer.initOverlays({
      hole: this.textures.hole,
      blood: this.textures.blood,
    });

    // 敌人与武器的实例批（独立于场景批次，切换场景时只清场景批次）
    this.enemyBatches = {};
    this.setupSharedBatches();

    this.player = new Player();
    this.player.killGoal = KILL_GOAL;
    this.weapons = new WeaponState();
    this.enemies = null;

    this.projectiles = [];    // 手榴弹与火箭
    this.tracers = [];
    this.impacts = [];
    this.props = [];
    this.debris = [];        // 爆炸飞散的像素方块碎片
    this.lastEscTime = 0;    // 双击 ESC 退出的计时
    this.aiming = false;     // 瞄准镜（鼠标中键切换）
    this.zoom = 2.0;         // 瞄准镜放大倍数（滚轮调节，默认 2 倍）
    this.easterEgg = false;  // 彩蛋模式（连续输入 FIRE 触发）
    this.easterBuffer = '';  // 彩蛋序列缓冲
    this.dragonBuffer = '';  // 末影龙彩蛋序列缓冲
    this.dragon = null;      // 末影龙实体（输入 dragon 触发）
    this.tntMode = false;    // TNT 彩蛋：枪射出 TNT 方块（输入 tnt 触发）
    this.invincible = false; // FIRE 彩蛋：无敌（受到攻击不掉血）
    this.tntBuffer = '';     // TNT 序列缓冲
    this.freezeBuffer = '';  // FREEZE 序列缓冲

    this.sceneIndex = 0;
    this.scene = null;
    this.weather = null;
    this.rng = makeRng(20261017);
    this.builtBlocks = [];   // 建造枪砌出的方块（渲染体素 + 碰撞盒）

    this.time = 0;
    this.accumulator = 0;
    this.lastFrame = 0;
    this.fpsSamples = [];
    this.pixelScale = 1;
    this.postFx = {
      exposure: 1, vignette: 0.45, bloom: 0.55, damage: 0, aberration: 0,
      flash: 0, saturation: 1.25, bloomThreshold: 0.78, bloom: 0.45,
    };

    this.hud = new Hud(document.body, { mode: MODE });
    this.bindings = this.hud.bindings;

    this.setupInput();
    this.setupResize();
    this.loadScene(0);

    this.transitioning = false;
    this.deathTimer = 0;

    // 通知宿主首帧就绪（宿主的壁纸层会等这个信号才挂载）
    this.readyNotified = false;
  }

  /* ================================================================ 资源 */

  /** 为敌人与武器预建实例批。每类几何一个批，逐帧只填数据。 */
  setupSharedBatches() {
    const gl = this.renderer.gl;
    const MAXE = 200;
    // 敌人各部件：全部用单位立方体，靠实例矩阵缩放
    this.enemyBox = this.renderer.batch('enemy:box', box(1, 1, 1), MAXE * 8);
    this.enemyBox.texture = this.textures.dirt;      // 中性贴图，敌人颜色靠 color tint
    // 敌人血条背景
    this.hpBarBack = this.renderer.batch('ui:bar', box(1, 1, 1), MAXE);
    this.hpBarBack.texture = this.textures.plank;
    // 武器视图模型。容量 = 单把武器最多部件数（rifle 21 件）+ 余量
    this.viewBox = this.renderer.batch('view:box', box(1, 1, 1), 24);
    this.viewBox.texture = this.textures.snow;      // 浅色底，颜色完全由 GUN_MATERIALS 决定
    // 子弹壳/投掷物/爆炸碎片（debris）。容量 640：喷火器火龙单帧 ~300 体素 +
    // 龙散裂 70 + 爆炸碎片叠加，旧值会顶满溢出截断。
    this.projBox = this.renderer.batch('proj:box', box(1, 1, 1), 640);
    this.projBox.texture = this.textures.stone;
    // 建造枪砌出的方块：持久静态批（与场景方块同类）——爆炸破坏逻辑靠
    // o.batch.list[o.idx] 隐藏实例，动态每帧重建的批次无法被引用，所以必须静态化
    this.builtBatch = this.renderer.batch('built:block', box(1, 1, 1), 240);
    this.builtBatch.texture = this.textures.plank;
    // 曳光弹（开火瞬间的红色火光，沿准星方向）
    this.tracerBatch = this.renderer.batch('fx:tracer', box(1, 1, 1), 96);
    this.tracerBatch.texture = this.textures.glow;
  }

  /* ================================================================ 输入 */

  setupInput() {
    this.input = {
      forward: false, back: false, left: false, right: false,
      jump: false, sprint: false, crouch: false,
      mouseLeft: false, mouseRight: false,
    };

    this.keys = new Set();

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Escape') this.onEscape();
      if (e.code === 'KeyR') this.weapons.startReload();
      if (e.code === 'F11') { e.preventDefault(); this.toggleFullscreen?.(); }
      // 快捷栏：数字键直选武器（1~6）与彩蛋（7 FIRE / 8 TNT / 9 FREEZE / 0 DRAGON）
      const d = /^Digit([0-9])$/.exec(e.code);
      if (d) this.onQuickBar(+d[1]);
      // 彩蛋序列：连续输入 F-I-R-E（不区分大小写）
      const m = /^Key([A-Z])$/.exec(e.code);
      if (m) {
        this.easterBuffer += m[1];
        if (this.easterBuffer.length > 4) this.easterBuffer = this.easterBuffer.slice(-4);
        if (this.easterBuffer === 'FIRE') { this.easterBuffer = ''; this.activateEasterEgg(); }
        // 末影龙彩蛋：连续输入 D-R-A-G-O-N
        this.dragonBuffer += m[1];
        if (this.dragonBuffer.length > 6) this.dragonBuffer = this.dragonBuffer.slice(-6);
        if (this.dragonBuffer === 'DRAGON') { this.dragonBuffer = ''; this.spawnDragon(); }
        // TNT 彩蛋：连续输入 T-N-T
        this.tntBuffer += m[1];
        if (this.tntBuffer.length > 3) this.tntBuffer = this.tntBuffer.slice(-3);
        if (this.tntBuffer === 'TNT') { this.tntBuffer = ''; this.activateTnt(); }
        // FREEZE 彩蛋：连续输入 F-R-E-E-Z-E（翻转式：全场敌人原地不动/恢复）
        this.freezeBuffer += m[1];
        if (this.freezeBuffer.length > 6) this.freezeBuffer = this.freezeBuffer.slice(-6);
        if (this.freezeBuffer === 'FREEZE') { this.freezeBuffer = ''; this.activateFreeze(); }
      }
      // 阻止空格/方向键滚动页面，以及 F5 刷新（会打断游戏状态）
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F5'].includes(e.code)) {
        e.preventDefault();
      }
      this.syncKeyBindings();
    });

    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); this.syncKeyBindings(); });
    window.addEventListener('blur', () => { this.keys.clear(); this.syncKeyBindings(); });

    const canvas = this.canvas;

    canvas.addEventListener('mousedown', (e) => {
      if (this.mode === 'wallpaper') {
        // 壁纸态：点击 = 请求进入游戏（宿主也会轮询到，两条路都留着更稳）
        this.requestStartGame();
        return;
      }
      e.preventDefault();
      if (!this.pointerLocked) { this.requestLock(); return; }
      if (e.button === 0) { this.input.mouseLeft = true; this.fireHeld = true; this.tryFire(true); }
      if (e.button === 1) { this.toggleScope(); }   // 鼠标中键：切换瞄准镜显示/隐藏
      if (e.button === 2) { this.cycleWeapon(1); }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) { this.input.mouseLeft = false; this.fireHeld = false; }
    });

    // 鼠标滚轮：瞄准镜开启时放大/缩小
    window.addEventListener('wheel', (e) => {
      if (this.mode !== 'game' || !this.aiming) return;
      e.preventDefault();
      this.zoom = clamp(this.zoom + (e.deltaY < 0 ? 0.5 : -0.5), 1.5, 8.0);
      this.updateScopeUI();
    }, { passive: false });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (this.mode !== 'game') return;
      if (!this.pointerLocked) return;
      this.player.look(e.movementX || 0, e.movementY || 0,
        this.hud.sensitivity / (this.aiming ? 2.5 : 1));   // 瞄准镜开启时灵敏度降低
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      this.post({ type: this.pointerLocked ? 'lock' : 'unlock' });
      if (!this.pointerLocked) {
        this.input.mouseLeft = false;
        this.fireHeld = false;
        if (this.mode === 'game') this.hud.el.hint.textContent = '点击画面继续';
      } else if (this.hud.el.hint) {
        this.hud.el.hint.textContent = '';
      }
    });

    this.onEscHandlers = [];
  }

  syncKeyBindings() {
    const b = this.bindings;
    const k = this.keys;
    this.input.forward = k.has(b.forward);
    this.input.back = k.has(b.back);
    this.input.left = k.has(b.left);
    this.input.right = k.has(b.right);
    this.input.jump = k.has(b.jump);
    this.input.sprint = k.has(b.sprint) || k.has(b.crouch) && false;
    this.input.crouch = k.has(b.crouch);
  }

  requestLock() {
    this.canvas.requestPointerLock?.();
  }

  requestStartGame() {
    this.post({ type: 'startgame' });
  }

  /** 切换瞄准镜显示/隐藏（鼠标中键）。 */
  toggleScope() {
    this.aiming = !this.aiming;
    this.updateScopeUI();
  }

  /** 同步瞄准镜 UI：遮罩/十字线的显隐 + 放大倍数读数。 */
  updateScopeUI() {
    const scope = this.hud.el.scope;
    if (!scope) return;
    scope.classList.toggle('show', this.aiming);
    // 瞄准镜开启时隐藏普通准星（由镜内十字线取代）
    if (this.hud.el.cross) this.hud.el.cross.style.display = this.aiming ? 'none' : '';
    if (this.aiming) this.hud.el.scopeZoom.textContent = this.zoom.toFixed(1) + '×';
  }

  /** 彩蛋模式：无限弹药 + 无需换弹 + 敌人数量翻倍。 */
  /** FIRE 彩蛋：翻转式（再次输入关闭）。激活/关闭均有白闪 + 消息反馈，
   *  避免已激活时二次输入被静默吞掉而显得"没响应"。 */
  activateEasterEgg() {
    this.easterEgg = !this.easterEgg;
    const on = this.easterEgg;
    this.invincible = on;                            // 无敌：受到攻击不掉血
    this.weapons.infiniteAmmo = on;
    if (this.enemies) this.enemies.spawnMultiplier = on ? 2 : 1;
    this.hud.pushFeed(on ? '★ FIRE 彩蛋：无限弹药 · 敌人翻倍 · 无敌' : 'FIRE 彩蛋已关闭');
    this.postFx.flash = on ? 0.55 : 0.15;            // 白闪：即时可感知的反馈
    this.post({ type: 'easter' });
  }

  /** TNT 彩蛋：切换"枪射出 TNT 方块"模式。 */
  activateTnt() {
    this.tntMode = !this.tntMode;
    this.hud.pushFeed(this.tntMode ? '★ TNT 彩蛋：枪枪爆 TNT！' : 'TNT 彩蛋已关闭');
  }

  /** FREEZE 彩蛋：翻转"全场敌人原地不动"（再次输入解除）。 */
  activateFreeze() {
    if (!this.enemies) return;
    this.enemies.frozen = !this.enemies.frozen;
    this.hud.pushFeed(this.enemies.frozen ? '★ FREEZE 彩蛋：敌人全部冻结！' : 'FREEZE 解除：敌人恢复行动');
  }

  /* ============================================================ 末影龙彩蛋 */

  /** 触发末影龙：在高空生成，绕玩家盘旋。 */
  spawnDragon() {
    if (this.dragon || this.mode !== 'game' || !this.player.alive) return;
    const e = this.player.eye;
    this.dragon = {
      x: e[0], y: e[1] + 15, z: e[2] - 10,
      vx: 0, vy: 0, vz: 0,
      yaw: 0,
      health: 1500, maxHealth: 1500,   // 血条加长，便于瞄准射击
      angle: 0, radius: 10, height: 14,
      flameTimer: 2, dying: 0,
    };
    this.hud.pushFeed('★ DRAGON 彩蛋：末影龙降临！');
  }

  /** 龙的平滑移动（向目标点逼近）。 */
  dragonMove(d, tx, ty, tz, dt, speed) {
    const dx = tx - d.x, dy = ty - d.y, dz = tz - d.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const sp = Math.min(speed, dist / Math.max(dt, 1e-4) * 0.25);
    d.vx = (dx / dist) * sp;
    d.vy = (dy / dist) * sp;
    d.vz = (dz / dist) * sp;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
  }

  /** 龙喷火：壮丽的火焰（外焰 + 白炽核心 + 火花）+ 范围伤害。 */
  dragonFlame(d) {
    const p = this.player;
    // 火焰从龙头喷出（龙头在 yaw 方向前方），而非身体中心
    const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw);
    const mx = d.x + fx * 2.5, my = d.y + 0.1, mz = d.z + fz * 2.5;
    const dx = p.eye[0] - mx, dy = p.eye[1] - my, dz = p.eye[2] - mz;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const nx = dx / dist, ny = dy / dist, nz = dz / dist;
    // 三层华丽火焰：
    // 第一层：外焰（橙红，大且散，形成巨大火舌）
    for (let i = 0; i < 16; i++) {
      this.particles.spawn({
        x: mx, y: my, z: mz,
        vx: nx * (7 + Math.random() * 6) + (Math.random() - 0.5) * 3.5,
        vy: ny * (7 + Math.random() * 6) + (Math.random() - 0.5) * 3.5,
        vz: nz * (7 + Math.random() * 6) + (Math.random() - 0.5) * 3.5,
        life: 0.4 + Math.random() * 0.25, size: 0.5, size1: 1.2,
        color: [1, 0.35, 0.08], alpha: 0.9,
        kind: 1, additive: true, drag: 0.9,
      });
    }
    // 第二层：中层火焰（金黄，中）
    for (let i = 0; i < 10; i++) {
      this.particles.spawn({
        x: mx, y: my, z: mz,
        vx: nx * (9 + Math.random() * 4) + (Math.random() - 0.5) * 2,
        vy: ny * (9 + Math.random() * 4) + (Math.random() - 0.5) * 2,
        vz: nz * (9 + Math.random() * 4) + (Math.random() - 0.5) * 2,
        life: 0.3 + Math.random() * 0.15, size: 0.35, size1: 0.8,
        color: [1, 0.65, 0.15], alpha: 0.95,
        kind: 1, additive: true, drag: 0.88,
      });
    }
    // 第三层：核心（白炽，小且快）
    for (let i = 0; i < 8; i++) {
      this.particles.spawn({
        x: mx, y: my, z: mz,
        vx: nx * (11 + Math.random() * 3) + (Math.random() - 0.5) * 1.2,
        vy: ny * (11 + Math.random() * 3) + (Math.random() - 0.5) * 1.2,
        vz: nz * (11 + Math.random() * 3) + (Math.random() - 0.5) * 1.2,
        life: 0.18 + Math.random() * 0.1, size: 0.22, size1: 0.5,
        color: [1, 0.92, 0.6], alpha: 1,
        kind: 1, additive: true, drag: 0.85,
      });
    }
    if (dist < 10) this.onPlayerHit(6, null);
  }

  /** 龙死亡散裂：大量四散的黑色小方块。 */
  dragonShatter(x, y, z) {
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * TAU;
      const sp = 2 + Math.random() * 9;
      this.debris.push({
        x, y, z,
        vx: Math.cos(a) * sp, vy: 2 + Math.random() * 7, vz: Math.sin(a) * sp,
        size: 0.18 + Math.random() * 0.3,
        life: 0.8 + Math.random() * 0.9,
        color: [0.1, 0.08, 0.13],   // 末影龙黑
        rx: Math.random() * TAU, ry: Math.random() * TAU, rz: Math.random() * TAU,
        spinX: (Math.random() - 0.5) * 9, spinY: (Math.random() - 0.5) * 9, spinZ: (Math.random() - 0.5) * 9,
      });
    }
  }

  /** 龙的 AI：空中盘旋 + 每隔几秒自动喷火；死亡坠落 + 散裂。 */
  updateDragon(dt) {
    const d = this.dragon;
    // 龙血条 HUD（无论龙是否存在都同步显隐）
    if (this.hud.el.dragonBar) {
      const show = !!d;
      this.hud.el.dragonBar.classList.toggle('show', show);
      this.hud.el.dragonName.classList.toggle('show', show);
      if (show) this.hud.el.dragonFill.style.width = (d.health / d.maxHealth * 100) + '%';
    }
    if (!d) return;
    const p = this.player;

    if (d.dying > 0) {
      d.vy -= 30 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.dying += dt;
      if (d.y <= 0.3) {
        this.dragonShatter(d.x, 0.3, d.z);
        this.cameraShake = (this.cameraShake || 0) + 2.0;
        this.hud.pushFeed('末影龙已坠落！');
        this.dragon = null;
      }
      return;
    }

    // 只盘旋（不俯冲）：慢速绕圈，时而飞远时而飞近
    d.angle += dt * 0.35;
    const rVar = d.radius + Math.sin(this.time * 0.4) * 3;
    const hVar = d.height + Math.sin(this.time * 0.3) * 2;
    this.dragonMove(d, p.eye[0] + Math.cos(d.angle) * rVar, p.pos[1] + hVar,
      p.eye[2] + Math.sin(d.angle) * rVar, dt, 6);

    // 每隔几秒自动喷火（三层华丽火焰）
    d.flameTimer -= dt;
    if (d.flameTimer <= 0) {
      d.flameTimer = 3 + Math.random() * 2;   // 每 3~5 秒喷一次
      this.dragonFlame(d);
    }

    d.yaw = Math.atan2(p.eye[0] - d.x, p.eye[2] - d.z);
  }

  /** 玩家子弹命中龙判定：返回命中距离，未命中 -1。 */
  raycastDragon(ro, rd) {
    const d = this.dragon;
    if (!d || d.dying > 0) return -1;
    // 龙身大 AABB（长 5 × 高 2 × 宽 3，中心在龙位置）
    const min = [d.x - 2.5, d.y - 1, d.z - 1.5];
    const max = [d.x + 2.5, d.y + 1, d.z + 1.5];
    const t = rayAabb(ro, rd, min, max);
    return t;
  }

  onEscape() {
    const now = performance.now();
    // 双击检测：两次 ESC 间隔 < 500ms → 退出整个程序（宿主收到 quit）
    if (this.lastEscTime && now - this.lastEscTime < 500) {
      this.post({ type: 'quit' });
      this.lastEscTime = 0;   // 重置，避免连按持续触发
      return;
    }
    this.lastEscTime = now;
    // 单击 ESC：游戏态退出游戏态（回到壁纸）；壁纸态不动作
    if (this.mode === 'game') {
      this.post({ type: 'endgame' });
    }
  }

  post(msg) {
    if (window.chrome?.webview) {
      // 必须传对象，不能传 JSON.stringify 的字符串：
      // WebView2 会把字符串再 JSON 编码一层（WebMessageAsJson 带外层引号），
      // 宿主 JsonDocument.Parse 得到的是 string 而非 object，
      // TryGetProperty("type") 永远失败 —— ready/fps/scene/startgame 全部被静默丢弃。
      // 真机表现：壁纸 ready 8 秒超时、fps 恒 0、场景名恒空（日志 00:57 实测）。
      // GhibliMeadow 传对象 postMessage({ type:'ready' }) 所以能工作。
      window.chrome.webview.postMessage(msg);
    } else {
      console.log('[host]', JSON.stringify(msg));
    }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.();
  }

  setupResize() {
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(320, Math.floor(window.innerWidth * dpr * this.pixelScale));
      const h = Math.max(240, Math.floor(window.innerHeight * dpr * this.pixelScale));
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.renderer.resize(w, h, 1);
    };
    window.addEventListener('resize', resize);
    resize();
  }

  /* ================================================================ 场景 */

  loadScene(index) {
    this.renderer.clearBatches();
    this.renderer.clearDecals();
    this.particles.clear();

    const def = SCENES[index];
    const seed = 0x9E37 + index * 7919;
    this.scene = buildScene(this.renderer, this.textures, def, seed);
    this.sceneDef = def;
    this.props = this.scene.props;
    this.builtBlocks.length = 0;       // 换场景清空建造方块（碰撞盒随旧 scene 释放）
    this.builtBatch.list.length = 0;   // 同步清空静态渲染批

    // 天气随机搭配（受室内外限制）
    const wkey = pickWeather(def, makeRng(seed ^ 0x5A5A));
    this.weather = WEATHERS[wkey];
    this.weatherFx.setWeather(this.weather);
    this.renderer.setSkyTexture(buildSky(this.renderer.gl, G.textureFromImage, this.skyCache, this.weather));

    this.enemies = new EnemyManager(this.scene, this.particles, makeRng(seed ^ 0x1234));
    this.enemies.kills = this.carryKills || 0;

    const sp = def.spawnPlayer;
    this.player.spawnAt(sp[0], sp[1] - this.player.eyeHeight, sp[2], Math.PI);

    this.tracers.length = 0;
    this.projectiles.length = 0;
    this.impacts.length = 0;
    for (const k of WEAPON_ORDER) this.weapons.ammo[k] = WEAPONS[k].magazine;

    this.applyWeatherToEnv();
    this.postFx.exposure = this.weather.exposure;

    this.sceneIndex = index;
    if (this.mode === 'game') {
      this.hud.el.sceneName.textContent = def.name;
    }
    this.post({ type: 'scene', name: def.name });
  }

  /**
   * 把当前天气写进环境光照参数。
   * 抽成方法是为了支持"不换场景只换天气"（调试与截图核对都要用）。
   */
  applyWeatherToEnv() {
    const def = this.sceneDef;
    if (!def || !this.weather) return;
    // 室内压暗环境光、提高雾密度，让"室内"读得出来
    const bias = def.lightBias ?? 1;
    this.env = {
      sunDir: sunDirection(this.weather.sunElev, this.rng),
      sunColor: mul(this.weather.sunColor, def.indoor ? 0.45 : 1.0),
      ambientSky: mul(this.weather.ambientSky, bias),
      ambientGround: mul(this.weather.ambientGround, bias),
      // 天气表里的颜色是 0~255 的书写形式（便于人眼调参），
      // 必须归一化到 0~1：着色器里 fogColor 直接参与 mix()/clearColor，
      // 传 [176,190,200] 会让雾色远超 1.0，把整个画面钳成白色 —— 实测 8 个场景
      // 直方图全部挤在 153~211、暗部为零，看起来"一片发白"。
      fogColor: this.weather.fogColor.map(c => c / 255),
      // fogVisibility(米) -> shader 衰减系数。fogFalloff = fogScale / vis。
      // fogScale 是「雾浓度倍率」（>1 更浓，室内常用 1.6~1.9）：
      // 浓度倍率越大 -> 可视距离越短 -> 衰减系数越大，所以是相乘。
      fogFalloff: (def.fogScale ?? 1) / Math.max(this.weather.fogVisibility, 1),
      wind: [this.weather.windStrength * 2, 0, this.weather.windStrength * 1.4],
    };
  }

  /** 只换天气，不换场景。返回实际生效的天气 key。 */
  setWeather(key) {
    const w = WEATHERS[key];
    if (!w) throw new Error('未知天气: ' + key);
    this.weather = w;
    this.weatherFx.setWeather(w);
    this.renderer.setSkyTexture(buildSky(this.renderer.gl, G.textureFromImage, this.skyCache, w));
    this.applyWeatherToEnv();
    this.postFx.exposure = w.exposure;
    return w.key;
  }

  /* ================================================================ 开火 */

  tryFire(isDown) {
    if (this.mode !== 'game' || this.transitioning || !this.player.alive) return;
    const w = this.weapons.current;

    // 单发武器：必须"按下瞬间"才发射，不能靠按住
    if (!w.auto && !isDown) return;

    const shot = this.weapons.fire();
    if (!shot) return;

    const eye = this.player.eye;
    // 射击方向 = forward(pitch + recoil, yaw + recoil)，与渲染视线完全一致。
    // 旧版用 applyRecoil(forward, rp, ry) 叠加，但绕 X/Y 轴旋转不交换，
    // 与渲染视线的「直接加角度」不等价（实测最大偏差 0.111 弧度 ≈ 6°），
    // 这正是"火光连线低于准星约 3cm/100~200 像素"的根因。
    const rp = this.weapons.recoilPitch * (Math.PI / 180) * 0.55;
    const ry = this.weapons.recoilYaw * (Math.PI / 180);
    const ap = this.player.pitch + rp;
    const ay = this.player.yaw + ry;
    const cp = Math.cos(ap), sp = Math.sin(ap);
    const baseDir = [-Math.sin(ay) * cp, sp, -Math.cos(ay) * cp];

    const spread = this.weapons.currentSpread(this.player.moveSpeed);
    const muzzle = this.muzzlePosition();

    if (this.tntMode) {
      // TNT 彩蛋：任何枪都射出 TNT 方块
      this.fireTnt(muzzle, baseDir);
    } else if (w.ammoType === 'flame') {
      // 喷火器：点燃火龙（体素流），附带锥形灼烧伤害
      this.fireFlame(muzzle, baseDir, w);
    } else if (w.ammoType === 'grenade') {
      this.throwGrenade(muzzle, baseDir, w);
    } else if (w.ammoType === 'rocket') {
      this.fireRocket(muzzle, baseDir, w);
    } else if (w.ammoType === 'block') {
      this.throwBlock(muzzle, baseDir, w);
    } else {
      this.fireHitscan(muzzle, baseDir, spread, w);
    }

    // 自动武器按住时持续射击，由主循环按冷却续射
  }

  muzzlePosition() {
    const eye = this.player.eye;
    const right = this.player.right;
    const f = this.player.forward;
    // 枪口世界坐标：前方 0.45m + 下方 0.32m + 右 0.27m，与 viewmodel 的 baseX/baseY/baseZ
    // （right*0.27 + forward*0.40，下方 0.31）一致。y 用**固定** -0.32，不再叠加
    // forward[1]（旧版 y 随 pitch 漂移，朝下看枪口反而更低，瞄准线起点与枪管视觉脱节）。
    const fh = Math.hypot(f[0], f[2]) || 1;   // 水平投影长度，避免朝正上/正下时前向量退化
    return [
      eye[0] + right[0] * 0.27 + (f[0] / fh) * 0.45,
      eye[1] - 0.32,
      eye[2] + right[2] * 0.27 + (f[2] / fh) * 0.45,
    ];
  }

  fireHitscan(origin, dir, spread, w) {
    let anyHit = false;
    let anyKill = false;
    let anyHead = false;
    // 命中判定从 eye（相机中心）沿准星方向，与屏幕中心准星**完全一致**；
    // 火光（红色弹道线）从 muzzle（origin）沿同一方向，只作视觉。
    // 旧版命中从 muzzle 出发 + jitterDir(spread) 散布，伤害跟着火光走、
    // 不跟准星走 —— 出现"准星没对准却打中 / 准星对准却打不中"。
    const eye = this.player.eye;

    for (let p = 0; p < w.pellets; p++) {
      // 单弹丸武器精确沿准星（无散布）；霰弹枪多弹丸以准星为中心扇形散布
      const d = w.pellets > 1 ? jitterDir(dir, spread) : [...dir];
      // 先测敌人，再测场景：取更近的那个
      const e = this.enemies.raycast(eye, d);
      const wallT = this.raycastScene(eye, d, 200);
      // 末影龙命中（优先于敌人和墙：龙在空中不会被墙挡）
      const dragT = this.raycastDragon(eye, d);
      if (dragT >= 0 && (e.t < 0 || dragT < e.t) && (wallT < 0 || dragT < wallT)) {
        this.dragon.health -= w.damage;
        anyHit = true;
        const dhx = eye[0] + d[0] * dragT, dhy = eye[1] + d[1] * dragT, dhz = eye[2] + d[2] * dragT;
        this.particles.impact(dhx, dhy, dhz, -d[0], -d[1], -d[2], 'concrete');
        if (this.dragon.health <= 0) {
          this.dragon.health = 0;
          this.dragon.dying = 0.01;   // 血条耗尽：开始坠落
        }
      } else if (e.t >= 0 && (wallT < 0 || e.t < wallT)) {
        const killed = e.enemy.applyDamage(w.damage, d[0], d[2], e.headshot);
        const hx = eye[0] + d[0] * e.t;
        const hy = eye[1] + d[1] * e.t;
        const hz = eye[2] + d[2] * e.t;
        this.particles.blood(hx, hy, hz, d[0], d[1], d[2]);
        if (killed) {
          anyKill = true;
          this.onKill(e.enemy, e.headshot);
        }
        anyHit = true;
        anyHead = anyHead || e.headshot;
        this.renderer.addDecal('blood',
          [hx, hy, hz],
          [-d[2], 0, d[0]],
          [0, 1, 0], 0.55, [0.6, 0.1, 0.1]);
      } else if (wallT >= 0) {
        const hx = eye[0] + d[0] * wallT;
        const hy = eye[1] + d[1] * wallT;
        const hz = eye[2] + d[2] * wallT;
        this.particles.impact(hx, hy, hz, -d[0], -d[1], -d[2], 'concrete');
        this.renderer.addDecal('hole', [hx + d[0] * 0.01, hy + d[1] * 0.01, hz + d[2] * 0.01],
          [-d[2], 0, d[0]],
          crossWith([-d[2], 0, d[0]], d) , 0.13, [1, 1, 1]);
        anyHit = true;
      }

      // 开火火光：从枪口（muzzle）精确连到命中点（eye + d*hitT，投影即准星中心）。
      // 火光终点必须落在准星交叉点，不能用 muzzle + d*len —— 那与命中判定 eye+d*t
      // 差一个 muzzle 偏移，火光终点在屏幕上会偏离准星。
      if (w.tracerEvery > 0 && p === 0) {
        const hitT = Math.min((wallT >= 0 && (e.t < 0 || wallT < e.t)) ? wallT : Math.max(e.t, 8), 40);
        const hx = eye[0] + d[0] * hitT;
        const hy = eye[1] + d[1] * hitT;
        const hz = eye[2] + d[2] * hitT;
        const fx = hx - origin[0], fy = hy - origin[1], fz = hz - origin[2];
        const flen = Math.hypot(fx, fy, fz) || 1;
        this.tracers.push({
          x: origin[0], y: origin[1], z: origin[2],
          dx: fx / flen, dy: fy / flen, dz: fz / flen,
          len: flen, life: 0.08, maxLife: 0.08,
        });
      }
    }
    this.shotIndex = (this.shotIndex || 0) + 1;

    if (w.muzzleScale > 0) {
      this.particles.muzzleFlash(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], w.muzzleScale);
    }
    // 抛壳方向：右上方，且必须打向相机后方（否则壳会飞进视野正中）
    const r = this.player.right;
    this.particles.shell(origin[0], origin[1], origin[2],
      -this.player.forward[0] * 0.5 + r[0] * 0.9,
      0.8,
      -this.player.forward[2] * 0.5 + r[2] * 0.9);

    // 视角冲击
    this.cameraShake = (this.cameraShake || 0) + w.recoil.kick * 0.12;
    this.postFx.aberration = Math.min(1.6, this.postFx.aberration + 0.25);

    if (anyHit) { this.hud.hitMarker(anyHead); if (anyHead) this.hud.pushFeed('HEADSHOT', true); }
  }

  throwGrenade(origin, dir, w) {
    this.projectiles.push({
      kind: 'grenade', w,
      x: origin[0], y: origin[1], z: origin[2],
      vx: dir[0] * w.throwSpeed, vy: dir[1] * w.throwSpeed + 2.2, vz: dir[2] * w.throwSpeed,
      fuse: w.fuse, bounces: 0, spin: [8, 6, 5], rot: [0, 0, 0], dead: false,
    });
    this.particles.muzzleFlash(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], 0.5);
  }

  /** 建造枪：抛出一枚方块（带重力弧线），落地后在原地生成 1×1×1 实体方块。
   *  朝上抛射可落在头顶/高处方块顶面，实现向上叠高。 */
  throwBlock(origin, dir, w) {
    this.projectiles.push({
      kind: 'block', w,
      x: origin[0], y: origin[1], z: origin[2],
      vx: dir[0] * w.throwSpeed, vy: dir[1] * w.throwSpeed + 1.2, vz: dir[2] * w.throwSpeed,
      fuse: 4.0, bounces: 0, spin: [0, 0, 0], rot: [0, 0, 0], dead: false,
    });
    this.particles.muzzleFlash(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], 0.4);
  }

  /** 在 (x, floorY, z) 放置一格实体方块：渲染体素 + 碰撞盒（玩家/敌人可踩踏）。
   *  落点与玩家/敌人重叠时不再垫层（会把人嵌进方块），而是直接把人顶到方块顶面。 */
  placeBlock(x, floorY, z) {
    if (this.builtBlocks.length >= 200) this.builtBlocks.shift();   // 上限 200 块
    const gx = Math.floor(x) + 0.5, gz = Math.floor(z) + 0.5;
    let gy = floorY;
    // 顶起重叠的单位：水平范围盖住且身体纵向与 [gy, gy+1] 相交 → 站到方块顶上
    const lift = (pos, feet, height, radius) => {
      if (Math.abs(gx - pos[0]) < 0.5 + radius && Math.abs(gz - pos[2]) < 0.5 + radius &&
          feet < gy + 1 && feet + height > gy) {
        pos[1] = gy + 1;
        return true;
      }
      return false;
    };
    const pP = this.player.pos;
    if (lift(pP, pP[1], 1.85, 0.42)) { this.player.vy = Math.max(this.player.vy, 0); }
    for (const e of this.enemies.list) {
      if (!e.alive) continue;
      if (lift(e, e.y, e.def.height, e.def.radius)) { e.vy = Math.max(e.vy, 0); e.onGround = true; }
    }
    this.builtBlocks.push({ x: gx, y: gy + 0.5, z: gz });
    // 静态批实例 + 碰撞盒引用（batch/idx）：让爆炸破坏逻辑能隐藏实例并移除碰撞盒
    const mat = new Float32Array(16);
    mat[0] = 1; mat[5] = 1; mat[10] = 1; mat[15] = 1;
    mat[12] = gx; mat[13] = gy + 0.5; mat[14] = gz;
    this.builtBatch.list.push({
      mat, color: [0.72, 0.56, 0.34], rough: 0.7, emissive: 0, caster: true,
    });
    this.scene.obstacles.push({
      min: [gx - 0.5, gy, gz - 0.5], max: [gx + 0.5, gy + 1, gz + 0.5],
      batch: this.builtBatch, idx: this.builtBatch.list.length - 1,
    });
    this.particles.impact(gx, gy + 0.5, gz, 0, 1, 0, 'dirt');
  }

  /** 喷火器：点燃火龙（体素流渲染 300 体素），并对锥形近距敌人灼烧。 */
  fireFlame(origin, dir, w) {
    // 激活/刷新火龙窗口（auto 武器按住时每次 tick 刷新，松开 0.25s 后熄灭）
    this.flameJet = { t: 0.25 };
    // 锥形灼烧：距玩家 <6.5m、与准星夹角小（点积高）的敌人受到伤害
    for (const e of this.enemies.list) {
      if (!e.alive) continue;
      const dx = e.x - origin[0], dz = e.z - origin[2];
      const dist = Math.hypot(dx, dz, (e.y + e.def.height * 0.5) - origin[1]);
      if (dist > 6.5) continue;
      const dot = (dx / Math.max(dist, 0.01)) * dir[0] + (dz / Math.max(dist, 0.01)) * dir[2];
      if (dot > 0.82) {
        const killed = e.applyDamage(w.damage, dx / Math.max(dist, 0.01), dz / Math.max(dist, 0.01), false);
        if (killed) this.onKill(e, false);
      }
    }
  }

  /** TNT 彩蛋：射出 TNT 方块（直线飞行，接触即炸）。 */
  fireTnt(origin, dir) {
    // 俯角射击（向下攻击）：从眼睛沿准星方向发射，避免弹道撞上自家平台边缘
    const downward = dir[1] < -0.12;
    const d = downward ? dir : this.aimFromMuzzle(origin, dir);
    const eye = this.player.eye;
    const start = downward
      ? [eye[0] + dir[0] * 0.3, eye[1] + dir[1] * 0.3, eye[2] + dir[2] * 0.3]
      : origin;
    this.projectiles.push({
      kind: 'tnt',
      w: { kind: 'grenade', explosionScale: 1.3, radius: 7, damage: 160, falloff: 0.4, bounce: 0.25, friction: 0.8 },
      x: start[0], y: start[1], z: start[2],
      vx: d[0] * 16, vy: d[1] * 16, vz: d[2] * 16,   // 直线：无上抛分量
      fuse: 2.0, bounces: 0, spin: [3, 5, 2], rot: [0, 0, 0], dead: false,
    });
    this.particles.muzzleFlash(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], 0.5);
  }

  /** 准心对齐：命中点取准星射线上的目标（场景命中或 120m 远点），
   *  弹道从枪口射向该点 —— 火箭/TNT 在目标距离处恰好穿过准星位置。 */
  aimFromMuzzle(origin, dir) {
    const eye = this.player.eye;
    const t = this.raycastScene(eye, dir, 200);
    const target = t > 0 ? t : 120;
    const ax = eye[0] + dir[0] * target - origin[0];
    const ay = eye[1] + dir[1] * target - origin[1];
    const az = eye[2] + dir[2] * target - origin[2];
    const len = Math.hypot(ax, ay, az) || 1;
    return [ax / len, ay / len, az / len];
  }

  fireRocket(origin, dir, w) {
    // 俯角射击（向下攻击，如高塔上向下轰）：从眼睛沿准星方向发射——
    // 枪口校正的弹道起点低 0.3m、全程低于准星射线，会撞上自家平台边缘
    // 导致"无法向下射击"；准星射线本身越过平台边缘，精确命中准星指向的塔下目标。
    const downward = dir[1] < -0.12;
    const d = downward ? dir : this.aimFromMuzzle(origin, dir);
    const eye = this.player.eye;
    const start = downward
      ? [eye[0] + dir[0] * 0.3, eye[1] + dir[1] * 0.3, eye[2] + dir[2] * 0.3]
      : origin;
    this.projectiles.push({
      kind: 'rocket', w,
      x: start[0], y: start[1], z: start[2],
      vx: d[0] * w.rocketSpeed, vy: d[1] * w.rocketSpeed, vz: d[2] * w.rocketSpeed,
      fuse: 6.0, bounces: 0, spin: [0, 0, 0], rot: [0, 0, 0], dead: false,
      age: 0,   // 发射后飞行时间：飞离枪口 2m 内不判碰撞，避免枪口处立即爆炸
    });
    // 发射时的巨大后坐 + 烟
    for (let i = 0; i < 22; i++) {
      this.particles.spawn({
        x: origin[0], y: origin[1], z: origin[2],
        vx: -dir[0] * (4 + Math.random() * 9) + (Math.random() - 0.5) * 3,
        vy: -dir[1] * (4 + Math.random() * 9) + Math.random() * 2,
        vz: -dir[2] * (4 + Math.random() * 9) + (Math.random() - 0.5) * 3,
        life: 0.5 + Math.random() * 0.5,
        size: 0.4, size1: 1.6,
        color: [0.5, 0.48, 0.45], alpha: 0.5,
        kind: 0, additive: false, drag: 0.93, rotV: (Math.random() - 0.5) * 3,
      });
    }
    this.particles.muzzleFlash(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], w.muzzleScale);
    this.cameraShake = (this.cameraShake || 0) + 1.6;
    this.postFx.aberration = 1.6;
  }

  cycleWeapon(dir) {
    if (this.mode !== 'game' || this.transitioning) return;
    const k = this.weapons.cycle(dir);
    if (k && this.mode === 'game') {
      this.hud.pushFeed('▸ ' + WEAPONS[k].name);
    }
  }

  /** 快捷栏：数字键直选。1~6 切武器，7~0 触发/翻转彩蛋。 */
  onQuickBar(n) {
    if (this.mode !== 'game' || this.transitioning) return;
    if (n >= 1 && n <= 6) {
      const k = this.weapons.select(n - 1);
      if (k) this.hud.pushFeed('▸ ' + WEAPONS[k].name);
      return;
    }
    if (n === 7) this.activateEasterEgg();
    else if (n === 8) this.activateTnt();
    else if (n === 9) this.activateFreeze();
    else if (n === 0) this.toggleDragon();
  }

  /** DRAGON 彩蛋：翻转式——无龙时召唤，有龙时驱散。 */
  toggleDragon() {
    if (this.dragon) {
      this.dragon.dying = Math.max(this.dragon.dying || 0, 0.01);
      this.hud.pushFeed('DRAGON 彩蛋：巨龙已被驱散');
    } else {
      this.spawnDragon();
    }
  }

  /** 射线 vs 场景碰撞盒。返回最近距离，未命中 -1。 */
  raycastScene(origin, dir, maxDist) {
    let best = -1;
    for (const o of this.scene.obstacles) {
      const t = rayAabb(origin, dir, o.min, o.max);
      if (t >= 0 && t < maxDist && (best < 0 || t < best)) best = t;
    }
    // 地面基准面 y=0：平地草方块（h=0）不加入 obstacles（否则 2400+ 障碍拖垮射线检测），
    // 但子弹朝下必须能命中地面，否则"对准地上打不到地上"（实测根因）。
    // 山丘（h>0）在 obstacles 里，会优先命中其顶面。
    if (dir[1] < 0) {
      const t = (0 - origin[1]) / dir[1];
      if (t >= 0 && t < maxDist && (best < 0 || t < best)) best = t;
    }
    return best;
  }

  onKill(enemy, headshot) {
    // 记录本次击杀前的计数：范围伤害一帧杀多个时 kills 会跳跃（如 28→31），
    // 旧写法 `kills % goal === 0` 会恰好跳过 30 这个触发点，导致永远无法晋级。
    const prev = this.enemies.kills;
    this.enemies.registerKill(enemy);
    this.carryKills = this.enemies.kills;
    if (this.mode === 'game') {
      this.hud.pushFeed(`${headshot ? '✦ ' : ''}击杀 ${enemy.def.name}`, headshot);
    }
    // 击杀达标 -> 触发过场切场景（跨越倍数检测，正确处理一击多杀的跳跃）
    const goal = this.killGoal;
    if (goal > 0 && Math.floor(prev / goal) < Math.floor(this.enemies.kills / goal)) {
      this.beginSceneTransition();
    }
  }

  async beginSceneTransition() {
    if (this.transitioning) return;
    this.transitioning = true;
    const next = nextScene(this.sceneIndex);
    const def = SCENES[next];

    await this.hud.playTransition(
      'STAGE CLEAR',
      `${def.en}`,
      () => {
        // 换场景时重置本局击杀计数（"下一场景"重新开始计）
        this.carryKills = 0;
        this.loadScene(next);
        // 过场里让新场景先渲染一帧，避免揭幕时是空的
        this.renderFrame(0);
      }
    );
    this.transitioning = false;
    this.requestLock();
  }

  onPlayerHit(dmg, enemy, noShake) {
    if (!this.player.alive) return;
    if (this.invincible) return;   // FIRE 彩蛋：无敌，受到攻击不掉血
    const died = this.player.takeDamage(dmg);
    if (!noShake) {
      this.postFx.damage = Math.min(1, this.postFx.damage + 0.5);
      this.cameraShake = (this.cameraShake || 0) + 0.8;
    }
    if (died) this.onPlayerDeath();
  }

  onPlayerDeath() {
    this.deathTimer = 3.0;
    if (this.mode === 'game') this.hud.pushFeed('YOU DIED');
  }

  respawn() {
    const sp = this.sceneDef.spawnPlayer;
    this.player.spawnAt(sp[0], sp[1] - this.player.eyeHeight, sp[2], Math.PI);
    this.deathTimer = 0;
    this.postFx.damage = 0;
  }

  /* ================================================================ 更新 */

  update(dt) {
    this.time += dt;

    // 武器冷却与后坐回正
    this.weapons.tick(dt);

    // 自动武器持续射击
    if (this.fireHeld && this.mode === 'game' && this.weapons.current.auto && this.weapons.canFire()) {
      this.tryFire(false);
    }

    // 玩家
    this.player.update(dt, this.input, this.scene.obstacles, this.weapons, this.scene.bounds, this.scene.ladders);

    // 死亡重生
    if (!this.player.alive) {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) this.respawn();
    }

    // 敌人生成与 AI
    this.enemies.update(
      dt, this.player, this.scene.obstacles,
      (e, head) => this.onKill(e, head),
      (dmg, e) => this.onPlayerHit(dmg, e)
    );

    // 投射物
    this.updateProjectiles(dt);

    // 末影龙
    this.updateDragon(dt);

    // 喷火器火龙窗口递减（松开扳机 0.25s 后熄灭）
    if (this.flameJet) {
      this.flameJet.t -= dt;
      if (this.flameJet.t <= 0) this.flameJet = null;
    }

    // 曳光弹
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      this.tracers[i].life -= dt;
      if (this.tracers[i].life <= 0) this.tracers.splice(i, 1);
    }

    // 爆炸碎片（像素方块）：重力下落 + 旋转 + 地面弹跳 + 生命周期
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.vy -= 19.6 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      d.rx += d.spinX * dt;
      d.ry += d.spinY * dt;
      d.rz += d.spinZ * dt;
      if (d.y < d.size && d.vy < 0) { d.y = d.size; d.vy *= -0.35; d.vx *= 0.7; d.vz *= 0.7; }
      d.life -= dt;
      if (d.life <= 0) this.debris.splice(i, 1);
    }

    // 天气 + 粒子
    this.weatherFx.update(dt, this.player.eye, this.env.wind);
    this.particles.update(dt, this.env.wind);

    // 场景 prop 动画
    this.updateProps(dt);

    // 后处理衰减
    this.postFx.aberration = Math.max(0, this.postFx.aberration - dt * 3.2);
    this.postFx.damage = Math.max(0, this.postFx.damage - dt * 1.4);
    if (this.cameraShake) this.cameraShake = Math.max(0, this.cameraShake - dt * 5.5);

    // HUD
    if (this.mode === 'game') {
      const w = this.weapons.current;
      this.hud.update({
        kills: this.enemies.kills,
        killGoal: this.killGoal,
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        weapon: w.name,
        weaponKey: w.key,
        ammo: this.weapons.ammo[w.key],
        mag: w.magazine,
        ammoAll: this.weapons.ammo,
        reloading: this.weapons.reloading,
        sceneName: this.sceneDef.name,
        stageIndex: this.sceneIndex,
        stageTotal: SCENES.length,
        spread: this.weapons.currentSpread(this.player.moveSpeed) / w.spread,
        alive: this.player.alive,
        eggs: {
          fire: this.easterEgg,
          tnt: this.tntMode,
          freeze: this.enemies?.frozen || false,
          dragon: !!this.dragon,
        },
      });
    }
  }

  /** 火箭体素尾迹：记录历史位置（渲染层画成小方块烟迹，粒子路线已废弃）。 */
  pushRocketTrail(p) {
    if (!p.trail) p.trail = [];
    p.trail.push({ x: p.x, y: p.y, z: p.z });
    if (p.trail.length > 24) p.trail.shift();   // 24 点 ≈ 13m 尾迹
  }

  updateProjectiles(dt) {
    const obstacles = this.scene.obstacles;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const w = p.w;

      if (p.kind === 'rocket' || p.kind === 'tnt') {
        // 火箭 / TNT：直线飞行（无重力，沿发射方向匀速推进）
        p.age = (p.age || 0) + dt;
      } else {
        // 手榴弹 / 建造方块：重力 + 弹跳 + 摩擦
        p.vy -= 19.6 * dt;
      }

      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      const nz = p.z + p.vz * dt;

      p.rot[0] += p.spin[0] * dt;
      p.rot[1] += p.spin[1] * dt;
      p.rot[2] += p.spin[2] * dt;

      /* ---- 撞击判定 ---- */
      // 火箭/TNT 飞离枪口 10m 内不判碰撞：近距离的敌人/掩体/地面一律穿过，
      // 确保炮弹飞行一段可感知的距离后才可能引爆（用户反馈"出膛即爆"）。
      // 10m 内命中目标靠爆炸溅射（火箭半径 6.9m / TNT 半径 8m）覆盖。
      const guard = 10 / Math.max(w.rocketSpeed || 16, 1);
      if ((p.kind === 'rocket' || p.kind === 'tnt') && (p.age || 0) < guard) {
        p.x = nx; p.y = ny; p.z = nz;
        if (p.kind === 'rocket') this.pushRocketTrail(p);   // 体素尾迹：记录历史点
        continue;
      }
      const speed = Math.hypot(p.vx, p.vy, p.vz);

      // 撞地面 / 平台顶面：取脚下最高顶面（地面 y=0.08 或山丘/岩石等障碍顶面）。
      // 旧版只判 ny<=0.08（地面），手榴弹在第二层平台上会穿过平台顶面掉到下方消失。
      let floorY = 0.08;
      if (p.vy < 0) {
        for (const o of obstacles) {
          if (p.x > o.min[0] - 0.1 && p.x < o.max[0] + 0.1 &&
              p.z > o.min[2] - 0.1 && p.z < o.max[2] + 0.1 &&
              p.y >= o.max[1] - 0.01 && ny < o.max[1]) {
            if (o.max[1] > floorY) floorY = o.max[1];
          }
        }
      }

      if (ny <= floorY) {
        if (p.kind === 'block') {
          // 建造枪方块：落地即砌墙（floorY 支持落在既有方块顶面 → 可向上叠高）
          this.placeBlock(nx, floorY, nz);
          this.projectiles.splice(i, 1);
          continue;
        }
        if (p.kind === 'rocket' || p.kind === 'tnt' || p.bounces >= 3) {
          this.detonate(p, nx, floorY, nz);
          this.projectiles.splice(i, 1);
          continue;
        }
        p.y = floorY;
        p.vy = -p.vy * w.bounce;
        p.vx *= w.friction;
        p.vz *= w.friction;
        p.bounces++;
        this.particles.impact(p.x, floorY, p.z, 0, 1, 0, 'dirt');
      } else {
        // 撞墙 / 撞敌人
        const step = [nx - p.x, ny - p.y, nz - p.z];
        const len = Math.hypot(step[0], step[1], step[2]) || 1;
        const dir = [step[0] / len, step[1] / len, step[2] / len];

        const e = this.enemies.raycast([p.x, p.y, p.z], dir);
        // 注意：maxDist 必须是本帧位移 + 余量，且括号不能省 ——
        // 旧写法 `len + p.kind === 'rocket' ? 0.4 : 0.25` 因优先级恒为 0.25，
        // 高速下落时射线只探 0.25m，检测不到前方障碍。
        const probe = len + (p.kind === 'rocket' ? 0.4 : 0.25);
        const wt = this.raycastScene([p.x, p.y, p.z], dir, probe);

        if ((p.kind === 'rocket' || p.kind === 'tnt') && ((e.t >= 0 && e.t < probe) || wt >= 0)) {
          // 火箭 / TNT：接触即炸（命中敌人或墙壁立即引爆）
          const t = Math.min(e.t >= 0 && e.t < probe ? e.t : 1e9, wt >= 0 ? wt : 1e9);
          this.detonate(p, p.x + dir[0] * t, p.y + dir[1] * t, p.z + dir[2] * t);
          this.projectiles.splice(i, 1);
          continue;
        }
        if (wt >= 0 && wt <= probe) {
          // 火箭/TNT 撞墙即爆；建造方块撞墙就地砌上；手榴弹弹开
          if (p.kind === 'rocket' || p.kind === 'tnt') {
            this.detonate(p, p.x + dir[0] * wt, p.y + dir[1] * wt, p.z + dir[2] * wt);
            this.projectiles.splice(i, 1);
            continue;
          }
          if (p.kind === 'block') {
            const hx = p.x + dir[0] * wt, hy = p.y + dir[1] * wt, hz = p.z + dir[2] * wt;
            this.placeBlock(hx, Math.max(0, Math.round(hy - 0.5)), hz);
            this.projectiles.splice(i, 1);
            continue;
          }
          p.x = p.x + dir[0] * wt * 0.9;
          p.y = p.y + dir[1] * wt * 0.9;
          p.z = p.z + dir[2] * wt * 0.9;
          // 反射：把速度投影到法线之外
          const n = this.surfaceNormal(p.x, p.y, p.z);
          const dot = p.vx * n[0] + p.vy * n[1] + p.vz * n[2];
          p.vx = (p.vx - 2 * dot * n[0]) * w.bounce;
          p.vy = (p.vy - 2 * dot * n[1]) * w.bounce;
          p.vz = (p.vz - 2 * dot * n[2]) * w.bounce;
          p.vx *= 0.7; p.vz *= 0.7;
          p.bounces++;
          this.particles.impact(p.x, p.y, p.z, n[0], n[1], n[2], 'concrete');
        }
      }

      if (!p.dead) {
        p.x = nx; p.z = nz;
        if (ny > 0.08) p.y = ny;

        // 命中敌人（手榴弹不直接触发，靠范围）
        const e = this.enemies.raycast([p.x, p.y, p.z], [p.vx, p.vy, p.vz]);
        if (p.kind === 'rocket' && e.t >= 0 && e.t < speed * dt + 0.5) {
          this.detonate(p, p.x + p.vx * dt * (e.t / Math.max(speed * dt, 1e-4)), p.y, p.z);
          this.projectiles.splice(i, 1);
          continue;
        }

        if (p.kind === 'rocket') {
          this.pushRocketTrail(p);   // 体素尾迹：记录历史点，渲染为小方块
        } else {
          // 手榴弹尾迹：稀疏的烟，用来追踪它的位置
          if (Math.random() < 0.25) {
            this.particles.spawn({
              x: p.x, y: p.y, z: p.z,
              vx: 0, vy: 0.3, vz: 0,
              life: 0.5, size: 0.15, size1: 0.5,
              color: [0.7, 0.7, 0.68], alpha: 0.3,
              kind: 0, additive: false, drag: 0.9,
            });
          }
        }

        // 引信到点
        p.fuse -= dt;
        if (p.fuse <= 0) {
          if (p.kind === 'block') {
            this.placeBlock(p.x, Math.max(0, Math.round(p.y - 0.5)), p.z);   // 兜底：悬空超时就地放置
          } else {
            this.detonate(p, p.x, p.y, p.z);
          }
          this.projectiles.splice(i, 1);
        }
      }
    }
  }

  /** 找包含该点的碰撞盒表面法线。 */
  surfaceNormal(x, y, z) {
    for (const o of this.scene.obstacles) {
      if (x > o.min[0] && x < o.max[0] && y > o.min[1] && y < o.max[1] &&
          z > o.min[2] && z < o.max[2]) {
        // 取最近面的法线
        const d = [
          Math.min(x - o.min[0], o.max[0] - x),
          Math.min(y - o.min[1], o.max[1] - y),
          Math.min(z - o.min[2], o.max[2] - z),
        ];
        if (d[0] < d[1] && d[0] < d[2]) return [x - (o.min[0] + o.max[0]) / 2 > 0 ? 1 : -1, 0, 0];
        if (d[1] < d[2]) return [0, y > (o.min[1] + o.max[1]) / 2 ? 1 : -1, 0];
        return [0, 0, z > (o.min[2] + o.max[2]) / 2 ? 1 : -1];
      }
    }
    return [0, 1, 0];
  }

  /** 爆炸：粒子 + 范围杀伤 + 屏幕冲击。 */
  detonate(p, x, y, z) {
    const w = p.w;
    const scale = w.explosionScale;
    this.particles.explosion(x, y, z, scale, 0.05);

    // 像素方块碎片：爆炸"破坏方块"——飞散出匹配周围方块材质的彩色方块，
    // 体素风爆炸的核心视觉。
    const DEBRIS_COLORS = [
      [0.42, 0.66, 0.24],  // 草绿
      [0.20, 0.44, 0.15],  // 叶绿
      [0.53, 0.38, 0.24],  // 土棕
      [0.50, 0.50, 0.52],  // 石灰
      [0.63, 0.52, 0.32],  // 木棕
      [0.85, 0.79, 0.58],  // 砂黄
    ];
    const n = Math.floor((w.kind === 'grenade' ? 16 : 28) * scale);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (3 + Math.random() * 9) * scale;
      const col = DEBRIS_COLORS[(Math.random() * DEBRIS_COLORS.length) | 0];
      this.debris.push({
        x, y, z,
        vx: Math.cos(a) * sp, vy: 2.5 + Math.random() * 7 * scale, vz: Math.sin(a) * sp,
        size: 0.14 + Math.random() * 0.26,
        life: 0.6 + Math.random() * 0.7,
        color: col,
        rx: Math.random() * TAU, ry: Math.random() * TAU, rz: Math.random() * TAU,
        spinX: (Math.random() - 0.5) * 9, spinY: (Math.random() - 0.5) * 9, spinZ: (Math.random() - 0.5) * 9,
      });
    }

    const center = [x, y, z];
    const maxDmg = w.kind === 'grenade' ? w.damage : w.splashDamage;
    const killed = this.enemies.splash(center, w.radius, maxDmg, w.falloff);
    for (const e of killed) this.onKill(e, false);

    // 炸碎方块：爆炸半径内的方块（山丘/树叶/岩石/塔等）被破坏 ——
    // 隐藏其渲染实例 + 移除碰撞盒，地面塌出坑洞。
    const blastR = w.radius;
    for (let i = this.scene.obstacles.length - 1; i >= 0; i--) {
      const o = this.scene.obstacles[i];
      if (!o.batch) continue;   // 无渲染引用的（如边界墙）不动
      const cx = (o.min[0] + o.max[0]) / 2;
      const cy = (o.min[1] + o.max[1]) / 2;
      const cz = (o.min[2] + o.max[2]) / 2;
      if (Math.hypot(cx - x, cy - y, cz - z) < blastR) {
        const item = o.batch.list[o.idx];
        if (item) { item.mat[0] = item.mat[5] = item.mat[10] = 0; }  // 缩放归零 → 不可见
        this.scene.obstacles.splice(i, 1);
      }
    }

    // 爆炸也会打玩家（手雷不爆自己太宽松）
    const dx = this.player.eye[0] - x;
    const dy = this.player.eye[1] - y;
    const dz = this.player.eye[2] - z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < w.radius * 1.15) {
      const t = clamp(1 - dist / (w.radius * 1.15), 0, 1);
      let selfDmg = maxDmg * 0.32 * lerp(0.35, 1, t);
      if (dist < 3.5) selfDmg *= 0.25;   // 近距爆炸（贴地引爆等）自伤大幅减免，避免"发射即炸自己"
      this.onPlayerHit(selfDmg, null, p.kind === 'tnt');   // TNT：不掉震动
    }

    // 屏幕冲击与闪白（TNT 彩蛋：关闭震屏，只保留闪白/色差）
    const proximity = clamp(1 - dist / 20, 0, 1);
    if (p.kind !== 'tnt') this.cameraShake = (this.cameraShake || 0) + 3.2 * proximity * scale;
    this.postFx.flash = Math.min(0.85, proximity * 0.8);
    this.postFx.aberration = Math.min(2.5, 1.4 + proximity * 1.6);
    this.postFx.exposure = lerp(this.postFx.exposure, 1.6, proximity * 0.5);
  }

  updateProps(dt) {
    this.propTime = (this.propTime || 0) + dt;
    for (const p of this.props) {
      if (p.kind === 'ferris') p.angle = (p.angle || 0) + dt * 0.12;
      if (p.kind === 'carousel') p.angle = (p.angle || 0) + dt * 0.6;
      if (p.kind === 'windmill') p.angle = (p.angle || 0) + dt * 1.2;   // 风车叶片持续转动
      if (p.kind === 'torch') {
        // 火焰：悬空小方块组团飘动（独立相位 + 幅度）
        for (const f of p.flames) {
          f.phase += dt * (4 + f.speed * 6);
          f.ox = Math.sin(f.phase) * f.amp;
          f.oz = Math.cos(f.phase * 0.8) * f.amp;
          f.oy = Math.sin(f.phase * 1.4) * 0.08;
        }
      }
      if (p.kind === 'fountain') {
        // 体素水柱：14 个水滴小方块各自做抛物线循环（升起→顶点→落回池面）。
        // 粒子管线在此环境不可靠（与火把/火焰同因），改走体素 props 渲染。
        if (!p.drops) {
          p.drops = [];
          for (let i = 0; i < 14; i++) {
            p.drops.push({
              c: i / 14,                       // 循环相位错开
              speed: 0.75 + Math.sin(i * 57.3) * 0.12,   // 0.63~0.87 循环/秒（确定性）
              ox: (Math.sin(i * 127.1) * 43758.55 % 1) * 0.3 - 0.15,
              oz: (Math.sin(i * 311.7) * 12543.85 % 1) * 0.3 - 0.15,
              H: 2.0 + (Math.sin(i * 74.7) * 14672.3 % 1) * 0.8,   // 顶点高 2.0~2.8m
            });
          }
        }
        for (const d of p.drops) {
          d.c += dt * d.speed;
          if (d.c >= 1) d.c -= 1;
          // 抛物线：c=0 从池面起跳、c=0.5 顶点、c=1 落回；h = 4H·c·(1-c)
          d.h = 4 * d.H * d.c * (1 - d.c);
          // 落点外扩：越接近回落越向外散开（模拟水柱散开）
          const spread = 0.12 + d.c * 0.55;
          d.wx = p.x + d.ox * spread * 2 + Math.sin(d.c * 9 + d.speed * 20) * 0.1 * d.c;
          d.wz = p.z + d.oz * spread * 2 + Math.cos(d.c * 8 + d.speed * 17) * 0.1 * d.c;
        }
      }
    }
  }

  /* ================================================================ 渲染 */

  renderFrame(dt) {
    const R = this.renderer;

    // 相机（含后坐偏移与震屏）
    const eye = this.player.eye;
    let pitch = this.player.pitch + this.weapons.recoilPitch * (Math.PI / 180) * 0.55;
    let yaw = this.player.yaw + this.weapons.recoilYaw * (Math.PI / 180);

    // 镜头震动已全局关闭（用户要求射击/爆炸时画面不抖动）：
    // cameraShake 数值仍照常累积与衰减（不影响其它逻辑），但渲染不再应用偏移。
    // 如需恢复震动，删除下面的 CAM_SHAKE_ENABLED 常量即可。
    const CAM_SHAKE_ENABLED = false;
    if (CAM_SHAKE_ENABLED && this.cameraShake > 0) {
      const s = this.cameraShake;
      pitch += (Math.random() - 0.5) * s * 0.012;
      yaw += (Math.random() - 0.5) * s * 0.012;
    }

    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const dir = [-Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp];
    const target = [eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]];
    const up = [0, 1, 0];

    // 瞄准镜：中键开启时缩小 FOV（72° / zoom），实现放大；滚轮调节 zoom
    const fov = (this.aiming ? 72 / this.zoom : 72) * Math.PI / 180;
    R.setCamera(eye, target, up, fov, R.width / R.height, 0.05, 260);
    R.setSun(this.env.sunDir, this.env.sunColor, this.env.ambientSky,
             this.env.ambientGround, this.env.fogColor, this.env.fogFalloff, eye, 40);

    this.buildDynamicInstances(eye);

    // 闪白回落
    this.postFx.flash = Math.max(0, this.postFx.flash - dt * 2.2);
    this.postFx.exposure = lerp(this.postFx.exposure, this.weather.exposure, clamp(dt * 2.5, 0, 1));

    R.render(this.time, this.postFx);
    this.drawOverlays();
  }

  /** 每帧动态实例：敌人、武器模型、投射物、曳光弹。 */
  buildDynamicInstances(eye) {
    const R = this.renderer;
    const eb = this.enemyBox;
    eb.list.length = 0;
    const m = new Float32Array(16);
    const parts = humanoidParts();

    for (const e of this.enemies.list) {
      const d = e.def;
      const fade = e.fadeOut > 0 ? 1 - e.fadeOut / 0.7 : 1;
      // 死亡时向侧面倒下（绕自身前后轴侧滚，不是画面内翻转）
      let fallTilt = 0, fallAxis = 0;
      if (e.dying > 0) {
        const t = 1 - e.dying;
        fallTilt = Math.min(1, t * 1.8) * (Math.PI / 2) * 0.92;
        fallAxis = e.deathFallAxis ? 1 : -1;
      }

      const c = d.colors;
      for (const part of parts) {
        // 走路摆腿：腿部前后摆动，手臂反相
        let px = part.offset[0] * d.limbScale;
        let py = part.offset[1] * (d.limbScale > 1.1 ? 1.0 : 1.0);
        let pz = part.offset[2];
        const isLeg = part.name.startsWith('leg');
        const isArm = part.name.startsWith('arm');
        const swing = Math.sin(e.phase + (isLeg ? 0 : Math.PI)) * (isLeg ? 0.34 : 0.26) *
                      clamp(Math.hypot(e.vx, e.vz) / d.speed, 0, 1);
        if (isLeg || isArm) {
          pz += swing;
          py -= Math.abs(swing) * 0.12;
        }
        // 攻击前摇：手臂抬起
        if (isArm && e.attackWindup > 0) {
          py += 0.28;
          pz += 0.3;
        }

        let sx = part.size[0] * d.limbScale;
        let sy = part.size[1] * d.limbScale;
        let sz = part.size[2] * d.limbScale;

        // 颜色：受击白闪 + 死亡变暗。face 部件是深色眼睛/嘴区
        let col = isLeg || isArm ? c.limb
          : part.name === 'head' ? c.head
          : part.name === 'face' ? [0.14, 0.11, 0.09]
          : c.body;
        let bright = 1;
        if (e.hitFlash > 0) bright = 1 + e.hitFlash * 2.6;
        if (e.dying > 0) bright = 1 - (1 - e.dying) * 0.55;

        const wx = e.x + px * Math.cos(e.yaw) + pz * Math.sin(e.yaw);
        const wz = e.z - px * Math.sin(e.yaw) + pz * Math.cos(e.yaw);
        const wy = e.y + py;

        // 死亡倒地：绕 X 或 Z 轴旋转 90°
        let yaw = e.yaw, roll = 0, pitchR = 0;
        if (fallTilt > 0) {
          if (fallAxis > 0) { roll = fallTilt; } else { pitchR = fallTilt; }
          // 倒地时整体压低，避免悬在半空
          m4.compose(m, wx, wy - fallTilt * 0.25, wz, yaw, pitchR, roll, sx, sy, sz);
        } else {
          m4.compose(m, wx, wy, wz, yaw, 0, 0, sx, sy, sz);
        }

        eb.list.push({
          mat: Float32Array.from(m),
          color: [col[0] * bright, col[1] * bright, col[2] * bright],
          rough: 0.85, emissive: 0, caster: true,
        });
      }

      // 血条（受损时才显示，街机惯例）
      if (e.alive && e.health < e.maxHealth) {
        const pct = e.health / e.maxHealth;
        const w = 0.9 * pct;
        m4.compose(m, e.x, e.y + d.height + 0.28, e.z, e.yaw, 0, 0, w, 0.08, 0.02);
        eb.list.push({ mat: Float32Array.from(m), color: [0.9, 0.15, 0.15], rough: 0.5, emissive: 0.7, caster: false });
      }
    }

    /* ---- 末影龙（精细体素：身体5段/头角嘴/双紫眼/双翅扇动/长尾/腿） ---- */
    if (this.dragon) {
      const d = this.dragon;
      const dark = [0.12, 0.09, 0.16];
      const dark2 = [0.17, 0.13, 0.22];   // 背脊/头稍亮
      const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw);   // 头朝向
      const sx = -fz, sz = fx;                            // 侧向（翅膀方向）

      // 身体：5 段沿朝向，蜿蜒起伏（相位沿身体变化）
      for (let i = -2; i <= 2; i++) {
        const by = d.y + Math.sin(this.time * 2.2 + i * 0.8) * 0.22;
        const w = 1.25 - Math.abs(i) * 0.12;
        m4.compose(m, d.x + fx * i * 0.95, by, d.z + fz * i * 0.95, d.yaw, 0, 0, w, 0.9, 1.0);
        eb.list.push({ mat: Float32Array.from(m), color: i === 0 ? dark2 : dark, rough: 0.6, emissive: 0, caster: true });
      }
      // 头（前方）
      m4.compose(m, d.x + fx * 2.4, d.y + 0.12, d.z + fz * 2.4, d.yaw, 0, 0, 0.85, 0.7, 0.85);
      eb.list.push({ mat: Float32Array.from(m), color: dark2, rough: 0.6, emissive: 0.5, caster: true });
      // 嘴（前方下方）
      m4.compose(m, d.x + fx * 2.75, d.y - 0.12, d.z + fz * 2.75, d.yaw, 0, 0, 0.5, 0.2, 0.5);
      eb.list.push({ mat: Float32Array.from(m), color: dark, rough: 0.6, emissive: 0, caster: true });
      // 角（2 个，头顶上方）
      for (const s of [-1, 1]) {
        m4.compose(m, d.x + fx * 2.3 + sx * s * 0.35, d.y + 0.75, d.z + fz * 2.3 + sz * s * 0.35, d.yaw, 0, 0, 0.18, 0.5, 0.18);
        eb.list.push({ mat: Float32Array.from(m), color: dark2, rough: 0.6, emissive: 0, caster: true });
      }
      // 发光紫眼（2 个）
      for (const s of [-1, 1]) {
        m4.compose(m, d.x + fx * 2.5 + sx * s * 0.28, d.y + 0.25, d.z + fz * 2.5 + sz * s * 0.28, d.yaw, 0, 0, 0.2, 0.2, 0.2);
        eb.list.push({ mat: Float32Array.from(m), color: [0.7, 0.3, 0.95], rough: 0.3, emissive: 2.5, caster: false });
      }
      // 翅膀（两侧，主翼 + 后翼，扇动幅度更大）
      const flap = Math.sin(this.time * 2.6) * 0.55;
      for (const s of [-1, 1]) {
        m4.compose(m, d.x + sx * s * 1.3, d.y + 0.4, d.z + sz * s * 1.3, d.yaw, 0, s * (0.3 + flap), 0.2, 1.9, 2.3);
        eb.list.push({ mat: Float32Array.from(m), color: dark, rough: 0.6, emissive: 0, caster: false });
        m4.compose(m, d.x + sx * s * 1.2 - fx * 0.5, d.y + 0.3, d.z + sz * s * 1.2 - fz * 0.5, d.yaw, 0, s * (0.25 + flap * 0.85), 0.18, 1.4, 1.8);
        eb.list.push({ mat: Float32Array.from(m), color: dark, rough: 0.6, emissive: 0, caster: false });
      }
      // 尾巴（3 段递减，更长）
      for (let i = 1; i <= 3; i++) {
        const s = 0.6 - i * 0.14;
        m4.compose(m, d.x - fx * (1.5 + i * 0.85), d.y - i * 0.12, d.z - fz * (1.5 + i * 0.85), d.yaw, 0, 0, s, s, s);
        eb.list.push({ mat: Float32Array.from(m), color: dark, rough: 0.6, emissive: 0, caster: true });
      }
      // 腿/爪（4 个，身体下方）
      for (const s of [-1, 1]) {
        for (const f of [-0.5, 0.5]) {
          m4.compose(m, d.x + fx * f * 0.9 + sx * s * 0.55, d.y - 0.7, d.z + fz * f * 0.9 + sz * s * 0.55, d.yaw, 0, 0, 0.28, 0.6, 0.28);
          eb.list.push({ mat: Float32Array.from(m), color: dark, rough: 0.6, emissive: 0, caster: true });
        }
      }
    }

    /* ---- 道具（风车叶片 + 火把火焰，逐帧动态） ---- */
    for (const p of this.props) {
      if (p.kind === 'windmill') {
        // 荷兰风车风轮：4 片大叶片在垂直于轴（世界 Z 轴，朝 +z 朝向玩家）的
        // 平面内绕轴旋转，每片从轴心向外延伸 3.2m，木框色与体素风协调。
        const BL = 3.2, BW = 0.55, BT = 0.16;
        for (let i = 0; i < 4; i++) {
          const a = p.angle + i * (Math.PI / 2);
          // 叶片中心在轴向外 BL/2 处；roll=a 时 sx 沿径向——长边 BL 沿径向伸展
          m4.compose(m,
            p.x + Math.cos(a) * (BL / 2 + 0.1),
            p.y + Math.sin(a) * (BL / 2 + 0.1),
            p.z,
            0, 0, a, BL, BW, BT);
          eb.list.push({ mat: Float32Array.from(m), color: [0.78, 0.62, 0.42], rough: 0.6, emissive: 0, caster: true });
          // 叶片末端的横撑（格子帆感）
          const tipX = p.x + Math.cos(a) * (BL - 0.35);
          const tipY = p.y + Math.sin(a) * (BL - 0.35);
          m4.compose(m, tipX, tipY, p.z, 0, 0, a + Math.PI / 2, BL * 0.55, 0.14, BT);
          eb.list.push({ mat: Float32Array.from(m), color: [0.68, 0.54, 0.36], rough: 0.6, emissive: 0, caster: true });
        }
        // 轴心（帽正面伸出的木轴）
        m4.compose(m, p.x, p.y, p.z - 0.15, 0, 0, 0, 0.28, 0.28, 0.5);
        eb.list.push({ mat: Float32Array.from(m), color: [0.4, 0.35, 0.3], rough: 0.5, emissive: 0, caster: true });
      } else if (p.kind === 'torch') {
        // 火焰：悬空小方块组团飘动
        for (const f of p.flames) {
          m4.compose(m, p.x + (f.ox || 0), p.y + f.h + (f.oy || 0), p.z + (f.oz || 0), 0, 0, 0, f.size, f.size, f.size);
          eb.list.push({ mat: Float32Array.from(m), color: f.color, rough: 0.3, emissive: 2.2, caster: false });
        }
      } else if (p.kind === 'fountain') {
        // 体素水柱：14 个蓝色水滴小方块，抛物线升降（updateProps 中已算好 h/wx/wz）
        if (!p.drops) continue;   // updateProps 未跑过时（壁纸模式）防御
        for (const d of p.drops) {
          const s = 0.09 + (d.H - 2.0) * 0.04;   // 0.09~0.13，与火把火焰同量级
          m4.compose(m, d.wx, p.y + 0.35 + d.h, d.wz, d.c * 6, d.c * 4, 0, s, s, s);
          eb.list.push({
            mat: Float32Array.from(m),
            color: d.c > 0.8 ? [0.55, 0.8, 1.0] : [0.42, 0.7, 1.0],   // 落回时更亮（水花）
            rough: 0.25, emissive: 1.4, caster: false,
          });
        }
      }
    }

    /* ---- 投射物 ---- */
    const pb = this.projBox;
    pb.list.length = 0;
    for (const p of this.projectiles) {
      if (p.kind === 'tnt') {
        // TNT 方块（Minecraft 外形）：红色主体 + 白色横带
        m4.compose(m, p.x, p.y, p.z, p.rot[0], p.rot[1], p.rot[2], 0.5, 0.5, 0.5);
        pb.list.push({ mat: Float32Array.from(m), color: [0.82, 0.2, 0.15], rough: 0.55, emissive: 0, caster: true });
        m4.compose(m, p.x, p.y, p.z, p.rot[0], p.rot[1], p.rot[2], 0.52, 0.18, 0.52);
        pb.list.push({ mat: Float32Array.from(m), color: [0.92, 0.88, 0.78], rough: 0.55, emissive: 0, caster: true });
        continue;
      }
      const isGrenade = p.kind === 'grenade';
      m4.compose(m, p.x, p.y, p.z, p.rot[0], p.rot[1], p.rot[2],
        isGrenade ? 0.14 : 0.18, isGrenade ? 0.16 : 0.18, isGrenade ? 0.14 : 0.55);
      pb.list.push({
        mat: Float32Array.from(m),
        color: isGrenade ? [0.28, 0.32, 0.22] : [0.55, 0.56, 0.58],
        rough: 0.6, emissive: 0, caster: true,
      });
    }
    // 爆炸碎片（像素方块）
    for (const d of this.debris) {
      m4.compose(m, d.x, d.y, d.z, d.rx, d.ry, d.rz, d.size, d.size, d.size);
      pb.list.push({
        mat: Float32Array.from(m),
        color: d.color, rough: 0.5, emissive: 0, caster: false,
      });
    }
    // 掷石者的石块（实体方块：粒子是半透明烟雾看不见，必须走体素批次才醒目）
    for (const en of this.enemies.list) {
      if (en.alive && en.rockTimer > 0 && en.rockPos) {
        m4.compose(m, en.rockPos[0], en.rockPos[1], en.rockPos[2],
          this.time * 3, this.time * 2, 0, 0.22, 0.22, 0.22);
        pb.list.push({
          mat: Float32Array.from(m),
          color: [0.42, 0.36, 0.3], rough: 0.85, emissive: 0, caster: true,
        });
      }
    }
    // 喷火者的体素火舌：25 个火把级小方块（0.10~0.18），锥形散布伸向玩家方向。
    // 用索引确定性散布，保证帧间稳定不乱闪。
    for (const en of this.enemies.list) {
      if (en.alive && en.flameBurst > 0 && en.flameDir) {
        const t = this.time;
        const fx = en.flameDir[0], fz = en.flameDir[1];
        const sx = -fz, sz = fx;   // 垂直方向（锥形散布用）
        const N = 25;
        for (let i = 0; i < N; i++) {
          // 确定性伪随机（帧间稳定）
          const h1 = Math.abs(Math.sin(i * 127.1 + 1.7) * 43758.55) % 1;
          const h2 = Math.abs(Math.sin(i * 311.7 + 4.2) * 12543.85) % 1;
          const h3 = Math.abs(Math.sin(i * 74.7 + 9.1) * 24634.63) % 1;
          const d = 0.5 + h1 * 4.2;                       // 距嘴 0.5~4.7m
          const cone = 0.06 + (d / 4.7) * 0.55;           // 锥形半径随距离扩张
          const sway = Math.sin(t * 11 + i * 1.9) * cone * 0.55;
          const bx = en.x + fx * d + sx * (h2 - 0.5) * 2 * cone + sx * sway;
          const bz = en.z + fz * d + sz * (h2 - 0.5) * 2 * cone + sz * sway;
          const by = en.y + 1.3 + (h3 - 0.5) * 2 * cone * 0.6 + Math.sin(t * 15 + i * 2.3) * 0.05 + d * 0.06;
          const s = 0.025 + h3 * 0.02;                    // 尺寸缩至 1/4（0.025~0.045），形状/位置不变
          // 颜色/亮度随距离：白热→橙→暗红
          const k = d / 4.7;
          const col = k < 0.3 ? [1, 0.9 - k * 0.6, 0.55 - k]
                    : k < 0.65 ? [1, 0.72 - k * 0.5, 0.25 - k * 0.22]
                    : [0.85 - k * 0.35, 0.3 - k * 0.14, 0.06];
          m4.compose(m, bx, by, bz, t * 7 + i * 1.3, t * 5 + i * 2.1, 0, s, s, s);
          pb.list.push({
            mat: Float32Array.from(m),
            color: col, rough: 0.4,
            emissive: 2.4 - k * 2.0,   // 2.4 → 0.4
            caster: false,
          });
        }
      }
    }

    // 火箭的体素尾迹：24 个小方块（0.09~0.17），近端橙焰、远端灰烟
    for (const pr of this.projectiles) {
      if (pr.kind === 'rocket' && pr.trail) {
        const n = pr.trail.length;
        const t = this.time;
        for (let i = 0; i < n; i++) {
          const tp = pr.trail[i];
          const k = i / n;              // 0=最老 1=最新（贴火箭）
          const hot = k > 0.72;         // 最新段是尾焰
          const s = hot ? 0.13 + k * 0.04 : 0.09 + k * 0.06;
          const wob = Math.sin(t * 9 + i * 1.4) * 0.06 * (1 - k);
          m4.compose(m,
            tp.x + wob, tp.y + Math.sin(t * 7 + i * 1.1) * 0.05 * (1 - k), tp.z - wob,
            t * 3 + i, t * 2 + i, 0, s, s, s);
          pb.list.push({
            mat: Float32Array.from(m),
            color: hot ? [1, 0.6, 0.15] : [0.62, 0.58, 0.54],
            rough: 0.5,
            emissive: hot ? 2.0 - (1 - k) * 5 : 0.25,
            caster: false,
          });
        }
      }
    }

    // 喷火器火龙：130 个细小体素组成的稀疏火环——关键设计是"环形散布"：
    // 粒子被推离准星轴线（最小偏移 35% 锥半径），瞄准时视线中央留空，
    // 火焰在视野四周环绕喷涌，不遮挡目标。体素沿火流循环前移（不提前消散），
    // 同簇低频同相位摆动保留"一团团喷出"的集群感。
    if (this.flameJet && this.flameJet.t > 0) {
      const eye = this.player.eye;
      const f = this.player.forward;
      const r = this.player.right;
      const up = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];   // 叉积≈上向
      const t = this.time;
      const N = 130, LEN = 15;                          // 数量 300→130（稀疏化）
      for (let i = 0; i < N; i++) {
        const h1 = Math.abs(Math.sin(i * 127.1 + 3.3) * 43758.55) % 1;
        const h2 = Math.abs(Math.sin(i * 311.7 + 7.7) * 12543.85) % 1;
        const h3 = Math.abs(Math.sin(i * 74.7 + 1.1) * 24634.63) % 1;
        // 循环前移：体素以 7m/s 沿火流推进，跑完 15m 回卷到枪口 → 连续喷涌
        const d = (h1 * LEN + t * 7) % LEN;
        const k = d / LEN;
        const cone = 0.14 + Math.pow(k, 1.5) * 1.3;     // 近枪口即有 14cm 空心半径 → 远端膨胀（半径 1.3m）
        // 环形散布：径向距离推离轴线（35%~100% 锥半径），并强制视线区豁免——
        // 距准星轴 <0.42m 的粒子一律推到 0.42m 外，瞄准中央永远留空不遮挡
        const ringR = Math.max(cone * (0.35 + 0.65 * h2), 0.42);
        const ang = h3 * 6.283 + Math.sin(t * 2 + d * 0.8) * 0.5;   // 角向分布 + 慢速旋搅
        // 集群感：每 2.5m 一簇，同簇低频同相位摆动（团块整体晃）
        const cluster = Math.floor(d / 2.5);
        const sway = Math.sin(t * 3 + cluster * 2.1) * cone * 0.45;
        let jx = Math.cos(ang) * ringR + sway;
        let jy = Math.sin(ang) * ringR;
        const drop = k * k * 2.4;                        // 下坠：远端下垂 2.4m（重力感）
        // 视线区硬约束：横向偏移 + 下坠后的净垂直偏移，合成半径不足 0.5m 时放大——
        // 下坠的粒子会向四周散开（也符合物理直觉），瞄准中央 0.5m 内永远无粒子
        let vy = jy - drop;
        const vd = Math.hypot(jx, vy);
        if (vd < 0.5) { const f = 0.5 / Math.max(vd, 1e-4); jx *= f; vy *= f; }
        jy = vy + drop;
        const bx = eye[0] + f[0] * d + r[0] * jx + up[0] * jy;
        const by = eye[1] + f[1] * d + r[1] * jx + up[1] * jy - drop;
        const bz = eye[2] + f[2] * d + r[2] * jx + up[2] * jy;
        const s = 0.03 + h2 * 0.025 + k * 0.04;          // 细小粒子（0.03~0.095，远端略膨胀）
        const col = k < 0.2 ? [1, 0.93, 0.55]
                  : k < 0.55 ? [1, 0.62 - k * 0.35, 0.14]
                  : [0.88 - k * 0.45, 0.3 - k * 0.16, 0.05];
        m4.compose(m, bx, by, bz, t * 9 + i * 0.9, t * 6 + i * 1.7, 0, s, s, s);
        pb.list.push({
          mat: Float32Array.from(m),
          color: col, rough: 0.4,
          emissive: 2.3 - k * 2.0,
          caster: false,
        });
      }
    }

    // 建造枪方块已改为静态批（builtBatch），由渲染器随场景批次自动绘制——
    // 这里不再每帧重建（否则 batch/idx 引用失效，爆炸无法摧毁方块）

    /* ---- 开火火光（红色弹道线：沿准星方向，开火瞬间生成，随发射方向） ---- */
    const tb = this.tracerBatch;
    tb.list.length = 0;
    for (const t of this.tracers) {
      const a = t.life / t.maxLife;
      const mid = t.len * 0.5;
      // 沿弹道方向的细长盒：起点为 t 原点，方向 t.dir
      const px = t.x + t.dx * mid, py = t.y + t.dy * mid, pz = t.z + t.dz * mid;
      // 用 matrixFromDir 而非 m4.compose：compose 的 Z 轴 y 与 dir 反号，会上下反转
      matrixFromDir(m, px, py, pz, [t.dx, t.dy, t.dz], 0.03, 0.03, t.len);
      tb.list.push({
        mat: Float32Array.from(m),
        color: [1.0, 0.22, 0.1], rough: 0.1,   // 红色火光
        emissive: 3.4 * a, caster: false,
      });
    }

    /* ---- 武器视图模型 ---- */
    // 独立的一层：画在主场景之后、清深度前，并附加轻微视差 ——
    // 这样枪不会插进墙里，同时保持"它在场景里"的实感。
    this.viewModelMat = m4.create();
    const vb = this.viewBox;
    vb.list.length = 0;
    if (this.mode === 'game') {
      const parts2 = weaponModel(this.weapons.current.key);
      const bob = this.player.bobAmount;
      const recoilKick = this.weapons.recoilPitch * (Math.PI / 180);
      const swayX = Math.sin(this.player.bobPhase) * 0.012 * bob;
      const swayY = Math.abs(Math.cos(this.player.bobPhase)) * 0.010 * bob;
      const raise = this.weapons.switchCooldown > 0
        ? clamp(this.weapons.switchCooldown / 0.32, 0, 1) : 0;   // 换枪时武器下沉
      const reloadDip = this.weapons.reloading > 0
        ? clamp(this.weapons.reloading / this.weapons.current.reloadTime, 0, 1) * 0.5 : 0;

      // 参考图里武器占画面下 1/3：贴近、压低、靠右
      const baseX = eye[0] + this.player.right[0] * 0.27 + this.player.forward[0] * 0.40;
      const baseY = eye[1] - 0.31 + swayY + (raise + reloadDip) * -0.25 - recoilKick * 0.012;
      const baseZ = eye[2] + this.player.right[2] * 0.27 + this.player.forward[2] * 0.40;

      for (const part of parts2) {
        const mat = GUN_MATERIALS[part.k] || GUN_MATERIALS.steel;
        m4.compose(m, baseX + this.player.right[0] * part.o[0] - this.player.forward[0] * part.o[2],
                       baseY + part.o[1] + part.o[2] * recoilKick * 0.02,
                       baseZ + this.player.right[2] * part.o[0] - this.player.forward[2] * part.o[2],
                   this.player.yaw, this.player.pitch + recoilKick * 0.06, 0,
                   part.s[0] * 1.18, part.s[1] * 1.18, part.s[2] * 1.18);
        vb.list.push({
          mat: Float32Array.from(m),
          color: mat.c,
          rough: mat.rough, emissive: mat.em || 0, caster: false,
        });
      }
    }
  }

  /** 粒子与贴花的实际绘制（在几何之后、深度写回之前）。 */
  drawOverlays() {
    const R = this.renderer;
    const gl = R.gl;

    // 普通混合（烟/碎片/贴花）
    R.uploadParticles(this.particleList = this.particles.buildRenderList(this.particleList || []));
    // 分两次画：先非加法，再加法。混合函数不同，必须分开
    const normal = this.particleList.filter(p => !p.additive);
    const additive = this.particleList.filter(p => p.additive);

    if (normal.length) {
      R.bindParticleProgram(false);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.smoke);
      R.uploadParticles(normal);
      R.renderParticles(this.time);
    }
    if (additive.length) {
      R.bindParticleProgram(true);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.fire);
      R.uploadParticles(additive);
      R.renderParticles(this.time);
    }
  }

  /* ================================================================ 主循环 */

  start() {
    this.lastFrame = performance.now();
    this.frameCount = 0;
    this._lastWallpaperFrame = 0;

    const frame = (now) => {
      requestAnimationFrame(frame);
      const rawDt = (now - this.lastFrame) / 1000;
      this.lastFrame = now;
      // 夹住 dt：切标签页/过场会导致单帧 dt 极大，不夹会让物理穿透
      const dt = Math.min(rawDt, 0.05);

      this.fpsSamples.push(1 / Math.max(rawDt, 1e-4));
      if (this.fpsSamples.length > 60) this.fpsSamples.shift();

      if (this.mode === 'wallpaper') {
        // 壁纸态：rAF 驱动但内部节流到 ~10fps，省电且不抢 GPU。
        // 注意：必须用 rAF 而不是 setTimeout —— GhibliMeadow 实测 rAF 在
        // 壁纸窗口上照跑、setTimeout 反而不稳定（离屏坐标下两者都可能被冻结，
        // 根因是窗口位置，不是定时器种类）。
        if (now - this._lastWallpaperFrame < 100) return;
        this._lastWallpaperFrame = now;
        this.updateWallpaperIdle(dt);
        this.renderFrame(dt);
      } else {
        this.update(dt);
        this.renderFrame(dt);
      }

      if (!this.readyNotified) {
        this.readyNotified = true;
        this.post({ type: 'ready' });
      }
      // 每 30 帧回一次状态给宿主（日志用）
      if (this.frameCount++ % 30 === 0) {
        const fps = Math.round(this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length);
        this.post({ type: 'fps', fps, kills: this.enemies.kills, scene: this.sceneDef.name });
      }
    };
    requestAnimationFrame(frame);
  }

  /**
   * 壁纸态：镜头缓慢横移 + 敌人不生成。
   * 这是"平时是静态壁纸"的具体实现：不跑玩法逻辑，只跑镜头与天光。
   */
  updateWallpaperIdle(dt) {
    this.idleTime = (this.idleTime || 0) + dt;
    const p = this.player;
    // 缓慢的横向漂移，让画面"活着"但不喧宾夺主
    p.yaw = Math.PI + Math.sin(this.idleTime * 0.075) * 0.55;
    p.pitch = Math.sin(this.idleTime * 0.05) * 0.04 - 0.02;
    p.syncCamera(dt);

    this.weapons.tick(dt);
    this.weatherFx.update(dt, p.eye, this.env.wind);
    this.particles.update(dt, this.env.wind);

    // 提示文字缓慢淡出，让桌面恢复成"纯画面"
    if (this.hud.el.hint) {
      const t = clamp((this.idleTime - 1.2) / 2.0, 0, 1);
      this.hud.el.hint.style.opacity = String(1 - t * 0.55);
    }
  }

  /** 宿主侧调用的接口：开始/结束游戏。 */
  beginPlay() {
    this.hud.trans.classList.remove('show');
  }
}

/* ---------------------------------------------------------------- 工具 */

/**
 * 构造一个「局部 Z 轴精确指向 dir」的模型矩阵（细长盒沿 Z 轴拉长）。
 * 不能用 m4.compose(yaw,pitch)：其 Z 轴 y 分量是 -sin(pitch)，与 dir 的 y 符号相反，
 * 朝上/朝下看时线会上下反转（实测瞄准线上下偏移的根因）。
 * 这里直接由 dir 与 up 叉积构正交基，Z 轴严格 = dir。
 */
function matrixFromDir(o, px, py, pz, dir, sx, sy, sz) {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const zx = dir[0] / l, zy = dir[1] / l, zz = dir[2] / l;
  // up 取 [0,1,0]，若 dir 近乎竖直则退化为 [1,0,0] 避免叉积退化
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(zy) > 0.99) { ux = 1; uy = 0; uz = 0; }
  // X = normalize(cross(up, Z))
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  // Y = cross(Z, X)
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  o[0] = xx * sx; o[1] = xy * sx; o[2] = xz * sx; o[3] = 0;
  o[4] = yx * sy; o[5] = yy * sy; o[6] = yz * sy; o[7] = 0;
  o[8] = zx * sz; o[9] = zy * sz; o[10] = zz * sz; o[11] = 0;
  o[12] = px; o[13] = py; o[14] = pz; o[15] = 1;
  return o;
}

function jitterDir(dir, spread) {
  if (spread <= 0) return [...dir];
  // 在切平面上做圆盘内均匀采样：两个独立高斯会造成"十字状"散布，很假
  const a = Math.random() * TAU;
  const r = Math.sqrt(Math.random()) * spread;
  // 构造与 dir 正交的基
  let ux = -dir[2], uy = 0, uz = dir[0];
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uz /= ul;
  const vx = dir[1] * uz - dir[2] * uy;
  const vy = dir[2] * ux - dir[0] * uz;
  const vz = dir[0] * uy - dir[1] * ux;
  const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
  let nx = dir[0] + ux * ca + vx * sa;
  let ny = dir[1] + uy * ca + vy * sa;
  let nz = dir[2] + uz * ca + vz * sa;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

function sunDirection(elev, rng) {
  const az = rng() * TAU;
  const e = Math.max(0.06, elev) * Math.PI * 0.5;
  return [Math.cos(e) * Math.sin(az), Math.sin(e), Math.cos(e) * Math.cos(az)];
}

function mul(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }

function crossWith(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
