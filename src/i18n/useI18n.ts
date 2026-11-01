import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { en, type Dictionary } from './locales/en'
import { zh } from './locales/zh'

/**
 * Locale plumbing.
 *
 * ── Why English is the default, structurally ────────────────────────────────
 * The initial state is `'en'` and the persisted slice only ever overwrites it
 * with a locale the visitor actually chose. A first visit therefore renders in
 * English without a flash of the other language, and a returning visitor gets
 * their own choice back.
 *
 * ── Why the dictionary lives outside React ──────────────────────────────────
 * `t` is a plain object lookup, not a hook of its own: switching language swaps
 * one reference, every consumer re-renders through its single `locale`
 * subscription, and no component needs to thread a context provider.
 */

export type Locale = 'en' | 'zh'

/** The localStorage key the choice is remembered under. Versioned on purpose. */
export const LOCALE_STORAGE_KEY = 'showroom_locale_v1'

const DICTIONARIES: Record<Locale, Dictionary> = { en, zh }

/** `document.documentElement.lang` per locale. Not the same as the key. */
const HTML_LANG: Record<Locale, string> = { en: 'en', zh: 'zh-CN' }

/**
 * Mirror the locale onto the document.
 *
 * Both writes matter beyond cosmetics: `lang` drives hyphenation, screen-reader
 * pronunciation and the CJK font fallback chain, and `title` is what the tab and
 * the browser history entry show.
 */
function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = HTML_LANG[locale]
  document.title = DICTIONARIES[locale].meta.title

  const description = document.querySelector('meta[name="description"]')
  if (description) {
    description.setAttribute('content', DICTIONARIES[locale].meta.description)
  }
}

interface I18nState {
  locale: Locale
  setLocale: (locale: Locale) => void
  toggleLocale: () => void
}

export const useI18nStore = create<I18nState>()(
  persist(
    (set, get) => ({
      locale: 'en',
      setLocale: (locale) => set({ locale }),
      toggleLocale: () => set({ locale: get().locale === 'en' ? 'zh' : 'en' }),
    }),
    {
      name: LOCALE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Only the choice is persisted; the dictionary itself never is.
      partialize: (state) => ({ locale: state.locale }),
    },
  ),
)

/*
 * Apply the restored locale once, at module evaluation.
 *
 * `createJSONStorage` reads localStorage synchronously, so by this point the store
 * already holds either the stored choice or the English default.
 */
applyDocumentLocale(useI18nStore.getState().locale)

// Keep the document in sync for imperative callers too (menu items, shortcuts).
useI18nStore.subscribe((state, previous) => {
  if (state.locale !== previous.locale) applyDocumentLocale(state.locale)
})

export interface I18n {
  /** Active locale. */
  locale: Locale
  /** The active dictionary, fully typed by the English source of truth. */
  t: Dictionary
  setLocale: (locale: Locale) => void
  toggleLocale: () => void
}

/**
 * The only hook components need.
 *
 * Subscribes to `locale` alone, so a component re-renders when the language
 * changes and never when anything else in the store moves.
 */
export function useI18n(): I18n {
  const locale = useI18nStore((state) => state.locale)
  const setLocale = useI18nStore((state) => state.setLocale)
  const toggleLocale = useI18nStore((state) => state.toggleLocale)

  return { locale, t: DICTIONARIES[locale], setLocale, toggleLocale }
}

/** Read the dictionary without subscribing — for event handlers and rAF-free code. */
export function getDictionary(): Dictionary {
  return DICTIONARIES[useI18nStore.getState().locale]
}
