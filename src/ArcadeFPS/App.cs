using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace ArcadeFPS;

/// <summary>
/// 编排器。产品形态有两条互斥的呈现路径，共用一个进程与一个浏览器环境：
///
///   壁纸态（常驻）
///     WallpaperLayer 窗口 → SetParent 到 WorkerW → WebView2(mode=wallpaper)
///     静态场景、低帧率渲染、不抢焦点、不吃键盘。屏幕上就是一张会缓慢横移的画面。
///
///   游戏态（点击后）
///     点击被鼠标轮询捕获 → 新建 GameLayer 窗口（可获焦点）→ WebView2(mode=game)
///     指针锁定、全帧率、HUD 常驻。Esc 或页面 quit → 销毁游戏层，回到壁纸态。
///
/// 为什么必须两条 HWND 而不是一条：WorkerW 里的窗口收不到键盘 ——
/// 壁纸层 WS_EX_NOACTIVATE 不抢焦点，WASD 永远送不进去。这是 Win32 的硬约束，
/// 不是实现取舍。因此"点一下才启动游戏"只能靠第二条可获焦点的窗口。
/// </summary>
internal sealed class App
{
    private readonly string _webDir;
    private int _killGoal;
    private readonly bool _autostart;

    private IntPtr _wallpaperHwnd = IntPtr.Zero;
    private WebLayer? _wallpaper;
    private IntPtr _workerW = IntPtr.Zero;

    private IntPtr _gameHwnd = IntPtr.Zero;
    private WebLayer? _game;

    private Thread? _mouseThread;
    private volatile bool _running = true;
    private volatile bool _clickLatched;   // 边沿触发，避免按住不放时反复启动游戏

    private readonly System.Windows.Forms.Timer _statusTimer = new() { Interval = 1000 };

    public App(string webDir, int killGoal, bool autostart = false)
    {
        _webDir = webDir;
        _killGoal = killGoal;
        _autostart = autostart;
    }

    /// <summary>
    /// UI 线程调度器。WebView2 的 CoreWebView2 成员只能在创建 Environment 的
    /// 线程（UI 线程）上访问；游戏层窗口也必须由有消息泵的线程创建。
    /// 鼠标轮询线程发现点击后只能"投递"到 UI 线程，绝不能直接调 ToggleGameAsync ——
    /// 直接调会 FATAL "CoreWebView2 members can only be accessed from the UI thread"，
    /// 游戏层永远起不来（实测日志 00:24:08.998）。
    /// </summary>
    private SynchronizationContext? _ui;

    public void Start()
    {
        Log.Info("=== ARCADE FPS 启动 ===");
        Log.Info($"屏幕 {SystemInformation.PrimaryMonitorSize.Width}x{SystemInformation.PrimaryMonitorSize.Height}");

        // 必须在消息循环内捕获（Program.cs 用 Application.Idle 起动，此刻上下文已就位）
        _ui = SynchronizationContext.Current;
        if (_ui == null) Log.Warn("未取到 UI 线程 SynchronizationContext，游戏层可能无法启动");

        _workerW = DesktopHost.FindWorkerW();

        var b = Screen.PrimaryScreen?.Bounds ?? new Rectangle(0, 0, 1920, 1080);
        _wallpaperHwnd = RawWindow.CreateWallpaperLayer(b);
        _wallpaper = new WebLayer("wallpaper", _wallpaperHwnd, _webDir);
        _wallpaper.Signal += OnWallpaperSignal;
        _wallpaper.QuitRequested += RequestExit;
        _ = StartWallpaperAsync(b);

        /* 壁纸层在图标层之下收不到鼠标事件，必须轮询全局按键状态。
         * 只读不吞：桌面上原有的点击（选图标、打开文件）完全不受影响。 */
        _mouseThread = new Thread(MouseWatchLoop)
        {
            IsBackground = true,
            Name = "MouseWatch"
        };
        _mouseThread.Start();

        _statusTimer.Tick += (_, _) => LogStatus();
        _statusTimer.Start();

        if (_autostart)
        {
            // 测试用：自动进游戏，验证"UI 线程 + 游戏层 WebView2"链路。
            var auto = new System.Windows.Forms.Timer { Interval = 2500 };
            auto.Tick += (_, _) => { auto.Stop(); auto.Dispose(); _ui?.Post(_ => _ = ToggleGameAsync(), null); };
            auto.Start();
            Log.Info("（--autostart 测试模式：2.5 秒后自动进游戏）");
        }

        Log.Info("编排器就绪：壁纸态运行中，等待鼠标点击启动游戏");
    }

    private async Task StartWallpaperAsync(Rectangle b)
    {
        try
        {
            await _wallpaper!.StartAsync(b.Width, b.Height, _killGoal);

            /* 必须等 WebView2 首帧画完再挂载。先挂载的话 Chromium 的
             * DirectComposition 视觉会挂到跨进程父窗口的合成树上，画面能渲染
             * 但不会更新到屏幕 —— 表现为"壁纸静止不动"。 */
            if (DesktopHost.Attach(_wallpaperHwnd, _workerW, b))
                Log.Info("壁纸层已挂到桌面层");
            else
                Log.Warn("壁纸层挂载失败");

            // 挂载完让页面收掉起始遮罩，多留 350ms 给合成器把首帧真正呈现出来
            await Task.Delay(350);
            await _wallpaper.ExecuteAsync("window.wallpaper && window.wallpaper.reveal()");
            Log.Info("壁纸态已就绪");
        }
        catch (Exception ex)
        {
            Log.Fatal(ex);
        }
    }

