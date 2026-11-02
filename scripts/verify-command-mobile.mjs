/**
 * Verifies the command palette, the mobile bento adaptation and the touch-drag
 * fix.
 *
 * Two phases, two navigations, because the palette is a desktop affordance and
 * the bento adaptation is a capability question that has to be asked on a device
 * profile that actually answers "no hover, coarse pointer".
 *
 * ── On faking the media query ─────────────────────────────────────────────
 * The mobile phase enables real touch emulation AND installs a `matchMedia`
 * shim before the bundle loads. The shim is deliberate: headless Chrome's
 * touch emulation does not reliably flip `(hover: none)`, and the branch under
 * test is exactly "what the app does when the media query matches". Without it
 * the ambient path would silently never run and every assertion below it would
 * pass for the wrong reason.
 *
 * Run: node scripts/verify-command-mobile.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import { findMissing, finish } from './lib/verify.mjs'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9357'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5277'
/** Absolute: CDP resolves a relative downloadPath against the browser's cwd. */
const DOWNLOAD_DIR = resolve('screenshots/downloads')

/* -------------------------------------------------------------------------- */
/*  Page-side probes                                                          */
/* -------------------------------------------------------------------------- */

function installHelpers() {
  const KEY = (key, opts) => ({
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  })

  window.__cp = {
    async load() {
      window.__cpStore = await import('/src/store/useAppStore.ts')
      return true
    },

    state() {
      const s = window.__cpStore.useAppStore.getState()
      return {
        open: s.commandPaletteOpen,
        accent: s.accentTheme,
        gravity: s.gravityMode,
      }
    },

    /** Ctrl+K on window, exactly as a user would. */
    toggle() {
      window.dispatchEvent(new KeyboardEvent('keydown', KEY('k', { ctrlKey: true })))
      return window.__cpStore.useAppStore.getState().commandPaletteOpen
    },

    panel() {
      return document.querySelector('[aria-label="命令面板"]')
    },

    panelVisible() {
      const panel = document.querySelector('[aria-label="命令面板"]')
      if (!panel) return false
      const rect = panel.getBoundingClientRect()
      return rect.width > 200 && rect.height > 80
    },

    input() {
      return document.querySelector('input[role="combobox"]')
    },

    /** Drive the controlled input the way the browser would. */
    query(text) {
      const input = document.querySelector('input[role="combobox"]')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    },

    rows() {
      return Array.from(document.querySelectorAll('[role="option"]')).map((el) => ({
        title: (el.querySelector('span span') ?? el).textContent.trim(),
        selected: el.getAttribute('aria-selected') === 'true',
        full: el.textContent.replace(/\s+/g, ' ').trim(),
      }))
    },

    rowCount() {
      return document.querySelectorAll('[role="option"]').length
    },

    pressKey(key) {
      const input = document.querySelector('input[role="combobox"]')
      if (!input) return false
      input.dispatchEvent(new KeyboardEvent('keydown', KEY(key)))
      return true
    },

    /** Press Enter on the armed row. */
    enter() {
      return this.pressKey('Enter')
    },

    escape() {
      window.dispatchEvent(new KeyboardEvent('keydown', KEY('Escape')))
      return window.__cpStore.useAppStore.getState().commandPaletteOpen
    },

    /** Accent theme as it actually reached the document. */
    accent() {
      return {
        attr: document.documentElement.dataset.accent ?? null,
        cyan: getComputedStyle(document.documentElement)
          .getPropertyValue('--color-signal-cyan')
          .trim(),
        accentRgb: getComputedStyle(document.documentElement)
          .getPropertyValue('--accent-rgb')
          .trim(),
      }
    },

    gravity() {
      const sim = window.__lanyardSim
      return sim && typeof sim.getGravityScale === 'function' ? sim.getGravityScale() : null
    },

    scrollY() {
      return Math.round(window.scrollY)
    },

    /** The bento's layout as the browser actually computed it. */
    bento() {
      // Pick the grid that actually contains spotlight cards.
      const cards = document.querySelectorAll('.spotlight-glow')
      const host = cards.length ? cards[0].closest('.grid') : null
      if (!host) return null
      const style = getComputedStyle(host)
      return {
        columns: style.gridTemplateColumns.split(' ').filter(Boolean).length,
        templateRows: style.gridTemplateRows,
        ambientAttr: host.getAttribute('data-spotlight'),
        cardCount: cards.length,
        gridWidth: Math.round(host.getBoundingClientRect().width),
      }
    },

    /** Opacity of the border-glow layer, i.e. is the spotlight visible at all. */
    glowOpacity() {
      const el = document.querySelector('.spotlight-glow--ring')
      return el ? Number(getComputedStyle(el).opacity) : null
    },

    /** The live `--mouse-x` written by whichever driver is active. */
    spotlightVar() {
      const el = document.querySelector('[style*="--mouse-x"]')
      if (!el) return null
      return {
        x: el.style.getPropertyValue('--mouse-x'),
        y: el.style.getPropertyValue('--mouse-y'),
      }
    },

    touchAction() {
      const canvas = document.querySelector('canvas[role="application"]')
      return canvas ? getComputedStyle(canvas).touchAction : null
    },

    overscroll() {
      return getComputedStyle(document.documentElement).overscrollBehaviorY
    },

    /** Scroll the playground into view so the lanyard mounts and settles. */
    async visitPlayground() {
      document.querySelector('#playground')?.scrollIntoView({ block: 'center' })
      await new Promise((r) => setTimeout(r, 900))
      return true
    },

    async wait(ms) {
      await new Promise((r) => setTimeout(r, ms))
      return true
    },
  }
  return { ok: true }
}

