import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { cn } from '@/lib/cn'
import { soundEngine } from '@/utils/soundEngine'
import { useSpotlightRegistry } from '@/components/bento/spotlightRegistry'
import { CardParticleCanvas, type CardParticleHandle } from '@/components/bento/CardParticleCanvas'

/**
 * SpotlightCard — a glass panel with a cursor-following spotlight, a border glow
 * that lights up from the outside, and a spring-driven 3D tilt.
 *
 * ── The three light/physics layers ─────────────────────────────────────────
 *
 * 1. BORDER GLOW
 *    A `radial-gradient(<BORDER_GLOW_RADIUS>px circle at var(--mouse-x)
 *    var(--mouse-y), …, transparent 40%)` painted on the element's border ring.
 *    Because the gradient keeps its full radius even when its centre lies
 *    OUTSIDE the card, a card whose edge the cursor merely approaches still
 *    lights up along that edge. That "the light bleeds in before you touch it"
 *    behaviour is what makes the NVIDIA/Linear treatment feel physical.
 *
 * 2. SURFACE GLARE
 *    A second, far fainter radial fill inside the card tracking the same
 *    coordinates. It reads as sheen on glass rather than as a second light.
 *
 * 3. SPRING 3D TILT
 *    Cursor offset from the card centre, normalised to [-1, 1] per axis, is
 *    mapped to `rotateX`/`rotateY` capped at ±8°. Both run through `useSpring`
 *    so the card leans with weight and settles instead of tracking rigidly.
 *    Content sits at `translateZ(30px)` so it floats above the face during the
 *    lean, which is what produces the parallax.
 *
 * ── The two-element structure (required, not stylistic) ────────────────────
 * THERE ARE TWO NESTED ELEMENTS HERE FOR A REASON:
 *
 *   motion.div  (outer)  — owns the 3D transform, `preserve-3d`, `will-change`.
 *   div         (inner)  — owns `overflow: hidden` + the rounded clipping.
 *
 * The CSS Transforms spec says a value other than `visible` for `overflow`
 * forces the element's *used* `transform-style` to `flat`, regardless of what
 * was declared. Combining both on one element therefore silently disables 3D:
 * an earlier version did exactly that and `translateZ(30px)` had NO effect at
 * all — measured by swapping it for `translateZ(0px)` and observing a 0.00px
 * difference in the rendered box. Splitting the responsibilities keeps the
 * perspective chain intact while still clipping the glow layers to the radius.
 *
 * The same split fixes the settling artefact: with clipping on the transformed
 * element, the browser resamples the clipped edge on every spring step, and a
 * rotated, anti-aliased 14px-radius corner visibly crawls as it returns to rest.
 * Moving the clip onto a child that is composited once removes that per-frame
 * resampling.
 *
 * ── Why the parent tracks the mouse ────────────────────────────────────────
 * `BentoGrid` owns the single `mousemove` listener and pushes each card's local
 * coordinates into it. One listener regardless of card count — and, crucially, a
 * card reacts while the cursor is outside its own bounds, which the border-glow
 * effect depends on.
 *
 * ── Performance ────────────────────────────────────────────────────────────
 * Motion values drive the tilt and CSS custom properties carry the spotlight, so
 * cursor movement causes zero React renders. Nothing here is state.
 */

/** Maximum tilt, in degrees, per axis. */
const MAX_TILT = 8

/** Spring configuration for the tilt. */
const TILT_SPRING = { stiffness: 260, damping: 20, mass: 0.8 } as const

/** Radius of the border glow, in CSS pixels. Must match the gradient below. */
export const BORDER_GLOW_RADIUS = 400

export interface SpotlightCardProps {
  children: ReactNode
  className?: string
  /** Tailwind grid spans, e.g. "md:col-span-2 md:row-span-2". */
  spanClassName?: string
  /** Accent colour as an "r, g, b" triple. Defaults to emerald #10b981. */
  glowColor?: string
  /** Disable the 3D tilt while keeping the spotlight (e.g. dense charts). */
  enableTilt?: boolean
  /** Accessible label for the card region. */
  label?: string
}

