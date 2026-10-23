// game/hud.js —— HUD 与街机厅风格界面。
//
// 风格取向：日式街机厅（"agm"）的控制面板审美 ——
//   · 圆角深色面板 + 高饱和描边 + 扫描线；
//   · 数字用等宽 + 轻微发光，模拟 CRT 上的七段数码管；
//   · 右上角击杀数是规格明确要求的位置，做成最显眼的主信息；
//   · 全部用 DOM 而非 Canvas 绘制：文字清晰、零纹理成本、
//     高 DPI 下不会糊，且改文案不用碰渲染代码。

import { WEAPON_ORDER, WEAPONS, weaponStatLine } from './weapons.js';

const CSS = `
:root {
  --ag-red: #ff2b3c;
  --ag-amber: #ffb020;
  --ag-cyan: #22e0ff;
  --ag-green: #46f06a;
  --ag-panel: rgba(8, 10, 16, 0.62);
  --ag-edge: rgba(255, 255, 255, 0.16);
}
#hud, #hud * { box-sizing: border-box; }
#hud {
  position: fixed; inset: 0; pointer-events: none;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #fff; user-select: none; z-index: 10;
}
.panel {
  background: var(--ag-panel);
  border: 2px solid var(--ag-edge);
  border-radius: 10px;
  backdrop-filter: blur(3px);
  box-shadow: 0 2px 0 rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.10);
}
.label {
  font-size: 11px; letter-spacing: .22em; text-transform: uppercase;
  color: rgba(255,255,255,.62); font-weight: 600;
}

/* ---- 右上角：击杀数（规格指定位置，主信息） ---- */
#killPanel {
  position: absolute; top: 18px; right: 18px;
  padding: 10px 16px 12px; min-width: 186px; text-align: right;
  border-color: rgba(255, 43, 60, .5);
}
#killPanel .label { color: var(--ag-red); }
#killNum {
  font-size: 46px; font-weight: 800; line-height: .96;
  font-variant-numeric: tabular-nums; letter-spacing: -.02em;
  color: #fff;
  text-shadow: 0 0 12px rgba(255,43,60,.85), 0 0 34px rgba(255,43,60,.45);
}
#killNum.bump { animation: bump .18s ease-out; }
@keyframes bump { 0% { transform: scale(1.34); color: var(--ag-amber); } 100% { transform: scale(1); } }
#killGoal {
  margin-top: 4px; font-size: 12px; color: rgba(255,255,255,.55);
  font-variant-numeric: tabular-nums;
}
#goalBar {
  margin-top: 7px; height: 5px; background: rgba(255,255,255,.13);
  border-radius: 3px; overflow: hidden;
}
#goalFill {
  height: 100%; width: 0%; border-radius: 3px;
  background: linear-gradient(90deg, var(--ag-red), var(--ag-amber));
  transition: width .18s linear;
}

/* ---- 场景名 ---- */
#scenePanel {
  position: absolute; top: 18px; left: 18px;
  padding: 8px 14px; border-color: rgba(34,224,255,.42);
}
#sceneName { font-size: 15px; font-weight: 700; letter-spacing: .06em; }
#sceneSub { font-size: 11px; color: rgba(255,255,255,.5); letter-spacing: .16em; margin-top: 2px; }

/* ---- 左下：生命 ---- */
#hpPanel { position: absolute; left: 18px; bottom: 18px; padding: 9px 14px 11px; width: 224px; }
#hpRow { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
#hpNum { font-size: 26px; font-weight: 800; font-variant-numeric: tabular-nums; }
#hpBar { height: 11px; background: rgba(255,255,255,.12); border-radius: 6px; overflow: hidden;
  border: 1px solid rgba(255,255,255,.1); }
#hpFill { height: 100%; width: 100%; border-radius: 5px;
  background: linear-gradient(90deg, var(--ag-green), #b8ff5a);
  transition: width .12s linear, background .3s; }
#hpFill.warn { background: linear-gradient(90deg, var(--ag-amber), #ffd94a); }
#hpFill.crit { background: linear-gradient(90deg, var(--ag-red), #ff6b4a); }

/* ---- 右下：武器 + 弹药 ---- */
#wpnPanel { position: absolute; right: 18px; bottom: 18px; padding: 9px 14px 11px; min-width: 240px; text-align: right; }
#wpnName { font-size: 19px; font-weight: 800; letter-spacing: .04em; }
#wpnStat { font-size: 11px; color: rgba(255,255,255,.55); margin-top: 2px; font-variant-numeric: tabular-nums; }
#ammoNum { font-size: 34px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.05;
  text-shadow: 0 0 10px rgba(34,224,255,.5); }
#ammoNum small { font-size: 15px; color: rgba(255,255,255,.5); font-weight: 600; }
#reloadHint { font-size: 12px; color: var(--ag-amber); height: 15px; margin-top: 1px; }
#wpnList { display: flex; gap: 5px; justify-content: flex-end; margin-top: 7px; }
.chip {
  font-size: 10px; padding: 3px 7px; border-radius: 5px;
  border: 1px solid rgba(255,255,255,.18); color: rgba(255,255,255,.55);
  letter-spacing: .04em; background: rgba(0,0,0,.3);
}
.chip.on { border-color: var(--ag-cyan); color: #fff;
  background: rgba(34,224,255,.2); box-shadow: 0 0 10px rgba(34,224,255,.35); }
.chip.empty { color: var(--ag-red); border-color: rgba(255,43,60,.5); }

/* ---- 中央：准星 ---- */
#crosshair { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px;
  transform: translate(-50%,-50%); }
#crosshair div { position: absolute; background: #fff; box-shadow: 0 0 4px rgba(0,0,0,.9); }
#ch-t { left: 50%; top: 0; width: 2px; height: 9px; margin-left: -1px; }
#ch-b { left: 50%; bottom: 0; width: 2px; height: 9px; margin-left: -1px; }
#ch-l { top: 50%; left: 0; height: 2px; width: 9px; margin-top: -1px; }
#ch-r { top: 50%; right: 0; height: 2px; width: 9px; margin-top: -1px; }
#ch-dot { left: 50%; top: 50%; width: 2px; height: 2px; margin: -1px 0 0 -1px; border-radius: 50%; }
#hitMark { position: absolute; left: 50%; top: 50%; width: 26px; height: 26px;
  transform: translate(-50%,-50%) rotate(45deg); opacity: 0; }
#hitMark div { position: absolute; background: #fff; }
#hm-tl { left:0; top:0; width: 9px; height: 2px; }
#hm-tr { right:0; top:0; width: 9px; height: 2px; }
#hm-bl { left:0; bottom:0; width: 9px; height: 2px; }
#hm-br { right:0; bottom:0; width: 9px; height: 2px; }
#hitMark.show { animation: hm .26s ease-out; }
@keyframes hm { 0% { opacity: 1; transform: translate(-50%,-50%) rotate(45deg) scale(.6); }
  100% { opacity: 0; transform: translate(-50%,-50%) rotate(45deg) scale(1.25); } }

/* ---- 底部提示 ---- */
#hint { position: absolute; left: 50%; bottom: 92px; transform: translateX(-50%);
  font-size: 13px; color: rgba(255,255,255,.72); letter-spacing: .08em;
  text-shadow: 0 1px 3px rgba(0,0,0,.9); text-align: center; }
#killfeed { position: absolute; right: 18px; top: 132px; text-align: right; }
.kf { font-size: 12px; color: var(--ag-amber); letter-spacing: .06em; margin-top: 3px;
  animation: kfIn 2.2s ease-out forwards; text-shadow: 0 1px 3px rgba(0,0,0,.9); }
.kf.head { color: var(--ag-red); font-weight: 700; }
@keyframes kfIn { 0% { opacity: 0; transform: translateX(14px); } 12% { opacity:1; transform:none; }
  78% { opacity: 1; } 100% { opacity: 0; } }

/* ---- 瞄准镜：全屏黑遮罩 + 圆形镜孔 + 十字线 ---- */
#scope { position: fixed; inset: 0; z-index: 30; display: none; pointer-events: none; }
#scope.show { display: block; }
/* 黑色圆形遮罩：radial-gradient 挖出中心镜孔（透明），其余全黑覆盖整个屏幕 */
#scopeMask {
  position: absolute; inset: 0;
  background: radial-gradient(circle at 50% 50%,
    transparent 0, transparent calc(var(--scopeR, 40vmin) - 1px),
    rgba(0,0,0,0.985) var(--scopeR, 40vmin));
}
/* 镜孔边框（镜圈） */
#scopeRing {
  position: absolute; left: 50%; top: 50%;
  width: calc(var(--scopeR, 40vmin) * 2); height: calc(var(--scopeR, 40vmin) * 2);
  transform: translate(-50%,-50%); border-radius: 50%;
  box-shadow: 0 0 0 3px #050505, inset 0 0 50px rgba(0,0,0,.8);
}
/* 圆内十字瞄准线 */
#scopeCross { position: absolute; left: 50%; top: 50%;
  width: calc(var(--scopeR, 40vmin) * 2); height: calc(var(--scopeR, 40vmin) * 2);
  transform: translate(-50%,-50%); }
#scopeCross i { position: absolute; background: #000; }
#scopeCross .h { left: 0; right: 0; top: 50%; height: 2px; margin-top: -1px; }
#scopeCross .v { top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; }
/* 放大倍数读数 */
#scopeZoom { position: absolute; left: 50%; top: calc(50% + var(--scopeR, 40vmin) + 14px);
  transform: translateX(-50%); font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 15px; font-weight: 700; color: rgba(255,255,255,.85); letter-spacing: .08em;
  text-shadow: 0 1px 4px rgba(0,0,0,.9); font-variant-numeric: tabular-nums; }

/* ---- 末影龙血条（屏幕上方） ---- */
#dragonBar { position: absolute; left: 50%; top: 46px; transform: translateX(-50%);
  width: min(460px, 70vw); height: 14px; background: rgba(0,0,0,.62);
  border: 1px solid #6a4a9a; border-radius: 3px; display: none; overflow: hidden; }
#dragonBar.show { display: block; }
#dragonFill { height: 100%; width: 100%; background: linear-gradient(90deg, #7b3fd6, #b06bff);
  box-shadow: 0 0 10px rgba(176,107,255,.6); transition: width .12s linear; }
#dragonName { position: absolute; left: 50%; top: 30px; transform: translateX(-50%);
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; font-size: 13px;
  font-weight: 700; letter-spacing: .2em; color: #c9a6ff; text-shadow: 0 1px 4px rgba(0,0,0,.9);
  display: none; }
#dragonName.show { display: block; }
`;

