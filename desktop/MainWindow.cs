using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PrtsTerrarchive.Desktop;

internal sealed class MainWindow : Form
{
    private readonly string appRoot;
    private readonly DshHost host;
    private readonly DiagnosticLog log;
    private readonly Func<Task> requestExit;
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly Label statusLabel = new()
    {
        AutoSize = false,
        Dock = DockStyle.Fill,
        Text = "正在准备 PRTS Terrarchive…",
        TextAlign = ContentAlignment.MiddleLeft,
        Padding = new Padding(12, 0, 0, 0),
    };
    private readonly NotifyIcon trayIcon;
    private readonly ToolStripMenuItem restartMenuItem;
    private bool allowClose;
    private bool started;

    public MainWindow(
        string appRoot,
        DshHost host,
        DiagnosticLog log,
        Func<Task> requestExit)
    {
        this.appRoot = appRoot;
        this.host = host;
        this.log = log;
        this.requestExit = requestExit;

        Text = "PRTS Terrarchive";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(900, 620);
        ClientSize = new Size(1280, 820);
        Icon = CreateAppIcon();

        var statusPanel = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 32,
            BackColor = Color.FromArgb(241, 245, 243),
        };
        statusPanel.Controls.Add(statusLabel);
        Controls.Add(browser);
        Controls.Add(statusPanel);

        var showMenuItem = new ToolStripMenuItem("显示窗口", null, (_, _) => RestoreFromTray())
        {
            Font = new Font("Segoe UI", 9, FontStyle.Bold),
        };
        restartMenuItem = new ToolStripMenuItem("重启服务", null, async (_, _) => await RestartHostAsync());
        var openDataMenuItem = new ToolStripMenuItem("打开数据目录", null, (_, _) => OpenDataDirectory());
        var exitMenuItem = new ToolStripMenuItem("退出", null, async (_, _) => await requestExit());
        var trayMenu = new ContextMenuStrip();
        trayMenu.Items.AddRange([
            showMenuItem,
            restartMenuItem,
            openDataMenuItem,
            new ToolStripSeparator(),
            exitMenuItem,
        ]);

        trayIcon = new NotifyIcon
        {
            Icon = Icon,
            Text = "PRTS Terrarchive",
            ContextMenuStrip = trayMenu,
            Visible = true,
        };
        trayIcon.DoubleClick += (_, _) => RestoreFromTray();

