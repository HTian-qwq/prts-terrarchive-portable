import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCurrentDesktopEnvironment } from '../scripts/prepare-current-desktop-env.mjs'

function fixture(t) {
  const source = mkdtempSync(join(tmpdir(), 'prts-current-env-'))
  t.after(() => rmSync(source, { recursive: true, force: true }))
  mkdirSync(join(source, 'apps', 'desktop'), { recursive: true })
  return source
}

test('current Desktop preparation gets a valid local policy without release credentials', t => {
  const source = fixture(t)
  const destination = prepareCurrentDesktopEnvironment({ dshSource: source, appId: 'chat.prts.terrarchive.portable' })
  const settings = Object.fromEntries(readFileSync(destination, 'utf8').split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
  assert.equal(settings.DSH_DESKTOP_APP_ID, 'chat.prts.terrarchive.portable')
  assert.equal(settings.DSH_DESKTOP_AUTO_UPDATE_ENV, 'test')
  const origin = new URL(settings.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN)
  assert.equal(origin.protocol, 'https:')
  assert.equal(origin.hostname.endsWith('.invalid'), true)
  assert.deepEqual(JSON.parse(settings.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG.slice(1, -1)), {
    allowedAuthOrigins: [origin.origin],
  })
  assert.equal(Object.keys(settings).some(name => /CER_FILE|SIGNTOOL|TOKEN_PIN|COS_|DOWNLOAD_TEST_/u.test(name)), false)
})

test('current Desktop preparation preserves a pre-existing local dotenv', t => {
  const source = fixture(t)
  const destination = join(source, 'apps', 'desktop', '.env.windows')
  const original = 'DSH_DESKTOP_APP_ID=com.example.local\nDSH_DESKTOP_WINDOWS_TOKEN_PIN=private\n'
  writeFileSync(destination, original)
  assert.equal(prepareCurrentDesktopEnvironment({ dshSource: source }), destination)
  assert.equal(readFileSync(destination, 'utf8'), original)
})
