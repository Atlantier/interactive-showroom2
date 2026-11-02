import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PerformanceTier, TransientState } from '@/types'
import type { VfxPreset } from '@/lib/vfxPalette'
import { clamp, safeNumber } from '@/lib/math'
import { detectPerformanceTier } from '@/lib/device'

import { getDictionary } from '@/i18n/useI18n'
/* -------------------------------------------------------------------------- */
/*  Reactive state                                                            */
/* -------------------------------------------------------------------------- */

/** A transient toast shown when the renderer degrades itself. */
export interface PerfNotice {
  title: string
  detail: string
  /** Bumped on every notice so the toast can restart its own timer. */
  nonce: number
}

/**
 * Accent colour themes.
 *
 * `cyan` is the showroom's original identity and the default; the other three
 * are the switchable emphasises offered in the command palette (翡翠绿 / 赛博紫 /
 * 钛金橙). Applying a theme only overrides `--color-signal-cyan`, so every
 * component that already speaks in "signal cyan" re-tints at once without any of
 * them knowing a theme system exists.
 */
export type AccentTheme = 'cyan' | 'emerald' | 'violet' | 'amber'

/** Gravity presets for the Verlet sandbox, as a multiplier of Earth's pull. */
export type GravityMode = 'earth' | 'zero' | 'moon' | 'heavy'

/**
 * Gravity multiplier per mode.
 *
 * Moon is 1/6 of Earth — the real ratio, not a guessed value. `heavy` is 2.6x,
 * which is enough that the lanyards go visibly taut without the solver exploding
 * at the 60 Hz fixed step.
 */
export const GRAVITY_SCALE: Record<GravityMode, number> = {
  earth: 1,
  zero: 0,
  moon: 1 / 6,
  heavy: 2.6,
}

/** Swatch colours per accent, for the palette's preview dots. */
export const ACCENT_SWATCH: Record<AccentTheme, string> = {
  cyan: '#22d3ee',
  emerald: '#34d399',
  violet: '#a78bfa',
  amber: '#f59e0b',
}

/**
 * Low-frequency state. Every field here is safe to bind to a React component:
 * updating it re-renders only the components that select that exact slice.
 */
export interface AppState {
  /** Master audio switch (UI clicks + ambient bed). */
  soundEnabled: boolean
  /** Whether the live FPS/telemetry HUD in the navbar is expanded. */
  fpsMonitorEnabled: boolean
  /** Rendering budget. Seeded from device detection on first boot. */
  performanceTier: PerformanceTier
  /** Currently visible section id, driven by an IntersectionObserver. */
  activeSection: string
  /** Whether the developer telemetry overlay (Shift+D) is open. */
  perfHudOpen: boolean
  /** Toast shown when the adaptive monitor downgrades the tier. */
  perfNotice: PerfNotice | null
  /**
   * Whether the adaptive monitor is allowed to downgrade the tier.
   *
   * Set to false the first time the user picks a tier by hand: silently
   * overriding an explicit choice would make the manual control feel broken.
   */
  autoDowngradeArmed: boolean
  /**
   * The tier the VISITOR chose, or null if they never did. This is the only tier
   * that is persisted.
   *
   * `performanceTier` above is what is actually running and may have been lowered by
   * the adaptive monitor. Persisting that value meant one slow boot -- a cold shader
   * compile storm, which is exactly when the monitor fires -- pinned the visitor to
   * `medium` forever, with no path back even on a machine that was never struggling.
   */
  preferredTier: PerformanceTier | null
  /** Undo an automatic downgrade once frame pacing recovers. */
  restorePerformanceTier: () => void
  /** Accent colour theme (翡翠绿 / 赛博紫 / 钛金橙). */
  accentTheme: AccentTheme
  /**
   * Site-wide Visual Overdrive palette (翡翠赛博绿 / 黑金超新星 / 量子幻影紫).
   *
   * Separate from `accentTheme` on purpose. The accent theme is a DOM/CSS
   * concern that re-tints the interface through the cascade; this preset is the
   * spectral recipe for the *rendered* world — WebGL particle colours, stage
   * beams, the aurora and the bento glow. Coupling them would mean a UI accent
   * change also recolouring eight thousand particles, which is not what either
   * control promises. The palette values themselves live in
   * `@/lib/vfxPalette`; the store only tracks which one is active so every
   * consumer re-reads the same source of truth.
   */
  vfxPreset: VfxPreset
  /** Gravity preset for the Verlet lanyard sandbox. */
  gravityMode: GravityMode
  /** Whether the Cmd/Ctrl+K command palette is open. */
  commandPaletteOpen: boolean
  /**
   * Set once the architecture rig has drawn its materials for the first time.
   *
   * Shader programs compile on first draw and the driver blocks the main thread
   * while it happens -- measured at ~2.7s spread over a few tasks on a cold
   * driver cache. The boot veil covers that work and lifts when this flips, so
   * the stall is never attached to a visible freeze. Deliberately NOT part of
   * `partialize`: it describes this page load, not a user preference.
   */
  prewarmDone: boolean

