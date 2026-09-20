import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packageFiles, snapshotPlugin, firstRunSettings, buildQueue, shouldWatch, publishCurrent, ensureTestRoot } from '../scripts/test-desktop.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'prts-test-build-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const plugin = join(root, 'plugin')
  mkdirSync(join(plugin, 'lib'), { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'prts-terrarchive', version: '0.1.0', files: ['lib'] }))
  writeFileSync(join(plugin, 'lib/client.js'), 'original')
  mkdirSync(join(plugin, 'userdata'))
  writeFileSync(join(plugin, 'userdata/private.json'), 'never publish')
  return { root, plugin }
}

test('test snapshots contain published files only and do not follow later source edits', t => {
  const { root, plugin } = fixture(t)
  const first = join(root, 'first'), second = join(root, 'second')
  const a = snapshotPlugin(plugin, first)
  writeFileSync(join(plugin, 'lib/client.js'), 'new build')
  const b = snapshotPlugin(plugin, second)
  assert.equal(readFileSync(join(first, 'lib/client.js'), 'utf8'), 'original')
  assert.equal(readFileSync(join(second, 'lib/client.js'), 'utf8'), 'new build')
  assert.equal(existsSync(join(second, 'userdata')), false)
  assert.notEqual(a.sha256, b.sha256)
  assert.equal(a.files, 2)
})

test('package snapshots reject escapes, symlinks, overlaps and existing output', t => {
  const { root, plugin } = fixture(t)
  assert.throws(() => snapshotPlugin(plugin, join(plugin, 'build')), /overlap/)
  assert.throws(() => snapshotPlugin(plugin, root), /overlap/)
  const output = join(root, 'output'); mkdirSync(output)
  assert.throws(() => snapshotPlugin(plugin, output), /new directory/)
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({name:'prts-terrarchive',files:['../outside']}))
  assert.throws(() => packageFiles(plugin), /escapes/)
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({name:'prts-terrarchive',files:['linked']}))
  symlinkSync(join(plugin, 'lib'), join(plugin, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => packageFiles(plugin), /symlinks/)
})

test('first run selects Rhine and later builds preserve settings and sessions', t => {
  const { root } = fixture(t)
  const home = join(root, 'home')
  firstRunSettings(home)
  assert.equal(JSON.parse(readFileSync(join(home, 'prts-corpus.json'))).uiSkin, 'rhine-lab')
  writeFileSync(join(home, 'prts-corpus.json'), '{"uiSkin":"custom"}')
  writeFileSync(join(home, 'session.jsonl'), 'retained session')
  firstRunSettings(home)
  assert.equal(JSON.parse(readFileSync(join(home, 'prts-corpus.json'))).uiSkin, 'custom')
  assert.equal(readFileSync(join(home, 'session.jsonl'), 'utf8'), 'retained session')
})

test('only a finished build replaces the current selection; unrelated release folders are refused', t => {
  const { root } = fixture(t)
  const target = join(root, 'test')
  ensureTestRoot(target); ensureTestRoot(target)
  publishCurrent(target, {id:'first'})
  assert.equal(JSON.parse(readFileSync(join(target, 'current.json'))).id, 'first')
  publishCurrent(target, {id:'second'})
  assert.equal(JSON.parse(readFileSync(join(target, 'current.json'))).id, 'second')
  assert.throws(() => ensureTestRoot(root), /existing release/)
})

test('watcher ignores build-generated details and dependencies to avoid rebuild loops', () => {
  for (const path of ['ui/rhine/workbench.ts','ui\\rhine\\workbench.css','src/ui.js','lib/client.js','presets/prts/preset.yml']) assert.equal(shouldWatch(path), true, path)
  for (const path of ['ui/rhine/original/array-detail-data.ts','lib/rhine/rhine.js','lib/rhine/rhine.css','node_modules/three/index.js','work/notes.md']) assert.equal(shouldWatch(path), false, path)
})

test('watch builds serialize bursts, recover after failure and wait for shutdown', async () => {
  let resolveFirst, running = 0, maximum = 0, calls = 0
  const errors=[]
  const queue = buildQueue(async () => {
    running++; maximum = Math.max(maximum, running); calls++
    try {
      if(calls===1) await new Promise(resolve=>{resolveFirst=resolve})
      if(calls===2) throw new Error('compile failed')
    } finally { running-- }
  }, error => errors.push(error.message))
  const first = queue.request()
  queue.request(); queue.request(); queue.request()
  resolveFirst(); await first
  assert.equal(calls,2); assert.equal(maximum,1)
  assert.deepEqual(errors,['compile failed'])
  await queue.request(); assert.equal(calls,3)
  await queue.close(); await queue.request(); assert.equal(calls,3)
})
