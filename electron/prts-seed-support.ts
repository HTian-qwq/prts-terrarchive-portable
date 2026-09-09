/** Community seed additions; copied into the isolated official Desktop source before its build. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PRTS_SEED_FILE = 'prts-seed.json'
export const PRTS_PACKAGE = 'prts-terrarchive'

interface PrtsPackageRecord {
  readonly name: typeof PRTS_PACKAGE
  readonly version: string
  readonly file: string
  readonly bytes: number
  readonly integrity: string
}

interface PrtsSeed {
  readonly schemaVersion: 1
  readonly revision: string
  readonly packages: readonly PrtsPackageRecord[]
}

/** Bind seed identity to package contents, even when the npm or DSH version has not changed. */
export function createPrtsSeed(record: PrtsPackageRecord): PrtsSeed {
  const content = { schemaVersion: 1 as const, packages: [record] }
  return { ...content, revision: createHash('sha256').update(JSON.stringify(content)).digest('hex') }
}

function readSeed(projectDir: string): PrtsSeed | undefined {
  const path = join(projectDir, PRTS_SEED_FILE)
  if (!existsSync(path)) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<PrtsSeed>
  const record = value.packages?.[0]
  if (value.schemaVersion !== 1 || !Array.isArray(value.packages) || value.packages.length !== 1
    || record?.name !== PRTS_PACKAGE || typeof record.version !== 'string'
    || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u.test(record.version)
    || typeof record.file !== 'string' || !/^prts-terrarchive-[a-f0-9]{64}\.tgz$/u.test(record.file)
    || !Number.isSafeInteger(record.bytes) || record.bytes < 1
    || typeof record.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(record.integrity)) {
    throw new Error('PRTS Desktop: invalid community seed descriptor')
  }
  const seed = createPrtsSeed({ name: record.name, version: record.version, file: record.file,
    bytes: record.bytes, integrity: record.integrity })
  if (seed.revision !== value.revision) throw new Error('PRTS Desktop: invalid community seed revision')
  return seed
}

/** Extend upstream's exact tarball inventory with the verified community package only. */
export function prtsSeedPackageFiles(projectDir: string): string[] {
  const seed = readSeed(projectDir)
  if (!seed) return []
  return seed.packages.map(record => {
    const path = join(projectDir, 'desktop-packages', record.file)
    if (!lstatSync(path).isFile()) throw new Error('PRTS Desktop: package is not a regular file')
    const body = readFileSync(path)
    const sha256 = createHash('sha256').update(body).digest('hex')
    const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`
    if (body.byteLength !== record.bytes || integrity !== record.integrity
      || record.file !== `prts-terrarchive-${sha256}.tgz`) {
      throw new Error('PRTS Desktop: community package integrity check failed')
    }
    return record.file
  })
}

/** Match the applied community revision as well as upstream's DSH release identity. */
export function samePrtsSeedRevision(active: string, seed: string): boolean {
  return readSeed(active)?.revision === readSeed(seed)?.revision
}

/**
 * Reconcile a copied seed with the active profile's plugin choices before an offline install.
 * Bundled local PRTS follows the new seed; explicit registry updates and removals remain user choices.
 */
export function reconcilePrtsSeedUpgrade(
  active: string,
  staged: string,
  plugins: readonly { readonly name: string; readonly version: string }[],
): boolean {
  const targetSeed = readSeed(staged)
  const previousSeed = readSeed(active)
  if (!targetSeed) {
    if (previousSeed) throw new Error('PRTS Desktop: a community profile requires a community release seed')
    return false
  }
  const previous = JSON.parse(readFileSync(join(active, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  const manifestPath = join(staged, 'package.json')
  const target = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  const enabled = new Set(plugins.map(plugin => plugin.name))
  const oldRecord = previousSeed?.packages[0]
  if (oldRecord && !enabled.has(PRTS_PACKAGE)) delete target.dependencies[PRTS_PACKAGE]
  for (const plugin of plugins) {
    const oldLocalSpec = oldRecord ? `file:./desktop-packages/${oldRecord.file}` : undefined
    if (plugin.name === PRTS_PACKAGE && previous.dependencies[plugin.name] === oldLocalSpec) continue
    target.dependencies[plugin.name] = plugin.version
  }
  const defaults = target.dsh.profile.bundles.filter(name => name !== PRTS_PACKAGE)
  target.dsh.profile.bundles = [...defaults,
    ...(!oldRecord && !enabled.has(PRTS_PACKAGE) ? [PRTS_PACKAGE] : []),
    ...plugins.map(plugin => plugin.name),
  ]
  writeFileSync(manifestPath, `${JSON.stringify(target, undefined, 2)}\n`, { mode: 0o600 })
  return true
}
