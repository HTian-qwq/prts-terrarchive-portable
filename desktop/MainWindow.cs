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
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly Panel loadingOverlay;
    private readonly Label loadingMessage;
    private readonly Label loadingDetail;
    private readonly Button retryButton;
    private readonly Button openBrowserButton;
    private readonly Panel dragStrip;
    private readonly FlowLayoutPanel windowControls;
    private readonly Button maximizeButton;
    private readonly NotifyIcon trayIcon;
    private readonly ToolStripMenuItem restartMenuItem;
    private bool allowClose;
    private bool started;
    private Uri? hostUri;

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
        BackColor = Color.FromArgb(244, 244, 241);
        Font = new Font("Segoe UI", 9F);
        FormBorderStyle = FormBorderStyle.None;
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? CreateAppIcon();

        (loadingOverlay, loadingMessage, loadingDetail, retryButton, openBrowserButton) =
            CreateLoadingOverlay();
        retryButton.Click += (_, _) => RetryNavigation();
        openBrowserButton.Click += (_, _) =>
        {
            if (hostUri is not null) OpenExternalUri(hostUri.AbsoluteUri);
        };

        (dragStrip, windowControls, maximizeButton) = CreateWindowChrome();

        Controls.Add(browser);
        Controls.Add(loadingOverlay);
        Controls.Add(dragStrip);
        Controls.Add(windowControls);
        loadingOverlay.BringToFront();
        BringWindowChromeToFront();

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
        host.StatusChanged += message => RunOnUiThread(() => SetStatus(message));
        Shown += async (_, _) => await StartHostAsync();
        Resize += (_, _) =>
        {
            LayoutWindowChrome();
            maximizeButton.Text = WindowState == FormWindowState.Maximized ? "❐" : "□";
        };
        FormClosing += HandleFormClosing;
        LayoutWindowChrome();
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
            ShowLoadingFailure("桌面环境启动失败", error.Message);
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
        browser.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true;
        await browser.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("""
            (() => {
              if (window !== window.top) return;
              const post = action => window.chrome.webview.postMessage('prts-shell-action:' + action);
              const install = () => {
                if (!document.body || document.getElementById('prts-desktop-chrome')) return;

                const style = document.createElement('style');
                style.id = 'prts-desktop-chrome-style';
                style.textContent = `
                  #prts-desktop-drag {
                    position: fixed; z-index: 2147483646; inset: 0 128px auto 0; height: 8px;
                    cursor: default; user-select: none; -webkit-user-select: none;
                  }
                  #prts-desktop-chrome {
                    --shell-fg: rgba(22, 25, 29, .78);
                    --shell-bg: rgba(250, 250, 248, .76);
                    --shell-border: rgba(20, 24, 28, .10);
                    --shell-hover: rgba(20, 24, 28, .075);
                    position: fixed; z-index: 2147483647; top: 10px; right: 12px;
                    box-sizing: border-box; display: flex; align-items: center; gap: 2px;
                    height: 32px; padding: 3px;
                    color: var(--shell-fg); background: var(--shell-bg);
                    border: 1px solid var(--shell-border); border-radius: 13px;
                    box-shadow: 0 7px 24px rgba(17, 20, 24, .10), inset 0 1px rgba(255,255,255,.62);
                    backdrop-filter: blur(16px) saturate(1.15);
                    -webkit-backdrop-filter: blur(16px) saturate(1.15);
                    user-select: none; -webkit-user-select: none;
                  }
                  #prts-desktop-chrome button {
                    appearance: none; box-sizing: border-box; display: grid; place-items: center;
                    width: 31px; height: 24px; margin: 0; padding: 0;
                    color: inherit; background: transparent; border: 0; border-radius: 9px;
                    outline: none; cursor: default; transition: background-color 120ms ease, color 120ms ease;
                  }
                  #prts-desktop-chrome button:hover { background: var(--shell-hover); }
                  #prts-desktop-chrome button:active { transform: translateY(1px); }
                  #prts-desktop-chrome button[data-action='close']:hover { color: white; background: #c42b2b; }
                  #prts-desktop-chrome svg {
                    width: 12px; height: 12px; display: block; fill: none;
                    stroke: currentColor; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round;
                  }

                  body[data-prts-skin='agent'] #prts-desktop-chrome {
                    --shell-bg: rgba(248, 248, 245, .70);
                    --shell-border: rgba(25, 28, 31, .12);
                    --shell-hover: rgba(25, 28, 31, .09);
                    box-shadow: 0 8px 26px rgba(12, 15, 18, .12), inset 0 1px rgba(255,255,255,.68);
                  }

                  body[data-prts-skin='endfield-aic'] #prts-desktop-chrome {
                    --shell-fg: #f5fa3d; --shell-bg: rgba(7, 10, 11, .84);
                    --shell-border: rgba(245, 250, 61, .40); --shell-hover: rgba(245, 250, 61, .13);
                    top: 9px; right: 12px; gap: 0; height: 31px; padding: 2px 3px;
                    border-radius: 5px; box-shadow: 0 8px 22px rgba(0,0,0,.30), inset 0 0 18px rgba(245,250,61,.025);
                    clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
                  }
                  body[data-prts-skin='endfield-aic'] #prts-desktop-chrome button {
                    width: 31px; height: 25px; border-radius: 3px;
                  }
                  body[data-prts-skin='endfield-aic'] #prts-desktop-chrome button + button {
                    border-left: 1px solid rgba(245, 250, 61, .16);
                  }
                  body[data-prts-skin='endfield-aic'] #prts-desktop-chrome button[data-action='close']:hover {
                    color: #080a0b; background: #f5fa3d;
                  }
                `;

                const drag = document.createElement('div');
                drag.id = 'prts-desktop-drag';
                drag.setAttribute('aria-hidden', 'true');
                drag.addEventListener('pointerdown', event => {
                  if (event.button === 0) post('drag');
                });
                drag.addEventListener('dblclick', () => post('maximize'));

                const chrome = document.createElement('div');
                chrome.id = 'prts-desktop-chrome';
                chrome.setAttribute('role', 'group');
                chrome.setAttribute('aria-label', '窗口控制');
                const icons = {
                  minimize: '<svg viewBox="0 0 12 12"><path d="M2 8.5h8"/></svg>',
                  maximize: '<svg viewBox="0 0 12 12"><rect x="2.25" y="2.25" width="7.5" height="7.5" rx="1"/></svg>',
                  close: '<svg viewBox="0 0 12 12"><path d="m2.5 2.5 7 7m0-7-7 7"/></svg>',
                };
                for (const action of ['minimize', 'maximize', 'close']) {
                  const button = document.createElement('button');
                  button.type = 'button';
                  button.dataset.action = action;
                  button.title = action === 'minimize' ? '最小化' : action === 'maximize' ? '最大化 / 还原' : '关闭到托盘';
                  button.setAttribute('aria-label', button.title);
                  button.innerHTML = icons[action];
                  button.addEventListener('pointerdown', event => event.stopPropagation());
                  button.addEventListener('click', event => { event.stopPropagation(); post(action); });
                  chrome.appendChild(button);
                }
                (document.head || document.documentElement).appendChild(style);
                document.body.append(drag, chrome);
              };
              if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
              else install();
            })();
            """);
        browser.CoreWebView2.WebMessageReceived += (_, args) =>
        {
            string message;
            try { message = args.TryGetWebMessageAsString(); }
            catch (ArgumentException) { return; }
            const string prefix = "prts-shell-action:";
            if (!message.StartsWith(prefix, StringComparison.Ordinal)) return;
            RunOnUiThread(() => HandleShellAction(message[prefix.Length..]));
        };
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
        browser.CoreWebView2.NavigationCompleted += (_, args) =>
        {
            if (args.IsSuccess)
            {
                browser.Visible = true;
                loadingOverlay.Visible = false;
                HideNativeChrome();
                SetStatus("PRTS Host 已就绪");
                return;
            }

            log.Write($"WebView navigation failed: {args.WebErrorStatus}");
            ShowLoadingFailure("本地页面加载失败", $"WebView2：{args.WebErrorStatus}");
        };
        browser.CoreWebView2.ProcessFailed += (_, args) => RunOnUiThread(() =>
        {
            log.Write($"WebView process failed: {args.ProcessFailedKind}");
            ShowLoadingFailure("页面进程意外停止", "可以重试加载，或暂时在系统浏览器中打开。");
        });
    }

    private void NavigateToHost(Uri uri)
    {
        if (browser.CoreWebView2 is null) return;
        hostUri = uri;
        loadingOverlay.Visible = true;
        loadingOverlay.BringToFront();
        ShowNativeChrome();
        browser.Visible = false;
        retryButton.Visible = false;
        openBrowserButton.Visible = false;
        loadingMessage.Text = "正在连接本地档案终端";
        loadingDetail.Text = "PRTS Host 已启动，正在载入界面…";
        browser.CoreWebView2.Navigate(uri.AbsoluteUri);
        SetStatus("正在载入 PRTS 界面…");
    }

    private void RetryNavigation()
    {
        if (hostUri is null)
        {
            _ = RestartHostAsync();
            return;
        }
        NavigateToHost(hostUri);
    }

    private void SetStatus(string message)
    {
        if (loadingOverlay.Visible && !retryButton.Visible) loadingDetail.Text = message;
    }

    private void ShowLoadingFailure(string title, string detail)
    {
        browser.Visible = false;
        loadingOverlay.Visible = true;
        loadingOverlay.BringToFront();
        ShowNativeChrome();
        loadingMessage.Text = title;
        loadingDetail.Text = detail;
        retryButton.Visible = true;
        openBrowserButton.Visible = hostUri is not null;
    }

    private async Task RestartHostAsync()
    {
        restartMenuItem.Enabled = false;
        try
        {
            hostUri = null;
            browser.Visible = false;
            loadingOverlay.Visible = true;
            loadingOverlay.BringToFront();
            ShowNativeChrome();
            retryButton.Visible = false;
            openBrowserButton.Visible = false;
            loadingMessage.Text = "正在重启本地服务";
            SetStatus("正在重启 PRTS Host…");
            await host.RestartAsync();
        }
        catch (Exception error)
        {
            log.Write($"Host restart failed: {error}");
            ShowLoadingFailure("本地服务重启失败", error.Message);
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
            using var background = new SolidBrush(Color.White);
            graphics.FillRoundedRectangle(background, new Rectangle(3, 3, 58, 58), 17);
            using var font = new Font("Consolas", 36, FontStyle.Bold, GraphicsUnit.Pixel);
            using var foreground = new SolidBrush(Color.FromArgb(17, 18, 20));
            var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            var state = graphics.Save();
            graphics.TranslateTransform(2, 0);
            using var iconShear = new Matrix();
            iconShear.Shear(-0.08F, 0);
            graphics.MultiplyTransform(iconShear);
            graphics.DrawString("P", font, foreground, new RectangleF(2, -1, 58, 62), format);
            graphics.Restore(state);
        }
        var handle = bitmap.GetHicon();
        try { return (Icon)Icon.FromHandle(handle).Clone(); }
        finally { DestroyIcon(handle); }
    }

    private static (Panel Overlay, Label Message, Label Detail, Button Retry, Button Browser)
        CreateLoadingOverlay()
    {
        var overlay = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(244, 244, 241) };
        var center = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = Color.Transparent,
            ColumnCount = 1,
            RowCount = 6,
            Anchor = AnchorStyles.None,
            Margin = Padding.Empty,
        };
        center.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        var logo = new PrtsLogoControl { Size = new Size(64, 64), Anchor = AnchorStyles.None, Margin = new Padding(0, 0, 0, 18) };
        var eyebrow = new Label
        {
            AutoSize = true,
            Anchor = AnchorStyles.None,
            Text = "PRTS / TERRARCHIVE",
            ForeColor = Color.FromArgb(112, 112, 106),
            Font = new Font("Consolas", 9F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 8),
        };
        var message = new Label
        {
            AutoSize = true,
            Anchor = AnchorStyles.None,
            Text = "正在启动本地档案终端",
            ForeColor = Color.FromArgb(17, 18, 20),
            Font = new Font("Segoe UI", 18F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 8),
        };
        var detail = new Label
        {
            AutoSize = true,
            MaximumSize = new Size(560, 0),
            Anchor = AnchorStyles.None,
            Text = "正在准备 PRTS Host…",
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.FromArgb(102, 102, 96),
            Font = new Font("Segoe UI", 10F),
            Margin = new Padding(0, 0, 0, 22),
        };
        var actionRow = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Anchor = AnchorStyles.None,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = Padding.Empty,
        };
        var retry = CreateActionButton("重试", primary: true);
        var openBrowser = CreateActionButton("在浏览器打开", primary: false);
        retry.Visible = false;
        openBrowser.Visible = false;
        actionRow.Controls.Add(retry);
        actionRow.Controls.Add(openBrowser);

        center.Controls.Add(logo, 0, 0);
        center.Controls.Add(eyebrow, 0, 1);
        center.Controls.Add(message, 0, 2);
        center.Controls.Add(detail, 0, 3);
        center.Controls.Add(actionRow, 0, 4);

        var centeringGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 3 };
        centeringGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        centeringGrid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        centeringGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        centeringGrid.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        centeringGrid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        centeringGrid.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        centeringGrid.Controls.Add(center, 1, 1);
        overlay.Controls.Add(centeringGrid);
        return (overlay, message, detail, retry, openBrowser);
    }

    private static Button CreateActionButton(string text, bool primary)
    {
        var button = new Button
        {
            AutoSize = true,
            Text = text,
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand,
            Padding = new Padding(14, 6, 14, 6),
            Margin = new Padding(5, 0, 5, 0),
            BackColor = primary ? Color.FromArgb(17, 18, 20) : Color.FromArgb(250, 250, 247),
            ForeColor = primary ? Color.White : Color.FromArgb(17, 18, 20),
        };
        button.FlatAppearance.BorderColor = primary ? Color.FromArgb(17, 18, 20) : Color.FromArgb(205, 205, 198);
        button.FlatAppearance.BorderSize = 1;
        return button;
    }

    private (Panel DragStrip, FlowLayoutPanel Controls, Button Maximize) CreateWindowChrome()
    {
        var drag = new Panel
        {
            Height = 7,
            BackColor = Color.Transparent,
            Cursor = Cursors.SizeAll,
        };
        drag.MouseDown += (_, args) =>
        {
            if (args.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, WmNcLButtonDown, HtCaption, 0);
        };
        drag.DoubleClick += (_, _) => ToggleMaximize();

        var controls = new FlowLayoutPanel
        {
            Width = 116,
            Height = 34,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = Padding.Empty,
            Padding = new Padding(4, 3, 4, 3),
            BackColor = Color.FromArgb(252, 252, 250),
        };
        var minimize = CreateWindowButton("−");
        var maximize = CreateWindowButton("□");
        var close = CreateWindowButton("×", closeButton: true);
        close.Tag = "close";
        minimize.Click += (_, _) => WindowState = FormWindowState.Minimized;
        maximize.Click += (_, _) => ToggleMaximize();
        close.Click += (_, _) => Close();
        controls.Controls.Add(minimize);
        controls.Controls.Add(maximize);
        controls.Controls.Add(close);
        return (drag, controls, maximize);
    }

    private static Button CreateWindowButton(string text, bool closeButton = false)
    {
        var button = new Button
        {
            Width = 36,
            Height = 28,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
            Text = text,
            TabStop = false,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(252, 252, 250),
            ForeColor = Color.FromArgb(35, 38, 42),
            Font = new Font("Segoe UI Symbol", 10F),
            Cursor = Cursors.Hand,
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = closeButton
            ? Color.FromArgb(196, 43, 43)
            : Color.FromArgb(232, 233, 230);
        button.FlatAppearance.MouseDownBackColor = closeButton
            ? Color.FromArgb(154, 30, 30)
            : Color.FromArgb(218, 220, 217);
        if (closeButton)
        {
            button.MouseEnter += (_, _) => button.ForeColor = Color.White;
            button.MouseLeave += (_, _) => button.ForeColor = Color.FromArgb(35, 38, 42);
        }
        return button;
    }

    private void HandleShellAction(string action)
    {
        switch (action)
        {
            case "minimize":
                WindowState = FormWindowState.Minimized;
                break;
            case "maximize":
                ToggleMaximize();
                break;
            case "close":
                Close();
                break;
            case "drag":
                ReleaseCapture();
                SendMessage(Handle, WmNcLButtonDown, HtCaption, 0);
                break;
        }
    }

    private void ToggleMaximize()
    {
        if (WindowState == FormWindowState.Maximized)
        {
            WindowState = FormWindowState.Normal;
            return;
        }
        MaximizedBounds = Screen.FromControl(this).WorkingArea;
        WindowState = FormWindowState.Maximized;
    }

    private void LayoutWindowChrome()
    {
        dragStrip.SetBounds(0, 0, Math.Max(0, ClientSize.Width - windowControls.Width), 7);
        windowControls.Location = new Point(Math.Max(0, ClientSize.Width - windowControls.Width - 10), 9);
        using var path = GraphicsExtensions.CreateRoundedRectanglePath(
            new Rectangle(0, 0, windowControls.Width, windowControls.Height), 13);
        var previousRegion = windowControls.Region;
        windowControls.Region = new Region(path);
        previousRegion?.Dispose();
    }

    private void BringWindowChromeToFront()
    {
        dragStrip.BringToFront();
        windowControls.BringToFront();
    }

    private void ShowNativeChrome()
    {
        dragStrip.Visible = true;
        windowControls.Visible = true;
        BringWindowChromeToFront();
    }

    private void HideNativeChrome()
    {
        dragStrip.Visible = false;
        windowControls.Visible = false;
    }

    protected override void WndProc(ref Message message)
    {
        base.WndProc(ref message);
        if (message.Msg != WmNcHitTest || WindowState != FormWindowState.Normal
            || (int)message.Result != HtClient) return;

        var packed = message.LParam.ToInt64();
        var screenPoint = new Point(unchecked((short)(packed & 0xffff)), unchecked((short)((packed >> 16) & 0xffff)));
        var point = PointToClient(screenPoint);
        const int grip = 7;
        var left = point.X < grip;
        var right = point.X >= ClientSize.Width - grip;
        var top = point.Y < grip;
        var bottom = point.Y >= ClientSize.Height - grip;
        message.Result = (IntPtr)(top && left ? HtTopLeft
            : top && right ? HtTopRight
            : bottom && left ? HtBottomLeft
            : bottom && right ? HtBottomRight
            : left ? HtLeft
            : right ? HtRight
            : top ? HtTop
            : bottom ? HtBottom
            : HtClient);
    }

    private const int WmNcHitTest = 0x0084;
    private const int WmNcLButtonDown = 0x00A1;
    private const int HtClient = 1;
    private const int HtCaption = 2;
    private const int HtLeft = 10;
    private const int HtRight = 11;
    private const int HtTop = 12;
    private const int HtTopLeft = 13;
    private const int HtTopRight = 14;
    private const int HtBottom = 15;
    private const int HtBottomLeft = 16;
    private const int HtBottomRight = 17;

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr icon);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, int message, int wParam, int lParam);
}

