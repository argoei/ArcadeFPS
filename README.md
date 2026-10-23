# Arcade FPS —— 桌面动态壁纸 · 像素风街机射击

以 Windows 动态壁纸形式呈现的第一人称射击游戏。平时是静态的场景壁纸，
**鼠标点击桌面空白处即进入游戏**，退出后回到壁纸状态。

**美术方向：《我的世界》体素风** —— 方块堆叠的地形、16×16 像素贴图、
面朝向光照、距离雾。程序化生成最合适的形态。

- 宿主：.NET 8 + WinForms 消息循环 + WebView2（复用 GhibliMeadow 壁纸框架）
- 渲染：WebGL2 实例化渲染 + 体素面光照 + NEAREST 像素贴图
- 资源：**全部程序化生成**（几何 + 像素贴图），零外部素材依赖

---

## 快速开始

```bat
build.cmd          :: 构建 Release
run.cmd            :: 启动
```

或命令行：

```bat
dotnet build src\ArcadeFPS\ArcadeFPS.csproj -c Release
src\ArcadeFPS\bin\Release\net8.0-windows\win-x64\ArcadeFPS.exe
```

### 启动参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `--killGoal=N` | 达到 N 击杀后过场切场景 | 30 |
| `--web=DIR` | 指定前端资源目录 | exe 同级 `web\` |
| `--autostart` | 启动 2.5 秒后自动进游戏（调试用） | 关 |
| `--quiet` | 静默（出错不弹窗） | 关 |

---

## 操作

| 输入 | 行为 |
|---|---|
| **鼠标左键点击桌面空白处** | 进入游戏（指针锁定）。点图标/任务栏/其他程序**不会**触发 |
| 左键单击 / 按住 | 单发 / 连发（依武器） |
| 鼠标右键 | 循环切换武器 |
| `W A S D` | 移动 |
| 鼠标移动 | 转向 |
| `Esc` | 退出游戏，回到壁纸 |

> **为什么必须是两条窗口**：壁纸窗口挂在 WorkerW 层（桌面图标之下），
> 该层窗口带 `WS_EX_NOACTIVATE` 不抢焦点，**收不到键盘输入**，鼠标事件也被
> `SysListView32` 吃掉。所以"点一下才进游戏"无法在壁纸层内完成，
> 只能另起一个可获焦点的弹出窗口。这是 Win32 的硬约束，不是实现取舍。
>
> **点击判定**：宿主轮询全局左键状态后，先确认（1）前台窗口是桌面本体
> （Progman/WorkerW），（2）向 `SHELLDLL_DefView` 发 `LVM_HITTEST` 确认
> 未命中任何图标，两个条件都满足才启动游戏。否则点击原样交给目标窗口。
> 另外 WebView2 的所有成员访问都必须在 UI 线程上做，轮询线程只负责投递。

---

## 场景与天气

4 个体素世界（全部室外），fBm 噪声地形 + 方块堆叠：

| 场景 | 内容 |
|---|---|
| 方块草原 | 草地 + 树 + 彩色花 |
| 方块山地 | 石头山 + 雪顶 |
| 方块沙漠 | 沙丘 + 仙人掌 |
| 方块遗迹 | 草地 + 圆石残墙 |

天气 8 种：晴 / 阴 / 雨 / 雷雨 / 雪 / 雾 / 黄昏 / 夜。

击杀数达到阈值 → 播放过场动画（黑条扫入 → STAGE CLEAR → 倒数 → 换场景）→ 下一场景。

## 武器

| 武器 | 射速 | 伤害 | 特性 |
|---|---|---|---|
| 手枪 | 380 RPM | 34 | 半自动，精准 |
| 步枪 | 780 RPM | 22 | **全自动**，高射速低单发 |
| 霰弹枪 | 78 RPM | 17 × 9 弹丸 | 近距离爆发，范围杀伤 |
| 手榴弹 | 55 RPM | 150（半径 7.5m） | 引信 2.1s，抛物线 + 弹跳 |
| 火箭筒 | 42 RPM | 260 直击 / 180 溅射（半径 10.5m） | 单发装填，爆炸范围最大 |

各枪独立弹药，切枪保留弹量；后坐力影响射击方向与相机，但**不污染玩家意图朝向**
（回正后视角精确回到原处）。

---

## 性能设计

- **实例化绘制**：每种几何一个 batch，draw call 从 1000+ 降到 20~30
- **阴影范围跟随玩家**：把整张地图塞进 2048² 阴影贴图等于没有阴影
- **粒子 SoA 池**（3600 上限，Float32Array 并行数组）：避免每帧 GC
- **阻力与帧率解耦**：`pow(drag, dt*60)`，不同帧率下手感一致
- **后坐回正用临界阻尼弹簧解析解**：显式欧拉在 `dt > 2/ω` 时会过冲，
  掉帧时后坐会被打成负数再钳零（表现为"低帧率下没有后坐"），闭式解对任意 dt 稳定
- **攻击名额**：同时最多 3 个敌人可贴身进攻，其余在外围游走。
  否则 8 敌围殴 DPS 约 68，玩家 1.5 秒暴毙，完全没有射击空间

---

## 工程结构

```
src/ArcadeFPS/            宿主层（C#）
  Program.cs              入口、单实例互斥、异常入日志
  App.cs                  双态编排：壁纸层 <-> 游戏层
  Native.cs               Win32 互操作
  RawWindow.cs            裸 Win32 窗口（两个类：壁纸 / 游戏）
  DesktopHost.cs          WorkerW 桌面层挂载
  WebLayer.cs             WebView2 封装、消息收发
  Log.cs                  单行追加 + 2MB 轮转
  app.manifest            PerMonitorV2 DPI +独显优先

  web/                    前端（ES module）
    js/core/              math.js  gl.js
    js/render/            geometry.js  textures.js  shaders.js
                          renderer.js  particles.js
    js/game/              scenes.js  enemies.js  weapons.js
                          player.js  hud.js  game.js
    js/main.js            入口 + 宿主/调试接口

