import { describe, expect, it } from 'vitest'
import { VfxParticleEngine } from '@/utils/vfxParticleEngine'

/**
 * SH-17: the draw loop must not build strings per particle per frame.
 *
 * The old code assigned `ctx.strokeStyle = rgba(r, g, b, alpha)` (plus a second template for the hot
 * core) for every live spark, every frame -- ~4800 short-lived strings a second during a collision.
 * These assertions pin the replacement: one colour string per spawn, alpha via globalAlpha, and a
 * canvas state that is handed back clean.
 *
 * The context is a recorder rather than a real canvas: what matters is which values the loop assigns
 * and how many distinct strings it can produce, not what the pixels look like.
 */

interface Recorder {
  ctx: CanvasRenderingContext2D
  strokeStyles: string[]
  alphas: number[]
  lineWidths: number[]
  reset(): void
}

function recorder(): Recorder {
  const strokeStyles: string[] = []
  const alphas: number[] = []
  const lineWidths: number[] = []
  const state = {
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    lineCap: 'butt' as CanvasLineCap,
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    globalAlpha: 1,
  }

  const ctx = {
    get globalCompositeOperation() {
      return state.globalCompositeOperation
    },
    set globalCompositeOperation(value: GlobalCompositeOperation) {
      state.globalCompositeOperation = value
    },
    get lineCap() {
      return state.lineCap
    },
    set lineCap(value: CanvasLineCap) {
      state.lineCap = value
    },
    get lineWidth() {
      return state.lineWidth
    },
    set lineWidth(value: number) {
      state.lineWidth = value
      lineWidths.push(value)
    },
    get globalAlpha() {
      return state.globalAlpha
    },
    set globalAlpha(value: number) {
      state.globalAlpha = value
      alphas.push(value)
    },
    get strokeStyle() {
      return state.strokeStyle
    },
    set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
      state.strokeStyle = value
      strokeStyles.push(String(value))
    },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
  } as unknown as CanvasRenderingContext2D

  return {
    ctx,
    strokeStyles,
    alphas,
    lineWidths,
    reset() {
      strokeStyles.length = 0
      alphas.length = 0
      lineWidths.length = 0
      state.globalAlpha = 1
      state.globalCompositeOperation = 'source-over'
    },
  }
}

function engineWithParticles(count = 24): VfxParticleEngine {
  const engine = new VfxParticleEngine(64)
  for (let i = 0; i < count; i++) {
    const particle = engine.spawn({
      x: 100 + i,
      y: 200,
      speedMin: 40,
      speedMax: 80,
      lifeMin: 1,
      lifeMax: 2,
      sizeMin: 1.2,
      sizeMax: 1.6,
      color: [10, 20, 30],
    })
    // Age it so alpha is strictly between 0 and 1.
    particle.age = 0.4
  }
  return engine
}

describe('VfxParticleEngine.draw (SH-17)', () => {
  it('assigns only the spawn-cached colour, never a per-frame rgba string', () => {
    const engine = engineWithParticles()
    const record = recorder()

    engine.draw(record.ctx)
    const firstFrame = [...record.strokeStyles]
    record.reset()
    engine.draw(record.ctx)
    const secondFrame = [...record.strokeStyles]

    // Every assignment is one of exactly two strings: the particle colour at alpha 1, or the core.
    expect(new Set(firstFrame)).toEqual(new Set(['rgba(10,20,30,1)', 'rgba(255,255,255,1)']))
    // Repeated frames produce the same strings, so steady state allocates none.
    expect(new Set(secondFrame)).toEqual(new Set(firstFrame))
  })

  it('applies the fade through globalAlpha, not through the colour string', () => {
    const engine = engineWithParticles(4)
    const record = recorder()
    engine.draw(record.ctx)

    const fades = record.alphas.filter((value) => value !== 1)
    expect(fades.length).toBeGreaterThan(0)
    for (const fade of fades) {
      expect(fade).toBeGreaterThan(0)
      expect(fade).toBeLessThanOrEqual(1)
    }
  })

  it('leaves the canvas state as it found it', () => {
    const engine = engineWithParticles(8)
    const record = recorder()
    engine.draw(record.ctx)
    record.reset()
    engine.draw(record.ctx)

    expect(record.ctx.globalAlpha).toBe(1)
    expect(record.ctx.globalCompositeOperation).toBe('source-over')
  })

  it('touches nothing when there are no live particles', () => {
    const engine = new VfxParticleEngine(8)
    const record = recorder()
    engine.draw(record.ctx)

    expect(record.strokeStyles).toHaveLength(0)
    expect(record.alphas).toHaveLength(0)
  })
})