/** 街机厅风格的过场画面。规格要求"击杀达标时有过场动画再切场景"。 */
const TRANSITION_CSS = `
#transition {
  position: fixed; inset: 0; z-index: 40; display: none;
  align-items: center; justify-content: center; flex-direction: column;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
}
#transition.show { display: flex; }
#transBands { position: absolute; inset: 0; overflow: hidden; }
#transBands div { position: absolute; left: 0; right: 0; height: 10px;
  background: rgba(0,0,0,.85); transform: translateY(-100%); }
#transTitle {
  position: relative; font-size: 60px; font-weight: 900; letter-spacing: .1em;
  color: #fff; text-shadow: 0 0 22px rgba(255,43,60,.9), 4px 4px 0 rgba(255,43,60,.55);
  transform: scale(.7); opacity: 0;
}
#transSub { position: relative; margin-top: 10px; font-size: 17px; letter-spacing: .4em;
  color: var(--ag-cyan); text-transform: uppercase; opacity: 0; }
#transCount { position: relative; margin-top: 26px; font-size: 15px; letter-spacing: .2em;
  color: rgba(255,255,255,.8); opacity: 0; font-variant-numeric: tabular-nums; }
`;

export class Hud {
  constructor(root, opts = {}) {
    this.mode = opts.mode || 'game';
    this.sensitivity = opts.sensitivity || 0.0022;
    this.bindings = {
      forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
      jump: 'Space', sprint: 'ShiftLeft', crouch: 'ControlLeft', reload: 'KeyR',
    };
    this.root = root;
    this.build();
    this.hitTimer = null;
    this.feed = [];
  }

