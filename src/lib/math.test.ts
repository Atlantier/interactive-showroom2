import { describe, expect, it } from 'vitest'
import { clamp, damp, lerp, mapRange, safeNumber, createSpring, stepSpring, resetSpring } from './math'

/**
 * These are the numbers the README quotes and the animation depends on.
 *
 * Nothing here is clever: the point of the suite is that a refactor which quietly
 * changes an easing or a clamp bound fails here instead of showing up as "the scroll
 * feels wrong now" three weeks later.
 */
describe('clamp', () => {
  it('holds the value inside the range', () => {
    expect(clamp(0.5)).toBe(0.5)
    expect(clamp(-1)).toBe(0)
    expect(clamp(2)).toBe(1)
  })

  it('defaults to a 0..1 range and accepts a custom one', () => {
    expect(clamp(5, 2, 4)).toBe(4)
    expect(clamp(3, 2, 4)).toBe(3)
  })
})

describe('lerp', () => {
  it('returns the endpoints at t=0 and t=1', () => {
    expect(lerp(10, 20, 0)).toBe(10)
    expect(lerp(10, 20, 1)).toBe(20)
  })

  it('is linear in the middle', () => {
    expect(lerp(0, 100, 0.25)).toBe(25)
  })
})

describe('damp', () => {
  it('is frame-rate independent: two half steps equal one whole step', () => {
    const once = damp(0, 100, 6, 1 / 30)
    const twice = damp(damp(0, 100, 6, 1 / 60), 100, 6, 1 / 60)
    expect(twice).toBeCloseTo(once, 10)
  })

  it('approaches the target without overshooting it', () => {
    let value = 0
    for (let i = 0; i < 200; i++) value = damp(value, 100, 6, 1 / 60)
    expect(value).toBeGreaterThan(99)
    expect(value).toBeLessThanOrEqual(100)
  })
})

describe('mapRange', () => {
  it('maps linearly between two ranges', () => {
    expect(mapRange(5, 0, 10, 0, 100)).toBe(50)
    expect(mapRange(0, 0, 10, -1, 1)).toBe(-1)
  })

  it('does not divide by a zero-width source range', () => {
    expect(Number.isFinite(mapRange(1, 3, 3, 0, 1))).toBe(true)
  })
})

describe('safeNumber', () => {
  it('passes finite numbers through', () => {
    expect(safeNumber(1.5)).toBe(1.5)
    expect(safeNumber(-0)).toBe(-0)
  })

  it('replaces NaN and infinities with the fallback', () => {
    expect(safeNumber(Number.NaN, 7)).toBe(7)
    expect(safeNumber(Number.POSITIVE_INFINITY, 7)).toBe(7)
    expect(safeNumber(Number.NaN)).toBe(0)
  })
})

describe('spring', () => {
  it('settles on the target and comes to rest', () => {
    const spring = createSpring(0)
    for (let i = 0; i < 600; i++) stepSpring(spring, 1, 1 / 60)
    expect(spring.value).toBeCloseTo(1, 2)
    expect(Math.abs(spring.velocity)).toBeLessThan(0.01)
  })

  it('resets to a position with no carried velocity', () => {
    const spring = createSpring(0)
    for (let i = 0; i < 10; i++) stepSpring(spring, 1, 1 / 60)
    resetSpring(spring, 5)
    expect(spring.value).toBe(5)
    expect(spring.velocity).toBe(0)
  })
})