    /* ------------------------------------------------------------ 鼠标轮询 */

    private void MouseWatchLoop()
    {
        Native.POINT last = new();
        Native.GetCursorPos(out last);
        int idleTicks = 0;

        while (_running)
        {
            try
            {
                // 壁纸层收不到鼠标事件，这里只读全局按键状态
                bool down = (Native.GetAsyncKeyState(Native.VK_LBUTTON) & 0x8000) != 0;

                if (down && !_clickLatched)
                {
                    _clickLatched = true;
                    if (IsDesktopBlankClick(out var pt))
                    {
                        Log.Info($"捕获到桌面空白点击 @ {pt.X},{pt.Y}");
                        // WebView2/窗口创建都必须在 UI 线程做，轮询线程只投递
                        _ui?.Post(_ => _ = ToggleGameAsync(), null);
                    }
                    // 点中图标 / 任务栏 / 其他应用：完全不动作，
                    // 让点击走它本来该去的窗口（这也是"不吞噬鼠标"的关键）
                }
                else if (!down)
                {
                    _clickLatched = false;
                }

                // 光标移动检测：用于让页面知道"鼠标在动"，从而淡出提示文字
                if (Native.GetCursorPos(out var cur) && (cur.X != last.X || cur.Y != last.Y))
                {
                    last = cur;
                    idleTicks = 0;
                }
                else if (++idleTicks > 300)   // 约 6 秒无移动
                {
                    idleTicks = 301;
                }

                Thread.Sleep(20);   // 20ms 轮询，人手最短点击 >60ms，不会漏
            }
            catch (Exception ex)
            {
                Log.Fatal(ex);
                Thread.Sleep(200);
            }
        }
        Log.Info("鼠标轮询线程退出");
    }

    /// <summary>
    /// 这次左键按下是否为"点击了桌面空白处"。
    ///
    /// 判定依据是**鼠标位置下的窗口**，而不是"前台窗口"：
    /// 点击桌面的瞬间焦点还没切换，GetForegroundWindow 仍是上一个程序
    /// （实测前台是 Chrome_WidgetWin_0 时点击桌面被误杀），
    /// 用前台窗口判断会漏掉用户真正的桌面点击。
    ///
    /// 两个条件缺一不可：
    ///   1. 鼠标位置下的窗口是桌面图标层（SysListView32）—— 点任务栏/其他程序
    ///      时窗口不是 SysListView32，自然不触发；
    ///   2. 向 SysListView32 发 LVM_HITTEST 确认未命中图标 —— 点图标就交给图标。
    /// </summary>
    private bool IsDesktopBlankClick(out Native.POINT pt)
    {
        pt = new Native.POINT();
        Native.GetCursorPos(out pt);

        // 条件 1：鼠标位置下的窗口是桌面图标层
        IntPtr under = Native.WindowFromPoint(pt);
        if (under == IntPtr.Zero) return false;
        string cls = Native.GetWindowClassName(under);
        if (cls != "SysListView32") return false;

        // 条件 2：未命中桌面图标（LVM_HITTEST = 0x1012，iItem < 0 表示空白处）
        var info = new Native.LVHITTESTINFO
        {
            pt = new Native.POINT { X = pt.X, Y = pt.Y },
        };
        Native.ScreenToClient(under, ref info.pt);
        Native.SendMessageRef(under, 0x1012, IntPtr.Zero, ref info);
        return info.iItem < 0;
    }

    /* ------------------------------------------------------------ 游戏层 */

    private readonly SemaphoreSlim _gameGate = new(1, 1);

    private async Task ToggleGameAsync()
    {
        await _gameGate.WaitAsync();
        try
        {
            if (_game != null) { EndGame(); return; }
            await StartGameAsync();
        }
        catch (Exception ex)
        {
            Log.Fatal(ex);
        }
        finally
        {
            _gameGate.Release();
        }
    }