/* -------------------------------------------------------------------------- */
/*  CDP plumbing                                                              */
/* -------------------------------------------------------------------------- */

const targets = await (await fetch(CDP_HTTP + '/json/list')).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.once('open', res)
  ws.once('error', rej)
})

let nextId = 1
const pending = new Map()
const exceptions = []
const consoleErrors = []

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const entry = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
    else entry.resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    exceptions.push(d.exception?.description ?? d.text)
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

/**
 * Evaluate in the page, retrying the transient `-32000` ("Inspected target
 * navigated or closed") that CDP can return while a document swap is settling.
 */
const evalAsync = async (expression, attempt = 0) => {
  try {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      return {
        __error: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
      }
    }
    return res.result?.value
  } catch (error) {
    if (attempt < 3) {
      await sleep(500)
      return evalAsync(expression, attempt + 1)
    }
    return { __error: String(error) }
  }
}

const navigate = async (url) => {
  try {
    await send('Page.navigate', { url })
  } catch {
    // A rejection here means the target was already mid-navigation; waiting
    // below is the actual synchronisation, so there is nothing to recover.
  }
  await sleep(7000)
  const installed = await evalAsync('(' + installHelpers.toString() + ')()')
  if (installed && installed.ok) return installed
  await sleep(1500)
  return evalAsync('(' + installHelpers.toString() + ')()')
}

await send('Page.enable')
await send('Runtime.enable')

/*
 * Headless pages are never "focused" in the document sense, and both
 * `navigator.clipboard.writeText` and `execCommand('copy')` reject without focus
 * regardless of permissions. Without this the copy command always takes its
 * failure branch — which is correct behaviour, but it makes the success path
 * unobservable.
 */
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)

mkdirSync('screenshots', { recursive: true })
rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
mkdirSync(DOWNLOAD_DIR, { recursive: true })

/*
 * The clipboard is permission-gated. Without this grant `writeText` rejects and
 * `execCommand('copy')` returns false, so the copy command correctly declines to
 * show its "完成" tick — and the test would read that correct refusal as a
 * failure. Granting the permission is what makes the happy path observable.
 */
await send('Browser.grantPermissions', {
  origin: new URL(URL_TO_TEST).origin,
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
}).catch(() => undefined)

await send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: DOWNLOAD_DIR,
  eventsEnabled: true,
}).catch(() => undefined)

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Phase 1 — desktop: command palette                                       */
/* ══════════════════════════════════════════════════════════════════════════ */

await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
})
await send('Emulation.setTouchEmulationEnabled', { enabled: false })
await navigate(URL_TO_TEST)
await evalAsync('window.__cp.load()')

const desktop = {}

/* P1 — Ctrl+K opens */
desktop.afterToggle = await evalAsync('window.__cp.toggle()')
await sleep(600)
desktop.panelVisible = await evalAsync('window.__cp.panelVisible()')
desktop.rowCountAll = await evalAsync('window.__cp.rowCount()')

const shotPalette = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/103-command-palette.png', Buffer.from(shotPalette.data, 'base64'))

/* P2 — fuzzy substring search */
await evalAsync('window.__cp.query("架构")')
await sleep(400)
desktop.searchCjk = await evalAsync('window.__cp.rows().slice(0, 3)')

/* P3 — fuzzy via hidden English keyword */
await evalAsync('window.__cp.query("violet")')
await sleep(400)
desktop.searchKeyword = await evalAsync('window.__cp.rows().slice(0, 3)')

/* P4 — subsequence matching within a single title */
await evalAsync('window.__cp.query("跳架")')
await sleep(400)
desktop.searchSubsequence = await evalAsync('window.__cp.rows().slice(0, 2)')

