import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VFX_PRESET,
  VFX_PALETTES,
  VFX_PRESET_ORDER,
  getNextVfxPreset,
  getVfxPalette,
  isVfxPreset,
  vfxLabelKey,
} from './vfxPalette'

/**
 * The three "Visual Overdrive" palettes.
 *
 * The app cycles them from the command palette and the HUD, so the contract is: there
 * are exactly three, cycling visits each one, and an unknown value never breaks the
 * renderer (it falls back to the default instead of spreading `undefined` into a shader
 * uniform).
 */
describe('VFX_PALETTES', () => {
  it('defines every preset exactly once', () => {
    expect(Object.keys(VFX_PALETTES).sort()).toEqual([...VFX_PRESET_ORDER].sort())
    expect(VFX_PRESET_ORDER).toHaveLength(3)
  })

  it('keeps the three palettes distinct', () => {
    const serialised = VFX_PRESET_ORDER.map((preset) => JSON.stringify(VFX_PALETTES[preset]))
    expect(new Set(serialised).size).toBe(3)
  })

  it('uses the default preset by construction', () => {
    expect(VFX_PRESET_ORDER).toContain(DEFAULT_VFX_PRESET)
  })
})

describe('getVfxPalette', () => {
  it('returns the requested palette', () => {
    for (const preset of VFX_PRESET_ORDER) {
      expect(getVfxPalette(preset)).toBe(VFX_PALETTES[preset])
    }
  })

  it('falls back to the default for null, undefined and junk', () => {
    expect(getVfxPalette(null)).toBe(VFX_PALETTES[DEFAULT_VFX_PRESET])
    expect(getVfxPalette(undefined)).toBe(VFX_PALETTES[DEFAULT_VFX_PRESET])
  })
})

describe('getNextVfxPreset', () => {
  it('cycles through all three and returns to the start', () => {
    const visited = new Set<string>()
    let current: ReturnType<typeof getNextVfxPreset> = DEFAULT_VFX_PRESET
    for (let i = 0; i < VFX_PRESET_ORDER.length; i++) {
      current = getNextVfxPreset(current)
      visited.add(current)
    }
    expect(visited.size).toBe(3)
    // Three steps from the default land back on it: the order is a closed ring.
    expect(current).toBe(DEFAULT_VFX_PRESET)
    expect(VFX_PRESET_ORDER[0]).toBe(DEFAULT_VFX_PRESET)
  })

  it('starts from the head of the order when the input is unknown', () => {
    // The cycling order is the authority here; the default preset is only the palette
    // used for a fresh load, and the two do not have to agree.
    expect(getNextVfxPreset(null)).toBe(VFX_PRESET_ORDER[0])
    expect(getNextVfxPreset(undefined)).toBe(VFX_PRESET_ORDER[0])
  })
})

describe('isVfxPreset', () => {
  it('accepts the real presets and rejects everything else', () => {
    for (const preset of VFX_PRESET_ORDER) expect(isVfxPreset(preset)).toBe(true)
    expect(isVfxPreset('emerald')).toBe(false)
    expect(isVfxPreset('')).toBe(false)
    expect(isVfxPreset(null)).toBe(false)
    expect(isVfxPreset(undefined)).toBe(false)
  })
})

describe('vfxLabelKey', () => {
  it('maps every preset to a dictionary key', () => {
    for (const preset of VFX_PRESET_ORDER) {
      expect(['emerald', 'supernova', 'phantom']).toContain(vfxLabelKey(preset))
    }
  })
})
