import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectPrtsTarball } from '../electron/inject-runtime.mjs'
import { overlayCurrentChrome } from '../electron/source-overlay-current.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function put(path, body = '') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

test('current Electron injection accepts only the pinned PRTS bundle and zod dependency', t => {
  const dir = mkdtempSync(join(tmpdir(), 'prts-current-package-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const packageDir = join(dir, 'package')
  for (const file of ['cordis.patch.yml', 'presets/definition.js', 'presets/register.js', 'src/index.js']) {
    put(join(packageDir, file))
  }
  const manifest = { name: 'prts-terrarchive', version: '0.2.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: { zod: '4.4.3' } }
  const pack = () => {
    put(join(packageDir, 'package.json'), JSON.stringify(manifest))
    const archive = join(dir, 'plugin.tgz')
    execFileSync('tar', ['-czf', archive, '-C', dir, 'package'])
    return archive
  }
  assert.equal(inspectPrtsTarball(pack()).dependencies.zod, '4.4.3')
  manifest.dependencies.zod = '^4.4.3'
  assert.throws(() => inspectPrtsTarball(pack()), /zod 4\.4\.3/u)
  manifest.dependencies = { zod: '4.4.3', unexpected: '1.0.0' }
  assert.throws(() => inspectPrtsTarball(pack()), /zod 4\.4\.3/u)
})

test('current pinned official Desktop keeps the original PRTS window controls', t => {
  const dsh = resolve(root, '../deepseek-harness')
  const commit = JSON.parse(readFileSync(join(root, 'versions.electron.current.json'), 'utf8')).dsh.commit
  if (!existsSync(join(dsh, '.git'))
    || execFileSync('git', ['-C', dsh, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit) {
    t.skip('Pinned DSH source checkout is unavailable')
    return
  }
  for (const name of ['src/main.ts', 'src/preload-app.ts', 'src/preload-windows.ts']) {
    const source = readFileSync(join(dsh, 'apps/desktop', name), 'utf8')
    const patched = overlayCurrentChrome(name, source)
    assert.notEqual(patched, source)
    assert.equal(overlayCurrentChrome(name, patched), patched)
    assert.throws(() => overlayCurrentChrome(name, '// changed upstream'), /anchor changed/u)
  }
})