    private async Task StartGameAsync()
    {
        var screen = Screen.PrimaryScreen?.Bounds ?? new Rectangle(0, 0, 1920, 1080);

        // 先建局部实例，WebView2 初始化**成功后才**赋值给字段。
        // 之前 _game/_gameHwnd 在 await StartAsync 之前就赋值，一旦 CreateCoreWebView2ControllerAsync
        // 抛异常（UI 线程/运行时缺失），字段就残留一个半初始化实例，下次点击会走 EndGame
        // 分支去 Dispose 一个没建好的 controller，状态彻底错乱。
        var hwnd = RawWindow.CreateGameLayer(screen);
        RawWindow.MarkAsGameLayer(hwnd);
        var game = new WebLayer("game", hwnd, _webDir);
        game.Signal += OnGameSignal;
        game.QuitRequested += RequestExit;

        int w = screen.Width;
        int h = screen.Height;
        try
        {
            await game.StartAsync(w, h, _killGoal);
        }
        catch
        {
            // 初始化失败：回滚，字段保持 null，下次点击重新走启动路径
            game.Signal -= OnGameSignal;
            game.QuitRequested -= RequestExit;
            game.Dispose();
            RawWindow.Destroy(hwnd);
            throw;
        }

        _gameHwnd = hwnd;
        _game = game;

        // 光标锁定由页面 requestPointerLock 完成；这里额外夹一下位置，
        // 防止焦点抖动时光标飘出窗口导致指针锁定被浏览器自动解除
        var rc = new Native.RECT { Left = screen.Left, Top = screen.Top, Right = screen.Right, Bottom = screen.Bottom };
        Native.ClipCursor(ref rc);

        // 隐藏光标。ShowCursor 返回**递减后的显示计数**：>=0 表示仍可见，<0 表示已隐藏。
        // 原写法 `while (ShowCursor(false) != 0)` 是必然死循环 —— 隐藏态的计数是 -1、-2…，
        // 永远不会等于 0，UI 线程直接卡死（真机日志 AppHangB1，5 秒后 WER 挂起报告）。
        // 正确语义是循环到计数 < 0，并加守卫上限防止计数被其他程序干扰时意外卡死。
        for (int i = 0; i < 8 && Native.ShowCursor(false) >= 0; i++) { }

        Log.Info("进入游戏态");
    }

    private void EndGame()
    {
        if (_game == null) return;
        Log.Info("退出游戏态，回到壁纸");

        // 解除光标限制。不能用 {-1,-1,0,0} 这种无效矩形 —— ClipCursor 会返回 FALSE、
        // 限制不解除（多显示器下退出游戏后鼠标会被锁在主屏出不去）。
        // 正确做法：传覆盖**整个虚拟屏**的有效矩形。
        var vs = SystemInformation.VirtualScreen;
        var full = new Native.RECT { Left = vs.Left, Top = vs.Top, Right = vs.Right, Bottom = vs.Bottom };
        Native.ClipCursor(ref full);
        // 恢复光标：ShowCursor(true) 递增计数，<0 表示仍隐藏，循环到 >=0（可见）。
        // 同样加守卫上限。
        for (int i = 0; i < 8 && Native.ShowCursor(true) < 0; i++) { }

        _game.Signal -= OnGameSignal;
        _game.QuitRequested -= RequestExit;
        _game.Dispose();
        _game = null;

        RawWindow.Destroy(_gameHwnd);
        _gameHwnd = IntPtr.Zero;

        // 让桌面重新拿到焦点，否则任务栏/图标会一直处于非激活态
        Native.SetForegroundWindow(_workerW);
    }

    private void OnWallpaperSignal(string sig)
    {
        switch (sig)
        {
            case "startgame":
                _ = ToggleGameAsync();
                break;
            case "quit":
                RequestExit();
                break;
        }
    }

    private void OnGameSignal(string sig)
    {
        switch (sig)
        {
            case "endgame":
                _ = ToggleGameAsync();
                break;
            case "quit":
                RequestExit();
                break;
        }
    }

    /* ------------------------------------------------------------ 状态与退出 */

    private void LogStatus()
    {
        var w = _wallpaper;
        var g = _game;
        Log.Info($"[状态] 壁纸 fps={w?.Fps ?? 0} 场景={w?.SceneName ?? "-"} | " +
                 $"游戏 {(g == null ? "未运行" : $"fps={g.Fps} 击杀={g.Kills} 场景={g.SceneName}")}");
    }

    private void RequestExit()
    {
        if (!_running) return;
        _running = false;
        Log.Info("收到退出请求");
        ExitRequested?.Invoke();
    }

    /// <summary>托盘「进入游戏」入口。与桌面点击同一条链路，必须投递到 UI 线程。</summary>
    public void EnterGame()
    {
        _ui?.Post(_ => _ = ToggleGameAsync(), null);
    }

    /// <summary>托盘「退出」入口。</summary>
    public void RequestQuit() => RequestExit();

    /// <summary>击杀目标（设置对话框可改）。运行时改后下次进游戏生效。</summary>
    public int KillGoal
    {
        get => _killGoal;
        set => _killGoal = Math.Clamp(value, 1, 999);
    }

    /// <summary>是否正在游戏中（托盘状态用）。</summary>
    public bool GameRunning => _game != null;

    public event Action? ExitRequested;

    public void Shutdown()
    {
        _running = false;
        _statusTimer.Stop();
        EndGame();
        if (_wallpaper != null)
        {
            _wallpaper.Signal -= OnWallpaperSignal;
            _wallpaper.QuitRequested -= RequestExit;
            _wallpaper.Dispose();
            _wallpaper = null;
        }
        RawWindow.Destroy(_wallpaperHwnd);
        _wallpaperHwnd = IntPtr.Zero;
        _mouseThread?.Join(500);
        Log.Info("=== ARCADE FPS 退出 ===");
    }
}
