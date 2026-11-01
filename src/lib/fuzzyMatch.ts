/**
 * A small fuzzy matcher for the command palette.
 *
 * ── What "fuzzy" buys over `includes()` ───────────────────────────────────
 * Raycast/Linear-style palettes let you type `thm em` or `jmp arch` and still
 * land on "切换主题 · 翡翠绿" / "跳转到 架构". That requires subsequence matching
 * plus a scoring function good enough that the intended row is first, because
 * the user almost never looks past the top three results.
 *
 * ── Scoring model ─────────────────────────────────────────────────────────
 * A contiguous substring hit always beats a scattered subsequence, and within
 * each class the ranking rewards the things humans actually aim for:
 *
 *   prefix match        typing the start of the label
 *   word-boundary match typing the start of any later word
 *   consecutive run     letters that appear together, not sprayed apart
 *   early position      a match at char 0 beats one at char 40
 *   short target        "主题" beats a 60-character sentence containing it
 *
 * Scores are arbitrary units; only the ordering is meaningful.
 *
 * ── Matching is case-folded, indices refer to the ORIGINAL string ─────────
 * Lower-casing is used only for comparison. Callers pass the returned indices
 * into the target string to highlight matched characters, so they have to
 * address the original text.
 *
 * For the ASCII and CJK text this project searches, `toLowerCase()` preserves
 * length, so indices stay aligned. (A handful of Unicode characters fold to a
 * different length — e.g. 'İ' — but none can appear in these labels.)
 */

export interface FuzzyResult {
  /** Higher is better. Only the relative order matters. */
  score: number
  /** Indices into `target` that matched, ascending. Empty for an empty query. */
  indices: number[]
}

/** Characters that start a new "word" for boundary-bonus purposes. */
const BOUNDARY = /[\s\-_/·:：,，.。|()（）[\]【】]/

/** Bonus applied when a matched character begins a word. */
const BOUNDARY_BONUS = 18

/** Bonus applied when a matched character is the very first one. */
const PREFIX_BONUS = 34

/** Bonus per additional character in an unbroken run. */
const STREAK_BONUS = 9

/** Cost per character skipped between two matched characters. */
const GAP_PENALTY = 7

/**
 * Score a query against a target string.
 *
 * @returns `null` when the query is not a subsequence of the target at all,
 *          which lets the caller cheaply filter the list.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (!query) return { score: 0, indices: [] }
  if (!target) return null

  const q = query.toLowerCase()
  const t = target.toLowerCase()

  /* ── Fast path: a contiguous substring ────────────────────────────────── */
  const direct = t.indexOf(q)
  if (direct >= 0) {
    const indices: number[] = []
    for (let i = 0; i < q.length; i++) indices.push(direct + i)

    let score = 1000 + q.length * 14
    if (direct === 0) {
      score += PREFIX_BONUS * 10
    } else if (BOUNDARY.test(t[direct - 1])) {
      score += BOUNDARY_BONUS * 8
    }
    // Prefer earlier occurrences, gently.
    score -= Math.min(direct, 40)
    // Prefer tighter targets.
    score -= Math.floor(t.length / 8)

    return { score, indices }
  }

  /* ── Subsequence walk ─────────────────────────────────────────────────── */
  const indices: number[] = []
  let score = 0
  let cursor = 0
  let streak = 0

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    const at = t.indexOf(ch, cursor)
    if (at < 0) return null

    indices.push(at)

    let bonus = 10
    if (at === 0) bonus += PREFIX_BONUS
    else if (BOUNDARY.test(t[at - 1])) bonus += BOUNDARY_BONUS

    // An unbroken run of matches is a much stronger signal than the same
    // characters found far apart.
    streak = at === cursor && qi > 0 ? streak + 1 : 0
    bonus += streak * STREAK_BONUS

    // Penalise the gap that had to be skipped to reach this character.
    bonus -= Math.min((at - cursor) * GAP_PENALTY, GAP_PENALTY * 6)

    score += bonus
    cursor = at + 1
  }

  // A scattered match across a very long string is usually noise.
  score -= Math.floor(t.length / 6)

  return { score, indices }
}

/**
 * Merge ascending indices into `[start, end)` ranges.
 *
 * Rendering one `<mark>` per character would produce a span per letter; merging
 * consecutive runs keeps the DOM small and lets CSS style a whole matched token.
 */
export function toRanges(indices: number[]): Array<[number, number]> {
  if (indices.length === 0) return []
  const ranges: Array<[number, number]> = []
  let start = indices[0]
  let prev = indices[0]

  for (let i = 1; i < indices.length; i++) {
    const at = indices[i]
    if (at === prev + 1) {
      prev = at
      continue
    }
    ranges.push([start, prev + 1])
    start = at
    prev = at
  }
  ranges.push([start, prev + 1])
  return ranges
}
