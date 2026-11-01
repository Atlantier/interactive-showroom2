import { motion } from 'framer-motion'
import { useI18n, type Locale } from '@/i18n/useI18n'
import { soundEngine } from '@/utils/soundEngine'
import { cn } from '@/lib/cn'

/**
 * LanguageSwitcher — the bilingual capsule in the top navigation.
 *
 * ── Interaction ─────────────────────────────────────────────────────────────
 * Two segments, EN and 中文. The selected state is a single shared element
 * animated with framer-motion's `layoutId`: both buttons render the same
 * `locale-pill`, so moving between them is a layout animation the library can
 * interpolate instead of a cross-fade between two independent backgrounds. That
 * is what produces the sliding highlight rather than a blink.
 *
 * The easing is a spring, not a duration curve — the showroom's contract forbids
 * linear transitions, and a spring also reads correctly when the pointer arrives
 * mid-flight (the highlight retargets instead of restarting).
 *
 * ── Sound ───────────────────────────────────────────────────────────────────
 * Switching fires `playLocaleConfirm`, a rising two-note figure. An ordered pair
 * is deliberate: a chord says "something happened", a rising interval says
 * "moved from one state to the other", which is what this control does. The
 * engine is a singleton with its own throttle and mute gate, so this call is
 * safe to make unconditionally — with sound off it returns immediately.
 *
 * ── Accessibility ───────────────────────────────────────────────────────────
 * A grouped pair of toggle buttons with `aria-pressed`, not a fake radio list:
 * each is independently operable, and the group carries the localised label. The
 * visible text is the language's own endonym (EN / 中文) in both locales, which
 * is the convention — a user looking for their language should not have to read
 * the current one to find it.
 */

interface LocaleOption {
  value: Locale
  /** Key into `nav`, so the label is localised rather than hard-coded. */
  labelKey: 'languageEnglish' | 'languageChinese'
}

const OPTIONS: readonly LocaleOption[] = [
  { value: 'en', labelKey: 'languageEnglish' },
  { value: 'zh', labelKey: 'languageChinese' },
]

/** Shared layout id — the single element both segments render while selected. */
const PILL_LAYOUT_ID = 'locale-pill'

export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, t, setLocale } = useI18n()

  const select = (next: Locale): void => {
    if (next === locale) return
    setLocale(next)
    soundEngine.playLocaleConfirm()
  }

  return (
    <div
      role="group"
      aria-label={t.nav.languageAria}
      className={cn(
        'relative flex items-center gap-0.5 rounded-full border border-void-600/70',
        'bg-void-900/55 p-[3px] backdrop-blur-md',
        className,
      )}
    >
      {OPTIONS.map((option) => {
        const active = option.value === locale
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => select(option.value)}
            aria-pressed={active}
            className={cn(
              'relative rounded-full px-2.5 py-1 font-mono text-[0.58rem]',
              'tracking-[0.14em] uppercase transition-colors duration-300',
              active ? 'text-void-950' : 'text-ink-500 hover:text-ink-100',
            )}
          >
            {active && (
              <motion.span
                layoutId={PILL_LAYOUT_ID}
                className="absolute inset-0 rounded-full bg-signal-cyan"
                transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.6 }}
                // The highlight is decorative; the button already carries the state.
                aria-hidden
              />
            )}
            <span className="relative z-10">{t.nav[option.labelKey]}</span>
          </button>
        )
      })}
    </div>
  )
}

export default LanguageSwitcher
