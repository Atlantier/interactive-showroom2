/**
 * Captures the navbar spectrum meter while it is actually moving.
 *
 * A single sound decays within a few hundred milliseconds, and a CDP screenshot
 * takes longer than that — so the capture retriggers the activation chord every
 * 90 ms (well past the engine's 40 ms throttle) to hold the columns up while the
 * PNG is taken.
 *
 * Run: node scripts/shots-spectrum.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9352'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5272'

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

const evalAsync = async (expression) => {
  const res = await send('Runtime.evaluate', {
    expression,
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
  width: 1500,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(7000)

mkdirSync('screenshots', { recursive: true })

await evalAsync(`(async () => {
  const store = await import('/src/store/useAppStore.ts')
  store.useAppStore.getState().setSoundEnabled(true)
  await new Promise((r) => setTimeout(r, 400))
  return true
})()`)
await sleep(600)

// Hold the meter up with a repeating chord, then shoot.
await evalAsync(`(async () => {
  const mod = await import('/src/utils/soundEngine.ts')
  window.__holdTimer = setInterval(() => {
    mod.soundEngine.playCardActivate()
  }, 90)
  return true
})()`)
await sleep(600)

const shotA = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/99-spectrum-meter.png', Buffer.from(shotA.data, 'base64'))

// A second frame with a high-frequency voice so the columns differ visibly.
await evalAsync(`(async () => {
  clearInterval(window.__holdTimer)
  const mod = await import('/src/utils/soundEngine.ts')
  window.__holdTimer = setInterval(() => {
    mod.soundEngine.playHoverTick()
  }, 70)
  return true
})()`)
await sleep(600)
const shotB = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/100-spectrum-tick.png', Buffer.from(shotB.data, 'base64'))

await evalAsync('clearInterval(window.__holdTimer); true')
console.log('screenshots written')
ws.close()
