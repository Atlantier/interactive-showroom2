import type { PerformanceTier } from '@/types'

/**
 * Detect a sensible rendering budget once, on boot.
 * The result only seeds the store; the user (or AdaptiveDpr/FPS data later)
 * can switch tiers at runtime from the navbar.
 */
export function detectPerformanceTier(): PerformanceTier {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'high'

  const nav = navigator as Navigator & { deviceMemory?: number }
  const cores = nav.hardwareConcurrency ?? 4
  const memory = nav.deviceMemory ?? 8
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (reducedMotion) return 'medium'
  if (cores <= 4 || memory <= 4) return 'medium'
  if (coarsePointer && cores <= 6) return 'medium'

  return 'high'
}

/** Whether the device can create a WebGL2/WebGL context at all. */
export function supportsWebGL(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(
      canvas.getContext('webgl2') ??
        canvas.getContext('webgl') ??
        canvas.getContext('experimental-webgl'),
    )
  } catch {
    return false
  }
}

/** Live media-query helper for the rare case we need the boolean on demand. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
