import { describe, expect, it } from 'vitest'
import { findConnections, midpointDisplace, type PulsePoint } from './InterCardPulse'

/**
 * The geometry behind the inter-card discharge (extracted from `BentoGrid` by UI-19).
 *
 * Both functions are pure and were previously buried inside a 740-line component, so the only
 * way to check them was to look at the screen. They are exactly the kind of thing that should be
 * asserted: a wrong adjacency rule produces a bolt hopping across the whole grid, and a wrong
 * displacement produces a scribble instead of lightning.
 */

/** Deterministic stand-in for Math.random so the shape assertions are stable. */
function seededRandom(seed = 1): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

describe('midpointDisplace', () => {
  const from = { x: 0, y: 0 }
  const to = { x: 100, y: 0 }

  it('keeps both endpoints exactly where they were', () => {
    const points = midpointDisplace(from, to, 4, 0.55, seededRandom())
    expect(points[0]).toEqual(from)
    expect(points[points.length - 1]).toEqual(to)
  })

  it('produces 2^n + 1 vertices for an unbroken segment', () => {
    // Each pass replaces one span with two, so four passes give 17 points.
    expect(midpointDisplace(from, to, 0, 0.55)).toHaveLength(2)
    expect(midpointDisplace(from, to, 1, 0.55)).toHaveLength(3)
    expect(midpointDisplace(from, to, 4, 0.55, seededRandom())).toHaveLength(17)
  })

  it('pushes the arc sideways, never along the segment', () => {
    // A horizontal segment may only be displaced vertically: x stays sorted inside the span.
    const points = midpointDisplace(from, to, 4, 0.55, seededRandom(7))
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(100)
    }
    // At least some of the generated vertices must actually leave the straight line, otherwise
    // the "bolt" is a straight line.
    const displaced = points.filter((point: PulsePoint) => Math.abs(point.y) > 0.5)
    expect(displaced.length).toBeGreaterThan(4)
  })

  it('never displaces further than the first pass allowed', () => {
    /*
     * The invariant worth pinning: every pass halves the offset, so no vertex can end up further
     * from the straight line than the first pass could push it (span * 0.16). Asserting "the
     * later passes are smaller than the earlier ones" instead would be flaky -- each vertex is
     * displaced by its own random draw, so a fine vertex can legitimately exceed a coarse one.
     */
    const span = 100
    const points = midpointDisplace(from, to, 4, 0.55, seededRandom(3))
    const worst = Math.max(...points.map((point: PulsePoint) => Math.abs(point.y)))
    expect(worst).toBeLessThanOrEqual(span * 0.16 + 1e-9)
    expect(worst).toBeGreaterThan(0)
  })

  it('does not divide by zero on a zero-length segment', () => {
    const points = midpointDisplace({ x: 5, y: 5 }, { x: 5, y: 5 }, 2, 0.55, seededRandom())
    expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true)
  })
})

describe('findConnections', () => {
  it('links cards that sit side by side with a normal gap', () => {
    const links = findConnections([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 116, y: 0, w: 100, h: 100 },
    ])
    expect(links).toHaveLength(1)
    expect(links[0]?.from).toEqual({ x: 100, y: 50 })
    expect(links[0]?.to).toEqual({ x: 116, y: 50 })
  })

  it('links stacked cards through their shared columns', () => {
    const links = findConnections([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 116, w: 100, h: 100 },
    ])
    expect(links).toHaveLength(1)
    expect(links[0]?.from).toEqual({ x: 50, y: 100 })
    expect(links[0]?.to).toEqual({ x: 50, y: 116 })
  })

  it('refuses to link cards across a gap wider than the grid gutter', () => {
    expect(
      findConnections([
        { x: 0, y: 0, w: 100, h: 100 },
        // 200px away: not neighbours, whatever the JSX order says.
        { x: 300, y: 0, w: 100, h: 100 },
      ]),
    ).toHaveLength(0)
  })

  it('refuses to link diagonal cards', () => {
    expect(
      findConnections([
        { x: 0, y: 0, w: 100, h: 100 },
        { x: 116, y: 116, w: 100, h: 100 },
      ]),
    ).toHaveLength(0)
  })

  it('finds every neighbour in a 2x2 matrix', () => {
    // Four cards in a grid: four orthogonal pairs, two diagonals excluded.
    const links = findConnections([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 116, y: 0, w: 100, h: 100 },
      { x: 0, y: 116, w: 100, h: 100 },
      { x: 116, y: 116, w: 100, h: 100 },
    ])
    expect(links).toHaveLength(4)
  })
})
