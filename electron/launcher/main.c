/* Small, statically linked Windows entry point for the portable client folder. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdlib.h>
#include <wchar.h>

#define PATH_CAPACITY 32768

static int fail(const wchar_t *message, DWORD code) {
    wchar_t detail[1024];
    _snwprintf_s(detail, _countof(detail), _TRUNCATE,
        L"%ls\n\nWindows 错误码：%lu", message, (unsigned long)code);
    MessageBoxW(NULL, detail, L"PRTS Terrarchive", MB_OK | MB_ICONERROR);
    return 1;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR arguments, int show) {
    wchar_t root[PATH_CAPACITY];
    wchar_t client[PATH_CAPACITY];
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    wchar_t *separator;
    wchar_t *command;
    size_t commandLength;
    DWORD length;
    DWORD error;
    (void)instance; (void)previous; (void)show;

    length = GetModuleFileNameW(NULL, root, PATH_CAPACITY);
    if (length == 0 || length >= PATH_CAPACITY)
        return fail(L"无法定位便携版所在目录。", GetLastError());
    separator = wcsrchr(root, L'\\');
    if (separator == NULL) return fail(L"便携版目录无效。", ERROR_BAD_PATHNAME);
    /* Keep the trailing slash so drive-root installations also have a full path. */
    separator[1] = L'\0';
    if (_snwprintf_s(client, PATH_CAPACITY, _TRUNCATE,
        L"%lsclient\\PRTS Terrarchive.exe", root) < 0)
        return fail(L"便携版所在目录路径过长。", ERROR_FILENAME_EXCED_RANGE);

    commandLength = wcslen(client) + wcslen(arguments) + 4;
    if (commandLength > 32767)
        return fail(L"启动参数过长。", ERROR_BAD_ARGUMENTS);
    command = (wchar_t *)calloc(commandLength, sizeof(wchar_t));
    if (command == NULL) return fail(L"启动器无法分配内存。", ERROR_NOT_ENOUGH_MEMORY);
    /* wWinMain supplies the original argument tail; keep Windows quoting intact.
       Supply the absolute executable separately, never invoke a command shell. */
    _snwprintf_s(command, commandLength, _TRUNCATE, L"\"%ls\" %ls", client, arguments);
    startup.cb = (DWORD)sizeof(startup);
    if (!CreateProcessW(client, command, NULL, NULL, FALSE, 0, NULL, root, &startup, &process)) {
        error = GetLastError();
        free(command);
        return fail(L"无法启动 client\\PRTS Terrarchive.exe。\n请完整解压便携版，保留 client 文件夹及其中的全部文件。", error);
    }
    free(command);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 0;
}
