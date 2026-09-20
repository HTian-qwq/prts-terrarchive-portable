import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completeTestProfile } from '../scripts/test-profile.mjs'

test('release-only workspace modules are linked even when absent from pnpm hoisting', t => {
  const root = mkdtempSync(join(tmpdir(), 'prts-test-profile-'))
  const profile = join(root, 'profile')
  const added = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-web-fetch-http']
  t.after(() => {
    for (const name of added) {
      const link = join(profile, 'node_modules', name)
      if (existsSync(link)) unlinkSync(link)
    }
    rmSync(root, { recursive: true, force: true })
  })
  for (const [path, name] of [['packages/core/agent', added[0]], ['packages/web/web-fetch-http', added[1]], ['profile/node_modules/@deepseek-ai/cordis', '@deepseek-ai/cordis']]) {
    const directory = join(root, path)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '0.1.5-alpha.1' }))
  }
  const release = Object.fromEntries([...added, '@deepseek-ai/cordis'].map(name => [name, 'file:release.tgz']))
  assert.deepEqual(completeTestProfile(root, profile, release), added)
  assert.equal(realpathSync(join(profile, 'node_modules', added[0])), realpathSync(join(root, 'packages/core/agent')))
  assert.deepEqual(completeTestProfile(root, profile, release), [])
  assert.throws(() => completeTestProfile(root, profile, { '@deepseek-ai/missing-module': 'file:missing.tgz' }), /no built workspace package/)
  assert.throws(() => completeTestProfile(root, profile, { '../../escape': 'file:bad.tgz' }), /Unexpected release package/)
})
