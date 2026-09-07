using System.Diagnostics;

namespace PrtsTerrarchive.Desktop;

// Windows job handles cannot run in the portable Linux logic harness. Process
// launch, pipes, exit callbacks and DshHost cleanup all use the production code.
internal sealed class NativeJob : IDisposable
{
    public static bool FailNextAdd;
    public static int? FailedProcessId;
    public static int Disposals;

    public void Add(Process process)
    {
        if (!FailNextAdd) return;
        FailNextAdd = false;
        FailedProcessId = process.Id;
        throw new InvalidOperationException("Injected job assignment failure");
    }

    public void Dispose() => Interlocked.Increment(ref Disposals);
}
