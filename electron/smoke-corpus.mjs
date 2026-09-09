/** Wait for the plugin's background corpus indexes before checking release identity. */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export async function waitForCorpusReady(fetch, release, {
  timeoutMs = 180_000,
  intervalMs = 1_000,
  onProgress = () => {},
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  let lastProgress = -Infinity
  let lastStatus = null
  try {
    while (true) {
      const response = await fetch(new Request('dsh-app://app/api/prts-corpus/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'status', payload: {} }), signal: controller.signal,
      }))
      assert.equal(response.status, 200, `PRTS corpus status: HTTP ${response.status}`)
      const status = await response.json()
      assert.equal(status.ok, true, `PRTS corpus status: ${status.error?.message ?? status.error?.code ?? 'invalid response'}`)
      const store = status.value?.store
      assert(store && typeof store.loaded === 'boolean', 'PRTS corpus status has no valid store state')
      // Include only corpus facts in diagnostics, never the settings/token payload.
      lastStatus = { installed: store.installed, loaded: store.loaded, installationIssue: store.installationIssue,
        releaseId: store.releaseId, dataVersion: store.dataVersion, documentCount: store.documentCount, packCount: store.packCount }
      assert.equal(store.installed, true, `Bundled corpus is unavailable: ${JSON.stringify(lastStatus)}`)
      if (store.loaded) {
        assert.equal(store.releaseId, release.corpusReleaseId, 'Loaded corpus release does not match the artifact')
        assert.equal(store.dataVersion, release.corpusDataVersion, 'Loaded corpus data version does not match the artifact')
        assert.equal(store.documentCount, release.corpusDocumentCount, 'Loaded corpus document count does not match the artifact')
        return store
      }
      if (Date.now() - lastProgress >= 15_000) {
        onProgress(Date.now() - started)
        lastProgress = Date.now()
      }
      await delay(intervalMs, undefined, { signal: controller.signal })
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for PRTS corpus indexes; last status: ${JSON.stringify(lastStatus)}`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
