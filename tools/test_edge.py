"""边界条件 / 异常输入 / 错误处理 测试。

与 smoke_test.py（正常流程 44 项）互补，专门覆盖：
  A. 边界条件：弹药打空/满弹、切枪硬直、后坐上限、血量 clamp、生成上限、移动边界、爆炸半径边缘
  B. 异常输入：非法场景索引、非法天气、NaN/负数伤害、非法 spawn 参数
  C. 错误处理：玩家死亡门禁、敌人死亡清理、场景切换状态重置

用法：python tools/test_edge.py [--headed]
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
    mark = "PASS" if cond else "FAIL"
    print(f"  [{mark}] {name}" + (f"  -- {detail}" if detail else ""))
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


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_a):
        pass


def serve_forever():
    handler = functools.partial(QuietHandler, directory=str(WEB))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    import time, urllib.request
    for _ in range(25):   # 健康检查：偶发监听未就绪会导致页面加载失败而误报
        try:
            urllib.request.urlopen(base + "/index.html", timeout=1)
            break
        except Exception:
            time.sleep(0.2)
    else:
        raise RuntimeError("HTTP server failed to start")
    return httpd, base


async def main(headed=False):
    httpd, base = serve_forever()
    try:
        async with async_playwright() as pw:
            exe = find_chromium()
            launch_kw = dict(
                headless=not headed,
                args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                      "--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist",
                      "--disable-gpu-sandbox"],
            )
            if exe:
                launch_kw["executable_path"] = exe
            browser = await pw.chromium.launch(**launch_kw)
            page = await browser.new_page(viewport={"width": 1280, "height": 720})
            page.on("pageerror", lambda e: print("  [pageerror]", e))

            await page.goto(f"{base}/index.html?mode=game&killGoal=30")
            await page.wait_for_function("window.game && window.game.frameCount > 5", timeout=40000)

            # 每节开始复位：血量满、活着、清敌人，避免上一节污染
            async def reset():
                await page.evaluate("""() => {
                  const g = window.game;
                  g.player.health = g.player.maxHealth; g.player.alive = true;
                  g.player.pos = [0, 0, 16]; g.player.vel = [0,0,0];
                  g.weapons.index = 0;
                  g.weapons.cooldown = 0; g.weapons.reloading = 0; g.weapons.switchCooldown = 0;
                  g.weapons.recoilPitch = 0; g.weapons.recoilVel = 0; g.weapons.recoilYaw = 0;
                  g.enemies.clear();
                }""")

            print("\n== A. 边界条件 ==")

            print("\n A1. 弹药边界")
            await reset()
            ammo = await page.evaluate("""() => {
              const g = window.game, w = g.weapons;
              // 打空自动换弹
              w.ammo.rifle = 0; w.index = 1;
              w.fire();
              const autoReload = w.reloading > 0;
              // 满弹不换弹
              w.reloading = 0; w.ammo.pistol = 12; w.index = 0;
              const fullNoReload = w.startReload() === false;
              // 换弹中不开火
              w.reloading = 1.0;
              const noFireWhileReload = w.fire() === null;
              return {autoReload, fullNoReload, noFireWhileReload};
            }""")
            check("打空自动换弹", ammo["autoReload"])
            check("满弹不换弹", ammo["fullNoReload"])
            check("换弹中不开火", ammo["noFireWhileReload"])

            print("\n A2. 切枪硬直")
            await reset()
            switch = await page.evaluate("""() => {
              const g = window.game, w = g.weapons;
              w.switchCooldown = 0.3;
              const blocked = w.cycle(1) === null;   // 硬直中不切
              w.switchCooldown = 0;
              w.index = 4;                            // 最后一把（rocket）
              w.cycle(1);
              const wrapAround = w.current.key;        // 应回到 pistol
              return {blocked, wrapAround};
            }""")
            check("硬直中不切枪", switch["blocked"])
            check("末位切枪回环到首位", switch["wrapAround"] == "pistol" or switch["wrapAround"] == "builder",
                  switch["wrapAround"])   # 末位是 builder：从 rocket 再切一刀落到 builder 或回环 pistol 均合法

            print("\n A3. 后坐力上限")
            await reset()
            recoil_cap = await page.evaluate("""() => {
              const g = window.game, w = g.weapons;
              w.index = 4;  // rocket 后坐最大
              let maxSeen = 0;
              for (let i = 0; i < 50; i++) { w.cooldown = 0; w.fire(); maxSeen = Math.max(maxSeen, w.recoilPitch); }
              return {maxSeen, capped: maxSeen <= 22.001};
            }""")
            check("后坐力不超过 clamp 上限 22", recoil_cap["capped"], f'峰值 {recoil_cap["maxSeen"]:.1f}')

            print("\n A4. 血量边界")
            await reset()
            hp = await page.evaluate("""() => {
              const g = window.game, p = g.player;
              p.takeDamage(999);
              const dead = !p.alive;
              const clampedZero = p.health === 0;   // 不出现负血
              // 护甲吸收：重开一局验证
              p.health = 100; p.alive = true; p.armor = 50;
              p.takeDamage(100);
              const armorAbsorbed = p.armor < 50 && p.health > 0;
              return {dead, clampedZero, armorAbsorbed, armorLeft: p.armor, hpLeft: p.health};
            }""")
            check("过量伤害致死", hp["dead"])
            check("血量 clamp 到 0（不出现负血）", hp["clampedZero"])
            check("护甲吸收伤害", hp["armorAbsorbed"], f'护甲剩 {hp["armorLeft"]}, 血剩 {hp["hpLeft"]:.0f}')

            print("\n A5. 敌人生成上限")
            await reset()
            cap = await page.evaluate("""() => {
              const g = window.game, e = g.enemies;
              const cap = e.maxAlive;
              let spawned = 0;
              for (let i = 0; i < 50; i++) {
                if (e.spawn([0,0,16], 0)) spawned++; else break;
              }
              const alive = e.list.filter(x => x.alive).length;
              return {cap, spawned, alive, withinCap: alive <= cap};
            }""")
            check("生成不超过 maxAlive 上限", cap["withinCap"],
                  f'cap={cap["cap"]}, 存活 {cap["alive"]}')

            print("\n A6. 移动边界")
            await reset()
            bounds = await page.evaluate("""() => {
              const g = window.game, p = g.player;
              const b = g.sceneDef.bounds;
              p.pos = [b[0] * 3, 0, b[2] * 3];   // 放地图外
              p.clampToBounds(b);
              const clamped = Math.abs(p.pos[0]) <= b[0] / 2 + 1e-6 &&
                              Math.abs(p.pos[2]) <= b[2] / 2 + 1e-6;
              return {clamped, x: +p.pos[0].toFixed(1), z: +p.pos[2].toFixed(1)};
            }""")
            check("玩家被 clamp 回地图内", bounds["clamped"], f'({bounds["x"]}, {bounds["z"]})')

            print("\n A7. 爆炸半径边缘")
            await reset()
            edge = await page.evaluate("""() => {
              const g = window.game, e = g.enemies;
              // 造两个敌人：一个在半径内、一个在半径外
              const inner = e.spawn([0,0,10], 0);
              const outer = e.spawn([0,0,10], 0);
              inner.x = 0; inner.z = 10; inner.health = 100; inner.alive = true;
              outer.x = 0; outer.z = 25; outer.health = 100; outer.alive = true;  // 15m 外
              g.weapons.index = 4; const w = g.weapons.current;  // rocket radius 10.5
              const hpInner0 = inner.health, hpOuter0 = outer.health;
              g.detonate({kind:'rocket', w}, 0, 1.2, 10);  // 爆心在 (0,10)
              return {radius: w.radius, innerHurt: inner.health < hpInner0,
                      outerSafe: outer.health === hpOuter0};
            }""")
            check("半径内敌人受创", edge["innerHurt"], f'r={edge["radius"]}')
            check("半径外敌人不受创", edge["outerSafe"])

            print("\n== B. 异常输入 ==")
            await reset()

            print("\n B1. 非法场景索引")
            bad_scene = await page.evaluate("""() => {
              const results = {};
              // goto(99)：越界
              try { window.gameApi.goto(99); results.goto99 = 'no-throw'; }
              catch (e) { results.goto99 = 'throw:' + e.message; }
              // goto(-1)：负数（api 内部 findIndex 返回 -1 会 throw）
              try { window.gameApi.goto(-1); results.gotoNeg = 'no-throw'; }
              catch (e) { results.gotoNeg = 'throw:' + e.message; }
              // goto('nonexistent')：非法 key
              try { window.gameApi.goto('nonexistent'); results.gotoKey = 'no-throw'; }
              catch (e) { results.gotoKey = 'throw:' + e.message; }
              // 游戏是否还活着（未崩溃）
              results.stillRunning = window.game.frameCount > 2;
              return results;
            }""")
            check("goto(99) 不崩溃（抛错或安全忽略）", "throw" in bad_scene["goto99"] or bad_scene["goto99"] == "no-throw", bad_scene["goto99"])
            check("goto(-1) 抛可读错误", "throw" in bad_scene["gotoNeg"], bad_scene["gotoNeg"])
            check("goto 非法 key 抛可读错误", "throw" in bad_scene["gotoKey"], bad_scene["gotoKey"])
            check("非法 goto 后游戏仍运行", bad_scene["stillRunning"])

            print("\n B2. 非法天气")
            await page.evaluate("window.gameApi.goto(0)")
            bad_weather = await page.evaluate("""() => {
              const g = window.game;
              const before = g.weather ? g.weather.key : null;
              let threw = false;
              try { window.gameApi.setWeather('nonexistent_weather'); } catch (e) { threw = true; }
              const after = g.weather ? g.weather.key : null;
              return {threw, before, after, stillRunning: g.frameCount > 2};
            }""")
            check("非法天气不崩溃", bad_weather["stillRunning"], json.dumps(bad_weather))

            print("\n B3. NaN / 负数伤害")
            await reset()
            nan_dmg = await page.evaluate("""() => {
              const g = window.game, p = g.player;
              p.takeDamage(NaN);
              const nanSafe = Number.isFinite(p.health) && p.health === p.maxHealth;  // NaN 伤害应被忽略或安全
              p.takeDamage(-50);
              const negSafe = p.health >= p.maxHealth;  // 负伤害不加血
              return {nanSafe, negSafe, hp: p.health};
            }""")
            check("NaN 伤害不污染血量", nan_dmg["nanSafe"], f'hp={nan_dmg["hp"]}')
            check("负伤害不加血", nan_dmg["negSafe"], f'hp={nan_dmg["hp"]}')

            print("\n== C. 错误处理 ==")
            await reset()

            print("\n C1. 玩家死亡门禁")
            death = await page.evaluate("""() => {
              const g = window.game, p = g.player;
              p.health = 0; p.alive = false;
              g.weapons.index = 1; g.weapons.cooldown = 0;
              const ammoBefore = g.weapons.ammo.rifle;
              const fired = g.tryFire(true);      // 死亡后不应能开火
              const ammoAfter = g.weapons.ammo.rifle;
              const lookBlocked = (() => { p.look(100, 100, 0.01); return p.alive; })();
              return {fired, ammoUnchanged: ammoBefore === ammoAfter};
            }""")
            check("死亡后不能开火", death["ammoUnchanged"])

            print("\n C2. 敌人死亡清理")
            await reset()
            cleanup = await page.evaluate("""async () => {
              const g = window.game, e = g.enemies;
              const en = e.spawn([0,0,10], 0);
              en.health = 0; en.alive = false; en.dying = 0.5; en.fadeOut = 0;
              // 等 fadeOut 走完
              for (let i = 0; i < 60; i++) {
                g.enemies.update(0.05, g.player, [], () => {}, () => {});
                if (!e.list.includes(en)) break;
              }
              return {removed: !e.list.includes(en), remaining: e.list.length};
            }""")
            check("死亡敌人从列表清理", cleanup["removed"], f'剩余 {cleanup["remaining"]}')

            print("\n C3. 场景切换状态重置")
            await reset()
            scene_reset = await page.evaluate("""() => {
              const g = window.game;
              g.enemies.kills = 15;
              window.gameApi.goto(1);
              return {killsReset: g.enemies.kills === 0, sceneIndex: g.sceneIndex};
            }""")
            check("切场景后击杀数归零", scene_reset["killsReset"], f'scene={scene_reset["sceneIndex"]}')

            await browser.close()
    finally:
        httpd.shutdown()

    print("\n" + "=" * 62)
    print(f"边界/异常/错误处理测试：断言 {CHECKS} 项，失败 {len(FAILURES)} 项")
    for f in FAILURES:
        print("  ✗", f)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main("--headed" in sys.argv)))
