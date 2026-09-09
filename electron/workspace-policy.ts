/** Compare Desktop-owned pnpm settings after pnpm rewrites the YAML document. */
import { isDeepStrictEqual } from 'node:util'
import { JSON_SCHEMA, load } from 'js-yaml'

// pnpm records exact package versions here when resolving young dependencies.
const EXACT_PACKAGE_VERSION = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Preserve exact core overrides/build rules while accepting pnpm's version bookkeeping. */
export function desktopWorkspaceMatches(actualText: string, expectedText: string): boolean {
  try {
    const actual: unknown = load(actualText, { schema: JSON_SCHEMA })
    const expected: unknown = load(expectedText, { schema: JSON_SCHEMA })
    if (!isRecord(actual) || !isRecord(expected)) return false
    const { minimumReleaseAgeExclude, ...settings } = actual
    if (minimumReleaseAgeExclude !== undefined && (!Array.isArray(minimumReleaseAgeExclude)
      || !minimumReleaseAgeExclude.every(entry => typeof entry === 'string' && EXACT_PACKAGE_VERSION.test(entry)))) {
      return false
    }
    // Ignore key order, quoting, comments and CRLF; reject changed or extra settings.
    return isDeepStrictEqual(settings, expected)
  } catch {
    return false
  }
}
