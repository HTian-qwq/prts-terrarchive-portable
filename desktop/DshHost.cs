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
    private Process? process;
    private NativeJob? job;
    private bool requestedStop;
    private bool corpusWarningShown;

    public event Action<Uri>? Ready;
    public event Action<string>? StatusChanged;
    public event Action<string>? Warning;

    public DshHost(string appRoot, DiagnosticLog log)
    {
        this.appRoot = Path.GetFullPath(appRoot);
        dataRoot = Path.Combine(this.appRoot, "userdata");
        this.log = log;
    }

    public async Task StartAsync()
    {
        await lifecycle.WaitAsync();
        try
        {
            if (process is { HasExited: false }) return;
            process?.Dispose();
            process = null;
            job?.Dispose();
            job = null;
            AssertPortableDirectoryWritable();
            WarnIfCorpusUnavailable();

            var nodePath = Path.Combine(appRoot, "runtime", "node", "node.exe");
            var launcherPath = Path.Combine(appRoot, "app", "launcher.mjs");
            if (!File.Exists(nodePath) || !File.Exists(launcherPath))
            {
                throw new FileNotFoundException("运行时文件不完整，请重新下载并完整解压发行包。");
            }

            requestedStop = false;
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
            nextProcess.OutputDataReceived += (_, args) => ConsumeOutput(args.Data, isError: false);
            nextProcess.ErrorDataReceived += (_, args) => ConsumeOutput(args.Data, isError: true);
            nextProcess.Exited += (_, _) => HandleExit(nextProcess);

            StatusChanged?.Invoke("正在启动 PRTS Host…");
            log.Write("Starting portable DSH host.");
            if (!nextProcess.Start()) throw new InvalidOperationException("无法启动内置 Node.js。 ");

            var nextJob = new NativeJob();
            try
            {
                nextJob.Add(nextProcess);
            }
            catch
            {
                nextJob.Dispose();
                if (!nextProcess.HasExited) nextProcess.Kill(entireProcessTree: true);
                throw;
            }

            process = nextProcess;
            job = nextJob;
            nextProcess.BeginOutputReadLine();
            nextProcess.BeginErrorReadLine();
        }
        finally
        {
            lifecycle.Release();
        }
    }

    public async Task RestartAsync()
    {
        StatusChanged?.Invoke("正在重启 PRTS Host…");
        await StopAsync();
        await StartAsync();
    }

    public async Task StopAsync()
    {
        await lifecycle.WaitAsync();
        try
        {
            requestedStop = true;
            var current = process;
            if (current is null)
            {
                job?.Dispose();
                job = null;
                return;
            }

            if (!current.HasExited)
            {
                try
                {
                    await current.StandardInput.WriteLineAsync("shutdown");
                    await current.StandardInput.FlushAsync();
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                    await current.WaitForExitAsync(timeout.Token);
                }
                catch (OperationCanceledException)
                {
                    if (!current.HasExited) current.Kill(entireProcessTree: true);
                }
                catch (InvalidOperationException)
                {
                    // The process exited while the shutdown request was being sent.
                }
            }

            process = null;
            job?.Dispose();
            job = null;
            current.Dispose();
            log.Write("Portable DSH host stopped.");
        }
        finally
        {
            lifecycle.Release();
        }
    }

    public string MemorySnapshot()
    {
        var current = process;
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

    private void ConsumeOutput(string? line, bool isError)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        log.Write($"DSH{(isError ? " stderr" : string.Empty)}: {line}");
        var match = HostUrlPattern().Match(line);
        if (!match.Success || !Uri.TryCreate(match.Value, UriKind.Absolute, out var uri)) return;
        StatusChanged?.Invoke("PRTS Host 已就绪");
        Ready?.Invoke(uri);
    }

    private void HandleExit(Process exitedProcess)
    {
        int? exitCode = null;
        try { exitCode = exitedProcess.ExitCode; } catch (InvalidOperationException) { }
        log.Write($"Portable DSH host exited with code {exitCode?.ToString() ?? "unknown"}.");
        if (!requestedStop)
        {
            StatusChanged?.Invoke($"PRTS Host 已停止（退出码 {exitCode?.ToString() ?? "未知"}）");
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
