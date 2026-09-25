/** Supply the pinned Desktop preparation step with local, non-release settings. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const portableRoot = fileURLToPath(new URL('..', import.meta.url))
const placeholderOrigin = 'https://prts-desktop-policy.invalid'

export function prepareCurrentDesktopEnvironment({
  dshSource,
  appId = JSON.parse(readFileSync(join(portableRoot, 'versions.electron.current.json'), 'utf8')).appId,
} = {}) {
  if (!dshSource) throw new Error('Provide the pinned DSH source directory')
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(appId)) throw new Error('Invalid portable application ID')
  const destination = join(resolve(dshSource), 'apps', 'desktop', '.env.windows')
  const contents = [
    '# Generated for the unsigned PRTS portable preparation step; never used for release packaging.',
    `DSH_DESKTOP_APP_ID=${appId}`,
    'DSH_DESKTOP_AUTO_UPDATE_ENV=test',
    `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=${placeholderOrigin}`,
    `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG='${JSON.stringify({ allowedAuthOrigins: [placeholderOrigin] })}'`,
    '',
  ].join('\n')
  try {
    writeFileSync(destination, contents, { encoding: 'utf8', flag: 'wx' })
    console.log(`Created local Desktop preparation settings: ${destination}`)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    // The cache is a local checkout; do not overwrite any user-owned dotenv or credentials.
    console.log(`Using existing local Desktop preparation settings: ${destination}`)
  }
  return destination
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareCurrentDesktopEnvironment({ dshSource: process.argv[2] })
}