internal sealed class PrtsLogoControl : Control
{
    public PrtsLogoControl()
    {
        DoubleBuffered = true;
        SetStyle(ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
    }

    protected override void OnPaint(PaintEventArgs args)
    {
        base.OnPaint(args);
        var graphics = args.Graphics;
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var side = Math.Min(ClientSize.Width, ClientSize.Height) - 2;
        var bounds = new Rectangle((ClientSize.Width - side) / 2, (ClientSize.Height - side) / 2, side, side);
        using var background = new SolidBrush(Color.White);
        graphics.FillRoundedRectangle(background, bounds, Math.Max(10, side / 4));
        using var font = new Font("Consolas", side * 0.57F, FontStyle.Bold, GraphicsUnit.Pixel);
        using var foreground = new SolidBrush(Color.FromArgb(17, 18, 20));
        using var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        var state = graphics.Save();
        graphics.TranslateTransform(side * 0.03F, 0);
        using var logoShear = new Matrix();
        logoShear.Shear(-0.08F, 0);
        graphics.MultiplyTransform(logoShear);
        graphics.DrawString("P", font, foreground, bounds, format);
        graphics.Restore(state);
    }
}

internal static class GraphicsExtensions
{
    public static GraphicsPath CreateRoundedRectanglePath(Rectangle bounds, int radius)
    {
        var diameter = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void FillRoundedRectangle(this Graphics graphics, Brush brush, Rectangle bounds, int radius)
    {
        using var path = CreateRoundedRectanglePath(bounds, radius);
        graphics.FillPath(brush, path);
    }
}
