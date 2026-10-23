using System;
using System.Drawing;
using System.Windows.Forms;

namespace ArcadeFPS;

/// <summary>
/// 系统托盘图标 + 右键菜单。给"常驻壁纸"形态一个明确的出口与配置入口，
/// 否则用户只能靠任务管理器杀进程（这正是本轮的缺陷反馈）。
///
/// 菜单：进入游戏 / 设置 / 退出。
/// 双击图标 = 进入游戏。
/// </summary>
internal sealed class TrayIcon : IDisposable
{
    private readonly App _app;
    private readonly NotifyIcon _icon;

    public TrayIcon(App app)
    {
        _app = app;
        _icon = new NotifyIcon
        {
            Icon = MakeIcon(),
            Text = "Arcade FPS · 像素射击壁纸",
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };
        _icon.DoubleClick += (_, _) => _app.EnterGame();
        _icon.BalloonTipTitle = "Arcade FPS";
        _icon.BalloonTipText = "点击桌面空白处进入游戏，或右键托盘图标操作";
    }

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();

        var enter = new ToolStripMenuItem("进入游戏", null, (_, _) => _app.EnterGame());
        enter.Font = new Font(menu.Font, FontStyle.Bold);

        var settings = new ToolStripMenuItem("设置…", null, (_, _) => ShowSettings());
        var quit = new ToolStripMenuItem("退出程序", null, (_, _) => _app.RequestQuit());

        menu.Items.Add(enter);
        menu.Items.Add(settings);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(quit);
        return menu;
    }

    private void ShowSettings()
    {
        using var f = new SettingsForm(_app);
        f.ShowDialog();
    }

    /// <summary>程序化生成草方块像素图标（Minecraft 风，16×16 放大到 32）。</summary>
    private static Icon MakeIcon()
    {
        var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            using var green = new SolidBrush(Color.FromArgb(106, 168, 62));
            using var greenDark = new SolidBrush(Color.FromArgb(88, 150, 48));
            using var greenLight = new SolidBrush(Color.FromArgb(142, 208, 82));
            using var dirt = new SolidBrush(Color.FromArgb(134, 96, 62));
            using var dirtDark = new SolidBrush(Color.FromArgb(118, 82, 52));
            using var dirtLight = new SolidBrush(Color.FromArgb(148, 110, 72));

            // 草方块：顶部草 + 下面土
            g.FillRectangle(green, 4, 4, 24, 8);
            g.FillRectangle(dirt, 4, 12, 24, 16);
            // 草斑 / 土斑（像素纹理）
            g.FillRectangle(greenDark, 8, 5, 4, 4);
            g.FillRectangle(greenLight, 18, 5, 4, 4);
            g.FillRectangle(greenDark, 24, 7, 3, 3);
            g.FillRectangle(dirtDark, 7, 15, 5, 5);
            g.FillRectangle(dirtLight, 16, 14, 4, 4);
            g.FillRectangle(dirtDark, 20, 20, 5, 5);
            g.FillRectangle(dirtLight, 8, 22, 4, 4);
        }
        var h = bmp.GetHicon();
        try { return (Icon)Icon.FromHandle(h).Clone(); }
        finally { bmp.Dispose(); }
    }

    public void Dispose() => _icon.Dispose();
}

/// <summary>设置对话框：击杀目标（下次进游戏生效）。</summary>
internal sealed class SettingsForm : Form
{
    private readonly App _app;
    private readonly NumericUpDown _killGoal;

    public SettingsForm(App app)
    {
        _app = app;
        Text = "Arcade FPS 设置";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(300, 150);
        Font = new Font("Microsoft YaHei UI", 9f);

        var lbl = new Label
        {
            Text = "击杀目标（达到后切场景）：",
            Location = new Point(16, 24),
            AutoSize = true,
        };
        _killGoal = new NumericUpDown
        {
            Location = new Point(16, 50),
            Width = 120,
            Minimum = 1,
            Maximum = 999,
            Value = app.KillGoal,
        };

        var tip = new Label
        {
            Text = "改动后下次进入游戏生效。",
            Location = new Point(16, 82),
            AutoSize = true,
            ForeColor = SystemColors.GrayText,
        };

        var ok = new Button
        {
            Text = "保存",
            DialogResult = DialogResult.OK,
            Location = new Point(120, 118),
            Size = new Size(80, 26),
        };
        var cancel = new Button
        {
            Text = "取消",
            DialogResult = DialogResult.Cancel,
            Location = new Point(206, 118),
            Size = new Size(80, 26),
        };
        AcceptButton = ok;
        CancelButton = cancel;

        Controls.Add(lbl);
        Controls.Add(_killGoal);
        Controls.Add(tip);
        Controls.Add(ok);
        Controls.Add(cancel);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        base.OnFormClosed(e);
        if (DialogResult == DialogResult.OK)
            _app.KillGoal = (int)_killGoal.Value;
    }
}
