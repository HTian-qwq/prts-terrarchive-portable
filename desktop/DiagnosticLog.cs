using System.Text.RegularExpressions;

namespace PrtsTerrarchive.Desktop;

internal sealed partial class DiagnosticLog
{
    private const long MaximumBytes = 5 * 1024 * 1024;
    private readonly string path;
    private readonly object writeLock = new();

    public DiagnosticLog(string path)
    {
        this.path = path;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        RotateIfNeeded();
    }

    public void Write(string message)
    {
        var safeMessage = TokenPattern().Replace(message, "$1[redacted]");
        lock (writeLock)
        {
            File.AppendAllText(path, $"{DateTimeOffset.Now:O} {safeMessage}{Environment.NewLine}");
        }
    }

    private void RotateIfNeeded()
    {
        if (!File.Exists(path) || new FileInfo(path).Length <= MaximumBytes) return;
        var previous = $"{path}.previous";
        File.Delete(previous);
        File.Move(path, previous);
    }

    [GeneratedRegex(@"([?&]token=)[A-Za-z0-9_-]+", RegexOptions.CultureInvariant)]
    private static partial Regex TokenPattern();
}
