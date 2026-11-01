import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

import { isScrollBusy } from '@/lib/scrollEngine'
/**
 * CardParticleCanvas — the ember field inside a Bento card.
 *
 * A 2D canvas rather than WebGL: the effect is a few hundred soft dots with
 * short trails, which a 2D context composites faster than a full GL setup, and
 * it keeps the particle system out of the R3F scene graph entirely.
 *
 * ── Activation ──────────────────────────────────────────────────────────────
 * The loop only runs while the card is on screen AND either hovered or recently
 * touched — an IntersectionObserver gates the first, the parent gates the second.
 * With a dozen cards on the page, a permanently-running loop per card would cost
 * more than the entire 3D background.
 *
 * ── Layout of a frame ───────────────────────────────────────────────────────
 *   spawn     a few embers off the bottom edge (rate depends on hover)
 *   forces    normal: +sine sway on x, negative g on y (they rise)
 *             attract: pull toward a target point (the button)
 *             burst:   radial impulse, then coast
 *   draw      trail from the previous position, then the head with a radial glow
 *
 * ── Allocation ──────────────────────────────────────────────────────────────
 * The ember array is allocated once at maximum size and recycled from a cursor,
 * exactly like the 3D particle pools. No object is created inside the loop.
 */

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                  */
/* -------------------------------------------------------------------------- */

/** Hard pool size. */
const MAX_EMBERS = 180

/** Embers per second while hovered. */
const SPAWN_RATE_HOVER = 46

/** Embers per second while merely on screen — just enough to breathe. */
const SPAWN_RATE_IDLE = 5

/** Upward acceleration, px/s². */
const GRAVITY_UP = 34

/** Vertical drag so embers settle at a terminal rise speed. */
const DRAG = 1.35

/** Lateral sway amplitude range, px. */
const SWAY_MIN = 3
const SWAY_MAX = 11

/** Attraction strength toward a hovered button, px/s². */
const ATTRACT_ACCEL = 1900

/** Burst impulse, px/s. */
const BURST_SPEED = 210

/** Ember colours: emerald body, cyan highlight. */
const COLOR_WARM = '16, 185, 129'
const COLOR_COOL = '34, 211, 238'

/** Ember lifetime range, seconds. */
const LIFE_MIN = 1.5
const LIFE_MAX = 3.2

interface Ember {
  on: boolean
  x: number
  y: number
  px: number
  py: number
  vx: number
  vy: number
  /** Origin of the sine sway. */
  ox: number
  amp: number
  freq: number
  phase: number
  age: number
  life: number
  radius: number
  /** 0 = emerald, 1 = cyan. */
  tint: number
  /** 0 rising, 1 attracted, 2 bursting. */
  mode: 0 | 1 | 2
}

export interface CardParticleHandle {
  /** Hover state of the card, which drives the spawn rate. */
  setHovered(hovered: boolean): void
  /**
   * Centre of the action button the embers should collapse into, in card-local
   * pixels. Pass `null` to release them back to their rising behaviour.
   */
  setAttractor(x: number | null, y: number | null): void
  /** Fire the outward burst from the given card-local point. */
  burst(x: number, y: number): void
}

export interface CardParticleCanvasProps {
  /** Ember colour as an "r, g, b" triple, matching the card's glow colour. */
  glowColor?: string
  className?: string
}

