using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using PrtsTerrarchive.Desktop;

var timeout = TimeSpan.FromSeconds(10);
var nodePath = Path.GetFullPath(args[0]);
var root = Path.GetFullPath(args[1]);

void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

async Task ExpectFailure(Func<Task> action)
{
    try { await action(); }
    catch (InvalidOperationException) { return; }
    throw new Exception("Expected initialization failure");
}

async Task ExpectCancellation(Task task)
{
    try { await task.WaitAsync(timeout); }
    catch (OperationCanceledException) { return; }
    throw new Exception("Expected canceled recovery");
}

async Task Run(string name, Func<Task> action)
{
    await action();
    Console.WriteLine($"PASS {name}");
}

DshHost Fixture(string name, string script)
{
    var appRoot = Path.Combine(root, name);
    Directory.CreateDirectory(Path.Combine(appRoot, "runtime", "node"));
    Directory.CreateDirectory(Path.Combine(appRoot, "app"));
    var executable = Path.Combine(appRoot, "runtime", "node", "node.exe");
    if (OperatingSystem.IsWindows()) File.Copy(nodePath, executable);
    else File.CreateSymbolicLink(executable, nodePath);
    File.WriteAllText(Path.Combine(appRoot, "app", "launcher.mjs"), script);
    return new DshHost(appRoot, new DiagnosticLog(Path.Combine(appRoot, "desktop.log")));
}

const string liveScript = """
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => { if (data.includes('shutdown')) process.exit(0); });
    console.log('http://127.0.0.1:54321/?token=test-ready');
    """;

await Run("initialization failure retries before starting host", async () =>
{
    var recovery = new DesktopRecovery();
    var attempts = 0;
    var connected = 0;
    Task Init(CancellationToken token)
    {
        if (++attempts == 1) throw new InvalidOperationException("Runtime unavailable");
        return Task.CompletedTask;
    }
    Task Connect(CancellationToken token) { connected++; return Task.CompletedTask; }
    await ExpectFailure(() => recovery.RunAsync(Init, Connect));
    Check(!recovery.BrowserReady && connected == 0, "Failed browser must not start host");
    await recovery.RunAsync(Init, Connect);
    Check(attempts == 2 && connected == 1 && recovery.BrowserReady, "Retry must initialize again");
});

await Run("concurrent retry shares initialization and serializes host work", async () =>
{
    var recovery = new DesktopRecovery();
    var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var attempts = 0;
    var active = 0;
    var connections = 0;
    async Task Init(CancellationToken token) { attempts++; entered.TrySetResult(); await release.Task; }
    async Task Connect(CancellationToken token)
    {
        Check(Interlocked.Increment(ref active) == 1, "Host work overlapped");
        await Task.Yield();
        Interlocked.Decrement(ref active);
        connections++;
    }
    var first = recovery.RunAsync(Init, Connect);
    await entered.Task.WaitAsync(timeout);
    var second = recovery.RunAsync(Init, Connect);
    release.SetResult();
    await Task.WhenAll(first, second).WaitAsync(timeout);
    Check(attempts == 1 && connections == 2, "Concurrent retries duplicated browser initialization");
});

await Run("browser process exit recreates browser before reconnect", async () =>
{
    var recovery = new DesktopRecovery();
    var browser = 0;
    var connectedBrowser = 0;
    Task Init(CancellationToken token) { browser++; return Task.CompletedTask; }
    Task Connect(CancellationToken token) { connectedBrowser = browser; return Task.CompletedTask; }
    await recovery.RunAsync(Init, Connect);
    recovery.InvalidateBrowser();
    Check(!recovery.BrowserReady, "Exited browser stayed ready");
    await recovery.RunAsync(Init, Connect);
    Check(browser == 2 && connectedBrowser == 2, "Recovery navigated the dead browser");
    recovery.InvalidateBrowser();
    await ExpectFailure(() => recovery.RunAsync(token =>
    {
        recovery.InvalidateBrowser();
        return Task.CompletedTask;
    }, Connect));
    Check(!recovery.BrowserReady, "Browser dying during initialization was cached");
});

await Run("shutdown cancels pending initialization and queued retries", async () =>
{
    var recovery = new DesktopRecovery();
    var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var connected = 0;
    var stopped = 0;
    async Task Init(CancellationToken token) { entered.TrySetResult(); await release.Task; }
    Task Connect(CancellationToken token) { connected++; return Task.CompletedTask; }
    var first = recovery.RunAsync(Init, Connect);
    await entered.Task.WaitAsync(timeout);
    var queued = recovery.RunAsync(Init, Connect);
    await recovery.StopAsync(() => { stopped++; return Task.CompletedTask; }).WaitAsync(timeout);
    await ExpectCancellation(first);
    await ExpectCancellation(queued);
    release.SetResult();
    await Task.Yield();
    await ExpectCancellation(recovery.RunAsync(Init, Connect));
    Check(connected == 0 && stopped == 1 && !recovery.BrowserReady, "Late initialization restarted host");
});