  build() {
    const style = document.createElement('style');
    style.textContent = CSS + TRANSITION_CSS;
    document.head.appendChild(style);

    const hud = document.createElement('div');
    hud.id = 'hud';

    if (this.mode === 'game') {
      hud.innerHTML = `
        <div id="scenePanel" class="panel">
          <div id="sceneName">—</div>
          <div id="sceneSub">STAGE 1 / 8</div>
        </div>

        <div id="killPanel" class="panel">
          <div class="label">Kills</div>
          <div id="killNum">0</div>
          <div id="killGoal">/ ${this.killGoal} 下一场景</div>
          <div id="goalBar"><div id="goalFill"></div></div>
        </div>

        <div id="hpPanel" class="panel">
          <div id="hpRow"><span class="label">Vitals</span><span id="hpNum">100</span></div>
          <div id="hpBar"><div id="hpFill"></div></div>
        </div>

        <div id="wpnPanel" class="panel">
          <div id="wpnName">手枪</div>
          <div id="wpnStat"></div>
          <div id="ammoNum">12<small> / 12</small></div>
          <div id="reloadHint"></div>
          <div id="wpnList"></div>
        </div>

        <div id="crosshair">
          <div id="ch-t"></div><div id="ch-b"></div>
          <div id="ch-l"></div><div id="ch-r"></div><div id="ch-dot"></div>
        </div>
        <div id="hitMark">
          <div id="hm-tl"></div><div id="hm-tr"></div>
          <div id="hm-bl"></div><div id="hm-br"></div>
        </div>

        <div id="killfeed"></div>
        <div id="hint"></div>

        <div id="scope">
          <div id="scopeMask"></div>
          <div id="scopeRing"></div>
          <div id="scopeCross"><i class="h"></i><i class="v"></i></div>
          <div id="scopeZoom">2.0×</div>
        </div>

        <div id="dragonName">ENDER DRAGON</div>
        <div id="dragonBar"><div id="dragonFill"></div></div>
      `;

      // 注意：此时 hud 还没挂到 document 上，用 getElementById 一定拿不到，
      // 必须从 hud 节点自身查询。
      const chips = hud.querySelector('#wpnList');
      chips.innerHTML = WEAPON_ORDER
        .map((k, i) => `<span class="chip" data-w="${k}">${i + 1} ${WEAPONS[k].name}</span>`).join('');
      // 彩蛋快捷栏：7 FIRE / 8 TNT / 9 FREEZE / 0 DRAGON（激活时高亮）
      const eggBar = document.createElement('div');
      eggBar.id = 'eggList';
      eggBar.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
      eggBar.innerHTML = [
        ['fire', '7 FIRE'], ['tnt', '8 TNT'], ['freeze', '9 FREEZE'], ['dragon', '0 DRAGON'],
      ].map(([k, label]) =>
        `<span class="chip" data-egg="${k}" style="opacity:0.45">${label}</span>`).join('');
      chips.parentElement.appendChild(eggBar);

      const $ = (sel) => hud.querySelector(sel);
      this.el = {
        killNum: $('#killNum'),
        killGoal: $('#killGoal'),
        goalFill: $('#goalFill'),
        sceneName: $('#sceneName'),
        sceneSub: $('#sceneSub'),
        hpNum: $('#hpNum'),
        hpFill: $('#hpFill'),
        wpnName: $('#wpnName'),
        wpnStat: $('#wpnStat'),
        ammoNum: $('#ammoNum'),
        reloadHint: $('#reloadHint'),
        chips: chips.children,
        eggChips: eggBar.children,
        cross: $('#crosshair'),
        hitMark: $('#hitMark'),
        killfeed: $('#killfeed'),
        hint: $('#hint'),
        scope: $('#scope'),
        scopeZoom: $('#scopeZoom'),
        dragonBar: $('#dragonBar'),
        dragonFill: $('#dragonFill'),
        dragonName: $('#dragonName'),
      };
    } else {
      // 壁纸态：只放一行低调的提示，不做常驻 HUD（它会变成"界面浮在桌面上的图标"）
      hud.innerHTML = `<div id="hint" style="bottom:64px;font-size:15px;letter-spacing:.18em;
        color:rgba(255,255,255,.82);text-shadow:0 2px 8px rgba(0,0,0,.95)">
        单击任意位置 · 进入枪战</div>`;
      this.el = { hint: hud.querySelector('#hint') };
    }

    // 先挂到文档，再取过渡层元素（同样不能依赖 getElementById 的时序）
    document.body.appendChild(hud);

    const trans = document.createElement('div');
    trans.id = 'transition';
    trans.innerHTML = `
      <div id="transBands">${'<div></div>'.repeat(14)}</div>
      <div id="transTitle">STAGE CLEAR</div>
      <div id="transSub">—</div>
      <div id="transCount"></div>
    `;
    document.body.appendChild(trans);

    this.hud = hud;
    this.trans = trans;
    this.bands = trans.querySelectorAll('#transBands div');
    this.tTitle = trans.querySelector('#transTitle');
    this.tSub = trans.querySelector('#transSub');
    this.tCount = trans.querySelector('#transCount');
    this._lastKills = -1;
    this._lastHp = -1;
  }

