import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from './locales/en'
import { zh } from './locales/zh'

/**
 * The bilingual dictionary's invariants.
 *
 * ── Why a test and not a lint rule ──────────────────────────────────────────
 * The review found ten keys written in both languages with no call site (plus
 * `t.commands.groups`, which had a definition and no reader). Nothing catches that: a dead
 * string is invisible in review, does not fail a type check, and silently costs a
 * translator's time every time the copy is revised. So the dictionary itself is asserted.
 *
 * ── The heuristic and its limit ────────────────────────────────────────────
 * "Used" means the leaf name appears somewhere in `src/` outside the locale files. That is
 * a text search, not a resolver: it would accept a key mentioned in a comment, and it
 * cannot see a key built by concatenation. Both are acceptable for a guard whose job is to
 * notice a key that is referenced *nowhere at all*; a false alarm is a one-line fix, a
 * silent dead key is not. `t.nav[condition ? 'languageEnglish' : 'languageChinese']` and
 * `t.nav[option.labelKey]` are the two dynamic lookups in the app, and both spell their key
 * names as literals, which is why the search works on them.
 */

/** Every leaf path in a nested dictionary, e.g. `sandbox.verletHint`. */
function leafPaths(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? leafPaths(value as object, path)
      : [path]
  })
}

/** Relative paths of every non-locale source file. */
function sourceFiles(dir = 'src', out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== 'locales') sourceFiles(path, out)
    } else if (/\.(ts|tsx)$/.test(path) && !path.endsWith('.test.ts')) {
      out.push(path)
    }
  }
  return out
}

describe('dictionary shape', () => {
  it('defines exactly the same keys in both languages', () => {
    const enKeys = leafPaths(en).sort()
    const zhKeys = leafPaths(zh).sort()

    // Two diffs rather than a boolean, so a failure names the missing key.
    const missingInZh = enKeys.filter((key) => !zhKeys.includes(key))
    const missingInEn = zhKeys.filter((key) => !enKeys.includes(key))

    expect(missingInZh, 'keys present in en but missing in zh').toEqual([])
    expect(missingInEn, 'keys present in zh but missing in en').toEqual([])
    expect(enKeys.length).toBeGreaterThan(200)
  })

  it('never ships an empty string: an empty label is a missing translation', () => {
    const empties: string[] = []
    const walk = (tree: object, prefix = ''): void => {
      for (const [key, value] of Object.entries(tree)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (value !== null && typeof value === 'object') walk(value as object, path)
        else if (typeof value === 'string' && value.trim() === '') empties.push(path)
      }
    }
    walk(en)
    walk(zh)
    expect(empties).toEqual([])
  })
})

describe('dead keys', () => {
  it('has no key that no component reads', () => {
    const sources = sourceFiles().map((file) => readFileSync(file, 'utf8'))
    const unused = leafPaths(en).filter((path) => {
      const leaf = path.split('.').pop() as string
      return !sources.some((source) => source.includes(leaf))
    })

    expect(unused, 'keys defined in both languages but referenced nowhere').toEqual([])
  })
})
