import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 将锁内逐文件校验的 current release 复制到空的发行目录，只收录清单资产。 */
export async function packageCurrentCorpus({ releasesDir, targetDir, installer }) {
  if (existsSync(targetDir) && readdirSync(targetDir).length) {
    throw new Error('语料发行目标目录必须为空，不能混入先前构建的文件')
  }
  for (const method of ['withReleaseMutationLock', 'readCurrentReleasePointer', 'validateLocalRelease']) {
    if (typeof installer?.[method] !== 'function') throw new Error(`插件缺少语料封装接口：${method}`)
  }
  return installer.withReleaseMutationLock(releasesDir, async () => {
    const pointer = await installer.readCurrentReleasePointer(releasesDir)
    const { manifest, packManifests, releaseDir } = await installer.validateLocalRelease(
      releasesDir, pointer.release_id, { verifyHashes: true, details: true },
    )
    if (pointer.data_version !== manifest.data_version) {
      throw new Error('语料 current 指针与已校验 release 的 data_version 不一致')
    }
    const files = ['release-manifest.json']
    for (const [packId, pack] of packManifests) {
      files.push(`${packId}/pack-manifest.json`)
      const assets = [...pack.shards, ...(pack.search_index?.shards ?? []),
        ...(pack.document_catalog ? [pack.document_catalog] : [])]
      files.push(...assets.map((asset) => `${packId}/${asset.path}`))
    }
    for (const file of files) {
      const target = join(targetDir, pointer.release_id, file)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(releaseDir, file), target)
    }
    // 成品校验覆盖复制期间的 I/O 损坏；只有成功后才在发行包内声明 current。
    const copied = await installer.validateLocalRelease(targetDir, pointer.release_id, { verifyHashes: true })
    if (copied.data_version !== manifest.data_version) {
      throw new Error('复制后的语料版本与本次选定的 release 不一致')
    }
    writeFileSync(join(targetDir, 'current.json'), `${JSON.stringify(pointer, null, 2)}\n`)
    return { pointer, manifest }
  })
}
