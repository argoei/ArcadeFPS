using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace ArcadeFPS;

/// <summary>
/// 入口。
///
/// 刻意保持极简：没有开机自启、没有看门狗、没有 --quiet 静默退出。
/// 那些是"后台常驻壁纸"才需要的机制；而本产品虽然是壁纸形态，
/// 玩家依然会主动双击启动，失败时必须有可见反馈。
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        bool quiet = false;
        bool autostart = false;
        int killGoal = 30;
        string? webDir = null;
        foreach (var a in args)
        {
            if (string.Equals(a, "--quiet", StringComparison.OrdinalIgnoreCase)) quiet = true;
            else if (string.Equals(a, "--autostart", StringComparison.OrdinalIgnoreCase)) autostart = true;
            else if (a.StartsWith("--killGoal=", StringComparison.OrdinalIgnoreCase)
                     && int.TryParse(a["--killGoal=".Length..], out var kg)) killGoal = kg;
            else if (a.StartsWith("--web=", StringComparison.OrdinalIgnoreCase)) webDir = a["--web=".Length..];
        }

        using var mutex = new Mutex(true, @"Local\ArcadeFPS.SingleInstance.v2", out bool isFirst);
        if (!isFirst)
        {
            // 常驻形态：第二次启动不弹框，只是把已有实例叫到前面
            Log.Info("已有实例在运行，本次启动直接退出");
            if (!quiet) BringToFront();
            return;
        }

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Log.Fatal(e.ExceptionObject as Exception ?? new Exception(e.ExceptionObject?.ToString() ?? "unknown"));
        Application.ThreadException += (_, e) => Log.Fatal(e.Exception);

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        App? app = null;
        try
        {
            var dir = webDir ?? FindWebDir();
            Log.Info($"资源目录 {dir}");

            app = new App(dir, killGoal, autostart);

            /* 关键：初始化必须在消息循环**之内**。
             * 若在 Application.Run 之前 await，WinForms 还没装好同步上下文，
             * 续体会落到线程池线程上，非 STA 的 WebView2 被建在池线程里，
             * 线程一退出窗口即失效。 */
            EventHandler? once = null;
            TrayIcon? tray = null;
            once = (_, _) =>
            {
                Application.Idle -= once;
                app.ExitRequested += () =>
                {
                    tray?.Dispose();
                    app.Shutdown();
                    Application.Exit();
                };
                app.Start();
                // 托盘图标：常驻壁纸的退出与配置出口（不再靠任务管理器杀进程）
                tray = new TrayIcon(app);
            };
            Application.Idle += once;

            Application.Run(new GameContext());
        }
        catch (Exception ex)
        {
            Log.Fatal(ex);
            if (!quiet)
            {
                MessageBox.Show("启动失败：" + ex.Message + "\n\n详情见日志：\n" + Log.FilePath,
                    "ARCADE FPS", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        finally
        {
            app?.Shutdown();
            GC.KeepAlive(mutex);
        }
    }

    /// <summary>已有实例在跑时，把游戏层窗口叫到前面（不存在就只记日志）。</summary>
    private static void BringToFront()
    {
        // 交由下一次桌面点击自然唤起，这里不做跨进程窗口查找，
        // 避免为一个便利功能引入新的失败路径。
        Log.Info("（未实现跨进程唤起：点击桌面任意位置即可进入游戏）");
    }

    private static string FindWebDir()
    {
        var cands = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "web"),
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "web"),
        };
        foreach (var c in cands)
        {
            var full = Path.GetFullPath(c);
            if (File.Exists(Path.Combine(full, "index.html"))) return full;
        }
        throw new DirectoryNotFoundException(
            "找不到 web 资源目录（应含 index.html）。尝试过：\n" + string.Join("\n", cands));
    }
}

/// <summary>纯消息循环容器。窗口我们自己管，WinForms 这层只提供消息泵与同步上下文。</summary>
internal sealed class GameContext : ApplicationContext
{
    protected override void Dispose(bool disposing)
    {
        if (disposing) Log.Info("消息循环退出");
        base.Dispose(disposing);
    }
}
