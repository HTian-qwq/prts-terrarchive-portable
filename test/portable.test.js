import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeProfileManifest, parseDshUrl, redactToken } from '../src/portable.mjs'

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
