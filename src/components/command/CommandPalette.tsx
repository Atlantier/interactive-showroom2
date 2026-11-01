import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, CornerDownLeft, Search } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fuzzyMatch, toRanges } from '@/lib/fuzzyMatch'
import { startScroll, stopScroll } from '@/lib/scrollEngine'
import {
  GROUP_ORDER,
  buildCommands,
  type Command,
  type CommandGroup,
} from '@/config/commands'
import { useAppStore } from '@/store/useAppStore'
import { soundEngine } from '@/utils/soundEngine'

/**
 * CommandPalette — the Cmd/Ctrl+K palette.
 *
 * ── Why it is always mounted ──────────────────────────────────────────────
 * The global shortcut has to work while the palette is closed, so the component
 * stays in the tree and only its contents are behind `AnimatePresence`. Putting
 * the listener in `App` instead would separate "who owns the shortcut" from
 * "who owns the panel" for no benefit.
 *
 * ── Rendering discipline ──────────────────────────────────────────────────
 * Unlike the scroll/telemetry HUDs this is NOT a per-frame surface: it reacts to
 * discrete keystrokes, so ordinary React state is the correct tool. The one hot
 * path — the command list — is memoised on the query and the store slices that
 * can change a row's appearance.
 *
 * ── Accessibility ─────────────────────────────────────────────────────────
 * The input is a `combobox` owning a `listbox`, with `aria-activedescendant`
 * tracking the highlighted row. Rows are real `option`s, so a screen reader
 * announces "跳转到 架构, 3 / 14" rather than a wall of divs. The highlight is
 * driven by the same index the keyboard uses, so pointer and keyboard never
 * disagree about which row is armed.
 */

/**
 * A scored, filtered row.
 *
 * `indices` addresses `cmd.title` and drives the character highlight; a row that
 * only matched through its hidden keywords keeps an empty list, because
 * highlighting characters the matcher never saw would be a lie.
 */
interface ScoredCommand {
  cmd: Command
  score: number
  indices: number[]
}

interface GroupedCommands {
  group: CommandGroup
  items: ScoredCommand[]
}

const PANEL_EASE = [0.22, 1, 0.36, 1] as const

