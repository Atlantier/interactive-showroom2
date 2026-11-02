import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { getDictionary, useI18n } from '@/i18n/useI18n'
import {
  HELP_ART,
  buildHelpRows,
  MATRIX_HEADER,
  SKILLS_ART,
  SKILL_ROWS,
  UNKNOWN_ART,
  makeMatrixFrame,
  parseCommand,
  type TerminalLine,
  type TerminalTone,
} from '@/components/bento/micro/terminalCommands'

/**
 * TerminalTyper — an interactive terminal that visitors can actually type into.
 *
 * ── Interaction model ──────────────────────────────────────────────────────
 * The card runs a scripted demo loop until the visitor focuses it. On focus the
 * demo stops (so it cannot fight the user's cursor), a real `<input>` captures
 * keystrokes, and four commands become available: `help`, `skills`, `matrix`,
 * `clear`. Blurring returns to the demo after a short delay.
 *
 * Keeping the demo loop AND real input in one component is deliberate: a static
 * demo is forgettable, and an empty prompt is intimidating. The transition is
 * what makes the card feel alive on hover and responsive on click.
 *
 * ── Why an invisible input instead of a contenteditable ────────────────────
 * A real `<input>` gives correct caret positioning, mobile keyboards, IME
 * composition, clipboard paste and native accessibility for free. A
 * contenteditable would require re-implementing all of that. The input is
 * visually hidden but focusable, and the visible caret is drawn from its value.
 *
 * ── Why the demo types via refs ────────────────────────────────────────────
 * The typewriter appends characters straight to a DOM node's `textContent`.
 * Driving it with state would re-render on every character — hundreds of renders
 * per session for text the user is not interacting with yet.
 */

/** Milliseconds per typed character in the demo loop. */
const CHAR_DELAY = 26

/** Pause after a demo line finishes. */
const LINE_PAUSE = 520

/** Max lines kept in the scrollback. */
const MAX_LINES = 40

/** How long to wait after blur before resuming the demo. */
const DEMO_RESUME_DELAY = 2600

const TONE_CLASS: Record<TerminalTone, string> = {
  command: 'text-ink-100',
  success: 'text-signal-teal',
  dim: 'text-ink-500',
  accent: 'text-signal-cyan',
  error: 'text-signal-rose',
}

/** The scripted demo session shown until the visitor takes over. */
/**
 * The scripted demo session.
 *
 * Built per locale rather than frozen at module load: two of its five lines are
 * copy, and a module-level constant would keep whichever language was active when
 * the bundle evaluated.
 */
function buildDemoScript(): Array<{ text: string; prompt?: string; tone?: TerminalTone }> {
  const { bento } = getDictionary()
  return [
    { text: 'showroom deploy --env edge', prompt: '$ ', tone: 'command' },
    { text: 'resolve manifest ........ ok', prompt: '  ', tone: 'dim' },
    { text: 'upload 412 assets ...... 100%', prompt: '  ', tone: 'dim' },
    { text: bento.terminalOnline, prompt: '✓ ', tone: 'success' },
    { text: bento.terminalHint, prompt: '› ', tone: 'accent' },
  ]
}

interface TerminalTyperProps {
  className?: string
}

/** A committed output line. */
interface Line {
  id: number
  text: string
  tone: TerminalTone
  prompt?: string
}