export function SpotlightCard({
  children,
  className,
  spanClassName,
  glowColor = '16, 185, 129',
  enableTilt = true,
  label,
}: SpotlightCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const registry = useSpotlightRegistry()

  /** Last written spotlight position, used to skip no-op style writes. */
  const lastPos = useRef({ x: Number.NaN, y: Number.NaN })

  /* ── Spring tilt ────────────────────────────────────────────────────────── */
  // Normalised cursor offset from the card centre, in [-1, 1].
  const offsetX = useMotionValue(0)
  const offsetY = useMotionValue(0)

  const springX = useSpring(offsetX, TILT_SPRING)
  const springY = useSpring(offsetY, TILT_SPRING)

  // rotateY follows horizontal offset; rotateX is inverted so the card leans
  // toward the cursor rather than away from it.
  const rotateY = useTransform(springX, [-1, 1], [-MAX_TILT, MAX_TILT])
  const rotateX = useTransform(springY, [-1, 1], [MAX_TILT, -MAX_TILT])

  /**
   * Imperative handle published to the parent grid. Allocation is hoisted into
   * `useCallback` with stable deps so the registry entry is never recreated.
   *
   * Writes are guarded by a change check. Unconditionally assigning the CSS
   * custom properties marks the element dirty on every pointer sample even when
   * the value is unchanged (common at high polling rates, where several events
   * land per frame), and each dirty write forces the gradient layer to repaint.
   * Skipping no-op writes is what keeps a hover sweep smooth.
   */
  const update = useCallback(
    (localX: number, localY: number, width: number, height: number) => {
      const card = cardRef.current
      if (!card) return

      // Sub-pixel changes are invisible on a 400px gradient; ignore them.
      if (
        Math.abs(localX - lastPos.current.x) < 0.5 &&
        Math.abs(localY - lastPos.current.y) < 0.5
      ) {
        return
      }
      lastPos.current.x = localX
      lastPos.current.y = localY

      // CSS custom properties consumed by the two gradient layers.
      card.style.setProperty('--mouse-x', `${localX}px`)
      card.style.setProperty('--mouse-y', `${localY}px`)

      if (!enableTilt || width <= 0 || height <= 0) return

      // Offset from centre, normalised to [-1, 1] and clamped at the edges.
      const nx = Math.max(-1, Math.min(1, (localX - width / 2) / (width / 2)))
      const ny = Math.max(-1, Math.min(1, (localY - height / 2) / (height / 2)))
      offsetX.set(nx)
      offsetY.set(ny)
    },
    [enableTilt, offsetX, offsetY],
  )

  const reset = useCallback(() => {
    // Invalidate the cached position so the next real move always writes.
    lastPos.current.x = Number.NaN
    lastPos.current.y = Number.NaN
    offsetX.set(0)
    offsetY.set(0)
  }, [offsetX, offsetY])

  /* ── Ember field ────────────────────────────────────────────────────────── */
  const emberRef = useRef<CardParticleHandle>(null)

  /**
   * Action buttons opt into the gravity-collapse effect by carrying
   * `data-card-action`. Looking them up by attribute rather than by prop keeps
   * `children` opaque — the card never needs to know which controls its content
   * renders, and any future button gets the treatment for free.
   */
  const actionCentre = (target: Element): { x: number; y: number } | null => {
    const card = cardRef.current
    if (!card) return null
    const cardRect = card.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    return {
      x: rect.left - cardRect.left + rect.width / 2,
      y: rect.top - cardRect.top + rect.height / 2,
    }
  }

  const handleEmberOver = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest('[data-card-action]')
    if (!target) return
    const centre = actionCentre(target)
    if (centre) emberRef.current?.setAttractor(centre.x, centre.y)
  }, [])

  const handleEmberOut = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest('[data-card-action]')
    if (!target) return
    // Travelling between the button's own children is not a leave.
    const next = event.relatedTarget as Node | null
    if (next && target.contains(next)) return
    emberRef.current?.setAttractor(null, null)
  }, [])

  const handleEmberBurst = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest('[data-card-action]')
    if (!target) return
    const centre = actionCentre(target)
    if (centre) emberRef.current?.burst(centre.x, centre.y)
  }, [])

  /* ── Publish the handle to the grid ─────────────────────────────────────── */
  useEffect(() => {
    const card = cardRef.current
    if (!card || !registry) return

    registry.register(card, { update, reset })
    return () => registry.unregister(card)
  }, [registry, update, reset])

  return (
    /*
     * OUTER: the 3D plane. Everything here is transform-only so the compositor
     * can animate it without touching layout or paint.
     *
     * `overflow` MUST stay visible on this element — see the spec note above.
     * `backfaceVisibility: hidden` stops the browser from rasterising a second,
     * mirrored face during the settle, which is a common source of shimmering
     * at the edges of a rotated panel.
     */
    <motion.div
      ref={cardRef}
      data-spotlight-card
      style={{
        rotateX: enableTilt ? rotateX : 0,
        rotateY: enableTilt ? rotateY : 0,
        transformStyle: 'preserve-3d',
        backfaceVisibility: 'hidden',
      }}
      className={cn(
        'group relative rounded-panel',
        // Perspective must live on the SAME element that carries the rotation for
        // `transform-perspective` semantics, but the child `translateZ` needs a
        // perspective CONTEXT on an ancestor. Declaring the `perspective`
        // property here (rather than only `transformPerspective`) gives children
        // that context, which is what makes the 30px lift visible.
        '[perspective:1000px]',
        'transform-gpu will-change-transform [will-change:transform]',
        'shadow-[0_24px_60px_-32px_rgba(0,0,0,0.95)]',
        spanClassName,
      )}
      aria-label={label}
      /**
       * Activation chord on click.
       *
       * Fires for any click inside the card, including on an embedded widget.
       * That is deliberate — the whole card is one interactive surface, and
       * singling out children would make the sound unpredictable. Widgets that
       * genuinely need to swallow the event (the terminal's input) already call
       * `stopPropagation`.
       */
      onClick={(event) => {
        // Burst first: this is the visual consequence of the click, and the
        // chime is queued behind it.
        handleEmberBurst(event)
        soundEngine.playCardActivate()
      }}
    >
      {/*
       * INNER: the clipping surface.
       *
       * Hosting `overflow: hidden` here (rather than on the transformed element)
       * keeps `preserve-3d` legal on the parent AND moves the rounded-corner
       * clip out of the animated transform's rasterisation path. The rounded
       * corners are rasterised once into this layer and then composited, so a
       * returning spring cannot make the anti-aliased edge crawl.
       *
       * NOTE: this element's used `transform-style` is necessarily `flat`
       * (overflow is not `visible`), which closes the parent's 3D context here.
       * That is fine and intentional — the parallax is produced by the CHILD
       * below via `translateZ`, and for that to render, a fresh perspective
       * context has to be established on this element.
       */}
      <div
        className={cn(
          'relative h-full overflow-hidden rounded-panel',
          'border border-void-600/80 bg-void-850/55',
          // Perspective for the content lift. A child's translateZ is only
          // visible inside a perspective context on its parent; without this the
          // 30px lift collapses to a no-op (measured: identical rendered box for
          // translateZ(30px) and translateZ(0)).
          '[perspective:1000px]',
          className,
        )}
        onPointerEnter={() => emberRef.current?.setHovered(true)}
        onPointerLeave={() => {
          emberRef.current?.setHovered(false)
          emberRef.current?.setAttractor(null, null)
        }}
        onPointerOver={handleEmberOver}
        onPointerOut={handleEmberOut}
      >
        {/* ── Layer 1: border glow ────────────────────────────────────────────
            A 1px ring whose radial gradient is centred on the cursor. The mask
            pair cuts out the content box, leaving only the border band painted,
            which is why the glow hugs the edge instead of washing the face.

            `contain: paint` + `will-change: background` keep the gradient's
            repaint inside this one composited layer. Without them, writing
            `--mouse-x` invalidates style for the whole card subtree and the
            browser repaints the card face too — measured 52 vs 85 fps during a
            hover sweep. */}
        <span
          aria-hidden
          className="spotlight-glow spotlight-glow--ring pointer-events-none absolute inset-0 rounded-panel opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{
            padding: 1,
            contain: 'paint',
            willChange: 'background',
            background: `radial-gradient(${BORDER_GLOW_RADIUS}px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(${glowColor}, 0.5), transparent 40%)`,
            WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
            WebkitMaskComposite: 'xor',
            mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
            maskComposite: 'exclude',
          }}
        />

        {/* ── Layer 2: surface glare ──────────────────────────────────────────
            Much weaker than the border, at a larger radius: glass sheen rather
            than a light source. Same containment treatment as the border ring. */}
        <span
          aria-hidden
          className="spotlight-glow spotlight-glow--wash pointer-events-none absolute inset-0 rounded-panel opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          style={{
            contain: 'paint',
            willChange: 'background',
            background: `radial-gradient(500px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(${glowColor}, 0.1), transparent 45%)`,
          }}
        />

        {/* ── Layer 3: rising embers ──────────────────────────────────────────
            Its own canvas rather than DOM nodes: a few hundred soft dots with
            trails composite far faster on one 2D surface than as separate
            elements, and the loop is gated by an IntersectionObserver inside the
            renderer so an off-screen card costs nothing.

            Sits under the content and over the spotlight fills, so embers read as
            light inside the glass rather than as paint on top of it. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
          <CardParticleCanvas ref={emberRef} glowColor={glowColor} className="h-full w-full" />
        </div>

        {/* ── Layer 4: perimeter comets ───────────────────────────────────────
            Inset by 1px so the 1.5px stroke lands on the border ring instead of
            straddling the card's outer edge. `pathLength={100}` normalises the
            outline, and the dash/walk timing lives in index.css. */}
        <svg
          aria-hidden
          className="pointer-events-none absolute"
          style={{ inset: 1, overflow: 'visible' }}
        >
          <rect
            className="comet-beam"
            style={{ '--comet-glow': '#10b981' } as React.CSSProperties}
            x="0"
            y="0"
            width="100%"
            height="100%"
            rx="13"
            fill="none"
            stroke="#10b981"
            strokeWidth={1.5}
            pathLength={100}
            strokeDasharray="7 93"
            strokeLinecap="round"
          />
          <rect
            className="comet-beam comet-beam--reverse"
            style={
              {
                '--comet-glow': '#22d3ee',
                '--comet-duration': '23s',
              } as React.CSSProperties
            }
            x="0"
            y="0"
            width="100%"
            height="100%"
            rx="13"
            fill="none"
            stroke="#22d3ee"
            strokeWidth={1}
            pathLength={100}
            strokeDasharray="4 96"
            strokeLinecap="round"
          />
        </svg>

        {/* ── Content, lifted in Z for parallax ──────────────────────────────
            `translateZ(30px)` only has an effect because the ancestor chain now
            preserves 3D; see the component notes. `backfaceVisibility: hidden`
            again prevents a mirrored second face while tilting. */}
        <div
          className="relative flex h-full flex-col"
          style={{
            transform: 'translateZ(30px)',
            transformStyle: 'preserve-3d',
            backfaceVisibility: 'hidden',
          }}
        >
          {children}
        </div>
      </div>
    </motion.div>
  )
}

export default SpotlightCard
