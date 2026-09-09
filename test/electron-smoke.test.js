import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForCorpusReady } from '../electron/smoke-corpus.mjs'

const release = { corpusReleaseId: 'release-A', corpusDataVersion: 'a'.repeat(64), corpusDocumentCount: 31949 }
const cold = { installed: true, loaded: false, installationIssue: null,
  releaseId: null, dataVersion: null, documentCount: null, packCount: null }
const loaded = { ...cold, loaded: true, releaseId: release.corpusReleaseId,
  dataVersion: release.corpusDataVersion, documentCount: release.corpusDocumentCount, packCount: 7 }
const status = store => Response.json({ ok: true, value: { store, config: { token: 'do-not-log-settings' } } })

test('Electron smoke waits for background indexes after the Host and session are ready', async () => {
  let calls = 0
  const progress = []
  const store = await waitForCorpusReady(async request => {
    assert.equal(new URL(request.url).pathname, '/api/prts-corpus/rpc')
    assert.deepEqual(await request.json(), { endpoint: 'status', payload: {} })
    return status(++calls < 3 ? cold : loaded)
  }, release, { intervalMs: 1, onProgress: elapsed => progress.push(elapsed) })
  assert.equal(calls, 3)
  assert.deepEqual(store, loaded)
  assert.equal(progress.length, 1)
})

test('Electron smoke still rejects a loaded but mismatched corpus', async () => {
  for (const [field, value, message] of [
    ['releaseId', 'release-B', /corpus release/u],
    ['dataVersion', 'b'.repeat(64), /corpus data version/u],
    ['documentCount', 1, /corpus document count/u],
  ]) {
    await assert.rejects(waitForCorpusReady(async () => status({ ...loaded, [field]: value }), release), message)
  }
})

test('Electron smoke reports missing or broken corpus immediately without logging settings', async () => {
  let calls = 0
  await assert.rejects(waitForCorpusReady(async () => {
    calls++
    return status({ ...cold, installed: false, installationIssue: 'Missing required pack: entities' })
  }, release), error => {
    assert.match(error.message, /Missing required pack: entities/u)
    assert.doesNotMatch(error.message, /do-not-log-settings/u)
    return true
  })
  assert.equal(calls, 1)
})

test('Electron smoke bounds background-index waiting and prints the last corpus state', async () => {
  await assert.rejects(waitForCorpusReady(async () => status(cold), release, { timeoutMs: 30, intervalMs: 1 }), error => {
    assert.match(error.message, /Timed out after 30ms/u)
    assert.match(error.message, /"installed":true,"loaded":false/u)
    assert.doesNotMatch(error.message, /do-not-log-settings/u)
    return true
  })
})

test('Electron smoke timeout also cancels an unresponsive Host request', async () => {
  let aborted = false
  await assert.rejects(waitForCorpusReady(request => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => {
      aborted = true
      reject(request.signal.reason)
    }, { once: true })
  }), release, { timeoutMs: 30 }), /Timed out after 30ms/u)
  assert.equal(aborted, true)
})

test('Electron smoke preserves HTTP, RPC, and transport error diagnostics', async () => {
  await assert.rejects(waitForCorpusReady(async () => new Response(null, { status: 503 }), release), /HTTP 503/u)
  await assert.rejects(waitForCorpusReady(async () => Response.json({ ok: false,
    error: { message: 'Corpus service failed' } }), release), /Corpus service failed/u)
  await assert.rejects(waitForCorpusReady(async () => { throw new Error('Host exited') }, release), /Host exited/u)
})