export function TerminalTyper({ className }: TerminalTyperProps) {
  const { t, locale } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLSpanElement>(null)
  const promptRef = useRef<HTMLSpanElement>(null)

  /** Whether the visitor has taken control. */
  const [interactive, setInteractive] = useState(false)
  /** Current input value. */
  const [value, setValue] = useState('')
  /** Scrollback. */
  const [lines, setLines] = useState<Line[]>([])
  /** Monotonic id so React keys stay stable while lines are appended. */
  const nextId = useRef(0)

  const pushLines = useCallback((incoming: Array<Omit<Line, 'id'>>) => {
    setLines((prev) => {
      const added = incoming.map((l) => ({ ...l, id: nextId.current++ }))
      const next = [...prev, ...added]
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    })
  }, [])

  /* ── Demo loop (only while the visitor has not taken over) ─────────────── */
  useEffect(() => {
    if (interactive) return

    const script = buildDemoScript()
    let cancelled = false
    let charTimer: ReturnType<typeof setTimeout> | undefined
    let lineTimer: ReturnType<typeof setTimeout> | undefined

    const runLine = (index: number): void => {
      if (cancelled) return
      const line = script[index]
      if (!line) {
        // Loop the demo forever; it is ambient, not a one-shot.
        lineTimer = setTimeout(() => {
          if (cancelled) return
          setLines([])
          runLine(0)
        }, 1800)
        return
      }

      const live = liveRef.current
      const prompt = promptRef.current
      if (!live || !prompt) return

      prompt.textContent = line.prompt ?? ''
      live.textContent = ''

      let cursor = 0
      const typeNext = (): void => {
        if (cancelled) return
        cursor += 1
        const node = liveRef.current
        if (node) node.textContent = line.text.slice(0, cursor)

        if (cursor < line.text.length) {
          charTimer = setTimeout(typeNext, CHAR_DELAY)
        } else {
          lineTimer = setTimeout(() => {
            if (cancelled) return
            pushLines([{ text: line.text, tone: line.tone ?? 'dim', prompt: line.prompt }])
            const node = liveRef.current
            if (node) node.textContent = ''
            const promptNode = promptRef.current
            if (promptNode) promptNode.textContent = ''
            runLine(index + 1)
          }, LINE_PAUSE)
        }
      }
      charTimer = setTimeout(typeNext, 140)
    }

    runLine(0)

    return () => {
      cancelled = true
      if (charTimer) clearTimeout(charTimer)
      if (lineTimer) clearTimeout(lineTimer)
    }
  }, [interactive, pushLines, locale])

  /* ── Focus handling ────────────────────────────────────────────────────── */
  const takeOver = useCallback(() => {
    setInteractive(true)
    // Seed the scrollback with a greeting the first time only.
    setLines((prev) =>
      prev.length > 0
        ? prev
        : [
            { id: nextId.current++, text: 'showroom shell · v0.1', tone: 'accent' as const },
            {
              id: nextId.current++,
              text: t.bento.terminalInputHint,
              tone: 'dim' as const,
            },
          ],
    )
    // Focus on the next frame so the click that started this is not stolen.
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const release = useCallback(() => {
    // Keep the session visible; just stop the demo from taking back over.
    // Resuming is handled on blur with a delay so a stray click does not reset.
  }, [])

  useEffect(() => {
    if (!interactive) return
    // When focus leaves the terminal entirely, hand control back to the demo
    // after a pause — but only if the user has not typed anything since.
    let timer: ReturnType<typeof setTimeout> | undefined
    const onBlur = () => {
      timer = setTimeout(() => {
        setInteractive(false)
        setLines([])
      }, DEMO_RESUME_DELAY)
    }
    const onFocus = () => {
      if (timer) clearTimeout(timer)
    }
    const input = inputRef.current
    input?.addEventListener('blur', onBlur)
    input?.addEventListener('focus', onFocus)
    return () => {
      if (timer) clearTimeout(timer)
      input?.removeEventListener('blur', onBlur)
      input?.removeEventListener('focus', onFocus)
    }
  }, [interactive])

  /* ── Auto-scroll to the newest line ────────────────────────────────────── */
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  /* ── Command execution ─────────────────────────────────────────────────── */
  const runCommand = useCallback(
    (raw: string) => {
      const cmd = parseCommand(raw)
      const echo: Omit<Line, 'id'> = { text: raw, tone: 'command', prompt: '$ ' }

      if (cmd === 'clear') {
        // `clear` wipes the scrollback and shows nothing else — matching a real
        // shell, where the command itself leaves no trace.
        setLines([])
        return
      }

      if (cmd === 'help') {
        pushLines([
          echo,
          ...HELP_ART.map((t) => ({ text: t, tone: 'accent' as const })),
          ...buildHelpRows().map((l: TerminalLine) => ({ text: l.text, tone: l.tone ?? 'dim' })),
        ])
        return
      }

      if (cmd === 'skills') {
        pushLines([
          echo,
          ...SKILLS_ART.map((t) => ({ text: t, tone: 'success' as const })),
          { text: '', tone: 'dim' as const },
          ...SKILL_ROWS.map((l) => ({ text: l.text, tone: l.tone ?? 'success' })),
        ])
        return
      }

      if (cmd === 'matrix') {
        // A fresh frame each invocation, seeded from the clock so it varies.
        const frame = makeMatrixFrame(6, 46, Date.now())
        pushLines([
          echo,
          ...MATRIX_HEADER.map((t) => ({ text: t, tone: 'success' as const })),
          ...frame.map((t) => ({ text: t, tone: 'success' as const })),
        ])
        return
      }

      // Unknown: show the not-found art plus a hint.
      pushLines([
        echo,
        ...UNKNOWN_ART.map((t) => ({ text: t, tone: 'error' as const })),
        { text: t.bento.terminalUnknownHint, tone: 'dim' as const },
      ])
    },
    [pushLines],
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        const raw = value.trim()
        if (raw) runCommand(raw)
        setValue('')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setValue('')
        inputRef.current?.blur()
      }
    },
    [runCommand, value],
  )

  return (
    /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions --
       The interactive element is the real <input> inside this card: keyboard users tab
       straight into it (the browser gate asserts it is focusable and that focus lands on
       it). This click handler is a mouse convenience that forwards a click anywhere in the
       terminal to that input, so giving the wrapper a second keyboard path would create
       two ways to do one thing. */
    <div
      // Test hook: the focus ring lives on this element, not on the input inside it,
      // so an assertion has to be able to find it without guessing at class names.
      data-terminal="root"
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-md border border-void-600/60 bg-void-950/70',
        /*
         * The blur/focus ring goes here, not on the input.
         *
         * The real `<input>` is 1px and `opacity-0` — it exists for the caret, IME and
         * mobile keyboards, and `opacity: 0` would hide its own outline along with it,
         * so tabbing into the terminal used to leave a keyboard user with no visible
         * focus at all (WCAG 2.4.7). The ring belongs on the thing the user thinks they
         * are typing into. Inset offset because `overflow-hidden` is on this element.
         */
        'focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-signal-cyan',
        className,
      )}
      // Clicking anywhere in the terminal focuses the input; this is what makes
      // the whole card feel like a shell rather than a screenshot.
      onClick={() => {
        if (!interactive) takeOver()
        else inputRef.current?.focus()
      }}
      onMouseEnter={release}
    >
      {/* Title bar */}
      <div className="flex items-center gap-1.5 border-b border-void-600/60 px-2.5 py-1.5">
        <span className="size-1.5 rounded-full bg-signal-rose/70" aria-hidden />
        <span className="size-1.5 rounded-full bg-signal-amber/70" aria-hidden />
        <span className="size-1.5 rounded-full bg-signal-teal/70" aria-hidden />
        <span className="ml-1.5 font-mono text-[0.55rem] tracking-widest text-ink-700 uppercase">
          showroom — zsh
        </span>
        <span className="ml-auto font-mono text-[0.5rem] text-ink-700">
          {interactive ? 'interactive' : 'demo'}
        </span>
      </div>

      {/* Screen.
          `overflow-y-auto` + `overflow-x-auto` because the scrollback genuinely
          exceeds the card after a couple of commands — a real terminal scrolls
          rather than truncating. The scrollbar is hidden visually (the card is
          decorative) but scrolling still works via wheel/touch/keyboard. */}
      <div
        ref={scrollRef}
        className={cn(
          'flex-1 overflow-y-auto overflow-x-auto px-2.5 py-2',
          // 0.55rem keeps ~38 monospace columns inside the 367px card, which is
          // what the ASCII art is sized against.
          'font-mono text-[0.55rem] leading-[1.35]',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        )}
      >
        {lines.map((line) => (
          <div key={line.id} className="whitespace-pre">
            {line.prompt && <span className="text-signal-cyan/70">{line.prompt}</span>}
            <span className={TONE_CLASS[line.tone]}>{line.text}</span>
          </div>
        ))}

        {/* Live line: either the demo typing (via ref) or the real input echo. */}
        {interactive ? (
          <div className="whitespace-pre">
            <span className="text-signal-cyan/70">$ </span>
            <span className="text-ink-100">{value}</span>
            <span
              className="ml-px inline-block h-2.5 w-1 animate-pulse bg-signal-cyan align-middle"
              aria-hidden
            />
          </div>
        ) : (
          <div className="whitespace-pre">
            <span ref={promptRef} className="text-signal-cyan/70" />
            <span ref={liveRef} className="text-ink-100" />
            <span
              className="ml-px inline-block h-2.5 w-1 animate-pulse bg-signal-cyan align-middle"
              aria-hidden
            />
          </div>
        )}

        {/* A real, focusable input. Transparent and 1px so it never shows, but it
            provides the caret, mobile keyboard, IME and paste behaviour natively. */}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={t.bento.terminalAria}
          className="pointer-events-auto absolute h-px w-px opacity-0"
          tabIndex={0}
        />
      </div>
    </div>
  )
}

export default TerminalTyper
