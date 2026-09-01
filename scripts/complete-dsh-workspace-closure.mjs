import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

const sourceRoot = resolve(process.argv[2] ?? '')
const deployRoot = resolve(process.argv[3] ?? '')
if (!sourceRoot || !deployRoot) {
  throw new Error('用法：node scripts/complete-dsh-workspace-closure.mjs <dsh-source> <deploy-root>')
}
const modulesRoot = join(deployRoot, 'node_modules')

function findWorkspacePackages() {
  const packages = new Map()
  const roots = ['vendor', 'packages', 'apps'].map((name) => join(sourceRoot, name))
  const visit = (directory, depth) => {
    if (!existsSync(directory) || depth > 3) return
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/')) {
        packages.set(manifest.name, { directory, manifest })
        return
      }
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) {
        visit(join(directory, entry.name), depth + 1)
      }
    }
  }
  for (const root of roots) visit(root, 0)
  return packages
}

function packageDirectory(name) {
  const [scope, leaf] = name.split('/')
  return join(modulesRoot, scope, leaf)
}

function copyRuntimePackage(source, target) {
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter(path) {
      const pathFromSource = relative(source, path)
      if (!pathFromSource) return true
      const first = pathFromSource.split(sep, 1)[0]
      if (['node_modules', '.git', 'src', 'test', 'tests', 'docs'].includes(first)) return false
      const name = basename(path)
      return !/\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(name)
        && !name.startsWith('tsconfig.')
        && name !== 'AGENTS.md'
    },
  })
}

const workspace = findWorkspacePackages()
const included = new Set()
for (const [name] of workspace) {
  if (existsSync(join(packageDirectory(name), 'package.json'))) included.add(name)
}
const queue = [...included]
const added = []
while (queue.length) {
  const name = queue.shift()
  const entry = workspace.get(name)
  if (!entry) continue
  const references = {
    ...(entry.manifest.dependencies ?? {}),
    ...(entry.manifest.peerDependencies ?? {}),
  }
  for (const dependency of Object.keys(references).sort()) {
    const dependencyEntry = workspace.get(dependency)
    if (!dependencyEntry || included.has(dependency)) continue
    const target = packageDirectory(dependency)
    copyRuntimePackage(dependencyEntry.directory, target)
    if (!existsSync(join(target, 'package.json'))) {
      throw new Error(`补全 workspace 包失败：${dependency}`)
    }
    included.add(dependency)
    added.push(dependency)
    queue.push(dependency)
  }
}
console.log(`补全 ${added.length} 个官方 workspace runtime peer/dependency。`)
for (const name of added) console.log(`  + ${name}`)
