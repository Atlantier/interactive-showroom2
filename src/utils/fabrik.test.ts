import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_BEND,
  applyAngleConstraints,
  chainLength,
  solveFABRIK,
  type IKJoint,
} from './fabrik'

/**
 * The solver's contract, not its implementation.
 *
 * A FABRIK bug does not throw — it silently produces a rig that looks almost right, so
 * the assertions are the two invariants the rest of the app relies on: bones keep their
 * length, and the tip reaches the target when the target is reachable.
 */

const dist = (a: IKJoint, b: IKJoint): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Build a chain of `count` joints laid out along +X with the given bone lengths. */
function buildChain(lengths: number[]): IKJoint[] {
  const joints: IKJoint[] = [{ x: 0, y: 0 }]
  for (let i = 0; i < lengths.length; i++) {
    const prev = joints[i] as IKJoint
    joints.push({ x: prev.x + (lengths[i] as number), y: prev.y })
  }
  return joints
}

function boneLengths(joints: IKJoint[]): number[] {
  const out: number[] = []
  for (let i = 1; i < joints.length; i++)
    out.push(dist(joints[i - 1] as IKJoint, joints[i] as IKJoint))
  return out
}

describe('chainLength', () => {
  it('sums the bones', () => {
    expect(chainLength([3, 4, 5])).toBe(12)
    expect(chainLength([])).toBe(0)
  })
})

describe('solveFABRIK', () => {
  const lengths = [40, 40, 40]

  it('reaches a reachable target and reports convergence', () => {
    const joints = buildChain(lengths)
    const target = { x: 60, y: 50 }
    const result = solveFABRIK(joints, target, lengths, 0.5)

    expect(result.converged).toBe(true)
    expect(result.unreachable).toBe(false)
    expect(result.error).toBeLessThanOrEqual(0.5)
    expect(result.iterations).toBeGreaterThan(0)
    expect(dist(joints[joints.length - 1] as IKJoint, target)).toBeLessThanOrEqual(1)
  })

  it('keeps every bone at its rest length', () => {
    const joints = buildChain(lengths)
    solveFABRIK(joints, { x: 20, y: 95 }, lengths, 0.5)
    const measured = boneLengths(joints)
    for (let i = 0; i < lengths.length; i++) {
      expect(measured[i] as number).toBeCloseTo(lengths[i] as number, 1)
    }
  })

  it('reports an unreachable target instead of iterating forever', () => {
    const joints = buildChain(lengths)
    const result = solveFABRIK(joints, { x: 10_000, y: 0 }, lengths, 0.5)

    expect(result.unreachable).toBe(true)
    expect(result.converged).toBe(false)
    // Laid out straight toward the target, so the tip sits at full reach on +X.
    expect(dist(joints[0] as IKJoint, joints[joints.length - 1] as IKJoint)).toBeCloseTo(120, 1)
  })

  it('keeps the root pinned', () => {
    const joints = buildChain(lengths)
    const root = joints[0] as IKJoint
    const before = { x: root.x, y: root.y }
    solveFABRIK(joints, { x: -70, y: 30 }, lengths, 0.5)
    expect(root.x).toBe(before.x)
    expect(root.y).toBe(before.y)
  })
})

describe('applyAngleConstraints', () => {
  it('clamps every interior joint to the bend limit', () => {
    const joints: IKJoint[] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      // Folded right back on itself: a 180 degree bend, well past the default limit.
      { x: 1, y: 0 },
    ]
    applyAngleConstraints(joints, DEFAULT_MAX_BEND)

    const a = joints[0] as IKJoint
    const b = joints[1] as IKJoint
    const c = joints[2] as IKJoint
    const angleAB = Math.atan2(b.y - a.y, b.x - a.x)
    const angleBC = Math.atan2(c.y - b.y, c.x - b.x)
    let bend = Math.abs(angleBC - angleAB)
    if (bend > Math.PI) bend = Math.PI * 2 - bend

    expect(bend).toBeLessThanOrEqual(DEFAULT_MAX_BEND + 1e-6)
  })
})