  /* ------------------------------------------------------------ 每帧更新 */

  update(state) {
    if (this.mode !== 'game') return;
    const { kills, killGoal, health, maxHealth, weapon, ammo, mag, reloading,
            sceneName, stageIndex, stageTotal, spread, weaponKey, alive } = state;

    if (kills !== this._lastKills) {
      this._lastKills = kills;
      this.el.killNum.textContent = kills;
      this.el.goalFill.style.width = Math.min(100, (kills / killGoal) * 100) + '%';
      this.el.killGoal.textContent = `/ ${killGoal} 下一场景`;
      this.el.killNum.classList.remove('bump');
      // 强制重排以重启动画：同一帧内移除并加回，浏览器才会重新触发 keyframes
      void this.el.killNum.offsetWidth;
      this.el.killNum.classList.add('bump');
    }

    const hp = Math.round(health);
    if (hp !== this._lastHp) {
      this._lastHp = hp;
      this.el.hpNum.textContent = hp;
      const pct = Math.max(0, health / maxHealth) * 100;
      this.el.hpFill.style.width = pct + '%';
      this.el.hpFill.className = pct < 30 ? 'crit' : pct < 60 ? 'warn' : '';
    }

    this.el.wpnName.textContent = weapon;
    this.el.wpnStat.textContent = weaponStatLine(weaponKey);
    this.el.ammoNum.innerHTML = `${ammo}<small> / ${mag}</small>`;
    this.el.reloadHint.textContent = reloading > 0 ? '装填中…' : (ammo === 0 ? '按 R 装填' : '');

    for (const c of this.el.chips) {
      const k = c.dataset.w;
      c.classList.toggle('on', k === weaponKey);
      c.classList.toggle('empty', state.ammoAll[k] === 0);
    }

    // 彩蛋状态角标：激活高亮、未激活半透明
    if (state.eggs) {
      for (const c of this.el.eggChips) {
        c.classList.toggle('on', !!state.eggs[c.dataset.egg]);
        c.style.opacity = state.eggs[c.dataset.egg] ? '1' : '0.45';
      }
    }

    this.el.sceneName.textContent = sceneName;
    this.el.sceneSub.textContent = `STAGE ${stageIndex + 1} / ${stageTotal}`;

    // 准星随散布张开：散布是"当前能打多宽"的唯一可视化，必须做
    const gap = 5 + spread * 260;
    this.el.cross.children[0].style.top = `${22 - gap - 9}px`;
    this.el.cross.children[1].style.bottom = `${22 - gap - 9}px`;
    this.el.cross.children[2].style.left = `${22 - gap - 9}px`;
    this.el.cross.children[3].style.right = `${22 - gap - 9}px`;

    this.el.hint.textContent = alive ? '' : '你已阵亡 · 3 秒后重生';
  }

