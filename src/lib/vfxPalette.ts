/**
 * Visual Overdrive — the site-wide spectral palette.
 *
 * ── Why this is a plain data module and not CSS custom properties ───────────
 * The accent themes (`AccentTheme` in the store) can live purely in the cascade
 * because every consumer is DOM/CSS: one `[data-accent]` override re-tints them
 * for free. This palette cannot take that route. Most of its consumers are
 * WebGL materials whose colours are read as JS values (`THREE.Color`, shader
 * uniforms) once per palette change, and two of them (the bento spotlight and
 * the particle canvas) build `rgba()` strings from an "r, g, b" channel triple.
 * A single typed record that both the DOM and the render loop can read is the
 * only shape that fits all of them, so the palette is data here and each
 * consumer is responsible for pushing it into its own rendering system.
 *
 * ── Fields ─────────────────────────────────────────────────────────────────
 * `primary` / `secondary` / `accent` are the three spectral hues of the preset.
 * They are deliberately separate from `particleCore` / `particleEdge` because
 * the particle nebula needs a REST colour and an INTERACTION colour — a role
 * that is not the same as "hue 1 / hue 2" for every preset. For instance the
 * black-gold preset's particles cool toward amber under the cursor while the
 * lighting rig keeps three clearly separated beams.
 *
 * `glowRgb` is the same hue as `primary`, pre-split into an "r, g, b" triple.
 * It exists because `SpotlightCard` and `CardParticleCanvas` interpolate
 * `rgba(<triple>, <alpha>)` strings on the JS side, where a hex string is not
 * usable directly. Keeping the triple in the palette means one preset change
 * updates those consumers without any hex parsing at runtime.
 *
 * ── Default preset == the original showroom ────────────────────────────────
 * `emerald-cyber` reproduces the colours the site shipped with (emerald body,
 * cyan highlight, electric-violet interaction), so a visitor who never opens
 * the switcher sees the identity the composition was tuned against.
 */

/** The three switchable Visual Overdrive presets. */
export type VfxPreset = 'emerald-cyber' | 'supernova-gold' | 'quantum-violet'

/** One spectral recipe. All colours are CSS hex strings unless noted. */
export interface VfxPalette {
  /** The preset this palette belongs to. */
  id: VfxPreset
  /** Human-facing name, in the same Chinese style as the rest of the UI. */
  /** Identity only. The display name lives in the dictionary. */
  /** Hero spectral hue: the nebula, the main stage beam, the primary glow. */
  primary: string
  /** Counter-hue: the second beam / ribbon highlight / cool contrast. */
  secondary: string
  /** Third accent, used where a composition needs three distinguishable hues. */
  accent: string
  /** WebGL particle colour at rest. */
  particleCore: string
  /** WebGL particle colour under interaction (cursor push / fast motion). */
  particleEdge: string
  /**
   * `primary` as an "r, g, b" channel triple, for JS-built `rgba()` strings.
   *
   * Kept comma+space separated because the existing consumers interpolate it
   * directly — `rgba(${glowColor}, 0.5)` — so no parsing or re-formatting is
   * needed at runtime.
   */
  glowRgb: string
}

/**
 * 翡翠赛博绿 — the showroom's original identity.
 *
 * Primary emerald, secondary cyan, violet as the third light. The particle
 * channels keep the emerald → violet interaction grade of the original nebula,
 * which is what made the cursor repulsion legible as a colour transition.
 */
const EMERALD_CYBER: VfxPalette = {
  id: 'emerald-cyber',
  primary: '#10b981',
  secondary: '#22d3ee',
  accent: '#8b5cf6',
  particleCore: '#10b981',
  particleEdge: '#8b5cf6',
  glowRgb: '16, 185, 129',
}

/**
 * 黑金超新星 — gold and amber over deep space.
 *
 * Rose is the third hue on purpose: a supernova reads as gold → amber → red
 * shift, so an all-gold rig would collapse into one flat warm wash. The rose
 * only appears in the third beam and the aurora's lower fringe, which is where
 * the composition already expects a cool/violet-ish counterpoint.
 */
