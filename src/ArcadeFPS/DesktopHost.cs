using System;
using System.Runtime.InteropServices;
using System.Text;

namespace ArcadeFPS;

/// <summary>
/// 桌面层（WorkerW）挂载。做法与 GhibliMeadow 的 DesktopHost 一致，
/// 这里只保留"一个显示器一块壁纸面"所需的最小部分。
///
/// 挂载 5 步不能改：
///   1. FindWindow("Progman") 后发两次 WM_SPAWN_WORKER（0x052C 参数 0 与 0x1）——
///      Win10 / Win11 处理不同，两次都发才稳；
///   2. EnumWindows 找持有 SHELLDLL_DefView 子窗口的那个窗口；
///   3. FindWindowEx(NULL, 该窗口, "WorkerW", NULL) 取**它之后**（z 序更低）那个；
///   4. 改样式 → SetParent；
///   5. 位置换算用 ScreenToClient(host)，不要硬算虚拟屏原点。
/// </summary>
internal static class DesktopHost
{
    /// <summary>找到承载壁纸的 WorkerW 句柄；找不到时回退 Progman。</summary>
    public static IntPtr FindWorkerW()
    {
        var progman = Native.FindWindow("Progman", null);
        if (progman == IntPtr.Zero)
        {
            Log.Warn("未找到 Progman");
            return IntPtr.Zero;
        }

        Native.SendMessageTimeout(progman, Native.WM_SPAWN_WORKER, IntPtr.Zero, IntPtr.Zero,
            Native.SMTO_NORMAL, 1000, out _);
        Native.SendMessageTimeout(progman, Native.WM_SPAWN_WORKER, new IntPtr(0x1), IntPtr.Zero,
            Native.SMTO_NORMAL, 1000, out _);

        IntPtr host = IntPtr.Zero;
        Native.EnumWindows((h, _) =>
        {
            var defView = Native.FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (defView == IntPtr.Zero) return true;
            host = Native.FindWindowEx(IntPtr.Zero, h, "WorkerW", null);
            return false;
        }, IntPtr.Zero);

        // 取不到就用 Progman 本身，桌面照样能显示，只是层级靠前
        if (host == IntPtr.Zero)
        {
            Log.Warn("未找到 WorkerW，回退 Progman（壁纸可能覆盖在图标之上）");
            host = progman;
        }
        else
        {
            Log.Info($"WorkerW = 0x{host.ToInt64():X}");
        }
        return host;
    }

    /// <summary>
    /// 找桌面图标层 SHELLDLL_DefView。它可能在 Progman 直下（常态），也可能
    /// 在某个 WorkerW 下（挂壁纸后的分支）。点击判定要用它做 LVM_HITTEST。
    /// </summary>
    public static IntPtr FindDefView()
    {
        IntPtr defView = Native.FindWindowEx(Native.FindWindow("Progman", null), IntPtr.Zero, "SHELLDLL_DefView", null);
        if (defView != IntPtr.Zero) return defView;

        IntPtr result = IntPtr.Zero;
        Native.EnumWindows((h, _) =>
        {
            var dv = Native.FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (dv != IntPtr.Zero) { result = dv; return false; }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    /// <summary>把子窗口挂到桌面层并按 host 客户端坐标定位。</summary>
    public static bool Attach(IntPtr hwnd, IntPtr host, System.Drawing.Rectangle bounds)
    {
        if (host == IntPtr.Zero) return false;
        try
        {
            // 挂到桌面层前必须切成 WS_CHILD，否则跨进程父子关系会被系统拒绝
            long style = Native.GetWindowLongPtr(hwnd, Native.GWL_STYLE).ToInt64();
            Native.SetWindowLongPtr(hwnd, Native.GWL_STYLE,
                new IntPtr((style & ~Native.WS_POPUP) | Native.WS_CHILD | Native.WS_VISIBLE | Native.WS_CLIPCHILDREN));

            long ex = Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE).ToInt64();
            ex |= Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW;
            ex &= ~Native.WS_EX_APPWINDOW;
            Native.SetWindowLongPtr(hwnd, Native.GWL_EXSTYLE, new IntPtr(ex));

            if (Native.SetParent(hwnd, host) == IntPtr.Zero)
            {
                Log.Error($"SetParent 失败 winErr={Marshal.GetLastWin32Error()}");
                return false;
            }

            var pt = new Native.POINT { X = bounds.X, Y = bounds.Y };
            Native.ScreenToClient(host, ref pt);
            Native.SetWindowPos(hwnd, IntPtr.Zero, pt.X, pt.Y, bounds.Width, bounds.Height,
                Native.SWP_NOZORDER | Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
            return true;
        }
        catch (Exception ex)
        {
            Log.Error("挂载到桌面层异常: " + ex.Message);
            return false;
        }
    }
}
