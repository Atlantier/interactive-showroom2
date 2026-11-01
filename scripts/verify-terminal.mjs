/**
 * Verifies the interactive terminal and the tilt/settle fixes.
 *
 * Terminal checks:
 *   T1. Card starts in demo mode.
 *   T2. Clicking switches to interactive mode with a focusable input.
 *   T3. `help` prints the command list.
 *   T4. `skills` prints ASCII art + proficiency rows.
 *   T5. `matrix` prints falling-glyph art (and differs between runs).
 *   T6. `clear` empties the scrollback.
 *   T7. Unknown input prints the not-found art.
 *
 * Tilt checks:
 *   S1. translateZ(30px) actually affects rendering (the parallax is real).
 *   S2. Settle is monotonic (no edge crawl / jitter).
 *   S3. Hardware-acceleration declarations are present.
 *
 * Run: node scripts/verify-terminal.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9339'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5261'

/* -------------------------------------------------------------------------- */
/*  Page-side helpers (serialised as real functions)                          */
/* -------------------------------------------------------------------------- */

function installTerminalHelpers() {
  const findAll = () => Array.from(document.querySelectorAll('[data-spotlight-card]'))
  const termCard = () => findAll().find((c) => (c.textContent || '').includes('zsh'))
  window.__term = {
    card: termCard,
    screen() {
      const c = termCard()
      return c ? c.querySelector('input').parentElement : null
    },
    text() {
      const s = this.screen()
      return s ? s.innerText : ''
    },
    input() {
      const c = termCard()
      return c ? c.querySelector('input') : null
    },
    mode() {
      const c = termCard()
      if (!c) return 'no-card'
      return (c.textContent || '').includes('interactive') ? 'interactive' : 'demo'
    },
    /** Focus the terminal by clicking its screen. */
    focus() {
      const s = this.screen()
      if (s) s.click()
      return true
    },
  }
  return { ok: true, cardFound: Boolean(termCard()) }
}

/** Type a string into the focused input via the native setter + input event. */
function typeInto(selectorValue) {
  const input = window.__term.input()
  if (!input) return { ok: false, reason: 'no input' }
  input.focus()
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  ).set
  setter.call(input, selectorValue)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true, value: input.value }
}

/** Press Enter on the focused input. */
function pressEnter() {
  const input = window.__term.input()
  if (!input) return { ok: false }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return { ok: true }
}

