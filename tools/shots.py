"""场景截图工具：不跑玩法断言，只干净地渲染每个场景，便于人工核对画面。

用法：
    python tools/shots.py                 # 全部场景，默认 640x360 快速预览
    python tools/shots.py --w 1280 --h 720
    python tools/shots.py --scene forest --weather storm
"""
import sys, pathlib, asyncio, argparse
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from smoke_test import serve_forever, find_chromium  # noqa
from playwright.async_api import async_playwright

OUT = pathlib.Path(__file__).resolve().parent.parent / "shots"


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--w", type=int, default=960)
    ap.add_argument("--h", type=int, default=540)
    ap.add_argument("--scene", default=None)
    ap.add_argument("--weather", default=None)
    ap.add_argument("--settle", type=int, default=900, help="等待渲染稳定的毫秒")
    ap.add_argument("--killgoal", type=int, default=999)
    args = ap.parse_args()

    OUT.mkdir(exist_ok=True)
    httpd, base = await asyncio.get_running_loop().run_in_executor(None, serve_forever)
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path=find_chromium(),
                                     args=["--use-gl=angle", "--use-angle=swiftshader",
                                           "--enable-unsafe-swiftshader"])
        pg = await b.new_page(viewport={"width": args.w, "height": args.h})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"{base}/index.html?mode=game&w={args.w}&h={args.h}"
                      f"&killGoal={args.killgoal}")
        await pg.wait_for_function("window.game && window.game.frameCount > 3", timeout=60000)

        keys = await pg.evaluate(
            "window.gameApi.scenes.map(s => typeof s === 'string' ? s : s.key)")
        todo = [args.scene] if args.scene else keys
        for k in todo:
            await pg.evaluate(f"window.gameApi.goto('{k}')")
            if args.weather:
                await pg.evaluate(f"window.gameApi.setWeather('{args.weather}')")
            # 把玩家放到场景的推荐站位并清空敌人，避免拍到贴脸的墙或糊脸的敌人
            await pg.evaluate("""() => {
              window.gameApi.clearEnemies();
              window.gameApi.resetPlayer();
            }""")
            await pg.wait_for_timeout(args.settle)
            info = await pg.evaluate("""() => {
              const g = window.game;
              return {scene: g.sceneDef.name, weather: g.weather?.label,
                      fps: +g.fps?.toFixed(1), draws: g.renderer.drawCalls};
            }""")
            path = OUT / f"s_{k}_{info['weather']}.png".replace("/", "")
            await pg.screenshot(path=str(path))
            print(f"  {k:10s} {info['scene']:8s} {str(info['weather']):4s} "
                  f"{info['fps']} fps  draws={info['draws']}  -> {path.name}")
        if errs:
            print("  [pageerror]", errs[:3])
        await b.close()
    httpd.shutdown()


if __name__ == "__main__":
    asyncio.run(main())