/* P5 — Enter executes: switch accent to violet */
await evalAsync('window.__cp.query("violet")')
await sleep(350)
await evalAsync('window.__cp.enter()')
await sleep(700)
desktop.accentAfterViolet = await evalAsync('window.__cp.accent()')
desktop.stateAfterViolet = await evalAsync('window.__cp.state()')

/* P6 — gravity via the palette */
await evalAsync('window.__cp.toggle()')
await sleep(400)
await evalAsync('window.__cp.query("月球")')
await sleep(350)
await evalAsync('window.__cp.enter()')
await sleep(700)
desktop.gravityAfterMoon = await evalAsync('window.__cp.gravity()')
desktop.stateAfterMoon = await evalAsync('window.__cp.state()')

/* P7 — zero-g is a real state, not a truthiness bug */
await evalAsync('window.__cp.toggle()')
await sleep(400)
await evalAsync('window.__cp.query("零重力")')
await sleep(350)
await evalAsync('window.__cp.enter()')
await sleep(700)
desktop.gravityAfterZero = await evalAsync('window.__cp.gravity()')

/* P8 — copy email keeps the palette open and confirms */
await evalAsync('window.__cp.toggle()')
await sleep(400)
await evalAsync('window.__cp.query("复制邮箱")')
await sleep(350)
await evalAsync('window.__cp.enter()')
await sleep(700)
desktop.copyFlash = await evalAsync(`(() => {
  const row = Array.from(document.querySelectorAll('[role="option"]'))
    .map((el) => el.textContent.replace(/\\s+/g, ' ').trim())
    .find((t) => t.includes('复制邮箱'))
  return row ?? null
})()`)
desktop.stillOpenAfterCopy = await evalAsync('window.__cp.state().open')

/* P9 — download resume produces a file */
await evalAsync('window.__cp.query("简历")')
await sleep(350)
await evalAsync('window.__cp.enter()')
await sleep(2600)
desktop.downloadFiles = existsSync(DOWNLOAD_DIR)
  ? readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith('.json'))
  : []
desktop.downloadExists = desktop.downloadFiles.length > 0

/* P10 — Escape closes */
desktop.escapeResult = await evalAsync('window.__cp.escape()')
await sleep(400)
desktop.panelGone = !(await evalAsync('window.__cp.panelVisible()'))

/* P11 — arrow keys then Enter performs a section jump */
const scrollBefore = await evalAsync('window.__cp.scrollY()')
await evalAsync('window.__cp.toggle()')
await sleep(450)
await evalAsync('window.__cp.query("跳转到 沙盒")')
await sleep(350)
desktop.armedBySearch = await evalAsync('window.__cp.rows()[0]?.full ?? null')
await evalAsync('window.__cp.pressKey("ArrowDown")')
await sleep(150)
await evalAsync('window.__cp.pressKey("ArrowUp")')
await sleep(150)
const armedAfterArrows = await evalAsync(
  'document.querySelector(\'[role="option"][aria-selected="true"]\')?.textContent.replace(/\\s+/g, " ").trim() ?? null',
)
await evalAsync('window.__cp.enter()')
await sleep(2400)
desktop.armedAfterArrows = armedAfterArrows
desktop.scrollBefore = scrollBefore
desktop.scrollAfterJump = await evalAsync('window.__cp.scrollY()')
desktop.closedAfterJump = !(await evalAsync('window.__cp.state().open'))

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Phase 2 — mobile: bento flow, ambient spotlight, touch-action            */
/* ══════════════════════════════════════════════════════════════════════════ */

const MATCHMEDIA_SHIM = `
(() => {
  const real = window.matchMedia.bind(window)
  window.matchMedia = (query) => {
    if (query.includes('hover: none') || query.includes('pointer: coarse')) {
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() { return false },
      }
    }
    return real(query)
  }
})()
`

await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
})
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await send('Emulation.setUserAgentOverride', {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
const shim = await send('Page.addScriptToEvaluateOnNewDocument', {
  source: MATCHMEDIA_SHIM,
})

await navigate(URL_TO_TEST)
await evalAsync('window.__cp.load()')
await sleep(1500)

const mobile = {}
mobile.bento = await evalAsync('window.__cp.bento()')
mobile.glowOpacity = await evalAsync('window.__cp.glowOpacity()')
mobile.touchAction = await evalAsync('window.__cp.touchAction()')
mobile.overscroll = await evalAsync('window.__cp.overscroll()')

/* Scroll the bento into view and confirm the ambient spotlight is moving. */
await evalAsync(`(() => {
  document.querySelector('.spotlight-glow')?.scrollIntoView({ block: 'center' })
  return true
})()`)
await sleep(1200)

const sampleA = await evalAsync('window.__cp.spotlightVar()')
await sleep(700)
const sampleB = await evalAsync('window.__cp.spotlightVar()')
mobile.spotA = sampleA
mobile.spotB = sampleB

const shotMobile = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/104-mobile-bento.png', Buffer.from(shotMobile.data, 'base64'))

/* Also grab the lanyard on mobile, scrolled to the playground. */
await evalAsync('window.__cp.visitPlayground()')
await sleep(1200)
const shotPlay = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/105-mobile-sandbox.png', Buffer.from(shotPlay.data, 'base64'))
mobile.playgroundTouchAction = await evalAsync('window.__cp.touchAction()')
mobile.overscrollAfterScroll = await evalAsync('window.__cp.overscroll()')

await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: shim.identifier }).catch(
  () => undefined,
)

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Assertions                                                               */
/* ══════════════════════════════════════════════════════════════════════════ */