export const CardParticleCanvas = forwardRef<CardParticleHandle, CardParticleCanvasProps>(
  function CardParticleCanvas({ glowColor, className }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null)

    /* ── Mutable render state, allocated once ─────────────────────────────── */
    const state = useRef({
      embers: [] as Ember[],
      cursor: 0,
      hovered: false,
      inView: false,
      /** Attractor centre in card-local px, or null. */
      attractX: null as number | null,
      attractY: null as number | null,
      /** Seconds since the loop started, for the sine phase. */
      t: 0,
      /** Spawn accumulator, in embers. */
      spawnAcc: 0,
      width: 0,
      height: 0,
      dpr: 1,
      raf: 0,
      running: false,
      last: 0,
    })

    /* ── Pool ─────────────────────────────────────────────────────────────── */
    if (state.current.embers.length === 0) {
      for (let i = 0; i < MAX_EMBERS; i++) {
        state.current.embers.push({
          on: false,
          x: 0,
          y: 0,
          px: 0,
          py: 0,
          vx: 0,
          vy: 0,
          ox: 0,
          amp: 0,
          freq: 0,
          phase: 0,
          age: 0,
          life: 1,
          radius: 1,
          tint: 0,
          mode: 0,
        })
      }
    }

    /* ── Imperative surface ───────────────────────────────────────────────── */
    useImperativeHandle(
      ref,
      () => ({
        setHovered(next) {
          state.current.hovered = next
        },
        setAttractor(x, y) {
          state.current.attractX = x
          state.current.attractY = y
          if (x === null || y === null) {
            // Release: reset the mode so embers resume rising.
            for (const e of state.current.embers) if (e.mode === 1) e.mode = 0
          } else {
            for (const e of state.current.embers) if (e.on) e.mode = 1
          }
        },
        burst(x, y) {
          const s = state.current
          for (const e of s.embers) {
            if (!e.on) continue
            const dx = e.x - x
            const dy = e.y - y
            const len = Math.sqrt(dx * dx + dy * dy) || 1
            // Slight speed variance keeps the ring from looking like a stencil.
            const speed = BURST_SPEED * (0.55 + Math.random() * 0.9)
            e.vx = (dx / len) * speed
            e.vy = (dy / len) * speed
            e.mode = 2
            // Bursting embers get a fresh lease on life so the firework is
            // visible instead of dying mid-flight.
            e.life = Math.max(e.life, e.age + 0.7)
          }
        },
      }),
      [],
    )

    /* ── Sizing ───────────────────────────────────────────────────────────── */
    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return

      const parent = canvas.parentElement
      if (!parent) return

      const applySize = (): void => {
        const rect = parent.getBoundingClientRect()
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const s = state.current
        s.width = rect.width
        s.height = rect.height
        s.dpr = dpr
        canvas.width = Math.max(1, Math.round(rect.width * dpr))
        canvas.height = Math.max(1, Math.round(rect.height * dpr))
        canvas.style.width = `${rect.width}px`
        canvas.style.height = `${rect.height}px`
      }

      applySize()
      const ro = new ResizeObserver(applySize)
      ro.observe(parent)
      return () => ro.disconnect()
    }, [])

    /* ── Visibility gate ──────────────────────────────────────────────────── */
    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return

      const io = new IntersectionObserver(
        ([entry]) => {
          state.current.inView = entry.isIntersecting
        },
        { rootMargin: '120px' },
      )
      io.observe(canvas)
      return () => io.disconnect()
    }, [])

    /* ── The loop ─────────────────────────────────────────────────────────── */
    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const s = state.current
      s.last = performance.now()

      const spawn = (): void => {
        const e = s.embers[s.cursor]
        s.cursor = s.cursor + 1 >= s.embers.length ? 0 : s.cursor + 1

        const x = Math.random() * s.width
        e.on = true
        e.x = x
        e.px = x
        e.ox = x
        e.y = s.height - 2
        e.py = s.height
        e.vx = 0
        // A small initial kick so embers do not all start from rest.
        e.vy = -(12 + Math.random() * 26)
        e.amp = SWAY_MIN + Math.random() * (SWAY_MAX - SWAY_MIN)
        e.freq = 0.8 + Math.random() * 1.5
        e.phase = Math.random() * Math.PI * 2
        e.age = 0
        e.life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN)
        e.radius = 1 + Math.random() * 2
        e.tint = Math.random()
        e.mode = s.attractX !== null ? 1 : 0
      }

      const step = (now: number): void => {
        s.raf = requestAnimationFrame(step)

        let dt = (now - s.last) / 1000
        s.last = now
        if (dt > 0.05) dt = 0.05
        if (dt <= 0) return
        s.t += dt

        // Also stand down during the scroll: eleven of these cards each repaint
        // additive embers per frame, which is invisible while the page moves.
        const running = (s.inView || s.hovered) && !isScrollBusy()
        if (!running) {
          // Nothing visible is happening: park the loop until visibility
          // returns, otherwise a scrolled-away card keeps burning frames.
          if (s.running) {
            ctx.clearRect(0, 0, s.width, s.height)
            for (const e of s.embers) e.on = false
            s.running = false
          }
          return
        }
        s.running = true

        /* Spawn */
        const rate = s.hovered ? SPAWN_RATE_HOVER : SPAWN_RATE_IDLE
        s.spawnAcc += rate * dt
        while (s.spawnAcc >= 1) {
          s.spawnAcc -= 1
          if (s.width > 0 && s.height > 0) spawn()
        }

        /* Update */
        for (const e of s.embers) {
          if (!e.on) continue

          e.age += dt
          if (e.age >= e.life) {
            e.on = false
            continue
          }

          e.px = e.x
          e.py = e.y

          if (e.mode === 1 && s.attractX !== null && s.attractY !== null) {
            /* Gravity collapse: constant-magnitude pull toward the button, with
             * a tangential component so embers spiral in rather than falling
             * along straight lines. */
            const dx = s.attractX - e.x
            const dy = s.attractY - e.y
            const len = Math.sqrt(dx * dx + dy * dy) || 1
            e.vx += (dx / len) * ATTRACT_ACCEL * dt - (dy / len) * ATTRACT_ACCEL * 0.35 * dt
            e.vy += (dy / len) * ATTRACT_ACCEL * dt + (dx / len) * ATTRACT_ACCEL * 0.35 * dt
            e.x += e.vx * dt
            e.y += e.vy * dt
            // Reaching the centre consumes the ember.
            if (len < 6) e.on = false
          } else if (e.mode === 2) {
            /* Burst: ballistic with drag. */
            const drag = 1 - Math.min(DRAG * dt, 0.6)
            e.vx *= drag
            e.vy *= drag
            e.x += e.vx * dt
            e.y += e.vy * dt
          } else {
            /* Rising: negative gravity on y, sine sway on x. */
            e.vy -= GRAVITY_UP * dt
            const terminal = 1 - Math.min(DRAG * 0.5 * dt, 0.4)
            e.vy *= terminal
            e.y += e.vy * dt
            e.x = e.ox + Math.sin(s.t * e.freq + e.phase) * e.amp
            e.ox += e.vx * dt * 0.0 // origin stays put; sway does the work
          }
        }

        /* Draw */
        const w = s.width
        const h = s.height
        ctx.clearRect(0, 0, w, h)
        // Additive compositing is what turns overlapping embers into light
        // instead of into muddy paint.
        ctx.globalCompositeOperation = 'lighter'

        for (const e of s.embers) {
          if (!e.on) continue

          const fade = 1 - e.age / e.life
          // Embers fade in over their first 12% so they do not pop into being.
          const born = Math.min(1, e.age / 0.12)
          const alpha = fade * fade * born

          const rgb = e.tint > 0.55 ? COLOR_COOL : glowColor ?? COLOR_WARM

          // Trail: a short gradient along the segment the ember just travelled.
          const tx = e.px
          const ty = e.py
          const trailLen = Math.sqrt((e.x - tx) ** 2 + (e.y - ty) ** 2)
          if (trailLen > 0.4) {
            const grad = ctx.createLinearGradient(tx, ty, e.x, e.y)
            grad.addColorStop(0, `rgba(${rgb}, 0)`)
            grad.addColorStop(1, `rgba(${rgb}, ${alpha * 0.35})`)
            ctx.strokeStyle = grad
            ctx.lineWidth = e.radius * 0.9
            ctx.lineCap = 'round'
            ctx.beginPath()
            ctx.moveTo(tx, ty)
            ctx.lineTo(e.x, e.y)
            ctx.stroke()
          }

          // Head: a soft radial falloff, brighter than its own radius.
          const glowR = e.radius * 3.4
          const head = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, glowR)
          head.addColorStop(0, `rgba(255, 255, 255, ${alpha * 0.75})`)
          head.addColorStop(0.35, `rgba(${rgb}, ${alpha * 0.55})`)
          head.addColorStop(1, `rgba(${rgb}, 0)`)
          ctx.fillStyle = head
          ctx.beginPath()
          ctx.arc(e.x, e.y, glowR, 0, Math.PI * 2)
          ctx.fill()
        }

        ctx.globalCompositeOperation = 'source-over'
      }

      s.raf = requestAnimationFrame(step)
      return () => {
        cancelAnimationFrame(s.raf)
        s.running = false
      }
    }, [glowColor])

    return (
      <canvas
        ref={canvasRef}
        aria-hidden
        className={className}
        style={{ display: 'block', pointerEvents: 'none' }}
      />
    )
  },
)

export default CardParticleCanvas