  setSoundEnabled: (enabled: boolean) => void
  toggleSound: () => void
  setFpsMonitorEnabled: (enabled: boolean) => void
  toggleFpsMonitor: () => void
  setPerformanceTier: (tier: PerformanceTier) => void
  /** Automatic downgrade path; respects `autoDowngradeArmed`. */
  degradePerformanceTier: (reason: string) => void
  cyclePerformanceTier: () => void
  setActiveSection: (sectionId: string) => void
  setPerfHudOpen: (open: boolean) => void
  togglePerfHud: () => void
  showPerfNotice: (title: string, detail: string) => void
  clearPerfNotice: () => void
  setAccentTheme: (theme: AccentTheme) => void
  setVfxPreset: (preset: VfxPreset) => void
  setGravityMode: (mode: GravityMode) => void
  setCommandPaletteOpen: (open: boolean) => void
  /** Report that the architecture rig finished compiling its shaders. */
  setPrewarmDone: () => void
  toggleCommandPalette: () => void
  /** Restore the persisted preferences to their boot defaults. */
  resetPreferences: () => void
}

const DEFAULT_SECTION = 'hero'

/* -------------------------------------------------------------------------- */
/*  Transient state (hot path, zero React re-renders)                          */
/* -------------------------------------------------------------------------- */

/**
 * A single,永不变更引用的可变对象.
 *
 * Why not put this in zustand state? Because a mousemove/scroll write happens
 * 60-240 times per second: routing it through `set()` would schedule a store
 * notification (and, for any subscribed selector, a React render) on every
 * frame. Instead we mutate these leaves in place and read them directly from
 * `useFrame` callbacks and imperative DOM code.
 *
 * Contract:
 *   - NEVER replace `transient`, `transient.mouse` or `transient.scroll`.
 *   - NEVER use these values as React state; read them inside an animation loop.
 */
export const transient: TransientState = {
  mouse: { x: 0, y: 0, px: 0, py: 0, active: false,
    // Eased by the scroll engine; 0 while no pointer is over the viewport.
    strength: 0,
    tx: 0,
    ty: 0 },
  scroll: { progress: 0, velocity: 0 },
}

/** Write normalized mouse coordinates, both clamped to [-1, 1]. */
export function writeNormalizedMouse(x: number, y: number): void {
  // Written to the target only. The eased x/y are advanced by the scroll engine
  // so that re-entering the window after the pointer left fades the influence
  // in from where the last ease left it instead of snapping to the new position.
  transient.mouse.tx = clamp(safeNumber(x), -1, 1)
  transient.mouse.ty = clamp(safeNumber(y), -1, 1)
}

/** Write raw viewport pixel coordinates. */
export function writePixelMouse(px: number, py: number): void {
  transient.mouse.px = safeNumber(px)
  transient.mouse.py = safeNumber(py)
}

/**
 * Convert a DOM pointer event position into the transient mouse state.
 * `y` is flipped so that +1 is the top edge (WebGL / camera friendly) while
 * staying in [-1, 1] on both axes.
 *
 * ── Why the reference box is the canvas, not `window.innerWidth` ────────────
 * These values are consumed as Normalized Device Coordinates by a raycaster that
 * projects through the WebGL camera. The camera's aspect ratio is derived from
 * the CANVAS' box, but `window.innerWidth` includes the vertical scrollbar —
 * a 6–17 px difference. Normalising against the window therefore skews every
 * sample by `scrollbarWidth / innerWidth`, which is worst at narrow widths and
 * shows up as a cursor/ray mismatch that grows after each resize.
 *
 * The fix keeps the two coordinate systems on the same footing by measuring the
 * canvas box; `getBoundingClientRect()` also accounts for any offset, so the
 * math stays correct even if the canvas is not anchored at (0, 0).
 *
 * Falls back to the window box when no canvas exists yet (pre-mount events).
 */
/*
 * ── Cached projection box ───────────────────────────────────────────────────
 * `writePointer` runs on every accepted pointermove, i.e. up to 120 times a second.
 * It used to do a document-wide `querySelector('canvas')` plus a
 * `getBoundingClientRect()` per call -- the query walks the tree and the rect read
 * forces a style/layout flush, so the parallax was paying for a layout on every
 * mouse move.
 *
 * The box only changes on resize (the hero canvas is fixed to the viewport), so it is
 * measured once, cached, and invalidated explicitly: on window resize here, and from
 * `resizeScroll()` for programmatic resizes.
 */
