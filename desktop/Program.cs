using System.Threading;

namespace PrtsTerrarchive.Desktop;

internal static class Program
{
    private const string InstanceMutexName = @"Local\PRTS-Terrarchive-Desktop-3D105542";
    private const string ShowEventName = @"Local\PRTS-Terrarchive-Show-3D105542";

    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();

        using var mutex = new Mutex(true, InstanceMutexName, out var ownsInstance);
        if (!ownsInstance)
        {
            SignalExistingInstance();
            return;
        }

        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        using var context = new DesktopApplicationContext(showEvent);
        Application.Run(context);
    }

    private static void SignalExistingInstance()
    {
        try
        {
            using var showEvent = EventWaitHandle.OpenExisting(ShowEventName);
            showEvent.Set();
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            // The first process is still between acquiring the mutex and creating the event.
        }
    }
}
