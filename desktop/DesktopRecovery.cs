namespace PrtsTerrarchive.Desktop;

// All recovery requests share this gate: initialization, retry and tray restart
// must not create competing browsers or start a host after shutdown.
internal sealed class DesktopRecovery
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private int browserRevision;
    private bool browserReady;

    public bool IsStopping => lifetime.IsCancellationRequested;
    public bool BrowserReady => browserReady && !IsStopping;

    public void InvalidateBrowser()
    {
        browserReady = false;
        browserRevision++;
    }

    public async Task RunAsync(
        Func<CancellationToken, Task> initializeBrowser,
        Func<CancellationToken, Task> connectHost)
    {
        var token = lifetime.Token;
        await gate.WaitAsync(token);
        try
        {
            token.ThrowIfCancellationRequested();
            if (!browserReady)
            {
                var revision = browserRevision;
                await initializeBrowser(token).WaitAsync(token);
                token.ThrowIfCancellationRequested();
                if (revision != browserRevision)
                    throw new InvalidOperationException("页面进程在初始化时停止，请重试。");
                browserReady = true;
            }
            token.ThrowIfCancellationRequested();
            await connectHost(token);
        }
        finally
        {
            gate.Release();
        }
    }

    public void Cancel() => lifetime.Cancel();

    public async Task StopAsync(Func<Task> stopHost)
    {
        Cancel();
        await gate.WaitAsync();
        try { await stopHost(); }
        finally { gate.Release(); }
    }
}