/** Snapshot the terminal text. */
function readTerminalText() {
  return window.__term.text()
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

const run = async (fn, ...args) => {
  const call =
    typeof fn === 'function'
      ? '(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')'
      : fn
  const res = await send('Runtime.evaluate', {
    expression: call,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    return { __error: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text }
  }
  return res.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1100,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(6500)

await run("document.getElementById('gallery')?.scrollIntoView({ block: 'start' }); true")
await sleep(1800)

const report = {}
report.install = await run(installTerminalHelpers)

/* ── T1: demo mode at rest ───────────────────────────────────────────────── */
report.T1_demoMode = await run(function t1() {
  return { mode: window.__term.mode(), hasInput: Boolean(window.__term.input()) }
})

/* ── T2: click to take over ──────────────────────────────────────────────── */
report.T2_takeOver = await run(function t2() {
  window.__term.focus()
  return new Promise((r) =>
    setTimeout(() => {
      const input = window.__term.input()
      r({
        mode: window.__term.mode(),
        focused: document.activeElement === input,
        text: window.__term.text().slice(0, 120),
      })
    }, 400),
  )
})

/* ── T3..T7: commands ────────────────────────────────────────────────────── */
const runCmd = async (cmd) => {
  await run(typeInto, cmd)
  await sleep(120)
  await run(pressEnter)
  await sleep(420)
  return run(readTerminalText)
}

report.T3_help = await runCmd('help')
report.T4_skills = await runCmd('skills')
report.T5_matrix_a = await runCmd('matrix')
await sleep(200)
report.T5_matrix_b = await runCmd('matrix')
report.T6_unknown = await runCmd('bogus')
report.T7_clear = await runCmd('clear')

/* ── Derived assertions ──────────────────────────────────────────────────── */
report.assertions = {
  demoAtRest: report.T1_demoMode?.mode === 'demo',
  becameInteractive: report.T2_takeOver?.mode === 'interactive',
  inputFocused: report.T2_takeOver?.focused === true,
  helpListsCommands:
    typeof report.T3_help === 'string' &&
    ['help', 'skills', 'matrix', 'clear'].every((c) => report.T3_help.includes(c)),
  skillsShowsArt:
    typeof report.T4_skills === 'string' &&
    (report.T4_skills.includes('█') || report.T4_skills.includes('╗')),
  matrixShowsGlyphs:
    typeof report.T5_matrix_a === 'string' && /[ｱ-ﾝ]/.test(report.T5_matrix_a),
  matrixDiffersBetweenRuns: report.T5_matrix_a !== report.T5_matrix_b,
  unknownShowsError:
    typeof report.T6_unknown === 'string' &&
    // The art is letter-spaced for visual weight ("C O M M A N D  N O T …").
    // Assert on the individual spaced letters rather than the plain phrase, and
    // tolerate any run of spaces between words so the check survives an art
    // width tweak (the frame was narrowed once already).
    /C\s+O\s+M\s+M\s+A\s+N\s+D/.test(report.T6_unknown) &&
    /F\s+O\s+U\s+N\s+D/.test(report.T6_unknown),
  clearEmpties:
    typeof report.T7_clear === 'string' && report.T7_clear.trim().length < 20,
}

/* ── Tilt / settle checks ────────────────────────────────────────────────── */
report.tilt = await run(function tiltCheck() {
  return new Promise((resolve) => {
    const cards = Array.from(document.querySelectorAll('[data-spotlight-card]'))
    const card = cards[0]
    const grid = card.parentElement
    let bx = 0
    let by = 0
    let n = card
    while (n) {
      bx += n.offsetLeft
      by += n.offsetTop
      n = n.offsetParent
    }

    const boxOf = (el) => {
      const r = el.getBoundingClientRect()
      return { x: +r.x.toFixed(3), y: +r.y.toFixed(3), w: +r.width.toFixed(3) }
    }
    const content = card.querySelector(':scope > div > div')

    // Strong tilt, held.
    grid.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: bx + card.offsetWidth - 8 - scrollX,
        clientY: by + card.offsetHeight * 0.15 - scrollY,
        bubbles: true,
        pointerType: 'mouse',
      }),
    )

    setTimeout(() => {
      const withZ = boxOf(content)
      const original = content.style.transform
      content.style.transform = 'translateZ(0px)'
      setTimeout(() => {
        const withZero = boxOf(content)
        content.style.transform = original
        const deltaW = Math.abs(withZ.w - withZero.w)
        const zHasEffect = deltaW > 0.05 || Math.abs(withZ.x - withZero.x) > 0.05

        // Now release and watch the settle for width jitter.
        const widths = []
        grid.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: 2,
            clientY: 2,
            bubbles: true,
            pointerType: 'mouse',
          }),
        )
        let i = 0
        const step = () => {
          widths.push(+card.getBoundingClientRect().width.toFixed(3))
          i += 1
          if (i < 45) requestAnimationFrame(step)
          else {
            let flips = 0
            for (let k = 2; k < widths.length; k++) {
              const d1 = widths[k - 1] - widths[k - 2]
              const d2 = widths[k] - widths[k - 1]
              if (Math.sign(d1) !== Math.sign(d2) && Math.abs(d2) > 0.01) flips++
            }
            const cs = getComputedStyle(card)
            const clip = getComputedStyle(card.querySelector(':scope > div'))
            resolve({
              zHasEffect,
              deltaW: +deltaW.toFixed(3),
              settleFlips: flips,
              settleMonotonic: flips === 0,
              outer: {
                transformStyle: cs.transformStyle,
                overflow: cs.overflow,
                willChange: cs.willChange,
                backface: cs.backfaceVisibility,
                perspective: cs.perspective,
              },
              clip: {
                overflow: clip.overflow,
                transformStyle: clip.transformStyle,
                perspective: clip.perspective,
              },
            })
          }
        }
        requestAnimationFrame(step)
      }, 160)
    }, 1200)
  })
})

/* ── Screenshots of each command ─────────────────────────────────────────── */
mkdirSync('screenshots', { recursive: true })

const shoot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`screenshots/${name}.png`, Buffer.from(s.data, 'base64'))
}

// Re-focus and replay commands for the screenshots, one at a time.
await run(function refocus() {
  window.__term.focus()
  return true
})
await sleep(300)

await run(typeInto, 'help')
await run(pressEnter)
await sleep(500)
await shoot('40-terminal-help')

await run(typeInto, 'skills')
await run(pressEnter)
await sleep(500)
await shoot('41-terminal-skills')

await run(typeInto, 'matrix')
await run(pressEnter)
await sleep(500)
await shoot('42-terminal-matrix')

report.exceptions = exceptions
report.consoleErrors = consoleErrors
writeFileSync('screenshots/terminal-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
ws.close()
