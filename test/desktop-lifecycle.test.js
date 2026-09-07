import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('desktop recovery and host process lifecycle', { timeout: 120_000 }, t => {
  const dotnet = process.env.DOTNET_HOST_PATH || 'dotnet';
  const sdks = spawnSync(dotnet, ['--list-sdks'], { encoding: 'utf8' });
  if (sdks.error?.code === 'ENOENT') {
    t.skip('Requires a .NET 8+ SDK to execute the C# desktop lifecycle harness');
    return;
  }
  assert.equal(sdks.status, 0, sdks.stderr);
  const major = Math.max(...[...sdks.stdout.matchAll(/^(\d+)\./gm)].map(match => Number(match[1])));
  if (!(major >= 8)) {
    t.skip('Requires a .NET 8+ SDK to execute the C# desktop lifecycle harness');
    return;
  }
  const scratch = mkdtempSync(path.join(tmpdir(), 'prts-desktop-tests-'));
  try {
    // Copy the linked production sources too, so builds leave no obj/bin files
    // or SDK-specific restore output in the working tree.
    cpSync(path.join(root, 'test', 'desktop'), path.join(scratch, 'test', 'desktop'), { recursive: true });
    for (const file of ['DesktopRecovery.cs', 'DshHost.cs', 'DiagnosticLog.cs']) {
      cpSync(path.join(root, 'desktop', file), path.join(scratch, 'desktop', file), { recursive: true });
    }
    writeFileSync(path.join(scratch, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
    const project = path.join(scratch, 'test', 'desktop', 'DesktopLifecycle.csproj');
    writeFileSync(project, readFileSync(project, 'utf8').replace('<TargetFramework>net8.0</TargetFramework>', `<TargetFramework>net${major}.0</TargetFramework>`));
    const result = spawnSync(dotnet, ['run', '--project', project, '--', process.execPath, path.join(scratch, 'fixtures')], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 100_000,
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.split('\n').filter(line => line.startsWith('PASS ')).length, 9, result.stdout);
    t.diagnostic(result.stdout.trim());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
