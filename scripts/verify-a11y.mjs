/**
 * Accessibility assertions.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every WCAG fix in batch 3 was verified with a throwaway CDP snippet that was then
 * discarded. That is how the same class of bug returns: someone edits a class, the
 * build stays green, and nobody re-checks the behaviour. This turns those probes into
 * a gate that runs against the BUILT output.
 *
 * One dependency: `axe-core`, injected into the page and run with the WCAG 2.0/2.1/2.2
 * AA tag set. The hand-written checks below encode the specific things this project kept
 * getting wrong; axe covers the long tail those checks cannot enumerate. Chromium itself
 * is still driven over the same `ws` transport the other verify scripts use.
 *
 * Usage:
 *   node scripts/verify-a11y.mjs --base http://127.0.0.1:4173
 *   CHROME_PATH=/usr/bin/chromium node scripts/verify-a11y.mjs --base ...
 *
 * Each check prints PASS/FAIL with the measured value, and any failure sets exit 1.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/*
 * First candidate that actually EXISTS on this machine.
 *
 * Checking only for a non-empty string is not enough: the Windows install paths are
 * non-empty everywhere, so on the Linux CI runner the script happily tried to spawn
 * `C:/Program Files/...` and died with ENOENT. Existence is the whole question.
 */
const chromePath = CANDIDATES.find((c) => typeof c === 'string' && c.length > 0 && existsSync(c))
const base = (() => {
  const i = process.argv.indexOf('--base')
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'http://127.0.0.1:4173'
})()

if (!chromePath) {
  console.error('::error::no Chrome/Chromium found; set CHROME_PATH')
  process.exit(1)
}

/**
 * Known-open items, deliberately NOT asserted.
 *
 * UI-10 (focus ring on the topology nodes) is unfinished: three separate mechanisms
 * were measured as ineffective on the SVG group, so it needs a different element, not a
 * different style. Asserting it now would just paint CI red for a known defect; it is
 * listed here so the exclusion is visible instead of forgotten.
 */
/*
 * Failures that are known and deliberately not asserted yet.
 *
 * Empty since UI-10 was closed by measurement: the ring had been rendering all along,
 * and the three "it does not work" results were probes that selected the page's first
 * `[role=button]` (a different card) instead of a node inside this SVG.
 */
const KNOWN_OPEN = []

const port = 9450 + Math.floor(Math.random() * 90)
const profile = await mkdtemp(join(tmpdir(), 'showroom-a11y-'))
/*
 * Platform flags.
 *
 * `--no-sandbox` and `--disable-dev-shm-usage` are required for Chrome to start at all
 * on the GitHub runner (and in most containers): without them the process exits before
 * it opens the debugging port, which surfaced as "debugging endpoint never became
 * ready" rather than as a clear error. The GPU flags are Windows-oriented and are
 * skipped elsewhere so they cannot be rejected as unknown switches.
 */
const platformArgs = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1600,900',
  ...(process.platform === 'linux'
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox']
    : []),
  ...(process.platform === 'win32'
    ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
    : []),
]

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...platformArgs,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

let ws = null

