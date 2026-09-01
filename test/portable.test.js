import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeProfileManifest,
  parseDshUrl,
  redactToken,
  syncManagedInstall,
} from '../src/portable.mjs'
import { assertWindowsX64Executable } from '../scripts/windows-pe.mjs'

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

test('托管目录仅在发行标记变化时原子替换', () => {
  const root = mkdtempSync(join(tmpdir(), 'prts-managed-test-'))
  const appRoot = join(root, 'app')
  const dataRoot = join(root, 'data')
  const profile = join(appRoot, 'templates', 'profiles', 'web')
  const plugin = join(profile, 'node_modules', 'prts-terrarchive')
  const preset = join(appRoot, 'templates', '.agent-presets', 'prts')
  mkdirSync(plugin, { recursive: true })
  mkdirSync(preset, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { 'prts-terrarchive': '0.1.0-alpha.1' },
  }))
  writeFileSync(join(profile, 'cordis.yml'), 'name: web\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), 'patch: true\n')
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    name: 'prts-terrarchive', version: '0.1.0-alpha.1',
  }))
  writeFileSync(join(plugin, 'content.txt'), 'first')
  writeFileSync(join(plugin, '.prts-portable-source.json'), '{"build":"one"}\n')
  writeFileSync(join(preset, 'preset.txt'), 'first')
  writeFileSync(join(preset, '.prts-portable-source.json'), '{"build":"one"}\n')

  try {
    syncManagedInstall({ appRoot, dataRoot })
    const installed = join(dataRoot, 'profiles', 'web', 'node_modules', 'prts-terrarchive')
    writeFileSync(join(installed, 'sentinel.txt'), 'keep when current')
    syncManagedInstall({ appRoot, dataRoot })
    assert.equal(readFileSync(join(installed, 'sentinel.txt'), 'utf8'), 'keep when current')

    writeFileSync(join(plugin, 'content.txt'), 'second')
    writeFileSync(join(plugin, '.prts-portable-source.json'), '{"build":"two"}\n')
    syncManagedInstall({ appRoot, dataRoot })
    assert.equal(readFileSync(join(installed, 'content.txt'), 'utf8'), 'second')
    assert.equal(existsSync(join(installed, 'sentinel.txt')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
