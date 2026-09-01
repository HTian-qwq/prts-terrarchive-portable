import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const MANAGED_PLUGIN = 'prts-terrarchive'
export const MANAGED_PRESET = 'prts'

export function parseDshUrl(text) {
  const match = String(text).match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[A-Za-z0-9_-]+/u)
  return match?.[0] ?? null
}

export function redactToken(text) {
  return String(text).replace(/([?&]token=)[A-Za-z0-9_-]+/gu, '$1[redacted]')
}

export function mergeProfileManifest(current, managed) {
  const source = current && typeof current === 'object' ? current : {}
  const currentProfile = source.dsh?.profile && typeof source.dsh.profile === 'object'
    ? source.dsh.profile
    : {}
  const existingBundles = Array.isArray(currentProfile.bundles) ? currentProfile.bundles : []
  const managedBundles = new Set([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    MANAGED_PLUGIN,
  ])
  const extraBundles = existingBundles.filter((entry) => !managedBundles.has(entry))
  return {
    ...source,
    name: source.name || 'dsh-profile-web',
    private: true,
    dependencies: {
      ...(source.dependencies ?? {}),
      [MANAGED_PLUGIN]: managed.pluginVersion,
    },
    dsh: {
      ...(source.dsh ?? {}),
      profile: {
        ...currentProfile,
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          ...extraBundles,
          MANAGED_PLUGIN,
        ],
        patchReload: currentProfile.patchReload || 'live',
      },
    },
  }
}

function assertManagedTarget(dataRoot, target, expectedName) {
  const base = resolve(dataRoot)
  const absolute = resolve(target)
  const pathFromBase = relative(base, absolute)
  if (!pathFromBase || pathFromBase.startsWith('..') || isAbsolute(pathFromBase)) {
    throw new Error(`拒绝修改 userdata 之外的路径：${absolute}`)
  }
  if (absolute.split(/[\\/]/u).at(-1) !== expectedName) {
    throw new Error(`拒绝替换非托管目录：${absolute}`)
  }
}

function replaceManagedDirectory(source, target, dataRoot, expectedName) {
  assertManagedTarget(dataRoot, target, expectedName)
  const parent = dirname(target)
  const next = join(parent, `.${expectedName}.next-${process.pid}`)
  const backup = join(parent, `.${expectedName}.previous-${process.pid}`)
  mkdirSync(parent, { recursive: true })
  rmSync(next, { recursive: true, force: true })
  rmSync(backup, { recursive: true, force: true })
  cpSync(source, next, { recursive: true, dereference: true })
  if (existsSync(target)) renameSync(target, backup)
  try {
    renameSync(next, target)
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target)
    throw error
  } finally {
    rmSync(next, { recursive: true, force: true })
  }
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.next-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try {
    renameSync(temporary, path)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
    rmSync(path, { force: true })
    renameSync(temporary, path)
  }
}

export function syncManagedInstall({ appRoot, dataRoot }) {
  const templateRoot = join(appRoot, 'templates')
  const templateProfile = join(templateRoot, 'profiles', 'web')
  const templatePlugin = join(templateProfile, 'node_modules', MANAGED_PLUGIN)
  const templatePreset = join(templateRoot, '.agent-presets', MANAGED_PRESET)
  const templateManifest = JSON.parse(readFileSync(join(templateProfile, 'package.json'), 'utf8'))
  const pluginVersion = templateManifest.dependencies?.[MANAGED_PLUGIN]
  if (!pluginVersion || !existsSync(join(templatePlugin, 'package.json'))) {
    throw new Error('发行包中的 PRTS profile 模板不完整。')
  }

  const profileDir = join(dataRoot, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  for (const name of ['cordis.yml', 'cordis.patch.yml']) {
    const target = join(profileDir, name)
    if (!existsSync(target)) cpSync(join(templateProfile, name), target)
  }

  const manifestPath = join(profileDir, 'package.json')
  const currentManifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {}
  writeJsonAtomic(manifestPath, mergeProfileManifest(currentManifest, { pluginVersion }))

  replaceManagedDirectory(
    templatePlugin,
    join(profileDir, 'node_modules', MANAGED_PLUGIN),
    dataRoot,
    MANAGED_PLUGIN,
  )
  replaceManagedDirectory(
    templatePreset,
    join(dataRoot, '.agent-presets', MANAGED_PRESET),
    dataRoot,
    MANAGED_PRESET,
  )
  mkdirSync(join(dataRoot, 'logs'), { recursive: true })
  return { profileDir, pluginVersion }
}

export function readHostState(path) {
  if (!existsSync(path)) return null
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'))
    return Number.isInteger(state.pid) && typeof state.url === 'string' ? state : null
  } catch {
    return null
  }
}

export function writeHostState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  writeJsonAtomic(path, state)
}

export function removeHostState(path) {
  rmSync(path, { force: true })
}