tools/
  smoke_test.py           无头验收（44 项断言）
  shots.py                场景截图
```

日志：`%LOCALAPPDATA%\ArcadeFPS\game.log`

---

## 验收

```bat
python tools\smoke_test.py --shots
```

44 项断言，覆盖：WebGL2 启动、8 场景构建、敌人生成/横移/扑近、
5 武器参数互异、开火火光与命中、爆炸范围杀伤、HUD 右上角计数、
过场与场景循环、帧率与 draw call、壁纸模式。

无头环境用 SwiftShader 软件光栅化，**帧率数字不代表真机性能**，
只用来确认渲染循环在推进、`preserveDrawingBuffer` 关闭时也能稳定出图。

场景截图核对：

```bat
python tools\shots.py                     :: 全部 8 个场景
python tools\shots.py --scene forest --weather storm
```

---

## 已知限制

- **宿主侧尚未实机验证**：WorkerW 挂载、指针锁定、GPU 帧时间分布（p50/p95）
  只在无头浏览器里验过逻辑，真机需首次运行时确认
- 全屏无边框 HWND 上 Chromium 的 D3D11 翻转模型是否被禁用，未打包票；
  以真机帧时间分布为准
- 无头双页面会争抢软件光栅化资源，验收脚本已改为先关游戏页再开壁纸页
---

## 打包 Windows 安装包

配置与 GhibliMeadow 一致（Inno Setup 6，框架依赖版 + .NET 8 / WebView2 依赖检测，
用户级安装免管理员权限）：

```bat
package-installer.cmd
```

产物：`release\ArcadeFPS-Setup-1.0.0.exe`（约 2.5 MB）。

安装器行为：
- 装到 `%LocalAppData%\Programs\ArcadeFPS`（无需管理员）
- 开始菜单 + 可选桌面快捷方式；卸载时结束进程并清理 `%LocalAppData%\ArcadeFPS` 缓存
- 缺 .NET 8 Desktop Runtime / WebView2 时提示并可联动安装同目录的依赖包
  （`windowsdesktop-runtime-8.0.32-win-x64.exe` / `MicrosoftEdgeWebview2Setup.exe`）

手动编译：`ISCC.exe installer\ArcadeFPS.iss`（需先 `dotnet publish ... -o release\app`）
