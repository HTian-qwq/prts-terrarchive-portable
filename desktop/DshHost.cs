using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PrtsTerrarchive.Desktop;

internal sealed partial class DshHost : IAsyncDisposable
{
    private readonly string appRoot;
    private readonly string dataRoot;
    private readonly DiagnosticLog log;
    private readonly SemaphoreSlim lifecycle = new(1, 1);
    private sealed class HostProcess(Process process, long generation)
    {
        public Process Process { get; } = process;
        public long Generation { get; } = generation;
        public NativeJob? Job { get; set; }
        public int Stopping;
        public int Exited;
    }

    private HostProcess? currentHost;
    private long nextGeneration;
    private bool corpusWarningShown;

    public event Action<long, Uri>? Ready;
    public event Action<long, string>? Failed;
    public event Action<string>? StatusChanged;
    public event Action<string>? Warning;

    public DshHost(string appRoot, DiagnosticLog log)
    {
        this.appRoot = Path.GetFullPath(appRoot);
        dataRoot = Path.Combine(this.appRoot, "userdata");
        this.log = log;
    }

    public bool IsCurrentGeneration(long generation) =>
        Volatile.Read(ref currentHost) is { } current
        && current.Generation == generation && Volatile.Read(ref current.Stopping) == 0;

    public bool IsRunningGeneration(long generation) =>
        Volatile.Read(ref currentHost) is { } current
        && current.Generation == generation && Volatile.Read(ref current.Stopping) == 0
        && Volatile.Read(ref current.Exited) == 0;

    public async Task StartAsync()
    {
        await lifecycle.WaitAsync();
        try
        {
            if (currentHost is { } running && !running.Process.HasExited) return;
            DisposeCurrentHost();
            AssertPortableDirectoryWritable();
            WarnIfCorpusUnavailable();

            var nodePath = Path.Combine(appRoot, "runtime", "node", "node.exe");
            var launcherPath = Path.Combine(appRoot, "app", "launcher.mjs");
            if (!File.Exists(nodePath) || !File.Exists(launcherPath))
            {
                throw new FileNotFoundException("运行时文件不完整，请重新下载并完整解压发行包。");
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                WorkingDirectory = appRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            startInfo.ArgumentList.Add(launcherPath);
            startInfo.Environment["PRTS_DATA_DIR"] = dataRoot;
            startInfo.Environment["PRTS_NO_OPEN"] = "1";
            startInfo.Environment["PRTS_DESKTOP"] = "1";

            var nextProcess = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            var next = new HostProcess(nextProcess, Interlocked.Increment(ref nextGeneration));
            nextProcess.OutputDataReceived += (_, args) => ConsumeOutput(next, args.Data, isError: false);
            nextProcess.ErrorDataReceived += (_, args) => ConsumeOutput(next, args.Data, isError: true);
            nextProcess.Exited += (_, _) => HandleExit(next);
            Volatile.Write(ref currentHost, next);

            StatusChanged?.Invoke("正在启动 PRTS Host…");
            log.Write("Starting portable DSH host.");
            try
            {
                if (!nextProcess.Start()) throw new InvalidOperationException("无法启动内置 Node.js。");
                next.Job = new NativeJob();
                next.Job.Add(nextProcess);
                nextProcess.BeginOutputReadLine();
                nextProcess.BeginErrorReadLine();
            }
            catch
            {
                Interlocked.Exchange(ref next.Stopping, 1);
                KillHost(nextProcess);
                DisposeCurrentHost();
                throw;
            }
        }
        finally
        {
            lifecycle.Release();
        }
    }

    public async Task RestartAsync(CancellationToken token = default)
    {
        StatusChanged?.Invoke("正在重启 PRTS Host…");
        await StopAsync();
        token.ThrowIfCancellationRequested();
        await StartAsync();
    }

    public async Task StopAsync()
    {
        await lifecycle.WaitAsync();
        try
        {
            var current = currentHost;
            if (current is null) return;
            Interlocked.Exchange(ref current.Stopping, 1);
            try
            {
                if (!current.Process.HasExited)
                {
                    try
                    {
                        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                        await current.Process.StandardInput.WriteLineAsync("shutdown").WaitAsync(timeout.Token);
                        await current.Process.StandardInput.FlushAsync().WaitAsync(timeout.Token);
                        await current.Process.WaitForExitAsync(timeout.Token);
                    }
                    catch (Exception error) when (error is OperationCanceledException or IOException
                        or InvalidOperationException)
                    {
                        // A closed stdin must not prevent process/job cleanup or a later retry.
                        log.Write($"Graceful host shutdown unavailable: {error.Message}");
                        KillHost(current.Process);
                    }
                }
            }
            finally
            {
                DisposeCurrentHost();
            }
            log.Write("Portable DSH host stopped.");
        }
        finally
        {
            lifecycle.Release();
        }
    }

    private void KillHost(Process process)
    {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            log.Write($"Host termination raced with exit: {error.Message}");
        }
    }

