import { describe, expect, it } from 'vitest'
import {
  BREAK_STRAIN,
  LanyardSimulation,
  collideObb,
  FIXED_DT,
  RELAXATION_ITERATIONS,
  bezierPathLength,
  createConstraint,
  createPoint,
  findBreakPoint,
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

describe('findBreakPoint', () => {
  /*
   * PB-08: the break RULE uses signed strain, and the break EFFECT used to search with absolute
   * strain. These pin down the shared quantity, and one test records the reason the visible
   * difference never actually occurs: compression is bounded at -1 while a break needs > 2.5, so a
   * rope that just broke always has its largest |strain| on the stretched link anyway.
   */

  it('returns the midpoint of the most stretched link', () => {
    const points = [createPoint(0, 0, true), createPoint(50, 0), createPoint(52, 0)]
    const spot = findBreakPoint(points, [createConstraint(1, 2, 20), createConstraint(0, 1, 20)])
    expect(spot).not.toBeNull()
    // Link 0-1 is 50 vs 20 = +1.5; link 1-2 is 2 vs 20 = -0.9.
    expect(spot?.strain).toBeCloseTo(1.5, 6)
    expect(spot?.x).toBeCloseTo(25, 6)
  })

  it('prefers tension over compression, unlike an absolute-strain search', () => {
    const points = [createPoint(0, 0, true), createPoint(2, 0), createPoint(8, 0)]
    const constraints = [createConstraint(0, 1, 30), createConstraint(1, 2, 4)]
    const spot = findBreakPoint(points, constraints)
    // 0-1 is 2 vs 30 = -0.93 (larger magnitude, so an absolute search picks it), 1-2 is 6 vs 4 = +0.5.
    expect(spot?.strain).toBeCloseTo(0.5, 6)
    expect(spot?.x).toBeCloseTo(5, 6)
  })

  it('agrees with an absolute-strain search on a rope that actually broke', () => {
    const points = [createPoint(0, 0, true), createPoint(70, 0), createPoint(72, 0)]
    const constraints = [createConstraint(0, 1, 20), createConstraint(1, 2, 20)]
    const signed = findBreakPoint(points, constraints)
    // The comparison the old code ran, kept here as evidence rather than as an implementation.
    let worstAbs = -1
    for (const c of constraints) {
      const a = points[c.a] as VerletPoint
      const b = points[c.b] as VerletPoint
      worstAbs = Math.max(
        worstAbs,
        Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - c.restLength) / c.restLength,
      )
    }
    expect(signed?.strain).toBeCloseTo(2.5, 6)
    expect(worstAbs).toBeCloseTo(signed?.strain ?? 0, 6)
    expect(signed?.strain ?? 0).toBeGreaterThan(BREAK_STRAIN - 1e-9)
  })

  it('returns null for a rope with no usable constraint', () => {
    expect(findBreakPoint([createPoint(0, 0)], [createConstraint(0, 5, 20)])).toBeNull()
  })

  it('reports the same link the break rule reported, on a rope that actually snapped', () => {
    const specs = [{ id: 'a', label: 'A', accent: '#fff', anchorXRatio: 0.5 }]
    const sim = new LanyardSimulation({ width: 800, height: 600, specs })
    const lanyard = sim.lanyards[0]
    expect(lanyard).toBeDefined()

    // Grab the badge and drag it away, which is how a visitor actually breaks a rope: the held end
    // becomes a pin inside the solver, so the chain has to absorb an unsatisfiable error.
    const tag = lanyard!.tag
    expect(sim.pointerDown(tag.x, tag.y)).toBe(true)
    for (let i = 0; i < 90 && !lanyard!.broken; i++) {
      sim.pointerMove(tag.x + 40 * i, tag.y - 10 * i)
      sim.step(1 / 60, i / 60)
    }
    sim.pointerUp()

    expect(lanyard!.broken).toBe(true)
    const reported = measureMaxStrain(lanyard!.points, lanyard!.constraints)
    const spot = findBreakPoint(lanyard!.points, lanyard!.constraints)
    expect(reported).toBeGreaterThan(BREAK_STRAIN)
    expect(spot?.strain).toBeCloseTo(reported, 6)
  })
})

