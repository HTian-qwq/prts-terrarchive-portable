/** Offline seed installation and real official Desktop Host verification for a Windows artifact. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
// This build-only file is copied to the isolated upstream apps/desktop/scripts directory.
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { waitForCorpusReady } from './prts-smoke-corpus.mjs'

const { values } = parseArgs({ options: { artifact: { type: 'string' } } })
if (!values.artifact) throw new Error('usage: prts-smoke.ts --artifact <expanded Windows release>')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Desktop artifact smoke requires Windows x64')
const artifact = resolve(values.artifact)
const release = JSON.parse(readFileSync(join(artifact, 'release-manifest.json'), 'utf8'))
const temporary = mkdtempSync(join(tmpdir(), 'prts-electron-smoke-'))
const home = join(temporary, 'userdata')
const workspace = join(temporary, 'workspace')
mkdirSync(home)
mkdirSync(workspace)
const previous = {
  DSH_HOME: process.env.DSH_HOME,
  PRTS_CORPUS_RELEASES_DIR: process.env.PRTS_CORPUS_RELEASES_DIR,
  PRTS_PORTABLE: process.env.PRTS_PORTABLE,
}
process.env.DSH_HOME = home
process.env.PRTS_CORPUS_RELEASES_DIR = join(artifact, 'corpus', 'releases')
process.env.PRTS_PORTABLE = '1'
writeFileSync(join(home, 'cordis.patch.yml'), '- id: agent-presets\n  config:\n    default: prts\n')
const runtime = {
  node: join(artifact, 'client', 'resources', 'runtime', 'node', 'node.exe'),
  pnpm: join(artifact, 'client', 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
}
const seed = join(artifact, 'client', 'resources', 'seed')
let host: DesktopHostProcess | undefined
try {
  const manager = new DesktopProjectManager(resolveDesktopPaths(home), runtime)
  const installed = await manager.applyRelease(seed, release.dshVersion, {
    healthCheck: async (directory) => {
      const probe = new DesktopHostProcess(runtime.node, directory)
      try { await probe.start() } finally { await probe.stop() }
    },
    beforeActivate: async () => {},
    afterActivate: async () => {},
  })
  assert.equal(installed, true)
  assert(manager.listPlugins().some(plugin => plugin.name === 'prts-terrarchive'))
  host = new DesktopHostProcess(runtime.node, manager.paths.profile)
  const ready = await host.start()
  assert.equal(ready.dshVersion, release.dshVersion)
  const active = host
  async function rpc(method: string, args: Record<string, unknown> = {}) {
    const rpcId = randomUUID()
    const response = await active.fetch(new Request(`dsh-app://app/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      signal: AbortSignal.timeout(60_000),
    }))
    assert.equal(response.status, 200, method)
    const envelope = await response.json()
    assert.equal(envelope.rpcId, rpcId, method)
    assert.equal(envelope.result?.ok, true, `${method}: ${envelope.result?.error?.code ?? 'bad response'}`)
    return envelope.result.value
  }
  const roster = await rpc('agentPresets/list')
  assert(roster.presets.some((preset: { id: string; broken?: unknown }) => preset.id === 'prts' && !preset.broken))
  const createdWorkspace = await rpc('workspace/create', { request: { path: workspace } })
  const session = await rpc('session/create', { request: {
    workspaceId: createdWorkspace.workspace.workspaceId, agentPreset: 'prts',
  } })
  assert.equal(session.agentPreset, 'prts')
  const store = await waitForCorpusReady(request => active.fetch(request), release, {
    onProgress: elapsed => console.log(`Waiting for PRTS background corpus indexes (${Math.round(elapsed / 1000)}s)...`),
  })
  for (const path of ['/index.html', '/api/prts-corpus/skins/common.css', '/api/prts-corpus/ui-skin.json']) {
    const response = await active.fetch(new Request(`dsh-app://app${path}`, { signal: AbortSignal.timeout(30_000) }))
    assert.equal(response.status, 200, path)
    await response.arrayBuffer()
  }
  console.log(`Electron seed and official Host passed: ${release.dshVersion}, ${store.documentCount} documents; no model request or corpus download.`)
} finally {
  await host?.stop()
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
}
