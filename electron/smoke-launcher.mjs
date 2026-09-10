/** Run the real Windows launcher against a Node probe, without opening Electron. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout } from 'node:timers/promises'

export async function verifyPortableLauncher({ launcher, node }) {
  assert.equal(process.platform, 'win32', 'Launcher smoke requires Windows')
  const root = mkdtempSync(join(tmpdir(), 'PRTS 中文 launcher '))
  try {
    mkdirSync(join(root, 'client'))
    copyFileSync(launcher, join(root, 'PRTS Terrarchive.exe'))
    copyFileSync(node, join(root, 'client', 'PRTS Terrarchive.exe'))
    const args = ['带 空格', '引号"和反斜杠\\', 'a&b|c%PATH%', '结尾反斜杠 \\', '']
    const probe = "const fs = require('node:fs'); fs.writeFileSync('probe.json.next', JSON.stringify({cwd:process.cwd(), exe:process.execPath, args:process.argv.slice(1)})); fs.renameSync('probe.json.next', 'probe.json')"
    execFileSync(join(root, 'PRTS Terrarchive.exe'), ['--eval', probe, '--', ...args], {
      cwd: tmpdir(), windowsHide: true, timeout: 10_000,
    })
    const result = join(root, 'probe.json')
    const deadline = Date.now() + 10_000
    while (!existsSync(result) && Date.now() < deadline) await setTimeout(50)
    assert(existsSync(result), 'The launcher did not start its client')
    const observed = JSON.parse(readFileSync(result, 'utf8'))
    assert.equal(observed.cwd.toLowerCase(), root.toLowerCase())
    assert.equal(observed.exe.toLowerCase(), join(root, 'client', 'PRTS Terrarchive.exe').toLowerCase())
    assert.deepEqual(observed.args, args, 'The launcher must forward arguments without shell interpretation')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { launcher: { type: 'string' }, node: { type: 'string' } } })
  assert(values.launcher && values.node, 'usage: smoke-launcher.mjs --launcher <exe> --node <node.exe>')
  await verifyPortableLauncher({ launcher: values.launcher, node: values.node })
  console.log('Portable launcher passed: Unicode paths, working directory, and quoted arguments.')
}
