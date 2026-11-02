import { describe, expect, it } from 'vitest'
import {
  BREAK_STRAIN,
  FIXED_DT,
  RELAXATION_ITERATIONS,
  bezierPathLength,
  createConstraint,
  createPoint,
  integratePoints,
  measureMaxStrain,
  relaxConstraints,
  sampleBezier,
  wrapAngle,
  type VerletPoint,
} from './mathPhysics'

/**
 * The Verlet solver: the invariants the two sandboxes depend on.
 *
 * All of it is pure and synchronous, which is exactly why it is worth pinning down —
 * this code runs 60 times a second inside an animation loop where a regression shows up
 * as "the rope looks springy today" rather than as a failing test.
 */
describe('constants', () => {
  it('matches the values the render loop assumes', () => {
    expect(FIXED_DT).toBeCloseTo(1 / 60, 12)
    expect(RELAXATION_ITERATIONS).toBeGreaterThan(0)
    expect(BREAK_STRAIN).toBeGreaterThan(1)
  })
})

describe('createPoint', () => {
  it('starts at rest: previous position equals current', () => {
    const p = createPoint(10, 20)
    expect(p.x).toBe(10)
    expect(p.y).toBe(20)
    expect(p.px).toBe(10)
    expect(p.py).toBe(20)
  })

  it('records the pinned flag', () => {
    expect(createPoint(0, 0, true).pinned).toBe(true)
    expect(createPoint(0, 0).pinned).toBeFalsy()
  })
})

describe('integratePoints', () => {
  it('does not move a pinned point', () => {
    const points = [createPoint(0, 0, true)]
    integratePoints(points, FIXED_DT, 900)
    expect(points[0]?.y).toBe(0)
    expect(points[0]?.x).toBe(0)
  })

  it('pulls a free point along +Y when gravity is positive', () => {
    const points = [createPoint(0, 0)]
    for (let i = 0; i < 10; i++) integratePoints(points, FIXED_DT, 900)
    expect((points[0] as VerletPoint).y).toBeGreaterThan(0)
  })

  it('accumulates velocity: the second step travels further than the first', () => {
    const points = [createPoint(0, 0)]
    integratePoints(points, FIXED_DT, 900)
    const afterOne = (points[0] as VerletPoint).y
    integratePoints(points, FIXED_DT, 900)
    const afterTwo = (points[0] as VerletPoint).y
    expect(afterTwo - afterOne).toBeGreaterThan(afterOne)
  })
})

describe('relaxConstraints', () => {
  it('pulls two points back to the rest length', () => {
    const points = [createPoint(0, 0, true), createPoint(40, 0)]
    const constraint = createConstraint(0, 1, 20)
    relaxConstraints(points, [constraint], RELAXATION_ITERATIONS)

    const a = points[0] as VerletPoint
    const b = points[1] as VerletPoint
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(20, 1)
  })

  it('leaves the pinned end untouched', () => {
    const points = [createPoint(0, 0, true), createPoint(40, 0)]
    relaxConstraints(points, [createConstraint(0, 1, 20)], RELAXATION_ITERATIONS)
    expect(points[0]?.x).toBe(0)
    expect(points[0]?.y).toBe(0)
  })
})

describe('measureMaxStrain', () => {
  it('is relative strain: 0 at rest, and past the break threshold when stretched', () => {
    const atRest = [createPoint(0, 0, true), createPoint(20, 0)]
    expect(measureMaxStrain(atRest, [createConstraint(0, 1, 20)])).toBeCloseTo(0, 6)

    // 50 vs a rest length of 20 is 1.5x, i.e. 150% relative strain.
    const stretched = [createPoint(0, 0, true), createPoint(50, 0)]
    const strain = measureMaxStrain(stretched, [createConstraint(0, 1, 20)])
    expect(strain).toBeCloseTo(1.5, 6)
    expect(strain * 100).toBeGreaterThan(BREAK_STRAIN)
  })

  it('writes the strain back onto the constraint so the renderer can colour it', () => {
    const points = [createPoint(0, 0, true), createPoint(30, 0)]
    const constraint = createConstraint(0, 1, 20)
    measureMaxStrain(points, [constraint])
    expect(constraint.strain).toBeCloseTo(0.5, 6)
  })
})

describe('wrapAngle', () => {
  it('folds any angle into (-PI, PI]', () => {
    for (const angle of [-7, -Math.PI, 0, Math.PI, 7]) {
      const wrapped = wrapAngle(angle)
      expect(wrapped).toBeGreaterThanOrEqual(-Math.PI - 1e-9)
      expect(wrapped).toBeLessThanOrEqual(Math.PI + 1e-9)
      // Same direction: the wrapped angle differs by whole turns.
      expect(Math.sin(wrapped)).toBeCloseTo(Math.sin(angle), 6)
    }
  })
})

describe('bezier helpers', () => {
  it('reports zero length for an empty path', () => {
    expect(bezierPathLength([])).toBe(0)
  })

  it('samples the midpoint of a straight cubic', () => {
    const straight = { x0: 0, y0: 0, x1: 0, y1: 0, x2: 10, y2: 0, x3: 10, y3: 0 }
    expect(sampleBezier(straight, 0).x).toBeCloseTo(0, 6)
    expect(sampleBezier(straight, 1).x).toBeCloseTo(10, 6)
    expect(sampleBezier(straight, 0.5).x).toBeCloseTo(5, 6)
    expect(sampleBezier(straight, 0.5).y).toBeCloseTo(0, 6)
  })

  it('lengths a straight segment by its endpoint distance', () => {
    const straight = { x0: 0, y0: 0, x1: 0, y1: 0, x2: 10, y2: 0, x3: 10, y3: 0 }
    expect(bezierPathLength([straight])).toBeCloseTo(10, 1)
  })
})
