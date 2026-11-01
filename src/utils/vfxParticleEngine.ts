/**
 * vfxParticleEngine — the shared particle pool behind both physics sandboxes.
 *
 * ── Why a pool and not an array of live particles ───────────────────────────
 * Sparks are spawned in bursts (15–40 at a collision, a stream while a laser
 * burns) and die within a second. Allocating and collecting those objects at
 * runtime would put the garbage collector inside the animation loop, which shows
 * up as periodic hitches exactly when the scene is busiest. Every slot here is
 * allocated once at construction and recycled from a cursor; a dead particle is
 * simply `active = false` and needs no sweep.
 *
 * ── Everything is in one flat record ────────────────────────────────────────
 * Fields live directly on the particle rather than in a nested options object,
 * so the per-frame update touches one contiguous run of memory per particle
 * instead of chasing pointers.
 *
 * ── What this file is NOT ───────────────────────────────────────────────────
 * It does not own a clock and never calls `requestAnimationFrame`. The sandboxes
 * already have exactly one loop each (gated by IntersectionObserver); the engine
 * is stepped from there, receives `dt` in seconds, and draws into whatever 2D
 * context it is handed. That keeps the single-clock rule intact.
 */

/** Floor and wall bounds for the bounce test, in canvas pixels. */
export interface VfxBounds {
  left: number
  right: number
  /** Y of the floor. Particles below this bounce. */
  bottom: number
}

/**
 * Reusable result record for `VfxParticleEngine.computeIllumination`.
 *
 * A plain mutable object rather than a return value: the whole point of the pool
 * is that nothing is allocated inside the frame loop, and that includes the
 * record describing where the light is.
 */
export interface VfxIllumination {
  x: number
  y: number
  /** 0..1, calibrated so a full collision burst saturates. */
  intensity: number
}

export interface VfxParticle {
  active: boolean
  x: number
  y: number
  vx: number
  vy: number
  /** Seconds lived. */
  age: number
  /** Seconds of total life. */
  life: number
  /** Stroke half-width in px. */
  size: number
  r: number
  g: number
  b: number
  /** Downward acceleration, px/s². */
  gravity: number
  /** Velocity multiplier per second (0 = no drag). */
  drag: number
  /** Bounce coefficient against the floor. */
  restitution: number
  /** Whether this particle collides with the sandbox floor. */
  bounce: boolean
  /**
   * Velocity-stretch factor, in seconds of travel. A spark moving at 900 px/s
   * with a factor of 0.02 draws a 18 px streak behind its head, which is what
   * makes fast sparks read as light instead of as dots.
   */
  stretch: number
  /** Remaining generations of bounce-splitting. */
  splits: number
}

export interface VfxBurstOptions {
  count: number
  x: number
  y: number
  /** Speed range in px/s. */
  speedMin: number
  speedMax: number
  /** Emission cone in radians; omit for a full circle. */
  angle?: number
  spread?: number
  lifeMin: number
  lifeMax: number
  sizeMin: number
  sizeMax: number
  color: [number, number, number]
  gravity?: number
  drag?: number
  restitution?: number
  bounce?: boolean
  stretch?: number
  splits?: number
}

/** Emit one particle. Used both by `burst` and by continuous emitters. */
export interface VfxSpawnOptions extends Omit<VfxBurstOptions, 'count'> {}

const FULL_CIRCLE = Math.PI * 2

/**
 * Fractal lightning between two points, by midpoint displacement.
 *
 * Repeatedly split each segment at its midpoint and displace that midpoint
 * along the segment's NORMAL by a random amount, halving the displacement each
 * pass. Returns the polyline as a flat xy array so callers can stream it straight
 * into `moveTo`/`lineTo` without allocating a point object per vertex.
 *
 * The same generator backs the Bento grid's inter-card arcs; sharing it here
 * stops the two implementations from drifting apart.
 */
export function fractalLightning(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  iterations = 5,
  roughness = 0.52,
  displaceFactor = 0.18,
): number[] {
  let points: number[] = [x1, y1, x2, y2]
  let offset = Math.hypot(x2 - x1, y2 - y1) * displaceFactor

  for (let pass = 0; pass < iterations; pass++) {
    const next: number[] = [points[0], points[1]]
    for (let i = 0; i < points.length - 2; i += 2) {
      const ax = points[i]
      const ay = points[i + 1]
      const bx = points[i + 2]
      const by = points[i + 3]
      const dx = bx - ax
      const dy = by - ay
      const len = Math.hypot(dx, dy) || 1
      const nx = -dy / len
      const ny = dx / len
      const shift = (Math.random() * 2 - 1) * offset
      next.push((ax + bx) / 2 + nx * shift, (ay + by) / 2 + ny * shift)
      next.push(bx, by)
    }
    points = next
    offset *= roughness
  }

  return points
}

/** Stroke a polyline produced by `fractalLightning`. */
export function strokePolyline(
  ctx: CanvasRenderingContext2D,
  points: number[],
): void {
  if (points.length < 4) return
  ctx.beginPath()
  ctx.moveTo(points[0], points[1])
  for (let i = 2; i < points.length; i += 2) {
    ctx.lineTo(points[i], points[i + 1])
  }
  ctx.stroke()
}