const SUPERNOVA_GOLD: VfxPalette = {
  id: 'supernova-gold',
  primary: '#fbbf24',
  secondary: '#f59e0b',
  accent: '#fb7185',
  particleCore: '#fbbf24',
  particleEdge: '#f59e0b',
  glowRgb: '251, 191, 36',
}

/**
 * 量子幻影紫 — violet into deep purple, with a cold cyan third light.
 *
 * Cyan is the accent rather than another purple: violet and purple sit so close
 * on the hue wheel that a two-hue rig would read as one colour, and the cold
 * cyan is what makes the palette feel "quantum" instead of merely lilac.
 */
const QUANTUM_VIOLET: VfxPalette = {
  id: 'quantum-violet',
  primary: '#a78bfa',
  secondary: '#8b5cf6',
  accent: '#22d3ee',
  particleCore: '#a78bfa',
  particleEdge: '#8b5cf6',
  glowRgb: '167, 139, 250',
}

/** Every preset, keyed by id. This record is the single source of truth. */
export const VFX_PALETTES: Record<VfxPreset, VfxPalette> = {
  'emerald-cyber': EMERALD_CYBER,
  'supernova-gold': SUPERNOVA_GOLD,
  'quantum-violet': QUANTUM_VIOLET,
}

/** Boot default. Matches the persisted store's initial value. */
export const DEFAULT_VFX_PRESET: VfxPreset = 'emerald-cyber'

/**
 * Display / cycle order.
 *
 * Kept as an explicit array rather than `Object.keys(VFX_PALETTES)`: object key
 * order is an implementation detail of the JS engine, and the nav's cycle
 * control needs a stable, deliberate sequence (warm → cool progression).
 */
export const VFX_PRESET_ORDER: readonly VfxPreset[] = [
  'emerald-cyber',
  'supernova-gold',
  'quantum-violet',
]

/**
 * Resolve a preset id to its palette.
 *
 * `preset` is nominally a `VfxPreset`, but the store is persisted to
 * `localStorage`: a stale/hand-edited payload, or a future preset that this
 * build no longer ships, can surface as an arbitrary string at runtime. The
 * `in` check makes that case fall back to the default palette instead of
 * handing `undefined` to a shader uniform and turning the scene black.
 */
export function getVfxPalette(preset: VfxPreset | null | undefined): VfxPalette {
  if (preset && preset in VFX_PALETTES) return VFX_PALETTES[preset]
  return VFX_PALETTES[DEFAULT_VFX_PRESET]
}

/**
 * Next preset in {@link VFX_PRESET_ORDER}, wrapping back to the first.
 *
 * An unknown/undefined `current` lands on the first preset (`indexOf` returns
 * -1, so `(-1 + 1) % length === 0`), which gives the nav button a sane recovery
 * path after corrupt persisted state rather than a no-op.
 */
export function getNextVfxPreset(current: VfxPreset | null | undefined): VfxPreset {
  const index = current ? VFX_PRESET_ORDER.indexOf(current) : -1
  return VFX_PRESET_ORDER[(index + 1) % VFX_PRESET_ORDER.length]
}

/**
 * Dictionary key for a preset's display name.
 *
 * Kept here rather than in the dictionary so the mapping lives next to the preset
 * union it depends on: adding a preset without adding its name is then a compile
 * error at this switch.
 */
export function vfxLabelKey(preset: VfxPreset): 'emerald' | 'supernova' | 'phantom' {
  switch (preset) {
    case 'emerald-cyber':
      return 'emerald'
    case 'supernova-gold':
      return 'supernova'
    case 'quantum-violet':
      return 'phantom'
  }
}


/**
 * Narrow an arbitrary string to a preset id.
 *
 * The store keeps `vfxPreset` as a plain string so it can be persisted and
 * restored without trusting stored data. Consumers that need the compile-time
 * union (the dictionary lookup for a display name, for instance) narrow through
 * this guard instead of casting.
 */
export function isVfxPreset(value: string | null | undefined): value is VfxPreset {
  return value !== null && value !== undefined && (VFX_PRESET_ORDER as readonly string[]).includes(value)
}
