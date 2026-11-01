import {
  ArrowRight,
  Copy,
  Download,
  Globe,
  Moon,
  Orbit,
  Palette,
  Sparkles,
  Weight,
  type LucideIcon,
} from 'lucide-react'
import { SHOWROOM_SECTIONS } from '@/config/sections'
import { getDictionary } from '@/i18n/useI18n'
import { startScroll, scrollToTarget } from '@/lib/scrollEngine'
import { VFX_PRESET_ORDER, getVfxPalette } from '@/lib/vfxPalette'
import {
  ACCENT_SWATCH,
  GRAVITY_LABELS,
  useAppStore,
  type AccentTheme,
  type GravityMode,
} from '@/store/useAppStore'

/**
 * The command catalogue for the Cmd/Ctrl+K palette.
 *
 * ── Why this is a builder and not a constant ──────────────────────────────
 * Every entry closes over store actions, and the theme/gravity rows need to know
 * which option is currently active so the palette can tick it. A module-level
 * constant would capture the store at import time and stay stale forever; a
 * builder reads `getState()` at call time, and the palette re-runs it whenever
 * the relevant slices change.
 *
 * ── Keywords ──────────────────────────────────────────────────────────────
 * Each command carries an English/pinyin alias list. A Chinese-only palette is
 * frustrating for anyone who thinks in English (`theme`, `gravity`, `resume`),
 * and the fuzzy matcher scores aliases separately from the visible title, so
 * searching "violet" finds 赛博紫 without showing a confusing match highlight.
 */

export type CommandGroup = '跳转章节' | '物理沙盒' | '主题强调色' | '视觉调色' | '操作'

/** Order the groups appear in the list, regardless of query score. */
export const GROUP_ORDER: CommandGroup[] = [
  '跳转章节',
  '物理沙盒',
  '主题强调色',
  '视觉调色',
  '操作',
]

export interface Command {
  id: string
  /** Primary, human-facing text — this is what gets fuzzy-highlighted. */
  title: string
  /** Secondary line: tech stack, email address, current state, etc. */
  subtitle?: string
  group: CommandGroup
  /** Extra searchable text that is never displayed. */
  keywords: string
  icon: LucideIcon
  /** Swatch colour, rendered as a dot for theme commands. */
  swatch?: string
  /** Right-aligned hint, e.g. the section index. */
  hint?: string
  /** True when this row represents the current setting. */
  active?: boolean
  /**
   * Performs the action.
   *
   * Returning `false` (or resolving to it) tells the palette the action did not
   * take effect — a clipboard write blocked by permissions, for instance — so it
   * can withhold the "完成" tick instead of claiming a success that never happened.
   */
  run: () => void | boolean | Promise<void | boolean>
}

/** Contact address, shared by the palette and the contact section. */
export const CONTACT_EMAIL = 'hello@showroom.dev'

/** Scroll to a chapter and dismiss the palette. */
function jumpToSection(id: string): void {
  useAppStore.getState().setCommandPaletteOpen(false)
  // The palette locks scrolling while open, and Lenis' `scrollTo` is a no-op
  // while stopped. Resuming is the palette's own cleanup job, but relying on
  // that ordering makes this function fragile — resuming here first is
  // idempotent and removes the dependency.
  requestAnimationFrame(() => {
    startScroll()
    scrollToTarget(`#${id}`, -16)
  })
}

/**
 * Copy text, with a fallback for insecure origins.
 *
 * `navigator.clipboard` is unavailable on http:// (except localhost) and in some
 * embedded webviews, where it exists but rejects. A deprecated
 * `document.execCommand('copy')` still works there, and a command palette that
 * silently does nothing is worse than one that uses a deprecated API.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/**
 * Serialize a resume to JSON and hand it to the browser as a download.
 *
 * Built as a Blob rather than a data: URI because data URIs are capped in some
 * browsers and break entirely when the payload contains non-ASCII text that has
 * to be percent-encoded.
 */
