import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/store/useAppStore'
import { SPECTRUM_BANDS, soundEngine } from '@/utils/soundEngine'
import { useI18n } from '@/i18n/useI18n'

/**
 * AudioSpectrumMeter — a five-column live spectrum readout for the navbar.
 *
 * ── Zero React renders ────────────────────────────────────────────────────
 * The analyser is read 60 times a second. Routing those levels through React
 * state would re-render the navbar (and every child of it) on every frame, for a
 * decorative element 20 px wide. Instead each column is a ref and the loop writes
 * `transform: scaleY()` directly, exactly like `ScrollProgressRing` and the FPS
 * readout.
 *
 * `scaleY` on a `transform-origin: bottom` element is used rather than `height`
 * because a transform is handled by the compositor: animating height would
 * trigger layout on every frame for five elements.
 *
 * ── Ballistics ────────────────────────────────────────────────────────────
 * The columns rise instantly and fall slowly, which is how a physical VU meter
 * behaves. Instant rise makes a 15 ms hover tick visible at all; a slow fall
 * keeps it readable instead of flickering for one frame. The asymmetry is the
 * whole reason this looks like a meter rather than a bar chart.
 */

/** Resting height, as a fraction of full scale. Never zero, so the rail shows. */
const REST_SCALE = 0.08

/** Column accent, low band → high band. */
const BAND_COLORS = [
  '#5eead4', // teal
  '#22d3ee', // cyan
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#e879f9', // fuchsia
] as const

export function AudioSpectrumMeter({ className }: { className?: string }) {
  const { t } = useI18n()
  const soundEnabled = useAppStore((state) => state.soundEnabled)
  const barRefs = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    const bars = barRefs.current
    const bands = new Uint8Array(SPECTRUM_BANDS)
    /** Smoothed display level per column, 0..1. */
    const levels = new Float32Array(SPECTRUM_BANDS)

    /**
     * Park every column at rest. Used when sound is off and as the first paint,
     * so the meter never renders at an arbitrary stale height.
     */
    const park = (): void => {
      for (let i = 0; i < SPECTRUM_BANDS; i++) {
        const el = bars[i]
        if (el) el.style.transform = `scaleY(${REST_SCALE})`
      }
    }

    // No audio graph when sound is off, so there is nothing to read and no
    // reason to hold a rAF open.
    if (!soundEnabled) {
      park()
      return
    }

    let raf = 0
    let smoothed = false

    const tick = (): void => {
      raf = requestAnimationFrame(tick)

      const reading = soundEngine.readSpectrum(bands)

      for (let i = 0; i < SPECTRUM_BANDS; i++) {
        // The analyser reports 0-255 in dB; normalise for scaleY.
        const target = reading ? bands[i] / 255 : 0
        const prev = levels[i]

        /**
         * Asymmetric ballistics.
         *
         * Rise is immediate — a transient should register on the exact frame it
         * occurs. Fall is a geometric decay, so the column glides back rather
         * than snapping, and a burst of ticks reads as a bouncing meter.
         */
        levels[i] = target > prev ? target : prev * 0.82

        // Avoid writing a style on every frame for a column that is already at
        // rest: five style writes per frame is cheap, but not free.
        const scale = Math.max(REST_SCALE, levels[i])
        const el = bars[i]
        if (el && (smoothed || scale > REST_SCALE)) {
          el.style.transform = `scaleY(${scale.toFixed(3)})`
        }
      }
      smoothed = true
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [soundEnabled])

  return (
    <div
      className={cn(
        'flex items-end gap-[2px] transition-opacity duration-300',
        soundEnabled ? 'opacity-100' : 'opacity-40',
        className,
      )}
      // Decorative: the sound toggle button beside it already conveys the mute
      // state, so announcing five anonymous levels would only add noise.
      aria-hidden
      title={t.nav.audioSpectrumTitle}
    >
      {BAND_COLORS.map((color, i) => (
        <span key={color} className="relative h-4 w-[3px] overflow-hidden">
          {/* Rail: the unfilled track behind each column. */}
          <span className="absolute inset-x-0 bottom-0 h-full rounded-[1px] bg-void-600/50" />
          <span
            ref={(el) => {
              barRefs.current[i] = el
            }}
            data-spectrum-bar={i}
            className="absolute inset-x-0 bottom-0 h-full origin-bottom rounded-[1px]"
            style={{
              backgroundColor: color,
              transform: `scaleY(${REST_SCALE})`,
              // Cheap glow so the columns read as light rather than as paint.
              boxShadow: `0 0 4px ${color}80`,
              willChange: 'transform',
            }}
          />
        </span>
      ))}
    </div>
  )
}

export default AudioSpectrumMeter
