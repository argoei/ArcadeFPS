"""第十一轮修改的单元测试：子弹弹道 / 手榴弹弹跳 / 移动速度 / 敌人攀爬。

与 smoke_test（集成）和 test_edge（边界/异常）互补，这里针对本轮改动的具体函数
做行为级验证。
用法：python tools/test_round11.py [--headed]
"""
import asyncio
import functools
import http.server
import json
import os
import pathlib
import socketserver
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "src" / "ArcadeFPS" / "web"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
    os.environ.pop(k, None)
from playwright.async_api import async_playwright  # noqa: E402

FAILURES = []
CHECKS = 0


def check(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    print(f"  [{ 'PASS' if cond else 'FAIL' }] {name}" + (f"  -- {detail}" if detail else ""))
    if not cond:
        FAILURES.append(f"{name}: {detail}")
    return cond


def find_chromium():
    base = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"
    if base.is_dir():
        for d in sorted(base.glob("chromium-*"), reverse=True):
            for cand in (d / "chrome-win64" / "chrome.exe", d / "chrome-win" / "chrome.exe"):
                if cand.exists():
                    return str(cand)
    return None


class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_a):
        pass


def serve():
    handler = functools.partial(H, directory=str(WEB))
    socketserver.TCPServer.allow_reuse_address = True
    s = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    s.daemon_threads = True
    threading.Thread(target=s.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{s.server_address[1]}"
    import time, urllib.request
    for _ in range(25):   # 健康检查：监听未就绪时页面加载失败会产生大量误报
        try:
            urllib.request.urlopen(base + "/index.html", timeout=1)
            break
        except Exception:
            time.sleep(0.2)
    else:
        raise RuntimeError("HTTP server failed to start")
    return s, base


async def main(headed=False):
    srv, base = serve()
    try:
        async with async_playwright() as pw:
            exe = find_chromium()
            kw = dict(headless=not headed, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-gl=angle"])
            if exe:
                kw["executable_path"] = exe
            b = await pw.chromium.launch(**kw)
            pg = await b.new_page(viewport={"width": 1280, "height": 720})
            pg.on("pageerror", lambda e: print("  [pageerror]", e))
            await pg.goto(f"{base}/index.html?mode=game&killGoal=30")
            await pg.wait_for_function("window.game && window.game.frameCount > 5", timeout=40000)

            print("\n== 1. 子弹弹道（muzzle 位置随朝向） ==")
            mz = await pg.evaluate("""() => {
              const g = window.game, p = g.player;
              p.yaw = 0; p.pitch = 0; p.syncCamera(0.016);
              const eye0 = [...p.eye];
              const m0 = g.muzzlePosition();
              p.pitch = -1.0; p.syncCamera(0.016);
              const mDown = g.muzzlePosition();
              p.pitch = 1.0; p.syncCamera(0.016);
              const mUp = g.muzzlePosition();
              return {eye0, m0, mDown, mUp,
                      fwd0: m0[2] < eye0[2],   // 平视枪口在眼睛前方（z 减小）
                      low0: m0[1] < eye0[1],   // 枪口在眼睛下方
                      right0: m0[0] > eye0[0], // 枪口偏右
                      // 修复后：枪口 y 固定（不随 pitch 漂移），始终与 viewmodel 对齐
                      yStableDown: Math.abs(mDown[1] - m0[1]) < 0.001,
                      yStableUp: Math.abs(mUp[1] - m0[1]) < 0.001};
            }""")
            check("平视枪口在眼睛前方", mz["fwd0"], json.dumps({k: [round(v,2) for v in mz[k]] for k in ('eye0','m0')}))
            check("平视枪口在眼睛下方", mz["low0"])
            check("平视枪口偏右", mz["right0"])
            check("朝下看枪口 y 稳定（不随 pitch 漂移）", mz["yStableDown"], f'm0.y={mz["m0"][1]:.2f} down.y={mz["mDown"][1]:.2f}')
            check("朝上看枪口 y 稳定（不随 pitch 漂移）", mz["yStableUp"], f'm0.y={mz["m0"][1]:.2f} up.y={mz["mUp"][1]:.2f}')

            print("\n== 2. 手榴弹平台弹跳 ==")
            nade = await pg.evaluate("""async () => {
              const g = window.game;
              // 造一个 2m 高的平台障碍，模拟"第二层平台"
              g.scene.obstacles.push({min: [-3, 0, 8], max: [3, 2, 10]});
              // 在平台顶面（y=2）上方投一颗手榴弹，vy 向下
              g.projectiles.push({kind:'grenade', w: {bounce:0.42, friction:0.72, kind:'grenade'},
                x: 0, y: 2.6, z: 9, vx: 0, vy: -4, vz: 0, bounces: 0,
                fuse: 10, spin:[8,6,5], rot:[0,0,0], dead:false});
              // 手动步进若干帧，看它是否在平台顶面（y≈2）弹跳而非穿过
              let minY = 1e9;
              for (let i = 0; i < 120; i++) {
                g.updateProjectiles(1/60);
                const p = g.projectiles[0];
                if (!p) break;
                minY = Math.min(minY, p.y);
                if (p.bounces > 0) break;   // 已经弹跳了一次
              }
              const p = g.projectiles[0];
              // 清理
              g.projectiles.length = 0;
              g.scene.obstacles.pop();
              return {minY, bounced: p ? p.bounces > 0 : false, finalY: p ? p.y : null};
            }""")
            check("手榴弹在平台顶面弹跳（未穿过平台掉到 0 以下）", nade["bounced"] and nade["minY"] > 1.0,
                  f'minY={nade["minY"]:.2f} bounced={nade["bounced"]}')

            print("\n== 3. 移动速度 ==")
            spd = await pg.evaluate("""() => {
              const g = window.game;
              // 直接驱动 player.update 求步行速度：给前进输入，跑一帧看位移
              const p = g.player;
              p.pos = [0, 0, 16]; p.vel = [0,0,0]; p.yaw = 0;
              const input = {forward: true, back: false, left: false, right: false,
                             jump: false, sprint: false, crouch: false};
              // 跑若干帧让速度收敛到目标
              for (let i = 0; i < 30; i++) p.update(1/60, input, [], null, [100,100,100]);
              const walkSpeed = Math.hypot(p.vel[0], p.vel[2]);
              // 冲刺速度
              p.pos = [0,0,16]; p.vel = [0,0,0];
              const input2 = {...input, sprint: true};
              for (let i = 0; i < 30; i++) p.update(1/60, input2, [], null, [100,100,100]);
              const sprintSpeed = Math.hypot(p.vel[0], p.vel[2]);
              // 敌人最快速度（runner）
              const runner = 4.1;
              return {walkSpeed: +walkSpeed.toFixed(2), sprintSpeed: +sprintSpeed.toFixed(2),
                      walkFaster: walkSpeed > runner * 1.2,
                      sprintFaster: sprintSpeed > runner * 1.2, runner};
            }""")
            check("步行速度比最快敌人快 20%+", spd["walkFaster"],
                  f'步行 {spd["walkSpeed"]} vs runner {spd["runner"]}')
            check("冲刺速度比最快敌人快 20%+", spd["sprintFaster"],
                  f'冲刺 {spd["sprintSpeed"]} vs runner {spd["runner"]}')

            print("\n== 4. 敌人攀爬（跳跃上平台） ==")
            climb = await pg.evaluate("""async () => {
              const g = window.game;
              // 造一个 1m 高的平台障碍（可跳上），敌人放在平台前，玩家在平台后
              g.scene.obstacles.length = 0;
              g.scene.obstacles.push({min: [-3, 0, 8], max: [3, 1, 10]});
              g.enemies.clear();
              const e = g.enemies.spawn([0, 0, 5], 0);   // 敌人在平台前方（z=5）
              if (!e) return {err: 'spawn failed'};
              e.x = 0; e.z = 5; e.y = 0; e.onGround = true; e.vy = 0;
              e.def = {...e.def, speed: 2.3};
              // 玩家在平台后（z=12），敌人要追玩家必须翻过平台（z=8~10）
              g.player.pos = [0, 0, 12]; g.player.yaw = 0;
              const y0 = e.y;
              // 步进若干帧，敌人应跳跃上平台（y 增大到 1 附近）
              let maxY = 0;
              for (let i = 0; i < 300; i++) {
                g.enemies.update(1/60, g.player, g.scene.obstacles, () => {}, () => {});
                if (!e.alive) break;
                maxY = Math.max(maxY, e.y);
              }
              return {y0, maxY: +maxY.toFixed(2), climbed: maxY > 0.5};
            }""")
            check("敌人跳跃登上平台（y 升高到平台顶面）", climb["climbed"],
                  f'y0={climb["y0"]} maxY={climb["maxY"]}')

            await b.close()
    finally:
        srv.shutdown()

    print("\n" + "=" * 62)
    print(f"本轮单元测试：断言 {CHECKS} 项，失败 {len(FAILURES)} 项")
    for f in FAILURES:
        print("  ✗", f)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main("--headed" in sys.argv)))