    private void DisposeCurrentHost()
    {
        var old = Interlocked.Exchange(ref currentHost, null);
        if (old is null) return;
        Interlocked.Exchange(ref old.Stopping, 1);
        try { old.Job?.Dispose(); }
        finally { old.Process.Dispose(); }
    }

    public string MemorySnapshot()
    {
        var current = Volatile.Read(ref currentHost)?.Process;
        if (current is null) return "node=stopped";
        try
        {
            current.Refresh();
            return $"node(pid={current.Id}, working={ToMiB(current.WorkingSet64)}, private={ToMiB(current.PrivateMemorySize64)})";
        }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return "node=unavailable";
        }
    }

    private static string ToMiB(long bytes) => $"{bytes / 1048576D:F1} MiB";

    private void AssertPortableDirectoryWritable()
    {
        Directory.CreateDirectory(dataRoot);
        var probe = Path.Combine(dataRoot, $".write-test-{Environment.ProcessId}");
        try
        {
            File.WriteAllText(probe, "ok");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new IOException(
                "当前目录不可写。请完整解压程序，并将文件夹移动到桌面、文档或其他普通目录后重试。",
                error);
        }
        finally
        {
            try { File.Delete(probe); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private void WarnIfCorpusUnavailable()
    {
        if (corpusWarningShown) return;
        var releases = Path.Combine(appRoot, "corpus", "releases");
        var pointerPath = Path.Combine(releases, "current.json");
        string? message = null;
        try
        {
            using var pointer = JsonDocument.Parse(File.ReadAllText(pointerPath));
            var releaseId = pointer.RootElement.GetProperty("release_id").GetString();
            var dataVersion = pointer.RootElement.GetProperty("data_version").GetString();
            var manifestPath = string.IsNullOrWhiteSpace(releaseId)
                ? string.Empty : Path.Combine(releases, releaseId, "release-manifest.json");
            if (string.IsNullOrWhiteSpace(manifestPath) || !File.Exists(manifestPath))
            {
                message = "内置语料配置不完整。";
            }
            else
            {
                using var manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));
                var manifestReleaseId = manifest.RootElement.GetProperty("release_id").GetString();
                var manifestDataVersion = manifest.RootElement.GetProperty("data_version").GetString();
                if (manifestReleaseId != releaseId || manifestDataVersion != dataVersion
                    || string.IsNullOrWhiteSpace(dataVersion) || dataVersion.Length != 64)
                {
                    message = "内置语料版本配置不一致。";
                }
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException
            or JsonException or KeyNotFoundException)
        {
            message = "没有检测到可用的内置语料。";
        }
        if (message is null) return;
        corpusWarningShown = true;
        Warning?.Invoke($"{message}\n\n请确认发行包已完整解压且 corpus 目录仍在；程序启动后也可以前往“设置 → 插件 → PRTS 语料”重新下载或检查配置。");
    }

    private void ConsumeOutput(HostProcess source, string? line, bool isError)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        log.Write($"DSH{(isError ? " stderr" : string.Empty)}: {line}");
        if (!IsCurrentGeneration(source.Generation) || Volatile.Read(ref source.Exited) != 0) return;
        var match = HostUrlPattern().Match(line);
        if (!match.Success || !Uri.TryCreate(match.Value, UriKind.Absolute, out var uri)) return;
        StatusChanged?.Invoke("PRTS Host 已就绪");
        Ready?.Invoke(source.Generation, uri);
    }

    private void HandleExit(HostProcess source)
    {
        Interlocked.Exchange(ref source.Exited, 1);
        int? exitCode = null;
        try { exitCode = source.Process.ExitCode; } catch (InvalidOperationException) { }
        log.Write($"Portable DSH host exited with code {exitCode?.ToString() ?? "unknown"}.");
        if (IsCurrentGeneration(source.Generation))
        {
            var message = $"PRTS Host 已停止（退出码 {exitCode?.ToString() ?? "未知"}）。可以重试启动；详细信息见 userdata\\logs\\desktop.log。";
            StatusChanged?.Invoke(message);
            Failed?.Invoke(source.Generation, message);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        lifecycle.Dispose();
    }

    [GeneratedRegex(@"https?://(?:127\.0\.0\.1|localhost):\d+/\?token=[A-Za-z0-9_-]+", RegexOptions.CultureInvariant)]
    private static partial Regex HostUrlPattern();
}
