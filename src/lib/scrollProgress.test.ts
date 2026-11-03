import { describe, expect, it } from 'vitest'
import { resolveProgress } from './scrollProgress'

/**
 * Lenis reports `progress === 1` for a document with no scrollable distance, and this app reads
 * progress as "how far through the narrative the visitor is". Both halves are asserted here, plus
 * the malformed inputs that reach this from a library under load.
 */
describe('resolveProgress', () => {
  it('reports zero progress when there is nothing to scroll, whatever Lenis says', () => {
    // The actual bug: limit 0 comes back as progress 1 and parked the camera at the end.
    expect(resolveProgress(1, 0)).toBe(0)
    expect(resolveProgress(0.5, 0)).toBe(0)
    expect(resolveProgress(1, -10)).toBe(0)
  })

  it('passes normal values through', () => {
    expect(resolveProgress(0, 5000)).toBe(0)
    expect(resolveProgress(0.42, 5000)).toBe(0.42)
    expect(resolveProgress(1, 5000)).toBe(1)
  })

  it('clamps out-of-range values instead of trusting the library', () => {
    expect(resolveProgress(1.4, 5000)).toBe(1)
    expect(resolveProgress(-0.3, 5000)).toBe(0)
  })

  it('treats NaN and Infinity as no progress rather than propagating them', () => {
    expect(resolveProgress(Number.NaN, 5000)).toBe(0)
    expect(resolveProgress(Number.POSITIVE_INFINITY, 5000)).toBe(0)
    // A non-finite limit is not "no limit": it is an unmeasured layout.
    expect(resolveProgress(1, Number.NaN)).toBe(0)
    expect(resolveProgress(1, Number.POSITIVE_INFINITY)).toBe(0)
  })
})
