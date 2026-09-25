/** Real Windows smoke: boot the packaged DSH 0.1.7 Host and verify PRTS preset and corpus. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { authenticateWebHost } from '../src/web-document.ts'
import { prepareCurrentProfile } from '../portable-main.mjs'
import { waitForCorpusReady } from './prts-smoke-corpus.mjs'

const { values } = parseArgs({ options: { artifact: { type: 'string' } } })
if (!values.artifact) throw new Error('usage: prts-smoke-current.ts --artifact <expanded Windows release>')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Desktop artifact smoke requires Windows x64')
const artifact = resolve(values.artifact)
const release = JSON.parse(readFileSync(join(artifact, 'release-manifest.json'), 'utf8'))
const temporary = mkdtempSync(join(tmpdir(), 'prts-current-smoke-'))
const home = join(temporary, 'userdata')
const profile = prepareCurrentProfile(home)
const environment = {
  ...process.env,
  DSH_HOME: home,
  PRTS_PORTABLE: '1',
  PRTS_CORPUS_RELEASES_DIR: join(artifact, 'corpus', 'releases'),
}
writeFileSync(join(home, 'cordis.patch.yml'), '- id: agent-preset-registry\n  config:\n    default: prts\n')
const client = join(artifact, 'client')
const executable = join(client, 'PRTS Terrarchive.exe')
const resources = join(client, 'resources')
const dsh = join(resources, 'app.asar', 'dsh')
const runtime = join(resources, 'runtime')
let host: DesktopHostProcess | undefined
try {
  const manager = new DesktopProjectManager(resolveDesktopPaths(home), { dsh })
  await manager.applyRelease()
  host = new DesktopHostProcess(executable, dsh, profile, undefined, environment,
    undefined, join(runtime, 'primary-runtime'),
    { pnpm: join(runtime, 'pnpm', 'bin', 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
  const ready = await host.start()
  const cookie = await authenticateWebHost(ready.url)
  async function authenticated(request: Request): Promise<Response> {
    const source = new URL(request.url)
    const target = new URL(ready.url)
    target.pathname = source.pathname
    target.search = source.search
    const headers = new Headers(request.headers)
    headers.set('cookie', cookie)
    return fetch(target, { method: request.method, headers,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
      signal: request.signal })
  }
  async function rpc(method: string, args: Record<string, unknown> = {}) {
    const rpcId = randomUUID()
    const response = await authenticated(new Request(`dsh-app://app/api/${method}`, {
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
  assert(roster.presets.some((preset: { id: string; broken?: unknown; isDefault?: boolean }) =>
    preset.id === 'prts' && preset.isDefault && !preset.broken), 'PRTS mode was not registered as the default')
  const store = await waitForCorpusReady(authenticated, release, {
    onProgress: elapsed => console.log(`Waiting for bundled corpus indexes (${Math.round(elapsed / 1000)}s)...`),
  })
  for (const path of ['/api/prts-corpus/skins/common.css', '/api/prts-corpus/ui-skin.json']) {
    const response = await authenticated(new Request(`dsh-app://app${path}`, { signal: AbortSignal.timeout(30_000) }))
    assert.equal(response.status, 200, path)
    await response.arrayBuffer()
  }
  console.log(`Official Desktop Host and PRTS passed: ${release.dshVersion}, ${store.documentCount} documents`)
} finally {
  await host?.stop()
  rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
}
