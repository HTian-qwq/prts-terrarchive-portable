/** Prepare an isolated pinned DSH source tree, preferring an existing local checkout. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const portableRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const officialSource = 'https://github.com/deepseek-ai/deepseek-harness.git'

function git(args, { quiet = false } = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'ignore'] : 'inherit' })?.trim()
}
function commitAt(path) {
  if (!existsSync(join(path, '.git'))) return null
  try { return git(['-C', path, 'rev-parse', '--verify', 'HEAD'], { quiet: true }) } catch { return null }
}
function hasCommit(path, commit) {
  if (!existsSync(join(path, '.git'))) return false
  try { git(['-C', path, 'cat-file', '-e', `${commit}^{commit}`], { quiet: true }); return true } catch { return false }
}
function packageVersion(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')).version } catch { return null }
}
function isPinnedCheckout(path, pin) {
  return commitAt(path) === pin.commit && hasCommit(path, pin.commit)
    && packageVersion(join(path, 'package.json')) === pin.version
    && packageVersion(join(path, 'apps', 'desktop', 'package.json')) === pin.version
}
function removeIncomplete(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}

export function prepareCurrentDshSource({
  root = portableRoot,
  pin = JSON.parse(readFileSync(join(root, 'versions.electron.current.json'), 'utf8')).dsh,
  localSource = resolve(root, '..', 'deepseek-harness'),
  networkSource = officialSource,
  attempts = 3,
} = {}) {
  const cache = join(resolve(root), '.build', 'dsh-electron-current')
  if (isPinnedCheckout(cache, pin)) {
    console.log(`Reusing pinned DSH source: ${cache}`)
    return cache
  }
  const cachedCommit = commitAt(cache)
  if (cachedCommit && cachedCommit !== pin.commit) {
    throw new Error(`DSH cache is at ${cachedCommit}, expected ${pin.commit}. Move or remove ${cache} before building.`)
  }
  if (existsSync(cache)) console.warn(`Removing incomplete DSH source cache: ${cache}`)
  removeIncomplete(cache)
  mkdirSync(dirname(cache), { recursive: true })

  const candidate = resolve(localSource)
  if (candidate !== cache && hasCommit(candidate, pin.commit)) {
    console.log(`Copying pinned DSH source from local checkout: ${candidate}`)
    try {
      git(['clone', '--local', '--no-hardlinks', '--no-checkout', candidate, cache])
      git(['-C', cache, 'checkout', '--detach', pin.commit])
      if (!isPinnedCheckout(cache, pin)) throw new Error('Local DSH checkout did not produce the pinned Desktop source')
      return cache
    } catch (error) {
      console.warn(`Local source copy failed: ${error.message}`)
      removeIncomplete(cache)
    }
  } else if (existsSync(candidate)) {
    console.warn(`Local DSH checkout does not contain pinned commit ${pin.commit}: ${candidate}`)
  }

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`Fetching pinned official DSH source (attempt ${attempt}/${attempts})...`)
    try {
      git(['clone', '--depth', '1', '--single-branch', '--branch', pin.tag, networkSource, cache])
      if (!isPinnedCheckout(cache, pin)) throw new Error('Fetched DSH source does not match the pinned release')
      return cache
    } catch (error) {
      lastError = error
      removeIncomplete(cache)
      if (attempt < attempts) console.warn(`DSH clone failed; retrying from a clean cache: ${error.message}`)
    }
  }
  throw new Error(`Unable to prepare pinned DSH ${pin.version}. Check the network or provide a local checkout containing ${pin.commit}. Last error: ${lastError?.message ?? 'no source available'}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'local-source': { type: 'string' } } })
  prepareCurrentDshSource(values['local-source'] ? { localSource: values['local-source'] } : undefined)
}