export function CommandPalette() {
  const open = useAppStore((state) => state.commandPaletteOpen)
  const setOpen = useAppStore((state) => state.setCommandPaletteOpen)

  // Only these two slices change a command's `active` tick, so they are the only
  // ones worth subscribing to — subscribing to `activeSection` would re-render
  // the panel on every chapter crossing for a marker nobody reads while closed.
  const accentTheme = useAppStore((state) => state.accentTheme)
  const gravityMode = useAppStore((state) => state.gravityMode)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  /** Command id that just completed, for the transient tick. */
  const [flash, setFlash] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const flashTimer = useRef<number | null>(null)

  /* ── Catalogue, rebuilt when the settings it reflects change ───────────── */
  const commands = useMemo(
    () => buildCommands(),
    // The builder reads live store state; these deps are what make a row's
    // `active` tick and subtitle correct after a theme or gravity switch.
    [accentTheme, gravityMode, open],
  )

  /* ── Filter + score + group ─────────────────────────────────────────────── */
  const grouped = useMemo<GroupedCommands[]>(() => {
    const q = query.trim()
    const scored: ScoredCommand[] = []

    for (const cmd of commands) {
      if (!q) {
        scored.push({ cmd, score: 0, indices: [] })
        continue
      }

      const titleHit = fuzzyMatch(q, cmd.title)
      const keywordHit = fuzzyMatch(q, cmd.keywords)
      if (!titleHit && !keywordHit) continue

      // A title hit always wins when it is at all comparable: the highlight is
      // what tells the user WHY the row matched. Keyword hits are discounted but
      // still eligible, so "violet" can reach 赛博紫.
      if (titleHit && (!keywordHit || titleHit.score >= keywordHit.score - 40)) {
        scored.push({ cmd, score: titleHit.score, indices: titleHit.indices })
      } else {
        scored.push({ cmd, score: (keywordHit?.score ?? 0) - 40, indices: [] })
      }
    }

    // Groups keep a fixed order so the palette does not reshuffle its section
    // headers as you type; ranking happens only WITHIN a group.
    return GROUP_ORDER.map((group) => ({
      group,
      items: scored
        .filter((item) => item.cmd.group === group)
        .sort((a, b) => b.score - a.score),
    })).filter((section) => section.items.length > 0)
  }, [commands, query])

  /** Flattened rows — the single sequence both the keyboard and a11y use. */
  const flat = useMemo(() => grouped.flatMap((section) => section.items), [grouped])

  /* ── Reset on open ──────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    setFlash(null)
    // Focus after the enter animation has started so the browser does not scroll
    // the panel's own scroll container on focus.
    const handle = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(handle)
  }, [open])

  /* ── Lock page scrolling while open ─────────────────────────────────────── */
  useEffect(() => {
    if (!open) return
    stopScroll()
    return () => startScroll()
  }, [open])

  /* ── Global shortcut ────────────────────────────────────────────────────── */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey
      if (isMod && !event.altKey && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault()
        useAppStore.getState().toggleCommandPalette()
        return
      }
      if (event.key === 'Escape' && useAppStore.getState().commandPaletteOpen) {
        event.preventDefault()
        useAppStore.getState().setCommandPaletteOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /* ── Keep the armed row valid and visible ───────────────────────────────── */
  useEffect(() => {
    setActiveIndex((index) => (flat.length === 0 ? 0 : Math.min(index, flat.length - 1)))
  }, [flat.length])

  useEffect(() => {
    if (!open) return
    const id = flat[activeIndex]?.cmd.id
    if (!id) return
    rowRefs.current.get(id)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, flat, open])

  /* ── Execution ──────────────────────────────────────────────────────────── */
  const execute = useCallback(async (entry: ScoredCommand | undefined) => {
    if (!entry) return
    const { cmd } = entry

    // Commands that report back (`false` = the copy failed) keep the palette
    // open so the user sees the outcome instead of guessing.
    const result = await cmd.run()
    if (result === false) return

    if (cmd.group === '操作') {
      setFlash(cmd.id)
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setFlash(null), 1600)
      soundEngine.playCardActivate()
      return
    }

    soundEngine.playCardActivate()
    // Navigation and setting changes close the panel; `run` itself may already
    // have closed it (the section jump does).
    useAppStore.getState().setCommandPaletteOpen(false)
  }, [])

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    },
    [],
  )

  const onInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // While the IME is composing (Chinese/Japanese input), Enter confirms the
      // candidate and arrows move through it. Intercepting those would make the
      // palette unusable for exactly the users it is written for.
      if (event.nativeEvent.isComposing) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (flat.length === 0) return
        setActiveIndex((index) => (index + 1) % flat.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (flat.length === 0) return
        setActiveIndex((index) => (index - 1 + flat.length) % flat.length)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        void execute(flat[activeIndex])
      } else if (event.key === 'Home') {
        event.preventDefault()
        setActiveIndex(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        setActiveIndex(Math.max(0, flat.length - 1))
      }
    },
    [execute, flat, activeIndex],
  )

  const activeId = flat[activeIndex]?.cmd.id

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[120] flex items-start justify-center px-4 pt-[10vh] sm:pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: PANEL_EASE }}
        >
          {/* Backdrop. Clicking it dismisses, which is the expected exit. */}
          <div
            aria-hidden
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-void-950/72 backdrop-blur-[3px]"
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="命令面板"
            initial={{ opacity: 0, scale: 0.97, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -6 }}
            transition={{ duration: 0.2, ease: PANEL_EASE }}
            className={cn(
              'relative w-full max-w-[34rem] overflow-hidden rounded-panel',
              'border border-signal-cyan/25 bg-void-900/95 backdrop-blur-2xl',
              'shadow-[0_40px_120px_-32px_rgba(0,0,0,0.98),0_0_0_1px_rgba(255,255,255,0.03)_inset]',
            )}
          >
            {/* Top accent hairline: the one place the theme is unmistakable. */}
            <div
              aria-hidden
              className="h-px w-full bg-gradient-to-r from-transparent via-signal-cyan to-transparent opacity-80"
            />

            {/* ── Search row ─────────────────────────────────────────────── */}
            <div className="flex items-center gap-2.5 border-b border-void-600/60 px-4">
              <Search className="size-4 shrink-0 text-ink-700" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                }}
                onKeyDown={onInputKeyDown}
                placeholder="搜索章节、重力、主题或操作…"
                aria-label="搜索命令"
                role="combobox"
                aria-expanded
                aria-controls="command-palette-list"
                aria-autocomplete="list"
                aria-activedescendant={activeId ? `command-row-${activeId}` : undefined}
                spellCheck={false}
                autoComplete="off"
                className="w-full bg-transparent py-4 text-sm text-ink-100 placeholder:text-ink-700 focus:outline-none"
              />
              <kbd className="hidden shrink-0 rounded border border-void-600 px-1.5 py-0.5 font-mono text-[0.58rem] text-ink-700 sm:block">
                esc
              </kbd>
            </div>

            {/* ── Results ────────────────────────────────────────────────── */}
            <div
              id="command-palette-list"
              role="listbox"
              aria-label="可用命令"
              className="scrollbar-none max-h-[min(24rem,52vh)] overflow-y-auto overscroll-contain p-1.5"
            >
              {flat.length === 0 ? (
                <div className="px-3 py-10 text-center">
                  <p className="text-sm text-ink-300">没有匹配的命令</p>
                  <p className="mt-1 font-mono text-[0.62rem] text-ink-700">
                    试试「架构」「重力」「主题」「简历」
                  </p>
                </div>
              ) : (
                grouped.map((section) => (
                  <div key={section.group} className="mb-1 last:mb-0">
                    <div className="px-2.5 pt-2 pb-1 font-mono text-[0.55rem] tracking-[0.18em] text-ink-700 uppercase">
                      {section.group}
                    </div>
                    {section.items.map((item) => {
                      const isActive = item.cmd.id === activeId
                      const Icon = item.cmd.icon
                      return (
                        <div
                          key={item.cmd.id}
                          id={`command-row-${item.cmd.id}`}
                          ref={(element) => {
                            if (element) rowRefs.current.set(item.cmd.id, element)
                            else rowRefs.current.delete(item.cmd.id)
                          }}
                          role="option"
                          aria-selected={isActive}
                          onPointerEnter={() => {
                            const index = flat.findIndex(
                              (entry) => entry.cmd.id === item.cmd.id,
                            )
                            if (index >= 0) setActiveIndex(index)
                          }}
                          onClick={() => void execute(item)}
                          className={cn(
                            'group flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2.5',
                            'transition-colors duration-100',
                            isActive ? 'bg-signal-cyan/12' : 'hover:bg-void-800/60',
                          )}
                        >
                          {/* Icon or theme swatch */}
                          <span
                            className={cn(
                              'grid size-7 shrink-0 place-items-center rounded-md border',
                              isActive
                                ? 'border-signal-cyan/40 text-signal-cyan'
                                : 'border-void-600/70 text-ink-500',
                            )}
                          >
                            {item.cmd.swatch ? (
                              <span
                                aria-hidden
                                className="size-2.5 rounded-full"
                                style={{
                                  backgroundColor: item.cmd.swatch,
                                  boxShadow: `0 0 8px ${item.cmd.swatch}`,
                                }}
                              />
                            ) : (
                              <Icon className="size-3.5" aria-hidden />
                            )}
                          </span>

                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                'block truncate text-[0.82rem]',
                                isActive ? 'text-ink-100' : 'text-ink-300',
                              )}
                            >
                              <Highlight text={item.cmd.title} indices={item.indices} />
                            </span>
                            {item.cmd.subtitle && (
                              <span className="mt-0.5 block truncate font-mono text-[0.58rem] text-ink-700">
                                {item.cmd.subtitle}
                              </span>
                            )}
                          </span>

                          {/* Right-hand status: flash tick, active tick, or hint */}
                          {flash === item.cmd.id ? (
                            <span className="flex shrink-0 items-center gap-1 font-mono text-[0.55rem] text-signal-teal">
                              <Check className="size-3" aria-hidden />
                              完成
                            </span>
                          ) : item.cmd.active ? (
                            <Check
                              className="size-3.5 shrink-0 text-signal-cyan"
                              aria-label="当前设置"
                            />
                          ) : item.cmd.hint ? (
                            <span className="shrink-0 font-mono text-[0.58rem] text-ink-700">
                              {item.cmd.hint}
                            </span>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ))
              )}
            </div>

            {/* ── Footer ─────────────────────────────────────────────────── */}
            <div className="flex items-center justify-between border-t border-void-600/60 px-3 py-2 font-mono text-[0.55rem] text-ink-700">
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                  导航
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>
                    <CornerDownLeft className="size-2.5" aria-hidden />
                  </Kbd>
                  执行
                </span>
              </span>
              <span className="tabular-nums">
                {flat.length} 项 · {commands.length} 条命令
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** One keycap. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="grid min-w-[1.1rem] place-items-center rounded border border-void-600 bg-void-800/80 px-1 py-0.5 text-[0.55rem] text-ink-500">
      {children}
    </kbd>
  )
}

/**
 * Render `text` with the matched character runs emphasised.
 *
 * Ranges are merged first (`toRanges`), so a contiguous match becomes one
 * `<mark>` rather than one element per character.
 */
function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>

  const ranges = toRanges(indices)
  const parts: ReactNode[] = []
  let cursor = 0

  ranges.forEach(([start, end], i) => {
    if (start > cursor) parts.push(<span key={`t${i}`}>{text.slice(cursor, start)}</span>)
    parts.push(
      <mark key={`m${i}`} className="bg-transparent font-medium text-signal-cyan">
        {text.slice(start, end)}
      </mark>,
    )
    cursor = end
  })

  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>)

  return <>{parts}</>
}

export default CommandPalette