interface PointerBox {
  left: number
  top: number
  width: number
  height: number
}

const pointerBox: PointerBox = { left: 0, top: 0, width: 1, height: 1 }
let pointerCanvas: HTMLCanvasElement | null = null
let pointerBoxDirty = true
let pointerResizeBound = false

/** Mark the cached projection box stale. */
export function invalidatePointerBox(): void {
  pointerBoxDirty = true
}

/**
 * Tell the pointer pipeline which canvas defines the projection.
 *
 * Called from the canvas' `onCreated`, which also stops the code from guessing via
 * `querySelector` once a real element is known.
 */
export function registerPointerCanvas(canvas: HTMLCanvasElement | null): void {
  pointerCanvas = canvas
  pointerBoxDirty = true

  if (pointerResizeBound || typeof window === 'undefined') return
  pointerResizeBound = true
  window.addEventListener('resize', invalidatePointerBox, { passive: true })
}

function ensurePointerBox(): PointerBox {
  if (!pointerBoxDirty) return pointerBox

  const element =
    pointerCanvas ??
    (typeof document !== 'undefined' ? document.querySelector('canvas') : null)
  const rect = element?.getBoundingClientRect()

  pointerBox.left = rect?.left ?? 0
  pointerBox.top = rect?.top ?? 0
  pointerBox.width = rect && rect.width > 0 ? rect.width : (window.innerWidth || 1)
  pointerBox.height = rect && rect.height > 0 ? rect.height : (window.innerHeight || 1)
  pointerBoxDirty = false
  return pointerBox
}

export function writePointer(clientX: number, clientY: number): void {
  // The render canvas is the authority for the projection box, cached above.
  const { left, top, width, height } = ensurePointerBox()

  // Position relative to the canvas, then to NDC.
  const localX = clientX - left
  const localY = clientY - top

  writeNormalizedMouse((localX / width) * 2 - 1, -((localY / height) * 2 - 1))
  writePixelMouse(clientX, clientY)
  transient.mouse.active = true
  /*
   * `strength` is deliberately NOT forced to 1 here.
   *
   * Forcing it made the influence snap on at full weight the instant the pointer
   * came back, so a re-entry still read as a pop even though the position now
   * eases. Leaving it to the engine's ease means the effect ramps in from where
   * the release left it, which is what makes re-entry continuous.
   */
}

/** Write the smoothed scroll progress (p ∈ [0,1]) and its velocity. */
export function writeScroll(progress: number, velocity: number): void {
  transient.scroll.progress = clamp(safeNumber(progress), 0, 1)
  transient.scroll.velocity = safeNumber(velocity)
}

/**
 * Ease the mouse back to center (pointer left the window).
 * Scroll values are deliberately untouched: they belong to the scroll engine and
 * must never be clobbered by pointer activity.
 */
export function resetMouseTransient(): void {
  /*
   * Position is deliberately NOT zeroed here any more.
   *
   * Zeroing it is what produced the teleport: the cursor influence lives in the
   * same object, so resetting x/y to the centre while consumers were still
   * reading them moved every effect half a viewport in one frame. The scroll
   * engine now eases x/y (and `strength`) back to rest over a few hundred
   * milliseconds, so this only has to drop the flag.
   */
  transient.mouse.px = 0
  transient.mouse.py = 0
  transient.mouse.active = false
}

/** Full reset — used on teardown / route changes. */
export function resetTransient(): void {
  resetMouseTransient()
  transient.scroll.progress = 0
  transient.scroll.velocity = 0
}