/**
 * Soft radial flash, used for muzzle blasts, impact pops and the arc that
 * appears when the lanyard snaps.
 */
export function drawRadialFlash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  alpha: number,
  color: [number, number, number],
): void {
  if (radius <= 0 || alpha <= 0.002) return
  const grad = ctx.createRadialGradient(x, y, 0, x, y, radius)
  grad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`)
  grad.addColorStop(0.35, `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha * 0.6})`)
  grad.addColorStop(1, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0)`)
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, FULL_CIRCLE)
  ctx.fill()
}

/**
 * The pool.
 *
 * `step` and `draw` are deliberately separate so a sandbox can update physics at
 * a fixed cadence and still render on the same frame, and so a layer can be
 * drawn beneath or above other content.
 */
export class VfxParticleEngine {
  readonly particles: VfxParticle[]
  private cursor = 0
  private liveCount = 0

  constructor(capacity = 512) {
    this.particles = new Array<VfxParticle>(capacity)
    for (let i = 0; i < capacity; i++) {
      this.particles[i] = {
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        age: 0,
        life: 1,
        size: 1,
        r: 255,
        g: 255,
        b: 255,
        gravity: 0,
        drag: 0,
        restitution: 0.6,
        bounce: false,
        stretch: 0,
        splits: 0,
      }
    }
  }

  /** Particles currently alive. Cheap; maintained incrementally. */
  get alive(): number {
    return this.liveCount
  }

  get capacity(): number {
    return this.particles.length
  }

  /** Emit a single particle, recycling the oldest slot. */
  spawn(options: VfxSpawnOptions): VfxParticle {
    const p = this.particles[this.cursor]
    this.cursor = this.cursor + 1 >= this.particles.length ? 0 : this.cursor + 1

    const angle =
      options.angle === undefined
        ? Math.random() * FULL_CIRCLE
        : options.angle + (Math.random() * 2 - 1) * (options.spread ?? 0.4)
    const speed =
      options.speedMin + Math.random() * (options.speedMax - options.speedMin)

    if (!p.active) this.liveCount++

    p.active = true
    p.x = options.x
    p.y = options.y
    p.vx = Math.cos(angle) * speed
    p.vy = Math.sin(angle) * speed
    p.age = 0
    p.life = options.lifeMin + Math.random() * (options.lifeMax - options.lifeMin)
    p.size = options.sizeMin + Math.random() * (options.sizeMax - options.sizeMin)
    p.r = options.color[0]
    p.g = options.color[1]
    p.b = options.color[2]
    p.gravity = options.gravity ?? 900
    p.drag = options.drag ?? 0.6
    p.restitution = options.restitution ?? 0.6
    p.bounce = options.bounce ?? false
    p.stretch = options.stretch ?? 0
    p.splits = options.splits ?? 0

    return p
  }

  /** Emit a burst. The workhorse for collisions and impacts. */
  burst(options: VfxBurstOptions): void {
    for (let i = 0; i < options.count; i++) {
      this.spawn(options)
    }
  }

  /**
   * Integrate every live particle.
   *
   * `bounds` is optional: a spark that is not flagged `bounce` ignores it, and
   * a layer that has no floor can omit it entirely.
   */
  step(dt: number, bounds?: VfxBounds): void {
    if (!(dt > 0)) return
    let live = 0

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]
      if (!p.active) continue

      p.age += dt
      if (p.age >= p.life) {
        p.active = false
        continue
      }

      p.vy += p.gravity * dt
      // Exponential drag, framerate independent.
      const damp = p.drag > 0 ? Math.exp(-p.drag * dt) : 1
      p.vx *= damp
      p.vy *= damp

      p.x += p.vx * dt
      p.y += p.vy * dt

      if (bounds && p.bounce) {
        if (p.y > bounds.bottom) {
          p.y = bounds.bottom
          // The vertical component is reflected; tangential speed is preserved,
          // which is what makes a bouncing spark skitter along the floor rather
          // than reverse straight up.
          p.vy = -p.vy * p.restitution
          p.vx *= 0.92
          p.age = Math.min(p.life - 0.001, p.age + p.life * 0.08)

          /*
           * Splitting: a hard vertical impact throws off a couple of children so
           * the bounce reads as a scatter rather than as one ball reversing.
           * Children inherit the remaining generation budget minus one, so a
           * spark can only cascade a bounded number of times.
           */
          if (p.splits > 0 && Math.abs(p.vy) > 70) {
            const generations = p.splits - 1
            const childOptions: VfxSpawnOptions = {
              x: p.x,
              y: p.y,
              speedMin: 40,
              speedMax: 190,
              lifeMin: 0.16,
              lifeMax: 0.4,
              sizeMin: p.size * 0.55,
              sizeMax: p.size,
              color: [p.r, p.g, p.b],
              gravity: p.gravity,
              drag: p.drag,
              restitution: p.restitution,
              bounce: false,
              stretch: p.stretch,
              splits: generations,
            }
            const children = 2
            for (let c = 0; c < children; c++) this.spawn(childOptions)
          }
        }

        if (p.x < bounds.left) {
          p.x = bounds.left
          p.vx = -p.vx * p.restitution
        } else if (p.x > bounds.right) {
          p.x = bounds.right
          p.vx = -p.vx * p.restitution
        }
      }