const near = (value, target, tol) => typeof value === 'number' && Math.abs(value - target) <= tol

const rowsText = (rows) => (rows ?? []).map((r) => r.full ?? '').join(' | ')

const assertions = {
  /* ── Palette: open / close ─────────────────────────────────────────── */
  paletteOpensOnCtrlK: desktop.afterToggle === true,
  palettePanelRendered: desktop.panelVisible === true,
  paletteListsAllCommands: (desktop.rowCountAll ?? 0) >= 14,
  escapeClosesPalette: desktop.escapeResult === false && desktop.panelGone === true,

  /* ── Palette: search ───────────────────────────────────────────────── */
  cjkSubstringFindsSection: rowsText(desktop.searchCjk).includes('架构'),
  keywordFindsVioletTheme: rowsText(desktop.searchKeyword).includes('赛博紫'),
  subsequenceMatchesAcrossTitle: rowsText(desktop.searchSubsequence).includes('跳转到 架构'),

  /* ── Palette: execution ────────────────────────────────────────────── */
  accentThemeApplied: desktop.accentAfterViolet?.attr === 'violet',
  accentVariableOverridden: /^#a78bfa$/i.test(desktop.accentAfterViolet?.cyan ?? ''),
  accentPersistedToStore: desktop.stateAfterViolet?.accent === 'violet',

  moonGravityApplied: near(desktop.gravityAfterMoon, 1 / 6, 0.02),
  zeroGravityApplied: desktop.gravityAfterZero === 0,

  copyKeepsPaletteOpen: desktop.stillOpenAfterCopy === true,
  copyShowsConfirmation: (desktop.copyFlash ?? '').includes('完成'),
  resumeDownloaded: desktop.downloadExists === true,

  jumpArmedRowIsCorrect: (desktop.armedBySearch ?? '').includes('沙盒'),
  jumpArrowsDoNotSkip: (desktop.armedAfterArrows ?? '').includes('沙盒'),
  jumpScrollsPage: (desktop.scrollAfterJump ?? 0) - (desktop.scrollBefore ?? 0) > 300,
  jumpClosesPalette: desktop.closedAfterJump === true,

  /* ── Mobile bento ──────────────────────────────────────────────────── */
  bentoSingleColumnOnPhone: mobile.bento?.columns === 1,
  bentoUsesAmbientSpotlight: mobile.bento?.ambientAttr === 'ambient',
  // The glow is the whole point: `group-hover` never fires on touch, so without
  // the ambient CSS these layers stay at opacity 0 and the bento reads as flat.
  bentoGlowVisibleWithoutHover: (mobile.glowOpacity ?? 0) > 0.5,
  ambientSpotlightMoves:
    Boolean(mobile.spotA?.x) && Boolean(mobile.spotB?.x) && mobile.spotA.x !== mobile.spotB.x,

  /* ── Touch handling ────────────────────────────────────────────────── */
  lanyardCanvasBlocksGestures: mobile.touchAction === 'none',
  lanyardCanvasBlocksGesturesInPlayground: mobile.playgroundTouchAction === 'none',
  // Document-level: the only place that can suppress pull-to-refresh.
  documentBlocksPullToRefresh: mobile.overscroll === 'none',

  /* ── Hygiene ───────────────────────────────────────────────────────── */
  noExceptions: exceptions.length === 0,
  noConsoleErrors: consoleErrors.length === 0,
}

const failed = Object.entries(assertions)
  .filter(([, value]) => !value)
  .map(([key]) => key)

const report = { assertions, failed, desktop, mobile, exceptions, consoleErrors }
writeFileSync('screenshots/command-mobile-report.json', JSON.stringify(report, null, 2))

console.log(JSON.stringify(report, null, 2))

finish({
  failures: findMissing(report),
  label: 'command-mobile',
  exceptions,
  consoleErrors,
  report,
})
ws.close()
