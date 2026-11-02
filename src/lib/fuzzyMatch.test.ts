import { describe, expect, it } from 'vitest'
import { fuzzyMatch, toRanges } from './fuzzyMatch'

/**
 * The command palette's matcher.
 *
 * The behaviour that matters is what a user feels: a subsequence either matches or it
 * does not, the matched characters have to be the ones that get highlighted, and a
 * prefix/boundary match must outrank a scattered one, because that is what makes the
 * first result the expected one.
 */
describe('fuzzyMatch', () => {
  it('matches an exact string and highlights every character', () => {
    const result = fuzzyMatch('abc', 'abc')
    expect(result).not.toBeNull()
    expect(result?.indices).toEqual([0, 1, 2])
  })

  it('matches a subsequence and highlights the right positions', () => {
    const result = fuzzyMatch('gl', 'webgl shaders')
    expect(result?.indices).toEqual([3, 4])
  })

  it('returns null when the characters are not a subsequence', () => {
    expect(fuzzyMatch('zzz', 'webgl')).toBeNull()
    // Order matters: 'ga' is not in 'angular'.
    expect(fuzzyMatch('lgn', 'angular')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatch('WEB', 'webgl')).not.toBeNull()
    expect(fuzzyMatch('web', 'WEBGL')).not.toBeNull()
  })

  it('ranks a word-start match above the same characters found mid-word', () => {
    const atStart = fuzzyMatch('web', 'webgl')
    const midWord = fuzzyMatch('web', 'xwebgl')
    expect(atStart).not.toBeNull()
    expect(midWord).not.toBeNull()
    expect((atStart as { score: number }).score).toBeGreaterThan(
      (midWord as { score: number }).score,
    )
  })

  it('returns indices in ascending order', () => {
    const result = fuzzyMatch('cmd', 'command palette')
    const indices = result?.indices ?? []
    expect(indices.length).toBe(3)
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i] as number).toBeGreaterThan(indices[i - 1] as number)
    }
  })
})

describe('toRanges', () => {
  it('collapses consecutive indices into half-open ranges', () => {
    // `[start, end)` -- end is exclusive, which is what a `slice()` call needs.
    expect(toRanges([0, 1, 2, 5])).toEqual([
      [0, 3],
      [5, 6],
    ])
    expect(toRanges([4])).toEqual([[4, 5]])
  })

  it('returns nothing for no matches', () => {
    expect(toRanges([])).toEqual([])
  })
})
