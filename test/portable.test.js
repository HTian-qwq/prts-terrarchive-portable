import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeProfileManifest, parseDshUrl, redactToken } from '../src/portable.mjs'
import { assertWindowsX64Executable } from '../scripts/windows-pe.mjs'

test('桌面 SDK、WebView2 与版本清单保持一致', () => {
  const versions = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8'))
  const globalSdk = JSON.parse(readFileSync(new URL('../global.json', import.meta.url), 'utf8'))
  const project = readFileSync(
    new URL('../desktop/PrtsTerrarchive.Desktop.csproj', import.meta.url), 'utf8')
  assert.equal(globalSdk.sdk.version, versions.desktop.dotnetSdk)
  assert.match(project, new RegExp(
    `<PackageReference Include="Microsoft\\.Web\\.WebView2" Version="${versions.desktop.webView2Sdk}"`,
    'u',
  ))
  assert.match(project, /<TargetFramework>net10\.0-windows/u)
})

test('解析 alpha.1 Host 启动 URL，并在日志中隐藏 token', () => {
  const line = 'Open http://127.0.0.1:43189/?token=Abc_123-xyz now'
  assert.equal(parseDshUrl(line), 'http://127.0.0.1:43189/?token=Abc_123-xyz')
  assert.equal(redactToken(line), 'Open http://127.0.0.1:43189/?token=[redacted] now')
})

test('合并 profile 时保留第三方 bundle，并固定托管插件', () => {
  const merged = mergeProfileManifest({
    name: 'custom-web',
    dependencies: { example: '1.0.0', 'prts-terrarchive': 'old' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'example', 'prts-terrarchive'] } },
  }, { pluginVersion: '0.1.0-alpha.1' })
  assert.deepEqual(merged.dependencies, {
    example: '1.0.0',
    'prts-terrarchive': '0.1.0-alpha.1',
  })
  assert.deepEqual(merged.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'example',
    'prts-terrarchive',
  ])
  assert.equal(merged.dsh.profile.patchReload, 'live')
})

test('拒绝把 Linux ELF 伪装成 Windows node.exe', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prts-pe-test-'))
  const executable = join(directory, 'node.exe')
  const fd = openSync(executable, 'w')
  try {
    writeSync(fd, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    writeSync(fd, Buffer.alloc(60))
  } finally {
    closeSync(fd)
  }
  try {
    assert.throws(
      () => assertWindowsX64Executable(executable, 'Node.js'),
      /不是 Windows PE 文件/u,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('接受 Windows x64 PE 文件头', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prts-pe-test-'))
  const executable = join(directory, 'node.exe')
  const header = Buffer.alloc(70)
  header.write('MZ', 0, 'ascii')
  header.writeUInt32LE(64, 0x3c)
  header.write('PE\0\0', 64, 'binary')
  header.writeUInt16LE(0x8664, 68)
  const fd = openSync(executable, 'w')
  try {
    writeSync(fd, header)
  } finally {
    closeSync(fd)
  }
  try {
    assert.doesNotThrow(() => assertWindowsX64Executable(executable, 'Node.js'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
