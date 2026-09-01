namespace PrtsTerrarchive.Desktop;

internal sealed class DesktopApplicationContext : ApplicationContext
{
    private readonly MainWindow window;
    private readonly RegisteredWaitHandle showRegistration;
    private bool exiting;

    public DesktopApplicationContext(EventWaitHandle showEvent)
    {
        var appRoot = AppContext.BaseDirectory;
        var log = new DiagnosticLog(Path.Combine(appRoot, "userdata", "logs", "desktop.log"));
        var host = new DshHost(appRoot, log);
        window = new MainWindow(appRoot, host, log, RequestExitAsync);
        MainForm = window;
        showRegistration = ThreadPool.RegisterWaitForSingleObject(
            showEvent,
            (_, _) => window.RestoreFromTrayThreadSafe(),
            null,
            Timeout.Infinite,
            executeOnlyOnce: false);

        window.Show();
    }

    private async Task RequestExitAsync()
    {
        if (exiting) return;
        exiting = true;
        showRegistration.Unregister(null);
        await window.ShutdownAsync();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            showRegistration.Unregister(null);
            window.Dispose();
        }
        base.Dispose(disposing);
    }
}
