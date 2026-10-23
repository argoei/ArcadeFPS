using System;
using System.Drawing;
using System.Globalization;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace ArcadeFPS;

/// <summary>
/// 一块 WebView2 面。壁纸层与游戏层各持有一个实例，共用同一个浏览器环境
/// （同一个 Chromium 进程组），因此两层的 GPU 上下文是共享的。
///
/// 两种 mode 决定页面走哪条主循环：
///   · "wallpaper" —— 静态壁纸。低帧率、无人交互、只有场景缓慢横移与提示文字；
///   · "game"      —— 可操作游戏。指针锁定、全帧率、HUD 常驻。
/// 页面按 URL 的 mode 参数自行分流，宿主只负责把它送到正确的层。
/// </summary>
internal sealed class WebLayer : IDisposable
{
    private readonly string _mode;
    private readonly IntPtr _hwnd;
    private readonly string _webDir;
    private CoreWebView2Controller? _controller;
    private TaskCompletionSource<bool>? _ready;
    private bool _disposed;

    public IntPtr Handle => _hwnd;
    public string Mode => _mode;
    public int Fps { get; private set; }
    public int Kills { get; private set; }
    public string SceneName { get; private set; } = "";

    /// <summary>页面喊出的意图：由 App 消费（启动游戏 / 退出游戏 / 切场景）。</summary>
    public event Action<string>? Signal;
    /// <summary>页面认为该退出全屏/退出游戏时触发。</summary>
    public event Action? QuitRequested;

    public WebLayer(string mode, IntPtr hwnd, string webDir)
    {
        _mode = mode;
        _hwnd = hwnd;
        _webDir = webDir;
    }

    public async Task StartAsync(int w, int h, int killGoal)
    {
        var env = await WebViewRuntime.GetAsync();

        _ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _controller = await env.CreateCoreWebView2ControllerAsync(_hwnd);
        _controller.Bounds = new Rectangle(0, 0, w, h);
        /* 底色必须与游戏的天空/室内基调一致。原来用深蓝，游戏场景没画出来时
         * 会先闪一下深蓝再跳到完整画面。 */
        try { _controller.DefaultBackgroundColor = Color.FromArgb(0x14, 0x18, 0x1E); } catch { }
        _controller.IsVisible = true;

        var wv = _controller.CoreWebView2;
        wv.ProcessFailed += (_, e) => Log.Error($"[{_mode}] WebView2 进程异常 {e.ProcessFailedKind} {e.Reason}");

        var s = wv.Settings;
        s.AreDefaultContextMenusEnabled = false;
        s.AreDevToolsEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false;   // 防止 F12/Ctrl+ 等吞掉游戏按键
        s.IsSwipeNavigationEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsGeneralAutofillEnabled = false;

        wv.SetVirtualHostNameToFolderMapping("arcadefps.local", _webDir, CoreWebView2HostResourceAccessKind.Allow);
        wv.WebMessageReceived += OnWebMessage;

        var nav = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        wv.NavigationCompleted += (_, e) =>
        {
            Log.Info($"[{_mode}] 导航完成 ok={e.IsSuccess}{(e.IsSuccess ? "" : " " + e.WebErrorStatus)}");
            nav.TrySetResult(e.IsSuccess);
        };

        wv.Navigate(BuildUrl(w, h, killGoal));
        var ok = await Task.WhenAny(nav.Task, Task.Delay(20000)) == nav.Task && nav.Task.Result;
        if (!ok) Log.Warn($"[{_mode}] 导航超时或失败");

        var t0 = DateTime.UtcNow;
        await Task.WhenAny(_ready.Task, Task.Delay(8000));
        Log.Info($"[{_mode}] 首帧就绪 {(DateTime.UtcNow - t0).TotalMilliseconds:0} ms");
    }

