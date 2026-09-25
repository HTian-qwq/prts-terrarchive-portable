import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCurrentDshSource } from '../scripts/prepare-current-dsh-source.mjs'

function git(...args) { return execFileSync('git', args, { encoding: 'utf8' }).trim() }
function put(path, content) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content) }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'prts-dsh-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'deepseek-harness')
  mkdirSync(source)
  git('init', '-q', source)
  put(join(source, 'package.json'), JSON.stringify({ version: '0.1.7-rc.2' }))
  put(join(source, 'apps/desktop/package.json'), JSON.stringify({ version: '0.1.7-rc.2' }))
  git('-C', source, 'add', '.')
  git('-C', source, '-c', 'user.name=PRTS Test', '-c', 'user.email=prts@example.invalid', 'commit', '-qm', 'pinned')
  const commit = git('-C', source, 'rev-parse', 'HEAD')
  git('-C', source, 'tag', 'dsh-v0.1.7-rc.2')
  const pin = { commit, tag: 'dsh-v0.1.7-rc.2', version: '0.1.7-rc.2' }
  const portable = join(root, 'portable')
  mkdirSync(portable)
  return { root: portable, source, pin, cache: join(portable, '.build/dsh-electron-current') }
}

test('interrupted DSH clone is discarded and the pinned commit is copied from local source', t => {
  const { root, source, pin, cache } = fixture(t)
  mkdirSync(join(cache, '.git'), { recursive: true })
  put(join(cache, 'partial-pack'), 'truncated')
  // The local checkout may have moved ahead while still retaining the pinned tag.
  put(join(source, 'later.txt'), 'new commit')
  git('-C', source, 'add', '.')
  git('-C', source, '-c', 'user.name=PRTS Test', '-c', 'user.email=prts@example.invalid', 'commit', '-qm', 'later')
  assert.equal(prepareCurrentDshSource({ root, pin, localSource: source, attempts: 0 }), cache)
  assert.equal(git('-C', cache, 'rev-parse', 'HEAD'), pin.commit)
  assert.equal(existsSync(join(cache, 'partial-pack')), false)
  put(join(cache, 'prepared-build-marker'), 'keep')
  prepareCurrentDshSource({ root, pin, localSource: source, attempts: 0 })
  assert.equal(readFileSync(join(cache, 'prepared-build-marker'), 'utf8'), 'keep')
})

test('wrong cache commit is preserved; failed clones leave no incomplete cache', t => {
  const { root, source, pin, cache } = fixture(t)
  prepareCurrentDshSource({ root, pin, localSource: source, attempts: 0 })
  put(join(cache, 'different.txt'), 'other')
  git('-C', cache, 'add', '.')
  git('-C', cache, '-c', 'user.name=PRTS Test', '-c', 'user.email=prts@example.invalid', 'commit', '-qm', 'different')
  assert.throws(() => prepareCurrentDshSource({ root, pin, localSource: source, attempts: 0 }), /DSH cache is at/u)
  assert(existsSync(join(cache, 'different.txt')))
  rmSync(cache, { recursive: true, force: true })
  mkdirSync(cache, { recursive: true })
  put(join(cache, 'partial-pack'), 'truncated')
  assert.throws(() => prepareCurrentDshSource({ root, pin, localSource: join(root, 'missing'),
    networkSource: join(root, 'missing-remote'), attempts: 1 }), /Unable to prepare pinned DSH/u)
  assert.equal(existsSync(cache), false)
})