await Run("host exit before readiness emits retryable failure with exit code", async () =>
{
    await using var host = Fixture("early-exit", "setTimeout(() => process.exit(17), 100);");
    var failed = new TaskCompletionSource<(long Generation, string Message)>(TaskCreationOptions.RunContinuationsAsynchronously);
    var ready = 0;
    host.Ready += (_, _) => Interlocked.Increment(ref ready);
    host.Failed += (generation, message) => failed.TrySetResult((generation, message));
    await host.StartAsync();
    var result = await failed.Task.WaitAsync(timeout);
    Check(result.Message.Contains("17") && ready == 0, "Startup failure lost exit code or appeared ready");
    Check(host.IsCurrentGeneration(result.Generation) && !host.IsRunningGeneration(result.Generation), "Exited generation state incorrect");
    await host.StopAsync();
    Check(!host.IsCurrentGeneration(result.Generation), "Stopped failure can still update UI");
});

await Run("restart ignores previous generation output and exit", async () =>
{
    await using var host = Fixture("restart", liveScript);
    var ready = new ConcurrentQueue<long>();
    var failures = 0;
    var first = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
    var second = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
    host.Ready += (generation, _) =>
    {
        ready.Enqueue(generation);
        if (!first.TrySetResult(generation)) second.TrySetResult(generation);
    };
    host.Failed += (_, _) => Interlocked.Increment(ref failures);
    await host.StartAsync();
    var oldGeneration = await first.Task.WaitAsync(timeout);
    var flags = BindingFlags.Instance | BindingFlags.NonPublic;
    var previous = typeof(DshHost).GetField("currentHost", flags)!.GetValue(host)!;
    await host.RestartAsync();
    var newGeneration = await second.Task.WaitAsync(timeout);
    // Deliver the prior process's already-queued callbacks after the new host is
    // ready. This deterministically covers the race without scheduling sleeps.
    typeof(DshHost).GetMethod("HandleExit", flags)!.Invoke(host, [previous]);
    typeof(DshHost).GetMethod("ConsumeOutput", flags)!.Invoke(host,
        [previous, "http://127.0.0.1:12345/?token=stale", false]);
    Check(ready.Count == 2 && failures == 0, "Old callbacks affected the restarted host");
    Check(newGeneration != oldGeneration && !host.IsCurrentGeneration(oldGeneration)
        && host.IsRunningGeneration(newGeneration), "Generation did not advance");
    await host.StopAsync();
    Check(failures == 0 && host.MemorySnapshot() == "node=stopped", "Requested stop displayed a failure");
});

await Run("closed host stdin still cleans up and permits retry", async () =>
{
    await using var host = Fixture("closed-stdin", """
        import fs from 'node:fs';
        fs.closeSync(0);
        console.log('http://127.0.0.1:54321/?token=closed-stdin');
        setInterval(() => {}, 1000);
        """);
    var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var failures = 0;
    host.Ready += (_, _) => ready.TrySetResult();
    host.Failed += (_, _) => Interlocked.Increment(ref failures);
    await host.StartAsync();
    await ready.Task.WaitAsync(timeout);
    var disposals = NativeJob.Disposals;
    await host.StopAsync().WaitAsync(timeout);
    Check(NativeJob.Disposals == disposals + 1 && host.MemorySnapshot() == "node=stopped", "Broken pipe leaked host resources");
    Check(failures == 0, "Broken pipe during requested stop displayed failure");
    File.WriteAllText(Path.Combine(root, "closed-stdin", "app", "launcher.mjs"), liveScript);
    ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    await host.StartAsync();
    await ready.Task.WaitAsync(timeout);
});

await Run("job setup failure cleans process and allows startup retry", async () =>
{
    await using var host = Fixture("job-failure", liveScript);
    NativeJob.FailNextAdd = true;
    var disposals = NativeJob.Disposals;
    await ExpectFailure(host.StartAsync);
    Check(host.MemorySnapshot() == "node=stopped" && NativeJob.Disposals == disposals + 1, "Failed setup retained process/job");
    var pid = NativeJob.FailedProcessId!.Value;
    try
    {
        using var child = Process.GetProcessById(pid);
        await child.WaitForExitAsync().WaitAsync(timeout);
    }
    catch (ArgumentException) { }
    var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    host.Ready += (_, _) => ready.TrySetResult();
    await host.StartAsync();
    await ready.Task.WaitAsync(timeout);
});

await Run("shutdown during host restart does not launch a new generation", async () =>
{
    await using var host = Fixture("cancel-restart", """
        import fs from 'node:fs';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', data => {
          if (!data.includes('shutdown')) return;
          fs.writeFileSync('stopping', 'yes');
          const timer = setInterval(() => {
            if (fs.existsSync('release-stop')) { clearInterval(timer); process.exit(0); }
          }, 10);
        });
        console.log('http://127.0.0.1:54321/?token=cancel-restart');
        """);
    var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var connections = 0;
    host.Ready += (_, _) => { Interlocked.Increment(ref connections); ready.TrySetResult(); };
    await host.StartAsync();
    await ready.Task.WaitAsync(timeout);
    using var cancellation = new CancellationTokenSource();
    var restart = host.RestartAsync(cancellation.Token);
    var appRoot = Path.Combine(root, "cancel-restart");
    using var deadline = new CancellationTokenSource(timeout);
    while (!File.Exists(Path.Combine(appRoot, "stopping"))) await Task.Delay(10, deadline.Token);
    cancellation.Cancel();
    File.WriteAllText(Path.Combine(appRoot, "release-stop"), "yes");
    await ExpectCancellation(restart);
    Check(connections == 1 && host.MemorySnapshot() == "node=stopped", "Canceled restart created another host");
});