function downloadResumeJson(): void {
  const payload = {
    $schema: 'https://showroom.dev/schema/resume-v1.json',
    generatedAt: new Date().toISOString(),
    profile: {
      title: '个人数字展厅',
      role: '全栈 AI · 实时图形工程',
      email: CONTACT_EMAIL,
      summary:
        '一个由 WebGL、惯性滚动与实时状态编排构成的沉浸式空间。滚动即是镜头运动。',
    },
    sections: SHOWROOM_SECTIONS.map((section) => ({
      index: section.index,
      id: section.id,
      title: getDictionary().sections[section.id].title,
    })),
    skills: [
      { group: '实时图形', items: ['WebGL', 'Three.js', 'R3F', 'GLSL', '后处理管线'] },
      { group: '物理仿真', items: ['Verlet', 'FABRIK IK', '约束求解', '程序化步态'] },
      { group: '前端架构', items: ['React 19', 'TypeScript', 'Zustand', '单主时钟'] },
      { group: '交互', items: ['惯性滚动', '命令面板', '无障碍', '移动端适配'] },
    ],
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'showroom-resume.json'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoking synchronously can cancel the download in some browsers; one tick
  // is enough for the navigation to have been queued.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Build the full command list for the current store state. */
export function buildCommands(): Command[] {
  const state = useAppStore.getState()

  const sectionCommands: Command[] = SHOWROOM_SECTIONS.map((section) => ({
    id: `goto-${section.id}`,
    title: `${getDictionary().commands.jumpTo} ${getDictionary().sections[section.id].title}`,
    subtitle: section.id,
    group: '跳转章节',
    keywords: `${section.id} section chapter goto jump navigate ${getDictionary().sections[section.id].title}`,
    icon: ArrowRight,
    hint: section.index,
    active: state.activeSection === section.id,
    run: () => jumpToSection(section.id),
  }))

  const gravityOptions: Array<{
    mode: GravityMode
    icon: LucideIcon
    keywords: string
  }> = [
    { mode: 'zero', icon: Orbit, keywords: 'zero gravity float 零重力 失重' },
    { mode: 'moon', icon: Moon, keywords: 'moon lunar 月球重力 低重力' },
    { mode: 'heavy', icon: Weight, keywords: 'heavy overdrive 超重 高重力' },
    { mode: 'earth', icon: Globe, keywords: 'earth normal 地球重力 标准' },
  ]

  const gravityCommands: Command[] = gravityOptions.map(({ mode, icon, keywords }) => ({
    id: `gravity-${mode}`,
    title: GRAVITY_LABELS[mode],
    subtitle:
      mode === 'earth'
        ? '1.0 g · 恢复默认'
        : mode === 'zero'
          ? '0 g · 绳索自由漂浮'
          : mode === 'moon'
            ? '0.17 g · 月球表面'
            : '2.6 g · 绳索绷紧',
    group: '物理沙盒',
    keywords: `gravity physics sandbox ${keywords}`,
    icon,
    active: state.gravityMode === mode,
    run: () => useAppStore.getState().setGravityMode(mode),
  }))

  const accentOptions: Array<{
    theme: AccentTheme
    title: string
    subtitle: string
    keywords: string
  }> = [
    {
      theme: 'emerald',
      title: '翡翠绿',
      subtitle: 'Emerald · 默认强调色',
      keywords: 'emerald green 翡翠 绿 强调色 accent theme',
    },
    {
      theme: 'violet',
      title: '赛博紫',
      subtitle: 'Cyber Violet · 霓虹紫调',
      keywords: 'violet purple cyber 赛博 紫 强调色 accent theme',
    },
    {
      theme: 'amber',
      title: '钛金橙',
      subtitle: 'Titanium Amber · 暖金高光',
      keywords: 'amber orange titanium 钛金 橙 强调色 accent theme',
    },
    {
      theme: 'cyan',
      title: '信号青',
      subtitle: 'Signal Cyan · 展厅原色',
      keywords: 'cyan teal signal 信号青 青色 原始 accent theme',
    },
  ]

  const accentCommands: Command[] = accentOptions.map((option) => ({
    id: `accent-${option.theme}`,
    title: option.title,
    subtitle: option.subtitle,
    group: '主题强调色',
    keywords: option.keywords,
    icon: Palette,
    swatch: ACCENT_SWATCH[option.theme],
    active: state.accentTheme === option.theme,
    run: () => useAppStore.getState().setAccentTheme(option.theme),
  }))

  /**
   * Visual Overdrive spectral palettes.
   *
   * Same row shape as the accent commands on purpose — swatch dot, live `active`
   * tick, a subtitle that names the signature hues — because they are sibling
   * colour controls and should read as one pattern in the palette. The two are
   * separate groups, though: 主题强调色 re-tints the DOM accents while 视觉调色
   * recolours the rendered world, and conflating them would hide that.
   *
   * `run` re-reads the store with `getState()` rather than closing over the
   * `state` snapshot captured above, matching every other command here: the
   * catalogue object can outlive the state it was built from.
   */
  const vfxCommands: Command[] = VFX_PRESET_ORDER.map((preset) => {
    const vfxPalette = getVfxPalette(preset)
    return {
      id: `vfx-${preset}`,
      title: vfxPalette.label,
      subtitle: `Visual Overdrive · ${vfxPalette.primary.toUpperCase()} / ${vfxPalette.secondary.toUpperCase()}`,
      group: '视觉调色',
      keywords:
        'vfx visual overdrive palette spectral colour color shader particles 视觉 调色 光谱 粒子 配色',
      icon: Sparkles,
      swatch: vfxPalette.primary,
      active: state.vfxPreset === preset,
      run: () => useAppStore.getState().setVfxPreset(preset),
    }
  })

  const actionCommands: Command[] = [
    {
      id: 'copy-email',
      title: '复制邮箱',
      subtitle: CONTACT_EMAIL,
      group: '操作',
      keywords: 'copy email mail contact clipboard 复制 邮箱 联系',
      icon: Copy,
      run: () => copyText(CONTACT_EMAIL),
    },
    {
      id: 'download-resume',
      title: '下载简历 JSON',
      subtitle: 'showroom-resume.json',
      group: '操作',
      keywords: 'download resume json cv export save 下载 简历',
      icon: Download,
      run: () => {
        downloadResumeJson()
        return true
      },
    },
  ]

  return [
    ...sectionCommands,
    ...gravityCommands,
    ...accentCommands,
    ...vfxCommands,
    ...actionCommands,
  ]
}