try {
  let target = null
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((entry) => entry.type === 'page')
      if (target) break
    } catch {
      // not ready yet
    }
  }
  if (!target) throw new Error('Chrome debugging endpoint never became ready')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let messageId = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++messageId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(String(result.exceptionDetails.exception?.description))
    }
    return result.result?.value
  }

  const press = async (key, code, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      windowsVirtualKeyCode: code,
      modifiers,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      windowsVirtualKeyCode: code,
      modifiers,
    })
    await sleep(90)
  }

  await send('Page.enable')
  await send('Runtime.enable')
  // LD-04: the page must not need a third-party host to paint its text. Requests are
  // recorded here and asserted at the end.
  await send('Network.enable')
  const requestedUrls = []
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.method === 'Network.requestWillBeSent') {
      requestedUrls.push(message.params.request.url)
    }
  })
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url: base })

  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(500)
    const ready = await evaluate(
      `document.readyState === 'complete' && !!document.querySelector('main')`,
    )
    if (ready) break
  }
  await sleep(2500)

  /* 0. WCAG 3.1.1 — the document language must match the interface's default. */
  const docLang = await evaluate(`({
    lang: document.documentElement.lang,
    title: document.title.trim(),
  })`)
  check(
    'language-of-page: <html lang> is "en" (the default locale)',
    docLang.lang === 'en',
    `lang="${docLang.lang}"`,
  )
  check(
    'title: document.title is localised and non-empty',
    docLang.title.length > 0,
    `"${docLang.title}"`,
  )

  /*
   * 0b. axe-core — the batch-3 acceptance criterion (critical + serious = 0).
   *
   * Run on the untouched page, before any check opens a modal or switches language, so
   * the result describes what a visitor actually lands on. The global `:focus-visible`
   * rule and the inert/inert-less states are covered by the targeted checks below.
   */
  const axeSource = readFileSync(join(process.cwd(), 'node_modules/axe-core/axe.min.js'), 'utf8')
  await evaluate(axeSource)
  const axe = await evaluate(`(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    })
    const byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 }
    const violations = result.violations.map((v) => {
      byImpact[v.impact] = (byImpact[v.impact] || 0) + v.nodes.length
      return { id: v.id, impact: v.impact, nodes: v.nodes.length, target: v.nodes[0]?.target?.join(' ') }
    })
    return { byImpact, violations, passes: result.passes.length, incomplete: result.incomplete.length }
  })()`)
  const axeBlocking = axe.byImpact.critical + axe.byImpact.serious
  check(
    'axe: zero critical/serious WCAG 2.x AA violations on the landing page',
    axeBlocking === 0,
    `critical ${axe.byImpact.critical}, serious ${axe.byImpact.serious}, moderate ${axe.byImpact.moderate}, minor ${axe.byImpact.minor} (${axe.passes} passes, ${axe.incomplete} incomplete)`,
  )
  if (axe.violations.length > 0) {
    console.log('  axe violations by rule:')
    for (const v of axe.violations) {
      console.log(`    ${v.impact.padEnd(8)} ${v.id} x${v.nodes}  first: ${v.target}`)
    }
  }

  /*
   * 0c. Link previews (review UI-07): the static document must carry a complete Open
   * Graph set. A missing og:url or og:locale is invisible in the app and only shows up
   * when someone pastes the link somewhere, which is exactly the kind of thing that
   * rots unnoticed.
   */
  const social = await evaluate(`(() => {
    const meta = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || ''
    return {
      type: meta('meta[property="og:type"]'),
      url: meta('meta[property="og:url"]'),
      locale: meta('meta[property="og:locale"]'),
      title: meta('meta[property="og:title"]'),
      description: meta('meta[property="og:description"]'),
      twitterCard: meta('meta[name="twitter:card"]'),
    }
  })()`)
  check(
    'meta: Open Graph / Twitter cards are complete',
    Boolean(
      social.type &&
      social.url.startsWith('https://') &&
      social.locale &&
      social.title.length > 0 &&
      social.description.length > 0 &&
      social.twitterCard,
    ),
    `type=${social.type} locale=${social.locale} url=${social.url} card=${social.twitterCard}`,
  )

  /* 1. WCAG 1.4.3 — the smallest text must clear 4.5:1 against its own background. */
  const contrast = await evaluate(`(() => {
    const parse = (c) => c.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number)
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
    const ratio = (a, b) => { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05) }
    const probe = document.createElement('span')
    probe.className = 'text-ink-700'
    document.body.appendChild(probe)
    const fg = parse(getComputedStyle(probe).color)
    probe.remove()
    const bg = parse(getComputedStyle(document.body).backgroundColor)
    return { fg, bg, ratio: ratio(fg, bg) }
  })()`)
  check(
    'contrast: ink-700 text on page background >= 4.5:1',
    contrast.ratio >= 4.5,
    `${contrast.ratio.toFixed(2)}:1`,
  )

  /* 2. WCAG 2.4.1 — a bypass block exists and is the first focusable element. */
  const skip = await evaluate(`(() => {
    const link = document.querySelector('a[href="#main"]')
    if (!link) return { found: false }
    link.focus()
    const focused = document.activeElement === link
    link.click()
    const landed = document.activeElement === document.getElementById('main')
    return { found: true, focused, landed, text: link.textContent.trim() }
  })()`)
  check(
    'bypass: skip link is focusable and moves focus to <main>',
    Boolean(skip.found && skip.focused && skip.landed),
    skip.found ? `"${skip.text}"` : 'missing',
  )

  /* 3. WCAG 4.1.3 — announcements reach a live region. */
  const live = await evaluate(`(async () => {
    const group = [...document.querySelectorAll('[aria-label]')].find((el) =>
      /switch language|切换语言/i.test(el.getAttribute('aria-label')),
    )
    if (!group) return { found: false }
    const zh = [...group.querySelectorAll('button')].find((b) => b.textContent.trim() === '中文')
    if (!zh) return { found: true, button: false }
    zh.click()
    await new Promise((r) => setTimeout(r, 400))
    const region = document.getElementById('a11y-announcer')
    const snapshot = region ? { role: region.getAttribute('role'), live: region.getAttribute('aria-live'), text: region.textContent } : null
    /*
     * Switch back to English before returning.
     *
     * The later checks locate controls by their English labels; leaving the page in
     * Chinese made them report "not found" and looked like product failures when the
     * suite was first run. Each assertion must be independent of the ones before it.
     */
    const restoreGroup = [...document.querySelectorAll('[aria-label]')].find((el) =>
      /switch language|切换语言/i.test(el.getAttribute('aria-label')),
    )
    const en = restoreGroup ? [...restoreGroup.querySelectorAll('button')].find((b) => b.textContent.trim() === 'EN') : null
    en?.click()
    await new Promise((r) => setTimeout(r, 500))
    return { found: true, button: true, region: snapshot }
  })()`)
  check(
    'status: language switch announces through a polite live region',
    Boolean(live.region && live.region.live === 'polite' && live.region.text.length > 0),
    live.region ? `${live.region.live} / "${live.region.text}"` : 'no live region',
  )

  /* 4. WCAG 2.4.3 — focus is trapped while the palette is open, and restored on close. */
  const modal = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /command palette|命令面板/i.test(b.getAttribute('aria-label') || ''),
    )
    if (!btn) return { found: false }
    btn.focus()
    btn.click()
    return { found: true }
  })()`)
  await sleep(600)
  const trapped = await evaluate(`(() => {
    const input = document.querySelector('input[role="combobox"]')
    const dialog = input?.closest('[role="dialog"]')
    return { open: Boolean(dialog), startInside: dialog ? dialog.contains(document.activeElement) : false }
  })()`)
  const tabsInside = []
  for (let i = 0; i < 6; i++) {
    await press('Tab', 9)
    tabsInside.push(
      await evaluate(`(() => {
        const input = document.querySelector('input[role="combobox"]')
        const dialog = input?.closest('[role="dialog"]')
        return dialog ? dialog.contains(document.activeElement) : false
      })()`),
    )
  }
  /*
   * Look at <main> specifically, not at "how many inert elements exist".
   *
   * The closed mobile drawer is legitimately inert at all times, so a global count can
   * never go back to zero -- the first version of this assertion failed for that reason.
   */
  const inertDuring = await evaluate(`Boolean(document.getElementById('main')?.closest('[inert]'))`)
  await press('Escape', 27)
  await sleep(400)
  const restored = await evaluate(`({
    gone: !document.querySelector('input[role="combobox"]'),
    backOnButton: /command palette|命令面板/i.test(document.activeElement?.getAttribute?.('aria-label') || ''),
    inertCleared: !document.getElementById('main')?.closest('[inert]'),
  })`)
  check(
    'modal: focus starts inside, Tab never escapes, Escape restores focus',
    Boolean(
      modal.found &&
      trapped.open &&
      trapped.startInside &&
      tabsInside.every(Boolean) &&
      restored.gone &&
      restored.backOnButton,
    ),
    `start ${trapped.startInside}, trapped ${tabsInside.filter(Boolean).length}/6`,
  )
  check(
    'modal: background is inert while open and cleared after',
    inertDuring && restored.inertCleared,
  )

  /* 4b. WCAG 2.4.3 — the closed mobile drawer must not be reachable. */
  const drawer = await evaluate(`(() => {
    const sheet = document.querySelector('nav[aria-label]')?.closest('[inert]')
    const navs = [...document.querySelectorAll('nav')]
    // The mobile sheet is the nav that is hidden at lg+ widths (lg:hidden).
    const mobile = navs.find((n) => getComputedStyle(n).display === 'none')
    const host = mobile?.closest('[inert]')
    return { found: Boolean(mobile), inert: Boolean(host) }
  })()`)
  check(
    'drawer: closed mobile sheet is inert (no hidden tab stops)',
    !drawer.found || drawer.inert,
    drawer.found ? 'sheet present, inert ' + drawer.inert : 'sheet not rendered',
  )

  /* 4c. WCAG 4.1.2 — no interactive children inside a role="img". */
  const topology = await evaluate(`(() => {
    const svg = document.querySelector('svg[aria-label*="topology" i]')
    if (!svg) return { found: false }
    return { found: true, role: svg.getAttribute('role'), buttons: svg.querySelectorAll('[role="button"]').length }
  })()`)
  check(
    'aria: topology container is a labelled group (buttons inside role=img are invalid)',
    !topology.found || (topology.role !== 'img' && topology.buttons > 0),
    topology.found ? `role=${topology.role}, buttons=${topology.buttons}` : 'not found',
  )

  /*
   * 4d. WCAG 2.4.7 — a focused topology node must show something.
   *
   * UI-10 was reported as "the focus ring was deleted" and then bounced through three
   * failed attempts to bring it back; two of those failures were the test's fault (the
   * probe selected the page's first `[role=button]`, which is not in this diagram). This
   * assertion scopes everything from the labelled SVG, focuses the third node, and counts
   * the ring elements that exist afterwards -- plus checks the ring has a non-zero box,
   * so "present but collapsed to nothing" cannot pass.
   */
  const ring = await evaluate(`(async () => {
    const svg = document.querySelector('svg[aria-label*="topology" i]')
    if (!svg) return { found: false }
    const nodes = [...svg.querySelectorAll('g[role="button"]')]
    if (nodes.length < 3) return { found: true, nodes: nodes.length }
    const node = nodes[2]
    const rings = () => [...svg.querySelectorAll('circle[stroke-dasharray]')]
    const before = rings().length
    node.focus()
    // One frame for the React state update that renders the ring.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await new Promise((r) => setTimeout(r, 120))
    const after = rings()
    const first = after[0]
    const box = first ? first.getBoundingClientRect() : null
    const paint = first ? getComputedStyle(first) : null
    node.blur()
    return {
      found: true,
      nodes: nodes.length,
      focused: true,
      before,
      after: after.length,
      visible: Boolean(box && box.width > 4 && box.height > 4),
      stroke: paint ? paint.stroke : null,
      width: paint ? paint.strokeWidth : null,
    }
  })()`)
  check(
    'focus: the focused topology node paints a ring (WCAG 2.4.7)',
    Boolean(
      ring.found &&
      ring.before === 0 &&
      ring.after >= 1 &&
      ring.visible &&
      ring.stroke !== 'none' &&
      Number.parseFloat(ring.width) >= 1,
    ),
    ring.found
      ? `nodes ${ring.nodes}, rings ${ring.before} -> ${ring.after}, visible ${ring.visible}, stroke ${ring.stroke} @ ${ring.width}`
      : 'svg not found',
  )

  /*
   * 4e. WCAG 2.4.7 — the terminal's real input is 1px and transparent.
   *
   * It has to be (it is what gives the demo a caret, IME and a mobile keyboard), but
   * `opacity: 0` hides its own outline too, so tabbing into the terminal left a keyboard
   * user with nothing on screen. The ring now lives on the terminal card, and this checks
   * the proxy actually appears when the input takes focus.
   */
  const terminalRing = await evaluate(`(async () => {
    const root = document.querySelector('[data-terminal="root"]')
    const input = root?.querySelector('input')
    if (!root || !input) return { found: false }
    const before = getComputedStyle(root).outlineStyle
    input.focus()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    /*
     * Snapshot the properties NOW.
     *
     * getComputedStyle returns a LIVE declaration object: reading it after the blur
     * below reported outline-style none, which looked like the fix had not worked when
     * the ring had in fact been painted the whole time. Same class of mistake as the
     * topology probe that selected the wrong element.
     */
    const paint = getComputedStyle(root)
    const focused = document.activeElement === input
    const after = paint.outlineStyle
    const width = paint.outlineWidth
    const color = paint.outlineColor
    input.blur()
    return { found: true, focused, before, after, width, color }
  })()`)
  check(
    'focus: terminal input paints its ring on the card (WCAG 2.4.7)',
    Boolean(
      terminalRing.found &&
      terminalRing.focused &&
      terminalRing.before === 'none' &&
      terminalRing.after !== 'none' &&
      Number.parseFloat(terminalRing.width) >= 2,
    ),
    terminalRing.found
      ? `outline ${terminalRing.before} -> ${terminalRing.after} ${terminalRing.width} ${terminalRing.color}`
      : 'terminal not found',
  )

  /* 5. WCAG 2.5.8 — the two controls that measured under 24px. */
  const targets = await evaluate(`(() => {
    const measure = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }
    const group = [...document.querySelectorAll('[aria-label]')].find((el) =>
      /switch language|切换语言/i.test(el.getAttribute('aria-label')),
    )
    const seg = group?.querySelector('button')
    const cta = [...document.querySelectorAll('button')].find((b) => /inspect architecture/i.test(b.textContent || ''))
    return { seg: seg ? measure(seg) : null, cta: cta ? measure(cta) : null }
  })()`)
  check(
    'target-size: language segment >= 24x24',
    Boolean(targets.seg && targets.seg.h >= 24 && targets.seg.w >= 24),
    targets.seg ? `${targets.seg.w}x${targets.seg.h}` : 'not found',
  )
  check(
    'target-size: bento CTA >= 24px tall',
    Boolean(targets.cta && targets.cta.h >= 24),
    targets.cta ? `${targets.cta.w}x${targets.cta.h}` : 'not found',
  )

  /* 6. Touch scrolling over the sandboxes (not a WCAG number, but the reason PB-05 exists). */
  await evaluate(
    `(() => { const el = document.getElementById('playground'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY); return true })()`,
  )
  await sleep(1500)
  const touchAction = await evaluate(`(() => {
    const canvases = [...document.querySelectorAll('canvas')]
    const values = canvases.map((c) => getComputedStyle(c).touchAction).filter((v) => v && v !== 'auto')
    return { values }
  })()`)
  check(
    'touch: no sandbox canvas blocks page scrolling',
    !touchAction.values.includes('none'),
    touchAction.values.join(', ') || 'all auto',
  )

  /*
   * 7. PB-05 — keyboard parity for the two physics sandboxes.
   *
   * Both toys used to be pointer-only, so the "drag a badge" and "steer the arm"
   * interactions were unreachable without a mouse. Three properties are asserted, and
   * the third is the one that matters most:
   *
   *   a. both canvases are in the tab order and carry a name plus a description
   *   b. Enter/Escape actually drive the simulation (the announcement proves the
   *      handler reached `pointerDown`/`pointerUp`)
   *   c. arrows are only swallowed while something is held — an idle sandbox with
   *      focus must still let the page scroll
   *
   * `dispatchEvent` returns false when the handler called `preventDefault`, which is
   * exactly the "consumed" signal (c) needs; no pixel inspection involved.
   */
  const keyboardTargets = await evaluate(`(() => {
    const out = []
    for (const canvas of document.querySelectorAll('canvas[role="application"]')) {
      const describedBy = canvas.getAttribute('aria-describedby')
      const hint = describedBy ? document.getElementById(describedBy) : null
      canvas.focus()
      out.push({
        id: describedBy,
        label: (canvas.getAttribute('aria-label') || '').trim().length,
        hint: (hint?.textContent || '').trim().length,
        tabIndex: canvas.tabIndex,
        focused: document.activeElement === canvas,
      })
    }
    return out
  })()`)
  check(
    'keyboard: both sandbox canvases are tabbable, named and described',
    keyboardTargets.length === 2 &&
      keyboardTargets.every((c) => c.tabIndex === 0 && c.focused && c.label > 20 && c.hint > 20),
    keyboardTargets
      .map((c) => `${c.id} tabIndex=${c.tabIndex} name=${c.label} hint=${c.hint}`)
      .join(' | ') || 'no role=application canvas',
  )

  const lanyardKeys = await evaluate(`(async () => {
    const canvas = document.querySelector('canvas[aria-describedby="sandbox-verlet-keys"]')
    if (!canvas) return { found: false }
    canvas.focus()
    // A synthetic keydown bubbles to React's root listener exactly like a real one.
    const fire = (key) => canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    const announce = () => document.getElementById('a11y-announcer')?.textContent || ''
    const idleArrowScrollsPage = fire('ArrowRight')
    fire('Enter')
    await new Promise((r) => setTimeout(r, 220))
    const grabbed = announce()
    const heldArrowConsumed = fire('ArrowLeft') === false
    fire('Escape')
    await new Promise((r) => setTimeout(r, 220))
    return { found: true, idleArrowScrollsPage, grabbed, heldArrowConsumed, released: announce() }
  })()`)
  check(
    'keyboard: lanyard grabs, swings and releases from the keyboard',
    Boolean(
      lanyardKeys.found &&
      lanyardKeys.idleArrowScrollsPage &&
      /grabbed|抓住/i.test(lanyardKeys.grabbed) &&
      lanyardKeys.heldArrowConsumed &&
      /released|松手/i.test(lanyardKeys.released),
    ),
    lanyardKeys.found
      ? `idle arrow scrolls=${lanyardKeys.idleArrowScrollsPage}, grabbed "${lanyardKeys.grabbed}", held arrow consumed=${lanyardKeys.heldArrowConsumed}, released "${lanyardKeys.released}"`
      : 'canvas not found',
  )

  const armKeys = await evaluate(`(async () => {
    const canvas = document.querySelector('canvas[aria-describedby="sandbox-fabrik-keys"]')
    if (!canvas) return { found: false }
    canvas.focus()
    const fire = (key) => canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    const arrowConsumed = fire('ArrowUp') === false
    fire('Enter')
    await new Promise((r) => setTimeout(r, 220))
    return { found: true, arrowConsumed, fired: document.getElementById('a11y-announcer')?.textContent || '' }
  })()`)
  check(
    'keyboard: arm steers with arrows and fires with Enter',
    Boolean(armKeys.found && armKeys.arrowConsumed && /fired|发射/i.test(armKeys.fired)),
    armKeys.found
      ? `arrow consumed=${armKeys.arrowConsumed}, "${armKeys.fired}"`
      : 'canvas not found',
  )
  /*
   * 8. LD-04 — self-hosted fonts.
   *
   * The page used to fetch a Google Fonts stylesheet plus two font files from two
   * third-party hosts before it could paint text; on a network where those hosts are
   * unreachable the stylesheet stalls and the page reflows when it gives up. The fonts are
   * now bundled (62 KB of latin-subset variable WOFF2), so this asserts both halves:
   * nothing is requested from the old hosts, and the families really are the page's own.
   */
  const thirdPartyFonts = requestedUrls.filter((url) =>
    /fonts\.(googleapis|gstatic)\.com/.test(url),
  )
  const bundledFonts = requestedUrls.filter((url) => url.endsWith('.woff2'))
  const fontFaces = await evaluate(`(() => ({
    space: getComputedStyle(document.body).fontFamily.includes('Space Grotesk'),
    mono: [...document.fonts].some((face) => face.family.includes('JetBrains') && face.status === 'loaded'),
  }))()`)
  check(
    'fonts: self-hosted, no third-party requests, families applied',
    thirdPartyFonts.length === 0 && bundledFonts.length >= 2 && fontFaces.space && fontFaces.mono,
    `third-party ${thirdPartyFonts.length}, bundled ${bundledFonts.length}, body uses Space Grotesk ${fontFaces.space}, mono loaded ${fontFaces.mono}`,
  )
} catch (error) {
  check('harness', false, String(error?.message ?? error))
} finally {
  try {
    ws?.close()
  } catch {
    // already closed
  }
  chrome.kill()
  await sleep(300)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}

if (KNOWN_OPEN.length > 0) {
  console.log('\nknown open (not asserted):')
  for (const item of KNOWN_OPEN) console.log(`  - ${item}`)
}

const failed = results.filter((r) => !r.ok)
if (failed.length > 0) {
  for (const item of failed)
    console.error(`::error::${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  process.exit(1)
}
console.log(`\na11y OK — ${results.length} checks`)