      live++
    }

    this.liveCount = live
  }

  /**
   * Draw every live particle.
   *
   * Fast particles are drawn as a capsule from their head back along their
   * velocity vector — the length is `speed * stretch`, so the streak grows with
   * speed exactly as the brief asks, and a particle that slows down settles back
   * into a dot without any special-casing.
   */
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.liveCount === 0) return

    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]
      if (!p.active) continue

      // Fade with age, and over the first 6% so nothing pops into being.
      const remaining = 1 - p.age / p.life
      const born = Math.min(1, p.age / (p.life * 0.06))
      const alpha = remaining * remaining * born
      if (alpha < 0.004) continue

      const tailX = p.x - p.vx * p.stretch
      const tailY = p.y - p.vy * p.stretch

      ctx.strokeStyle = `rgba(${p.r}, ${p.g}, ${p.b}, ${alpha})`
      ctx.lineWidth = p.size
      ctx.beginPath()
      ctx.moveTo(tailX, tailY)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()

      // Hot white core on the head, so sparks read as metal vapour rather than
      // as coloured chalk.
      if (p.size > 0.9) {
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.75})`
        ctx.lineWidth = p.size * 0.42
        ctx.beginPath()
        ctx.moveTo(tailX, tailY)
        ctx.lineTo(p.x, p.y)
        ctx.stroke()
      }
    }

    ctx.globalCompositeOperation = 'source-over'
  }

  /**
   * Energy-weighted centroid of every live particle.
   *
   * This is the whole of the "dynamic point light": a burst of sparks is not one
   * emitter but dozens, so the light has to follow their centre of mass rather
   * than any single particle. Weighting by remaining life squared (the same
   * curve the sprite opacity uses) means the light tracks the part of the cloud
   * that is still visibly glowing, not the cold tail.
   *
   * The caller passes a reused record: allocating one per frame would defeat the
   * point of having a pool at all.
   */
  computeIllumination(out: VfxIllumination): VfxIllumination {
    let sumX = 0
    let sumY = 0
    let weight = 0

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]
      if (!p.active) continue
      const remaining = 1 - p.age / p.life
      const energy = remaining * remaining * p.size
      sumX += p.x * energy
      sumY += p.y * energy
      weight += energy
    }

    if (weight <= 0) {
      out.intensity = 0
      return out
    }

    out.x = sumX / weight
    out.y = sumY / weight
    // Calibrated so a typical 40-spark collision saturates at 1.0.
    out.intensity = Math.min(1, weight / (this.particles.length * 0.06))
    return out
  }

  /** Retire everything immediately (used when a sandbox leaves the viewport). */
  clear(): void {
    for (let i = 0; i < this.particles.length; i++) {
      this.particles[i].active = false
    }
    this.liveCount = 0
  }
}

/**
 * Paint the environment light cast by a particle cloud.
 *
 * Additive radial falloff centred on the cloud's centroid. Callers draw this
 * BELOW their own content — under the badge surface and under the background
 * grid — so the sparks appear to be the thing lighting the scene rather than an
 * overlay sitting on top of it.
 */
export function drawIllumination(
  ctx: CanvasRenderingContext2D,
  illumination: VfxIllumination,
  radius: number,
  color: [number, number, number],
  strength = 0.35,
): void {
  if (illumination.intensity <= 0.01) return
  // The lit area grows with the energy as well as brightening: a single stray
  // spark should not cast as wide a pool as a full collision.
  const spread = radius * (0.55 + illumination.intensity * 0.75)
  const previous = ctx.globalCompositeOperation
  ctx.globalCompositeOperation = 'lighter'
  drawRadialFlash(
    ctx,
    illumination.x,
    illumination.y,
    spread,
    illumination.intensity * strength,
    color,
  )
  ctx.globalCompositeOperation = previous
}

/**
 * One hexagonal holographic ripple.
 *
 * Drawn as a stroked hexagon plus a fainter inner copy, which is enough to read
 * as a projected grid without needing a real grid texture. Callers drive
 * `radius`/`alpha` over the ripple's life; run two of them at different phases
 * for the double-ring the brief asks for.
 */
export function drawHexRipple(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  alpha: number,
  color: [number, number, number],
  rotation = 0,
): void {
  if (radius <= 0.5 || alpha <= 0.004) return

  for (let ring = 0; ring < 2; ring++) {
    const r = radius * (ring === 0 ? 1 : 0.62)
    const a = alpha * (ring === 0 ? 1 : 0.55)
    ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${a})`
    ctx.lineWidth = ring === 0 ? 1.6 : 1
    ctx.beginPath()
    for (let i = 0; i < 6; i++) {
      const angle = rotation + (i / 6) * Math.PI * 2
      const px = x + Math.cos(angle) * r
      const py = y + Math.sin(angle) * r
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
    ctx.stroke()
  }
}
