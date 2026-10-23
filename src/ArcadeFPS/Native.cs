using System;
using System.Runtime.InteropServices;

namespace ArcadeFPS;

/// <summary>
/// Win32 互操作声明。来源是 GhibliMeadow 的 Native.cs，裁剪为本项目真正用到的部分。
///
/// 关键取舍说明：
///   · 保留 WorkerW 挂载所需全套（FindWindow / EnumWindows / FindWindowEx /
///     SendMessageTimeout / SetParent）—— 壁纸形态的基础，不能删；
///   · 保留鼠标轮询所需（GetAsyncKeyState / GetCursorPos）—— 壁纸窗口在图标层之下，
///     SysListView32 会把鼠标事件全吃掉，只能轮询（只读，不装钩子，不吞事件）；
///   · 额外声明 ClipCursor / ShowCursor / SetForegroundWindow 与焦点样式常量，
///     供"游戏窗口"使用。
/// </summary>
internal static class Native
{
    /* ---------------- 窗口样式 ---------------- */
    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;

    public const long WS_CHILD = 0x40000000L;
    public const long WS_POPUP = unchecked((long)0x80000000L);
    public const long WS_VISIBLE = 0x10000000L;
    public const long WS_CLIPCHILDREN = 0x02000000L;
    public const long WS_CLIPSIBLINGS = 0x04000000L;
    public const long WS_CAPTION = 0x00C00000L;
    public const long WS_THICKFRAME = 0x00040000L;
    public const long WS_SYSMENU = 0x00080000L;

    public const long WS_EX_NOACTIVATE = 0x08000000L;   // 壁纸层：绝不抢焦点
    public const long WS_EX_TOOLWINDOW = 0x00000080L;
    public const long WS_EX_APPWINDOW = 0x00040000L;   // 游戏层：需要进任务栏/可获焦点

    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_SHOWWINDOW = 0x0040;

    /* ---------------- 消息 ---------------- */
    public const uint WM_SIZE = 0x0005;
    public const uint WM_ERASEBKGND = 0x0014;
    public const uint WM_MOUSEACTIVATE = 0x0021;
    public const uint WM_DISPLAYCHANGE = 0x007E;
    public const uint WM_DPICHANGED = 0x02E0;
    public const uint WM_CLOSE = 0x0010;
    public const uint WM_DESTROY = 0x0002;

    public const uint WM_SPAWN_WORKER = 0x052C;   // 让 explorer 生成承载壁纸的 WorkerW
    public const uint SMTO_NORMAL = 0x0000;
    public const int MA_NOACTIVATE = 3;

    public static class SW { public const int HIDE = 0; public const int SHOW = 5; public const int MAXIMIZE = 3; }

    /* ---------------- 结构体 ---------------- */
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASSEX
    {
        public uint cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
        public IntPtr hIconSm;
    }

    public delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    /* ---------------- user32 ---------------- */
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string? lpszClass, string? lpszWindow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam,
        uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateWindowEx(uint dwExStyle, string lpClassName, string? lpWindowName,
        uint dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    /* 光标控制：游戏窗口的指针锁定兜底 */
    [DllImport("user32.dll")]
    public static extern int ShowCursor(bool bShow);

    [DllImport("user32.dll")]
    public static extern bool ClipCursor(ref RECT lpRect);

    /* ---------------- 鼠标状态轮询（壁纸层的唯一输入通道） ----------------
     * 壁纸窗口在桌面图标层之下，SysListView32 把鼠标事件全吃了，
     * 我们收不到 WM_LBUTTONDOWN。这里只**读取**全局按键/光标状态，
     * 不装钩子、不吞事件，桌面的原有交互完全不受影响。
     * 人手最短点击 >60ms，20ms 轮询不会漏。 */
    public const int VK_LBUTTON = 0x01;
    public const int VK_RBUTTON = 0x02;
    public const int VK_ESCAPE = 0x1B;

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);

    /// <summary>取屏幕上某坐标下的窗口句柄（最深子窗口）。</summary>
    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT pt);

    /* ---------------- 桌面点击判定（是否点中图标） ---------------- */
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

    /// <summary>取窗口类名（如 "Progman" / "WorkerW" / "SHELLDLL_DefView"）。</summary>
    public static string GetWindowClassName(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return "";
        var sb = new System.Text.StringBuilder(64);
        return GetClassName(hWnd, sb, sb.Capacity) > 0 ? sb.ToString() : "";
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct LVHITTESTINFO
    {
        public POINT pt;
        public uint flags;
        public int iItem;
        public int iSubItem;
    }

    // SendMessage 必须用 ref 重载传 LVHITTESTINFO（结构体按指针封送）。
    // 注意：C# 方法名可以叫 SendMessageRef，但 DllImport 必须声明真实导出名 SendMessage，
    // 否则运行时会去 user32.dll 里找 "SendMessageRef" 这个不存在的导出，抛
    // EntryPointNotFoundException（实测点击判定直接炸掉，游戏永远不启动）。
    [DllImport("user32.dll", EntryPoint = "SendMessage")]
    public static extern IntPtr SendMessageRef(IntPtr hWnd, uint msg, IntPtr wParam, ref LVHITTESTINFO lParam);

    /* ---------------- kernel32 ---------------- */
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr GetModuleHandle(string? lpModuleName);
}
