/** Complete and probe the official linked development profile before publishing a test build. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const json = path => JSON.parse(readFileSync(path, 'utf8'))

/** pnpm's virtual hoist omits workspace-only packages; the release manifest is authoritative. */
export function completeTestProfile(workspace, profile, dependencies) {
  const packages = new Map()
  const visit = (directory, depth) => {
    if (!existsSync(directory)) return
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const value = json(manifest)
      if (value.name?.startsWith('@deepseek-ai/')) packages.set(value.name, directory)
    }
    if (depth === 0) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') visit(join(directory, entry.name), depth - 1)
    }
  }
  for (const directory of ['apps', 'packages', 'vendor', 'native']) visit(join(workspace, directory), 3)
  const linked = []
  for (const name of Object.keys(dependencies)) {
    if (!/^@deepseek-ai\/[a-z0-9-]+$/.test(name)) throw new Error(`Unexpected release package: ${name}`)
    const destination = join(profile, 'node_modules', name)
    if (existsSync(join(destination, 'package.json'))) continue
    const source = packages.get(name)
    if (!source) throw new Error(`Release dependency has no built workspace package: ${name}`)
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(resolve(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
    linked.push(name)
  }
  return linked
}

async function unusedPort() {
  const server = createServer()
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const port = server.address().port
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()))
  return port
}

/** Uses temporary data only; no model requests and no access to the tester's credentials. */
export async function verifyTestProfile(config) {
  const workspace = resolve(config.desktop, '../..')
  const requireDsh = createRequire(join(workspace, 'package.json'))
  const { register } = await import(pathToFileURL(requireDsh.resolve('tsx/esm/api')).href)
  const unregister = register({ tsconfig: join(workspace, 'tsconfig.base.json') })
  const home = join(config.generation, 'smoke-home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'cordis.patch.yml'), '- id: agent-presets\n  config:\n    default: prts\n')
  writeFileSync(join(home, 'prts-corpus.json'), '{"uiSkin":"rhine-lab"}\n')
  const environment = { DSH_HOME: home, PRTS_PORTABLE: '1', PRTS_CORPUS_RELEASES_DIR: config.corpus }
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  Object.assign(process.env, environment)
  let host
  try {
    const { DesktopHostProcess } = await import(pathToFileURL(join(config.desktop, 'src/host-process.ts')).href)
    host = new DesktopHostProcess(config.node, config.profile, await unusedPort())
    let startupTimer
    let ready
    try {
      ready = await Promise.race([host.start(), new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error('Test Host startup timed out after 60 seconds')), 60000)
      })])
    } finally { clearTimeout(startupTimer) }
    assert.equal(ready.protocolVersion, 3)
    assert.equal(ready.dshVersion, json(join(config.desktop, 'package.json')).version)
    const rpc = async (method, args = {}) => {
      const rpcId = randomUUID()
      const response = await host.fetch(new Request(`dsh-app://app/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(30000),
      }))
      assert.equal(response.status, 200, method)
      const result = await response.json()
      assert.equal(result.rpcId, rpcId)
      assert.equal(result.result?.ok, true, `${method}: ${result.result?.error?.code || 'bad response'}`)
      return result.result.value
    }
    const roster = await rpc('agentPresets/list')
    assert(roster.presets.some(preset => preset.id === 'prts' && !preset.broken), 'PRTS preset must load')
    const testWorkspace = join(config.generation, 'smoke-workspace')
    mkdirSync(testWorkspace, { recursive: true })
    const created = await rpc('workspace/create', { request: { path: testWorkspace } })
    const session = await rpc('session/create', { request: { workspaceId: created.workspace.workspaceId, agentPreset: 'prts' } })
    assert.equal(session.agentPreset, 'prts')
    for (const path of ['/index.html', '/api/prts-corpus/ui-skin.json', '/api/prts-corpus/skins/common.css', '/api/prts-corpus/rhine/rhine.js']) {
      const response = await host.fetch(new Request(`dsh-app://app${path}`, { signal: AbortSignal.timeout(30000) }))
      assert.equal(response.status, 200, path)
      const body = Buffer.from(await response.arrayBuffer())
      if (path.endsWith('/ui-skin.json')) assert.equal(JSON.parse(body.toString('utf8')).uiSkin, 'rhine-lab')
      if (path.endsWith('/rhine.js')) {
        const hash = value => createHash('sha256').update(value).digest('hex')
        assert.equal(hash(body), hash(readFileSync(join(config.pluginSnapshot, 'lib/rhine/rhine.js'))), 'Host must serve this build\'s Rhine assets')
      }
    }
    const investigationRpc = async (endpoint, payload) => {
      const response = await host.fetch(new Request('dsh-app://app/api/prts-corpus/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(30000),
      }))
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.equal(result.ok, true, `${endpoint}: ${JSON.stringify(result.error)}`)
      return result.value
    }
    const investigationSession = session.sessionId || session.id || 'build-smoke-investigation'
    const createdBoard = await investigationRpc('investigation.create', { session_id: investigationSession, mutation_id: 'smoke-create', title: '构建验证调查板' })
    await investigationRpc('investigation.edit', { session_id: investigationSession, board_id: createdBoard.board_id, mutation_id: 'smoke-edit', changes: [{ title: '构建验证线索', kind: 'question' }] })
    const savedBoard = await investigationRpc('investigation.get', { session_id: investigationSession, board_id: createdBoard.board_id })
    assert.equal(savedBoard.board.clues[0].title, '构建验证线索')
    writeFileSync(join(config.generation, 'verification.json'), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), build: config.id, pluginSha256: config.sha256, checks: ['host-start', 'prts-preset', 'session-create', 'ui-resources', 'rhine-content-hash', 'investigation-storage-rpc'] }, null, 2) + '\n')
    console.log('Official Host passed: PRTS preset, session creation, UI resources and Rhine build hash. No model request.')
  } finally {
    try { await host?.stop() } finally {
      unregister()
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }
}
