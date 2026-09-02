import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const before = `    const after = classifyCharacter(code)
    const open = !after || (after === constants.characterGroupPunctuation && Boolean(before))
      || attentionMarkers.includes(code)
    const commonMarkClose = !before
      || (before === constants.characterGroupPunctuation && Boolean(after))
      || attentionMarkers.includes(previous)
    const markerCount = token.end.offset - token.start.offset
    const cjkStrongClose = markerCount >= 2`

const after = `    const after = classifyCharacter(code)
    const markerCount = token.end.offset - token.start.offset
    const commonMarkOpen = !after || (after === constants.characterGroupPunctuation && Boolean(before))
      || attentionMarkers.includes(code)
    // CommonMark does not open ** after CJK text when the emphasized phrase
    // starts with a quote. Chinese prose commonly writes 中文**“引文”**中文,
    // so admit the paired strong delimiter without relaxing single emphasis.
    const cjkStrongOpen = markerCount >= 2
      && isCjkCharacter(previous)
      && unicodePunctuation(code)
    const open = commonMarkOpen || cjkStrongOpen
    const commonMarkClose = !before
      || (before === constants.characterGroupPunctuation && Boolean(after))
      || attentionMarkers.includes(previous)
    const cjkStrongClose = markerCount >= 2`

export function patchDshCjkMarkdown(sourceDirectory, { checkBuilt = false } = {}) {
  const sourceRoot = resolve(sourceDirectory)
  const parserPath = join(sourceRoot,
    'packages', 'client', 'ui-primitives', 'src', 'markdown', 'cjkFriendlyStrong.ts')
  const testPath = join(sourceRoot,
    'packages', 'client', 'ui-primitives', 'tests', 'markdown.client.spec.tsx')
  const builtPath = join(sourceRoot, 'packages', 'client', 'ui-primitives', 'lib', 'index.js')
  const builtWebAssets = join(sourceRoot, 'apps', 'web', 'dist', 'assets')

  let parser = readFileSync(parserPath, 'utf8')
  if (!parser.includes('const cjkStrongOpen =')) {
    if (!parser.includes(before)) throw new Error('DSH Markdown 解析器结构已变化，无法安全应用 CJK 补丁。')
    parser = parser.replace(before, after)
    writeFileSync(parserPath, parser)
    console.log('已应用 DSH CJK 引号加粗兼容补丁。')
  } else {
    console.log('DSH CJK 引号加粗兼容补丁已存在。')
  }
  if (!parser.includes(`name: 'cjkFriendlyQuotedStrong'`)) {
    const constructName = `name: 'cjkFriendlyAttention'`
    if (!parser.includes(constructName)) throw new Error('DSH Markdown construct 名称已变化。')
    parser = parser.replace(constructName, `name: 'cjkFriendlyQuotedStrong'`)
    writeFileSync(parserPath, parser)
  }

  if (existsSync(testPath)) {
    let test = readFileSync(testPath, 'utf8')
    const anchor = `      ['**Warning!**继续', 'Warning!'],`
    if (!test.includes(`['段落**“引文”**继续', '“引文”']`)) {
      if (!test.includes(anchor)) throw new Error('DSH Markdown 测试结构已变化，无法添加回归用例。')
      test = test.replace(anchor, `${anchor}\n      ['段落**"引文"**继续', '"引文"'],\n      ['段落**“引文”**继续', '“引文”'],`)
      writeFileSync(testPath, test)
    }
  }

  if (checkBuilt) {
    const hasLibraryBuild = existsSync(builtPath)
      && readFileSync(builtPath, 'utf8').includes('cjkFriendlyQuotedStrong')
    const hasWebBuild = existsSync(builtWebAssets) && readdirSync(builtWebAssets)
      .filter((name) => name.endsWith('.js'))
      .some((name) => readFileSync(join(builtWebAssets, name), 'utf8')
        .includes('cjkFriendlyQuotedStrong'))
    if (!hasLibraryBuild || !hasWebBuild) {
      throw new Error('现有 DSH 构建不含 CJK 引号加粗修复。请去掉 -SkipDshBuild 完整构建一次。')
    }
    console.log('现有 DSH 构建已包含 CJK 引号加粗修复。')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const sourceArg = args.find((arg) => arg !== '--check-built')
  if (!sourceArg) throw new Error('用法：patch-dsh-cjk-markdown.mjs <dsh-source> [--check-built]')
  patchDshCjkMarkdown(sourceArg, { checkBuilt: args.includes('--check-built') })
}