/* -------------------------------------------------------------------------- */
/*  Store                                                                     */
/* -------------------------------------------------------------------------- */

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      soundEnabled: false,
      fpsMonitorEnabled: false,
      performanceTier: detectPerformanceTier(),
      preferredTier: null,
      activeSection: DEFAULT_SECTION,
      perfHudOpen: false,
      perfNotice: null,
      autoDowngradeArmed: true,
      accentTheme: 'cyan',
      vfxPreset: 'emerald-cyber',
      gravityMode: 'earth',
      commandPaletteOpen: false,
      prewarmDone: false,

      setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
      toggleSound: () => set((state) => ({ soundEnabled: !state.soundEnabled })),

      setFpsMonitorEnabled: (enabled) => set({ fpsMonitorEnabled: enabled }),
      toggleFpsMonitor: () =>
        set((state) => ({ fpsMonitorEnabled: !state.fpsMonitorEnabled })),

      // A manual choice disarms the adaptive monitor for the session, and is the
      // only thing that gets persisted.
      setPerformanceTier: (tier) =>
        set({ performanceTier: tier, preferredTier: tier, autoDowngradeArmed: false }),

      /**
       * Automatic downgrade, driven by the frame-rate monitor.
       *
       * Unlike `setPerformanceTier` this does NOT disarm the monitor — it is the
       * monitor's own action. It also refuses to fire when the user has already
       * chosen a tier by hand, so an explicit preference is never overridden.
       */
      degradePerformanceTier: (reason) => {
        const state = get()
        if (!state.autoDowngradeArmed) return
        if (state.performanceTier === 'medium') return
        set({
          performanceTier: 'medium',
          perfNotice: {
            title: getDictionary().hud.noticeTitle,
            detail: reason,
            nonce: Date.now(),
          },
        })
      },

      cyclePerformanceTier: () =>
        set((state) => {
          const next: PerformanceTier = state.performanceTier === 'high' ? 'medium' : 'high'
          return {
            performanceTier: next,
            preferredTier: next,
            // Cycling is a manual decision, so the monitor stands down.
            autoDowngradeArmed: false,
          }
        }),

      /*
       * Recovery path.
       *
       * The monitor could only ever go DOWN, so a single hitch (or a cold shader
       * compile) was a one-way trip. On an incline back to comfortable frame pacing
       * the tier returns to whatever the visitor chose, or to what the device
       * deserves if they never chose.
       */
      restorePerformanceTier: () => {
        const state = get()
        if (!state.autoDowngradeArmed) return
        const target = state.preferredTier ?? detectPerformanceTier()
        if (state.performanceTier !== target) set({ performanceTier: target })
      },

      setActiveSection: (sectionId) => {
        if (sectionId === get().activeSection) return
        set({ activeSection: sectionId })
      },

      setPerfHudOpen: (open) => set({ perfHudOpen: open }),
      togglePerfHud: () => set((state) => ({ perfHudOpen: !state.perfHudOpen })),

      showPerfNotice: (title, detail) =>
        set({ perfNotice: { title, detail, nonce: Date.now() } }),
      clearPerfNotice: () => {
        // Only clear the notice that is currently showing, so a stale timer
        // cannot dismiss a newer one.
        if (get().perfNotice) set({ perfNotice: null })
      },

      setAccentTheme: (theme) => set({ accentTheme: theme }),
      setVfxPreset: (preset) => set({ vfxPreset: preset }),
      setGravityMode: (mode) => set({ gravityMode: mode }),

      setPrewarmDone: () => set({ prewarmDone: true }),
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
      toggleCommandPalette: () =>
        set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

      resetPreferences: () =>
        set({
          soundEnabled: false,
          fpsMonitorEnabled: false,
          performanceTier: detectPerformanceTier(),
          preferredTier: null,
          activeSection: DEFAULT_SECTION,
          perfHudOpen: false,
          perfNotice: null,
          autoDowngradeArmed: true,
          accentTheme: 'cyan',
          vfxPreset: 'emerald-cyber',
          gravityMode: 'earth',
          commandPaletteOpen: false,
        }),
    }),
    {
      name: 'showroom:preferences',
      version: 1,
      // Transient data must never be serialized — only durable UI preferences.
      // The command palette's open state is deliberately absent: restoring a
      // panel over the page on reload would be a bug, not a preference.
      //
      // `vfxPreset` is additive to the v1 payload. zustand's persist merges the
      // stored object over the initial state, so an older payload simply keeps
      // the boot default ('emerald-cyber') and no version bump / migration is
      // needed — bumping without a `migrate` would only discard the other saved
      // preferences for no benefit.
      /*
       * Apply the restored preference once hydration lands.
       *
       * Without this the store would boot at the device default and a visitor who
       * had explicitly picked `medium` would silently get `high` again.
       */
      onRehydrateStorage: () => (state) => {
        if (state?.preferredTier) state.performanceTier = state.preferredTier
      },
      partialize: (state) => ({
        soundEnabled: state.soundEnabled,
        fpsMonitorEnabled: state.fpsMonitorEnabled,
        // The effective tier is deliberately absent: it is re-derived per load
        // (preferredTier, else the device probe) instead of being frozen by one
        // bad session.
        preferredTier: state.preferredTier,
        accentTheme: state.accentTheme,
        vfxPreset: state.vfxPreset,
        gravityMode: state.gravityMode,
      }),
    },
  ),
)

/* -------------------------------------------------------------------------- */
/*  Non-hook accessors                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Read the transient state without subscribing to anything.
 * Safe to call inside `useFrame`, `requestAnimationFrame`, or event handlers.
 */
export const getTransient = (): TransientState => transient

/** Read one reactive slice outside of React (event handlers, effects). */
export const getAppState = (): AppState => useAppStore.getState()