    private string BuildUrl(int w, int h, int killGoal)
    {
        var q = new StringBuilder("https://arcadefps.local/index.html?");
        void Add(string k, string v) => q.Append(k).Append('=').Append(Uri.EscapeDataString(v)).Append('&');
        void AddI(string k, long v) => Add(k, v.ToString(CultureInfo.InvariantCulture));

        Add("mode", _mode);
        AddI("w", w);
        AddI("h", h);
        AddI("t0", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        AddI("killGoal", killGoal);
        return q.ToString().TrimEnd('&');
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;

            if (root.TryGetProperty("fps", out var f) && f.TryGetInt32(out var fps))
            {
                if (Fps == 0 && fps > 0) Log.Info($"[{_mode}] 页面开始出帧 fps={fps}");
                Fps = fps;
            }
            if (root.TryGetProperty("kills", out var k) && k.TryGetInt32(out var kills)) Kills = kills;
            if (root.TryGetProperty("scene", out var sc) && sc.ValueKind == System.Text.Json.JsonValueKind.String)
                SceneName = sc.GetString() ?? "";

            if (root.TryGetProperty("type", out var ty) && ty.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                switch (ty.GetString())
                {
                    case "ready":
                        _ready?.TrySetResult(true);
                        return;
                    case "startgame": Signal?.Invoke("startgame"); return;
                    case "endgame": Signal?.Invoke("endgame"); return;
                    case "signal":
                        if (root.TryGetProperty("name", out var nm) && nm.ValueKind == System.Text.Json.JsonValueKind.String)
                            Signal?.Invoke(nm.GetString() ?? "");
                        return;
                    case "quit":
                        QuitRequested?.Invoke();
                        return;
                }
            }
        }
        catch
        {
            // 页面消息不在关键路径上，解析失败忽略
        }
    }

    public async Task ExecuteAsync(string script)
    {
        var wv = _controller?.CoreWebView2;
        if (wv == null) return;
        try { await wv.ExecuteScriptAsync(script); }
        catch (Exception ex) { Log.Warn($"[{_mode}] ExecuteScript 失败: {ex.Message}"); }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _controller?.Close(); } catch { }
        _controller = null;
    }
}

/// <summary>
/// WebView2 运行环境（全局一份，两层共用）。
///
/// 浏览器参数是本项目**性能的关键**，分三类：
///   1. 继承自壁纸项目踩坑得出的必要开关 —— 遮挡检测与后台节流那条链必须挡掉，
///      否则壁纸层在图标层之下会被判定"完全被遮挡"而挂起合成
///      （JS 循环照跑、fps 正常，屏幕纹丝不动）；
///   2. GPU 渲染：ANGLE 走 D3D11 + 硬件光栅化 + 忽略驱动黑名单；
///   3. 明确**不加** --in-process-gpu：实测把 GPU 工作挤到 UI 线程，帧率 30 → 8.9。
/// </summary>
internal static class WebViewRuntime
{
    private static CoreWebView2Environment? _env;

    public const string BrowserArgs =
        // ---- 必要：遮挡检测 / 后台节流 ----
        "--disable-features=CalculateNativeWinOcclusion,WinOcclusionTracking,msWebOOUI,msPdfOOUI " +
        "--disable-backgrounding-occluded-windows " +
        "--disable-renderer-backgrounding " +
        "--disable-background-timer-throttling " +
        // ---- 只为渲染一个页面，关掉无关能力 ----
        "--disable-component-update --no-first-run --no-default-browser-check " +
        "--disable-sync --disable-breakpad --disable-domain-reliability " +
        "--autoplay-policy=no-user-gesture-required " +
        // ---- GPU 渲染管线 ----
        "--use-angle=d3d11 " +
        "--enable-gpu-rasterization " +
        "--ignore-gpu-blocklist " +
        "--enable-webgl";
        // 注意：**刻意去掉** --disable-frame-rate-limit 与 --force-device-scale-factor=1。
        // GhibliMeadow（同框架、同离屏窗口、同挂载流程）没有这两个参数，壁纸能正常出首帧；
        // ArcadeFPS 加了之后壁纸页面在离屏窗口上 rAF/setTimeout 全部不跑、ready 8 秒超时、
        // fps 恒 0（真机日志 00:57/01:04 实测）。--disable-frame-rate-limit 会让合成器
        // 绕过 vsync 的 BeginFrame 调度，在离屏窗口上反而拿不到帧驱动信号。

    public static string? AvailableVersion()
    {
        try { return CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch { return null; }
    }

    public static async Task<CoreWebView2Environment> GetAsync()
    {
        if (_env != null) return _env;

        var dataDir = Path.Combine(Log.Dir, "WebView2");
        Directory.CreateDirectory(dataDir);

        var options = new CoreWebView2EnvironmentOptions(BrowserArgs);
        Log.Info("WebView2 参数: " + BrowserArgs);
        Log.Info("WebView2 运行时版本: " + (AvailableVersion() ?? "未检测到（会尝试装运行时）"));

        _env = await CoreWebView2Environment.CreateAsync(null, dataDir, options);
        return _env;
    }
}
