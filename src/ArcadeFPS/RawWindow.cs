using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Runtime.InteropServices;

namespace ArcadeFPS;

/// <summary>
/// 裸 Win32 窗口类 + 实例集合。
///
/// 不用 WinForms Form 的原因与 GhibliMeadow 相同：Form 自认顶层窗口，
/// 被跨进程 SetParent 后它的布局/定位逻辑会和我们手工定位打架。
///
/// 本项目需要**两种**窗口，唯一差别是样式与焦点策略：
///   · WallpaperLayer：WS_CHILD + WS_EX_NOACTIVATE，挂到 WorkerW。静态壁纸，绝不抢焦点；
///   · GameLayer：WS_POPUP + WS_EX_APPWINDOW，屏幕居中可获焦点。承载可操作的游戏。
/// 两者共用一个注册过的窗口类，因此 WndProc 走静态分发表。
/// </summary>
internal static class RawWindow
{
    private const string WallpaperClass = "ArcadeFPSWallpaperWnd";
    private const string GameClass = "ArcadeFPSGameWnd";

    private static readonly object Gate = new();
    private static readonly Dictionary<IntPtr, Action<uint, IntPtr, IntPtr>> Handlers = new();

    // 必须持有委托引用，否则被 GC 回收后 WndProc 回调会崩溃
    private static Native.WndProcDelegate? _proc;

    /// <summary>某块窗口的尺寸变化（宿主据此调整 WebView2 Bounds）。</summary>
    public static event Action<IntPtr, int, int>? SizeChanged;
    /// <summary>显示器布局 / DPI 变化。</summary>
    public static event Action? DisplayChanged;
    /// <summary>游戏层窗口被关闭（Alt+F4 / 点 X）。</summary>
    public static event Action? GameLayerClosed;

    private static void EnsureRegistered()
    {
        if (_atomWallpaper != 0 && _atomGame != 0) return;
        _proc = Dispatch;

        if (_atomWallpaper == 0) _atomWallpaper = Register(WallpaperClass);
        if (_atomGame == 0) _atomGame = Register(GameClass);
    }

    private static ushort _atomWallpaper;
    private static ushort _atomGame;

    private static ushort Register(string cls)
    {
        var wc = new Native.WNDCLASSEX
        {
            cbSize = (uint)Marshal.SizeOf<Native.WNDCLASSEX>(),
            style = 0,
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_proc!),
            cbClsExtra = 0,
            cbWndExtra = 0,
            hInstance = Native.GetModuleHandle(null),
            hIcon = IntPtr.Zero,
            hCursor = IntPtr.Zero,
            hbrBackground = IntPtr.Zero,   // 背景不刷，避免闪白
            lpszMenuName = null,
            lpszClassName = cls,
            hIconSm = IntPtr.Zero,
        };
        var atom = Native.RegisterClassEx(ref wc);
        if (atom == 0)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "RegisterClassEx 失败: " + cls);
        return atom;
    }

    /// <summary>壁纸层窗口。建在屏幕外，等 WebView2 首帧就绪后再挂载 ——
    /// 顺序反了 Chromium 的 DirectComposition 视觉会挂到跨进程父窗口的合成树上，
    /// 画面能渲染但不会更新到屏幕（表现为壁纸静止不动）。
    /// WS_VISIBLE 必须保留：Chromium 据此判断文档可见、驱动 rAF。
    /// 放到 -32000 屏幕外，两全（既可见驱动渲染，又不出现在屏幕上）。</summary>
    private const int OffScreen = -32000;

    public static IntPtr CreateWallpaperLayer(Rectangle bounds)
    {
        EnsureRegistered();
        var h = Create(WallpaperClass, "ArcadeFPS Wallpaper",
            unchecked((uint)(Native.WS_POPUP | Native.WS_VISIBLE | Native.WS_CLIPCHILDREN)),
            OffScreen, OffScreen, bounds.Width, bounds.Height);
        Log.Info($"壁纸层窗口 0x{h.ToInt64():X}（暂离屏，尺寸 {bounds.Width}x{bounds.Height}）");
        return h;
    }

    /// <summary>游戏层窗口：无边框、全屏、可获焦点，覆盖整个屏幕（打开即全屏）。</summary>
    public static IntPtr CreateGameLayer(Rectangle screen)
    {
        EnsureRegistered();
        int w = screen.Width;
        int h = screen.Height;
        var h2 = Create(GameClass, "ARCADE FPS",
            unchecked((uint)(Native.WS_POPUP | Native.WS_VISIBLE | Native.WS_CLIPCHILDREN)),
            screen.Left, screen.Top, w, h);
        Log.Info($"游戏层窗口 0x{h2.ToInt64():X} 全屏 {w}x{h}");
        Native.SetForegroundWindow(h2);
        return h2;
    }

    private static IntPtr Create(string cls, string title, uint style, int x, int y, int w, int h)
    {
        var hwnd = Native.CreateWindowEx(
            0, cls, title, style, x, y, w, h,
            IntPtr.Zero, IntPtr.Zero, Native.GetModuleHandle(null), IntPtr.Zero);
        if (hwnd == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateWindowEx 失败: " + cls);
        return hwnd;
    }

    public static void Destroy(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        lock (Gate) Handlers.Remove(hwnd);
        if (Native.IsWindow(hwnd)) Native.DestroyWindow(hwnd);
    }

    /// <summary>窗口关闭请求（区别于被销毁）。</summary>
    public static event Action<IntPtr>? CloseRequested;

    private static IntPtr Dispatch(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            switch (msg)
            {
                case Native.WM_ERASEBKGND:
                    return new IntPtr(1);   // 已声称擦除，抑制系统背景填充

                case Native.WM_SIZE:
                {
                    int w = (int)(lParam.ToInt64() & 0xFFFF);
                    int h = (int)((lParam.ToInt64() >> 16) & 0xFFFF);
                    if (w > 0 && h > 0) SizeChanged?.Invoke(hWnd, w, h);
                    break;
                }
                case Native.WM_DPICHANGED:
                case Native.WM_DISPLAYCHANGE:
                    DisplayChanged?.Invoke();
                    break;

                case Native.WM_CLOSE:
                    CloseRequested?.Invoke(hWnd);
                    // 游戏层：销毁自己；壁纸层：吞掉，防止误关掉壁纸
                    if (IsGameLayer(hWnd))
                    {
                        GameLayerClosed?.Invoke();
                        Native.DestroyWindow(hWnd);
                        return IntPtr.Zero;
                    }
                    return IntPtr.Zero;
            }

            // 自定义消息（控制台命令等）
            Action<uint, IntPtr, IntPtr>? handler;
            lock (Gate) Handlers.TryGetValue(hWnd, out handler);
            handler?.Invoke(msg, wParam, lParam);
        }
        catch (Exception ex)
        {
            /* Windows 直接回调这个函数，异常会跨过原生栈帧逃逸 ——
             * 那是极少数能直接终止进程的路径，且常发生在用户插拔显示器的时刻。
             * 宁可吞掉一次通知，也不要崩。 */
            Log.Fatal(ex);
        }
        return Native.DefWindowProc(hWnd, msg, wParam, lParam);
    }

    private static readonly HashSet<IntPtr> GameLayers = new();

    public static void MarkAsGameLayer(IntPtr hwnd) { lock (Gate) GameLayers.Add(hwnd); }
    private static bool IsGameLayer(IntPtr hwnd) { lock (Gate) return GameLayers.Contains(hwnd); }
}
