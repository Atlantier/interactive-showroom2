/**
 * ASCII art and command payloads for the interactive terminal card.
 *
 * Kept separate from the component so the art can be edited without touching
 * rendering logic, and so the data is plain strings with no JSX escaping traps
 * (backslashes, braces and backticks inside glyphs would otherwise need hand
 * escaping in a template literal).
 *
 * ── Why these glyphs ──────────────────────────────────────────────────────
 * All art uses Unicode box-drawing and block characters (█ ╔ ═ ║) plus a few
 * geometric shapes. They are present in the default monospace stack on Windows,
 * macOS and Linux; a pure-ASCII substitute would look cheap, and exotic symbols
 * (Braille, runic) render as tofu on a meaningful share of machines.
 */

import { getDictionary } from '@/i18n/useI18n'

export type TerminalTone = 'command' | 'success' | 'dim' | 'accent' | 'error'

/** One rendered line of terminal output. */
export interface TerminalLine {
  text: string
  tone?: TerminalTone
  /** Optional per-line indent used to align block art. */
  indent?: boolean
}

/* -------------------------------------------------------------------------- */
/*  help                                                                      */
/* -------------------------------------------------------------------------- */

/** Width budget: 34 columns of box-drawing inside the card (see SKILLS_ART). */
const BOX_TOP = ' ╔══════════════════════════════════╗'
const BOX_BOT = ' ╚══════════════════════════════════╝'

export const HELP_ART: string[] = [BOX_TOP, ' ║ A V A I L A B L E  C O M M A N D S ║', BOX_BOT]

/**
 * Help rows, resolved at call time.
 *
 * A function rather than a const: the descriptions are copy and have to follow the
 * active locale, and a module-level array would freeze whichever language was
 * active when the bundle first evaluated.
 */
export function buildHelpRows(): TerminalLine[] {
  const { terminalHelp } = getDictionary().bento
  return [
    { text: terminalHelp.help, tone: 'dim' },
    { text: terminalHelp.skills, tone: 'dim' },
    { text: terminalHelp.matrix, tone: 'dim' },
    { text: terminalHelp.clear, tone: 'dim' },
  ]
}

/* -------------------------------------------------------------------------- */
/*  skills                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Skills block art: a compact wordmark plus a proficiency table.
 *
 * ── Width budget (measured, not guessed) ──────────────────────────────────
 * The terminal card is ~367px wide with ~305px of usable text area at 0.55rem.
 * Crucially, the box-drawing and block glyphs below are NOT half-width in the
 * fallback mono stack: a 44-character line measures 341–377px, overflowing the
 * card. Measured capacity is therefore ~36 of these glyphs per line, and the
 * art is sized against that. My first version used 46 characters and the right
 * edge was clipped, which showed up as the `96` proficiency score rendering
 * as `9`.
 *
 * Keeping art within 36 columns means the terminal never needs horizontal
 * scrolling for output the component itself generates.
 */
export const SKILLS_ART: string[] = [
  ' ███████╗██╗ ██╗██╗██╗    ██╗███████╗',
  ' ██╔════╝██║ ██║██║██║    ██║██╔════╝',
  ' ███████╗█████║██║██║    ██║███████╗',
  ' ╚════██║██╔██║██║██║    ██║╚════██║',
  ' ███████║██║██║██║███████╗███████║',
  ' ╚══════╝╚═╝╚═╝╚═╝╚══════╝╚══════╝',
]

/**
 * Proficiency rows sized to the same 36-column budget.
 * The bar is 8 cells so label + bar + score all fit.
 */
export const SKILL_ROWS: TerminalLine[] = [
  { text: 'react/next   ████████ 96', tone: 'success' },
  { text: 'three/webgl  ███████░ 91', tone: 'success' },
  { text: 'typescript   ████████ 94', tone: 'success' },
  { text: 'glsl         ██████░░ 76', tone: 'accent' },
  { text: 'interaction  ███████░ 82', tone: 'accent' },
]

/* -------------------------------------------------------------------------- */
/*  matrix                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The "matrix" easter egg.
 *
 * A falling-rain frame is generated rather than hardcoded so each invocation
 * looks different — a static block would be spotted as a canned image instantly.
 * The generator is seeded so a single call is reproducible for tests.
 */
export const MATRIX_HEADER: string[] = [BOX_TOP, ' ║ W A K E   U P ,   N E O . . .     ║', BOX_BOT]

/** Glyph pool for the rain. Katakana + digits, as in the film. */
const MATRIX_GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'

/**
 * Build one frame of falling glyphs.
 *
 * @param rows   Number of text rows to produce.
 * @param cols   Characters per row.
 * @param seed   Deterministic seed; pass `Date.now()` for variety.
 */
export function makeMatrixFrame(rows: number, cols: number, seed: number): string[] {
  let state = seed | 0
  const rand = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }

  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      // Sparse: most cells are blank so the rain reads as columns, not noise.
      line += rand() > 0.72 ? MATRIX_GLYPHS[Math.floor(rand() * MATRIX_GLYPHS.length)] : ' '
    }
    out.push(line)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  unknown command                                                           */
/* -------------------------------------------------------------------------- */

export const UNKNOWN_ART: string[] = [BOX_TOP, ' ║ C O M M A N D  N O T  F O U N D   ║', BOX_BOT]

/* -------------------------------------------------------------------------- */
/*  Registry                                                                  */
/* -------------------------------------------------------------------------- */

export type TerminalCommandId = 'help' | 'skills' | 'matrix' | 'clear'

export const KNOWN_COMMANDS: readonly TerminalCommandId[] = ['help', 'skills', 'matrix', 'clear']

/** Normalise user input into a known command id, or `null`. */
export function parseCommand(input: string): TerminalCommandId | null {
  const trimmed = input.trim().toLowerCase()
  return (KNOWN_COMMANDS as readonly string[]).includes(trimmed)
    ? (trimmed as TerminalCommandId)
    : null
}
