using System;
using System.IO;
using System.Text;

namespace ArcadeFPS;

/// <summary>
/// 极简日志，写到 %LOCALAPPDATA%\ArcadeFPS\game.log。
///
/// 结构沿用 GhibliMeadow 的做法（单行追加 + 2MB 轮转），但文件名/目录独立，
/// 两个项目互不污染。
/// </summary>
internal static class Log
{
    private static readonly object Gate = new();
    private static string? _path;

    public static string Dir { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArcadeFPS");

    public static string FilePath => _path ??= Path.Combine(Dir, "game.log");

    public static void Info(string msg) => Write("INFO ", msg);
    public static void Warn(string msg) => Write("WARN ", msg);
    public static void Error(string msg) => Write("ERROR", msg);
    public static void Fatal(Exception ex) => Write("FATAL", ex.ToString());

    private static void Roll()
    {
        try
        {
            var fi = new FileInfo(FilePath);
            if (!fi.Exists || fi.Length < 2 * 1024 * 1024) return;
            var bak = FilePath + ".1";
            if (File.Exists(bak)) File.Delete(bak);
            File.Move(FilePath, bak);
        }
        catch { /* 日志轮转失败不影响游戏 */ }
    }

    private static void Write(string level, string msg)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Dir);
                Roll();
                File.AppendAllText(FilePath,
                    $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {msg}{Environment.NewLine}",
                    Encoding.UTF8);
            }
        }
        catch { /* 日志失败绝不能影响游戏本体 */ }
    }
}
