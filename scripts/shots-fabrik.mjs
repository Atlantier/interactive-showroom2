/**
 * Captures presentation screenshots of the FABRIK sandbox.
 *
 * Scrolls the FABRIK panel (the second canvas inside #playground) to the centre
 * of the viewport before each shot, because the playground section stacks two
 * sandboxes and a plain `scrollIntoView` on the section leaves this one below
 * the fold.
 *
 * Run: node scripts/shots-fabrik.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9348'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5268'

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
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const entry = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
    else entry.resolve(msg.result)
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
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(7000)

mkdirSync('screenshots', { recursive: true })

/** Centre the FABRIK panel in the viewport. */
const centrePanel = () =>
  run(function centre() {
    const canvases = document.querySelectorAll('#playground canvas')
    const c = canvases[1]
    if (!c) return false
    const wrap = c.parentElement
    const r = wrap.getBoundingClientRect()
    window.scrollBy(0, r.top + r.height / 2 - window.innerHeight / 2)
    return true
  })

const shoot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`screenshots/${name}.png`, Buffer.from(s.data, 'base64'))
}

/* ── Arm, tracking ──────────────────────────────────────────────────────── */
await centrePanel()
await sleep(1200)
await run(function aim() {
  const canvases = document.querySelectorAll('#playground canvas')
  const c = canvases[1]
  const r = c.getBoundingClientRect()
  window.__fabrik.pointer(r.width * 0.74, r.height * 0.2)
  window.__fabrik.step(150, 1 / 60)
  return true
})
await sleep(500)
await shoot('94-arm-tracking')

/* ── Arm, mid-laser ─────────────────────────────────────────────────────── */
await run(function fire() {
  window.__fabrik.fire()
  return true
})
// Only a couple of real frames: the pulse lasts 0.34 s and the RAF loop advances
// it, so waiting longer would capture an already-faded beam.
await sleep(60)
await shoot('95-arm-laser')

/* ── Arm, debug overlay ─────────────────────────────────────────────────── */
await run(function debugOn() {
  const s = document.getElementById('playground')
  const boxes = Array.from(s.querySelectorAll('input[type="checkbox"]'))
  const box = boxes.find((b) => /show ik vectors/i.test(b.closest('label')?.textContent ?? ''))
  if (box && !box.checked) box.click()
  return true
})
await sleep(900)
await run(function aim2() {
  const canvases = document.querySelectorAll('#playground canvas')
  const r = canvases[1].getBoundingClientRect()
  window.__fabrik.pointer(r.width * 0.62, r.height * 0.3)
  window.__fabrik.step(120, 1 / 60)
  return true
})
await sleep(500)
await shoot('96-arm-debug')

/* ── Creature, walking ──────────────────────────────────────────────────── */
await run(function switchMode() {
  const s = document.getElementById('playground')
  const btn = Array.from(s.querySelectorAll('button')).find((b) => /四足/.test(b.textContent ?? ''))
  if (btn) btn.click()
  return true
})
await sleep(900)
await centrePanel()
await sleep(600)

// Walk it, then stop stepping at a moment when a landing ripple is mid-expansion
// so the shot actually shows the ring rather than an empty frame.
const catchRipple = () =>
  run(function walkToRipple() {
    const canvases = document.querySelectorAll('#playground canvas')
    const r = canvases[1].getBoundingClientRect()
    window.__fabrik.pointer(r.width * 0.82, r.height * 0.42)
    window.__fabrik.step(140, 1 / 60)
    for (let i = 0; i < 600; i++) {
      window.__fabrik.step(1, 1 / 60)
      const cr = window.__fabrik.creature()
      const live = cr.ripples.filter((x) => x.alive)
      // Land on a ripple that is early in its life; the capture takes a few
      // frames, so starting early means it is still bright when the PNG is made.
      if (live.length > 0 && live[0].t > 0.06 && live[0].t < 0.3) return true
    }
    return false
  })

await catchRipple()
await shoot('97-creature-walk')

/* ── Creature, debug overlay ────────────────────────────────────────────── */
await run(function debugWalk() {
  const canvases = document.querySelectorAll('#playground canvas')
  const r = canvases[1].getBoundingClientRect()
  window.__fabrik.pointer(r.width * 0.12, r.height * 0.7)
  window.__fabrik.step(40, 1 / 60)
  return true
})
await catchRipple()
await shoot('98-creature-debug')

console.log('screenshots written')
ws.close()