  /** 命中标记。head 为真时改成红色。 */
  hitMarker(head) {
    const m = this.el.hitMark;
    m.querySelectorAll('div').forEach(d => {
      d.style.background = head ? '#ff2b3c' : '#fff';
    });
    m.classList.remove('show');
    void m.offsetWidth;
    m.classList.add('show');
  }

  /** 击杀播报。 */
  pushFeed(text, head) {
    const d = document.createElement('div');
    d.className = 'kf' + (head ? ' head' : '');
    d.textContent = text;
    this.el.killfeed.appendChild(d);
    setTimeout(() => d.remove(), 2300);
    // 防止长连杀时 DOM 无限增长
    while (this.el.killfeed.children.length > 6) this.el.killfeed.firstChild.remove();
  }

  /**
   * 过场动画。返回 Promise，在动画结束（约 2.4s）后 resolve。
   * 用 Web Animations API 而不是 CSS 动画：需要"播完再进下一场景"的确定性时点，
   * CSS 动画拿不到可靠的完成回调（animationend 在被遮挡/节流时不触发）。
   */
  async playTransition(title, sub, onSwap) {
    this.trans.classList.add('show');

    // 1) 横向黑条扫入（0.42s）
    const bandPromises = [...this.bands].map((b, i) =>
      b.animate(
        [{ transform: `translateY(${(i - 7) * 10}vh)` },
         { transform: 'translateY(0)' }],
        { duration: 380 + i * 22, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }
      ).finished
    );
    await Promise.all(bandPromises);

    // 2) 标题弹入
    this.tTitle.textContent = title;
    this.tSub.textContent = sub;
    this.tTitle.animate(
      [{ transform: 'scale(.7)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
      { duration: 320, easing: 'cubic-bezier(.2,1.5,.4,1)', fill: 'forwards' }
    );
    this.tSub.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: 300, delay: 120, fill: 'forwards' });

    // 3) 倒数
    const start = performance.now();
    await new Promise(resolve => {
      const tick = () => {
        const e = (performance.now() - start) / 1000;
        const left = Math.max(0, 3 - Math.floor(e));
        this.tCount.textContent = `下一场景 ${left}`;
        if (e < 3) requestAnimationFrame(tick); else resolve();
      };
      tick();
    });

    // 4) 换场景（此时被黑条完全遮住，不会看到跳变）
    onSwap?.();
    await new Promise(r => setTimeout(r, 260));

    // 5) 黑条扫出
    const outPromises = [...this.bands].map((b, i) =>
      b.animate(
        [{ transform: 'translateY(0)' }, { transform: `translateY(${i < 7 ? -110 : 110}%)` }],
        { duration: 300, delay: (this.bands.length - i) * 16, easing: 'cubic-bezier(.4,0,.7,.2)', fill: 'forwards' }
      ).finished
    );
    await Promise.all(outPromises);

    // 复位：清掉 fill:forwards 的终态，否则下一轮动画会从错误位置开始
    [...this.bands].forEach((b, i) => {
      b.getAnimations().forEach(a => a.cancel());
      b.style.transform = `translateY(${(i - 7) * 10}vh)`;
    });
    this.tTitle.getAnimations().forEach(a => a.cancel());
    this.tSub.getAnimations().forEach(a => a.cancel());
    this.tTitle.style.opacity = '0';
    this.tSub.style.opacity = '0';
    this.trans.classList.remove('show');
  }

  destroy() {
    this.hud.remove();
    this.trans.remove();
  }
}