        host.Ready += uri => RunOnUiThread(() => NavigateToHost(uri));
        host.StatusChanged += message => RunOnUiThread(() => statusLabel.Text = message);
        Shown += async (_, _) => await StartHostAsync();
        FormClosing += HandleFormClosing;
    }

    private async Task StartHostAsync()
    {
        if (started) return;
        started = true;
        try
        {
            await InitializeBrowserAsync();
            await host.StartAsync();
        }
        catch (Exception error)
        {
            log.Write($"Desktop startup failed: {error}");
            statusLabel.Text = $"启动失败：{error.Message}";
            MessageBox.Show(
                this,
                $"PRTS Terrarchive 启动失败：\n\n{error.Message}\n\n详细信息已写入 userdata\\logs\\desktop.log。",
                "启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private async Task InitializeBrowserAsync()
    {
        var webViewData = Path.Combine(appRoot, "userdata", "webview2");
        Directory.CreateDirectory(webViewData);
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, webViewData);
            await browser.EnsureCoreWebView2Async(environment);
        }
        catch (WebView2RuntimeNotFoundException error)
        {
            throw new InvalidOperationException(
                "没有检测到 Microsoft Edge WebView2 Runtime。请安装 WebView2 Evergreen Runtime 后重试。",
                error);
        }

        browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
        browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
        browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
        browser.CoreWebView2.Settings.IsZoomControlEnabled = true;
        browser.CoreWebView2.NavigationStarting += (_, args) =>
        {
            if (IsAllowedLocalUri(args.Uri) || args.Uri == "about:blank") return;
            args.Cancel = true;
            OpenExternalUri(args.Uri);
        };
        browser.CoreWebView2.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            if (IsAllowedLocalUri(args.Uri))
            {
                browser.CoreWebView2.Navigate(args.Uri);
            }
            else OpenExternalUri(args.Uri);
        };
        browser.NavigateToString("""
            <!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
            <style>body{margin:0;background:#f3f7f5;color:#24332d;font:16px system-ui;display:grid;place-items:center;height:100vh}strong{font-size:24px}</style>
            </head><body><div><strong>PRTS Terrarchive</strong><p>正在启动本地服务，请稍候…</p></div></body></html>
            """);
    }

    private void NavigateToHost(Uri uri)
    {
        if (browser.CoreWebView2 is null) return;
        browser.CoreWebView2.Navigate(uri.AbsoluteUri);
        statusLabel.Text = "PRTS Host 已就绪";
    }

    private async Task RestartHostAsync()
    {
        restartMenuItem.Enabled = false;
        try
        {
            statusLabel.Text = "正在重启 PRTS Host…";
            await host.RestartAsync();
        }
        catch (Exception error)
        {
            log.Write($"Host restart failed: {error}");
            statusLabel.Text = $"重启失败：{error.Message}";
            MessageBox.Show(this, error.Message, "重启失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            restartMenuItem.Enabled = true;
        }
    }

    private void OpenDataDirectory()
    {
        var dataRoot = Path.Combine(appRoot, "userdata");
        Directory.CreateDirectory(dataRoot);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{dataRoot}\"") { UseShellExecute = true });
    }

    private void HandleFormClosing(object? sender, FormClosingEventArgs args)
    {
        if (allowClose) return;
        if (args.CloseReason is CloseReason.WindowsShutDown or CloseReason.TaskManagerClosing)
        {
            allowClose = true;
            trayIcon.Visible = false;
            return;
        }

        args.Cancel = true;
        Hide();
        trayIcon.ShowBalloonTip(
            1800,
            "PRTS Terrarchive 仍在运行",
            "可通过任务栏托盘图标重新打开或退出。",
            ToolTipIcon.Info);
    }

    public void RestoreFromTrayThreadSafe()
    {
        if (IsDisposed) return;
        try { BeginInvoke(RestoreFromTray); } catch (InvalidOperationException) { }
    }

    public void RestoreFromTray()
    {
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    public async Task ShutdownAsync()
    {
        restartMenuItem.Enabled = false;
        statusLabel.Text = "正在退出…";
        await host.DisposeAsync();
        allowClose = true;
        trayIcon.Visible = false;
        Close();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            trayIcon.Dispose();
            browser.Dispose();
        }
        base.Dispose(disposing);
    }

    private void RunOnUiThread(Action action)
    {
        if (IsDisposed) return;
        if (InvokeRequired)
        {
            try { BeginInvoke(action); } catch (InvalidOperationException) { }
        }
        else action();
    }

    private static bool IsAllowedLocalUri(string rawUri)
    {
        if (!Uri.TryCreate(rawUri, UriKind.Absolute, out var uri)) return false;
        return uri.Scheme is "http" or "https" && uri.Host is "127.0.0.1" or "localhost";
    }

    private static void OpenExternalUri(string rawUri)
    {
        if (!Uri.TryCreate(rawUri, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http")) return;
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }

    private static Icon CreateAppIcon()
    {
        using var bitmap = new Bitmap(64, 64);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);
            using var background = new SolidBrush(Color.FromArgb(29, 103, 75));
            graphics.FillRoundedRectangle(background, new Rectangle(3, 3, 58, 58), 14);
            using var font = new Font("Segoe UI", 34, FontStyle.Bold, GraphicsUnit.Pixel);
            using var foreground = new SolidBrush(Color.White);
            var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            graphics.DrawString("P", font, foreground, new RectangleF(2, 0, 60, 60), format);
        }
        var handle = bitmap.GetHicon();
        try { return (Icon)Icon.FromHandle(handle).Clone(); }
        finally { DestroyIcon(handle); }
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr icon);
}

internal static class GraphicsExtensions
{
    public static void FillRoundedRectangle(this Graphics graphics, Brush brush, Rectangle bounds, int radius)
    {
        var diameter = radius * 2;
        using var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        graphics.FillPath(brush, path);
    }
}
