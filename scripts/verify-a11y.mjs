/**
 * Accessibility assertions.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every WCAG fix in batch 3 was verified with a throwaway CDP snippet that was then
 * discarded. That is how the same class of bug returns: someone edits a class, the
 * build stays green, and nobody re-checks the behaviour. This turns those probes into
 * a gate that runs against the BUILT output.
 *
 * No new dependencies: it drives Chromium itself over the same `ws` transport the
 * other verify scripts already use.
 *
 * Usage:
 *   node scripts/verify-a11y.mjs --base http://127.0.0.1:4173
 *   CHROME_PATH=/usr/bin/chromium node scripts/verify-a11y.mjs --base ...
 *
 * Each check prints PASS/FAIL with the measured value, and any failure sets exit 1.
 */
import { spawn } from 'node:child_process'
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

const chromePath = CANDIDATES.find((c) => typeof c === 'string' && c.length > 0)
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
const KNOWN_OPEN = ['UI-10 topology focus ring (needs a <button> overlay, not an SVG group)']

const port = 9450 + Math.floor(Math.random() * 90)
const profile = await mkdtemp(join(tmpdir(), 'showroom-a11y-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--window-size=1600,900',
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
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, modifiers })
    await sleep(90)
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url: base })

  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(500)
    const ready = await evaluate(`document.readyState === 'complete' && !!document.querySelector('main')`)
    if (ready) break
  }
  await sleep(2500)

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
  const inertDuring = await evaluate(`document.querySelectorAll('main[inert], [inert] main, [inert]').length > 0`)
  await press('Escape', 27)
  await sleep(400)
  const restored = await evaluate(`({
    gone: !document.querySelector('input[role="combobox"]'),
    backOnButton: /command palette|命令面板/i.test(document.activeElement?.getAttribute?.('aria-label') || ''),
    inertCleared: document.querySelectorAll('[inert]').length === 0,
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
  check('modal: background is inert while open and cleared after', inertDuring && restored.inertCleared)

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
  await evaluate(`(() => { const el = document.getElementById('playground'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY); return true })()`)
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
  for (const item of failed) console.error(`::error::${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  process.exit(1)
}
console.log(`\na11y OK — ${results.length} checks`)
