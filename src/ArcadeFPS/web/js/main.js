// main.js —— 页面入口。负责：建 canvas、起 Game、暴露宿主与调试接口、错误兜底。

import { Game } from './game/game.js';
import { SCENES } from './game/scenes.js';
import { WEAPONS } from './game/weapons.js';

function fatal(err) {
  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:fixed;inset:0;margin:0;padding:28px;background:#12141a;color:#ff6b6b;' +
    'font:13px/1.6 Consolas,monospace;white-space:pre-wrap;overflow:auto;z-index:99';
  pre.textContent = '启动失败\n\n' + (err && (err.stack || err.message || String(err)));
  document.body.appendChild(pre);
  console.error(err);
  window.chrome?.webview?.postMessage({ type: 'error', message: String(err) });
}

window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

try {
  const canvas = document.getElementById('gl');
  const game = new Game(canvas);
  game.start();

  /* ---- 宿主与调试接口 ----
     window.game 让宿主探针与控制台都能读到真实状态，
     排查"画面不动 / 帧率低 / 敌人不生成"时不需要改代码加日志。 */
  window.game = game;

  const api = {
    stats: () => ({
      mode: game.mode,
      scene: game.sceneDef?.name,
      sceneKey: game.sceneDef?.key,
      weather: game.weather?.key,
      kills: game.enemies?.kills,
      alive: game.enemies?.aliveCount,
      spawned: game.enemies?.totalSpawned,
      hp: Math.round(game.player.health),
      alive_player: game.player.alive,
      weapon: game.weapons.current.key,
      drawCalls: game.renderer.drawCalls,
      width: game.renderer.width,
      height: game.renderer.height,
      gpu: game.renderer.gpu,
    }),
    /** 宿主探针：读页面是否真的在出帧。 */
    running: () => game.frameCount > 2,
    /** 强制切场景（调试用，跳过过场）。传索引或场景 key。 */
    goto: (which) => {
      game.carryKills = 0;
      let i = typeof which === 'number'
        ? which
        : SCENES.findIndex(s => s.key === which);
      if (i < 0) throw new Error('未知场景: ' + which);
      game.loadScene(i);
    },
    /** 立即把击杀数推到阈值下一点，用来验证过场与场景循环。 */
    setKills: (n) => { game.enemies.kills = n; game.carryKills = n; },
    /** 手动触发过场。 */
    transition: () => game.beginSceneTransition(),
    /** 只换天气不换场景（核对不同天气下的画面表现）。 */
    setWeather: (k) => game.setWeather(k),
    /** 清空敌人（只想看场景本身时用）。 */
    clearEnemies: () => game.enemies.clear(),
    /** 把玩家放回当前场景的推荐站位。 */
    resetPlayer: () => {
      const sp = game.sceneDef?.spawnPlayer;
      if (sp) game.player.spawnAt(sp[0], sp[1], sp[2], sp[3]);
      game.player.pitch = -0.06;
    },
    /** 切换画质档位（低/中/高）。 */
    quality: (q) => {
      game.renderer.qualityName = q;
      game.post({ type: 'fps', fps: 0 });
      return q;
    },
    scenes: SCENES.map(s => ({ key: s.key, name: s.name })),
    weapons: Object.keys(WEAPONS),
  };

  // 游戏态：window.wallpaper 不存在；壁纸态：window.meadow 也不存在，
  // 统一暴露为 window.wallpaper（宿主只认这一个名字）
  window.wallpaper = {
    reveal: () => {
      document.body.style.opacity = '1';
      game.post({ type: 'ready' });
    },
    stats: () => api.stats(),
  };
  window.gameApi = api;

  // 画布点击进游戏（指针锁定需要用户手势，指针锁定必须在手势里请求）
  canvas.addEventListener('click', () => {
    if (game.mode === 'game' && !game.pointerLocked && !game.transitioning) {
      game.requestLock();
    }
  });
} catch (err) {
  fatal(err);
}