describe('collideObb', () => {
  /** An axis-aligned box centred on (cx, cy). */
  const box = (cx: number, cy: number, hw = 10, hh = 10) => ({ cx, cy, hw, hh, angle: 0 })
  const hit = () => ({ hit: false, nx: 0, ny: 0, depth: 0 })

  it('reports a miss, with a cleared normal and depth', () => {
    const out = collideObb(box(0, 0), box(40, 0), hit())
    expect(out.hit).toBe(false)
    expect(out.nx).toBe(0)
    expect(out.ny).toBe(0)
    expect(out.depth).toBe(0)
  })

  it('reports a hit with a unit normal pointing from A to B', () => {
    const out = collideObb(box(0, 0), box(15, 0), hit())
    expect(out.hit).toBe(true)
    expect(Math.hypot(out.nx, out.ny)).toBeCloseTo(1, 6)
    // B is to the right of A, so the normal points +X.
    expect(out.nx).toBeCloseTo(1, 6)
    expect(out.ny).toBeCloseTo(0, 6)
    expect(out.depth).toBeCloseTo(5, 6)
  })

  it('points the normal the other way when B is to the left', () => {
    const out = collideObb(box(0, 0), box(-15, 0), hit())
    expect(out.nx).toBeCloseTo(-1, 6)
    expect(out.depth).toBeCloseTo(5, 6)
  })

  it('picks the axis of least penetration, not the first one tested', () => {
    /*
     * A at (0,0), B at (15,19), both 20x20: X overlap is 20-15 = 5, Y overlap is 20-19 = 1.
     * The shallow axis is Y, so the normal must be vertical with depth 1 -- if the code returned
     * the first axis it tested, this would come back horizontal with depth 5.
     */
    const out = collideObb(box(0, 0), box(15, 19), hit())
    expect(out.hit).toBe(true)
    expect(out.nx).toBeCloseTo(0, 6)
    expect(out.ny).toBeCloseTo(1, 6)
    expect(out.depth).toBeCloseTo(1, 6)
  })

  it('separates two rotated boxes that their AABBs would call a hit', () => {
    /*
     * A 10x10 box rotated 45 degrees reaches 10*sqrt(2) ~= 14.14 along each axis, so two of them
     * separated by 26 on X still have their axis-aligned boxes overlapping -- an AABB test would
     * report a collision. The separating-axis test must not.
     */
    const a = { cx: 0, cy: 0, hw: 10, hh: 10, angle: Math.PI / 4 }
    const b = { cx: 30, cy: 0, hw: 10, hh: 10, angle: Math.PI / 4 }
    expect(collideObb(a, b, hit()).hit).toBe(false)
  })

  it('is symmetric in hit/miss and mirrors the normal', () => {
    const a = box(0, 0)
    const b = box(15, 0)
    const forward = collideObb(a, b, hit())
    const backward = collideObb(b, a, hit())
    expect(forward.hit).toBe(backward.hit)
    expect(backward.nx).toBeCloseTo(-forward.nx, 6)
    expect(backward.depth).toBeCloseTo(forward.depth, 6)
  })

  it("writes into the caller's object rather than allocating", () => {
    const out = hit()
    const returned = collideObb(box(0, 0), box(15, 0), out)
    expect(returned).toBe(out)
  })
})

describe('recoverIfNonFinite', () => {
  const specs = [
    { id: 'a', label: 'A', accent: '#fff', anchorXRatio: 0.3 },
    { id: 'b', label: 'B', accent: '#fff', anchorXRatio: 0.7 },
  ]
  const build = () => new LanyardSimulation({ width: 800, height: 600, specs })
  const finite = (sim: LanyardSimulation): boolean =>
    sim.lanyards.every(
      (l) =>
        l.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) &&
        Number.isFinite(l.tag.x) &&
        Number.isFinite(l.tag.angle),
    )

  it('leaves a healthy simulation alone', () => {
    const sim = build()
    expect(sim.recoverIfNonFinite(specs)).toBe(false)
    expect(finite(sim)).toBe(true)
  })

  it('reseeds when a point goes NaN, instead of letting it poison every later step', () => {
    const sim = build()
    const victim = sim.lanyards[1]?.points[3]
    expect(victim).toBeDefined()
    ;(victim as { x: number }).x = Number.NaN
    expect(sim.recoverIfNonFinite(specs)).toBe(true)
    expect(finite(sim)).toBe(true)
    // The rope is rebuilt, not left short or empty.
    expect(sim.lanyards).toHaveLength(specs.length)
    expect(sim.lanyards[0]?.points.length).toBeGreaterThan(8)
  })

  it('reseeds when a tag pose goes non-finite', () => {
    const sim = build()
    sim.lanyards[0]!.tag.angle = Number.POSITIVE_INFINITY
    expect(sim.recoverIfNonFinite(specs)).toBe(true)
    expect(finite(sim)).toBe(true)
  })

  it('keeps stepping cleanly after a recovery', () => {
    const sim = build()
    sim.lanyards[0]!.points[0]!.y = Number.NaN
    sim.recoverIfNonFinite(specs)
    for (let i = 0; i < 200; i++) sim.step(1 / 60, i / 60)
    expect(finite(sim)).toBe(true)
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
