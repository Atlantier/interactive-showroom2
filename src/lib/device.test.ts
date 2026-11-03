import { describe, expect, it } from 'vitest'
import { dprForTier } from './device'

/**
 * The policy the two 2D sandboxes were missing (PB-13).
 *
 * They size their own canvas buffers from `devicePixelRatio`, which is why the adaptive downgrade
 * used to skip them entirely: the renderer dropped to DPR 1 while the two heaviest canvases on the
 * page kept filling 1.5x. The rule now lives in one place so the two cannot drift apart again.
 */
describe('dprForTier', () => {
  it('gives the downgraded tier a 1x buffer', () => {
    expect(dprForTier('medium')).toBe(1)
  })

  it('gives the full tier the 1.5x cap the sandboxes were built around', () => {
    // 1.5 rather than 2: additive glow on near-black, where 2x is invisible and costs 44% more fill.
    expect(dprForTier('high')).toBe(1.5)
  })

  it("never exceeds the renderer's own cap", () => {
    expect(dprForTier('high')).toBeLessThanOrEqual(1.5)
    expect(dprForTier('medium')).toBeLessThan(dprForTier('high'))
  })
})
