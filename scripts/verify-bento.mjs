/**
 * Verifies the Bento grid + SpotlightCard implementation.
 * Run: node scripts/verify-bento.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9338'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5260'

function installHelpers() {
  const bento = {
    cards() { return Array.from(document.querySelectorAll('[data-spotlight-card]')) },
    grid() { return this.cards()[0].parentElement },
    layoutBox(el) {
      let x = 0, y = 0, n = el
      while (n) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent }
      return { docLeft: x, docTop: y, width: el.offsetWidth, height: el.offsetHeight }
    },
    parseRotation(m) {
      if (!m || m === 'none') return { rx: 0, ry: 0 }
      if (m.indexOf('matrix3d') === 0) {
        const v = m.slice(9, -1).split(',').map(Number)
        return {
          rx: Math.round(((Math.atan2(-v[9], v[10]) * 180) / Math.PI) * 100) / 100,
          ry: Math.round(((Math.atan2(v[2], v[0]) * 180) / Math.PI) * 100) / 100,
        }
      }
      const v = m.slice(7, -1).split(',').map(Number)
      return {
        rx: Math.round(((Math.atan2(v[1], v[0]) * 180) / Math.PI) * 100) / 100,
        ry: Math.round(((Math.atan2(-v[2], v[0]) * 180) / Math.PI) * 100) / 100,
      }
    },
    transformOf(el) { return getComputedStyle(el).transform },
    move(cx, cy) {
      this.grid().dispatchEvent(new PointerEvent('pointermove', {
        clientX: cx, clientY: cy, bubbles: true, pointerType: 'mouse',
      }))
    },
  }
  window.__bento = bento
  return { installed: true, cardCount: bento.cards().length }
}

function probeStructure() {
  const cards = window.__bento.cards()
  const grid = window.__bento.grid()
  return {
    cardCount: cards.length,
    gridDisplay: getComputedStyle(grid).display,
    gridColumns: getComputedStyle(grid).gridTemplateColumns,
    cardSpans: cards.map((c) => ({
      col: getComputedStyle(c).gridColumn,
      row: getComputedStyle(c).gridRow,
    })),
    hasCanvasChart: cards.some((c) => c.querySelector('canvas') !== null),
    hasSvgTopology: cards.some((c) => c.querySelector('svg [role="button"]') !== null),
    hasTerminal: cards.some((c) => (c.textContent || '').includes('zsh')),
  }
}

async function probeLocalCoordinates() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const cards = window.__bento.cards()
  const box0 = window.__bento.layoutBox(cards[0])
  const targetDocX = box0.docLeft + 40
  const targetDocY = box0.docTop + 30
  const targetX = targetDocX - window.scrollX
  const targetY = targetDocY - window.scrollY

  window.__bento.move(targetX, targetY)
  await wait(260)

  const all = cards.map((c, i) => {
    const b = window.__bento.layoutBox(c)
    const lx = parseFloat(c.style.getPropertyValue('--mouse-x'))
    const ly = parseFloat(c.style.getPropertyValue('--mouse-y'))
    const expX = targetDocX - b.docLeft
    const expY = targetDocY - b.docTop
    return {
      index: i,
      localX: Math.round(lx), localY: Math.round(ly),
      expectedX: Math.round(expX), expectedY: Math.round(expY),
      matches: Math.abs(lx - expX) < 1.5 && Math.abs(ly - expY) < 1.5,
    }
  })

  return {
    allCards: all,
    everyCardLocalAndCorrect: all.every((c) => c.matches),
    cardsUpdatedByOneEvent: all.filter((c) => Number.isFinite(c.localX)).length,
    isLocalNotViewport: all.some((c) => Math.abs(c.localX - targetX) > 5),
  }
}

async function probeOutsideGlow() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const cards = window.__bento.cards()
  const box = window.__bento.layoutBox(cards[0])
  window.__bento.move(box.docLeft + box.width / 2 - window.scrollX, box.docTop - 60 - window.scrollY)
  await wait(240)
  const my = parseFloat(cards[0].style.getPropertyValue('--mouse-y'))
  return { mouseY: Math.round(my), isOutside: my < -10 }
}

async function probeTilt() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const cards = window.__bento.cards()
  const card = cards[0]
  const box = window.__bento.layoutBox(card)
  const midY = box.docTop + box.height / 2 - window.scrollY

  window.__bento.move(box.docLeft + box.width - 6 - window.scrollX, midY)
  await wait(1000)
  const rightEdge = window.__bento.parseRotation(window.__bento.transformOf(card))

  window.__bento.move(box.docLeft + 6 - window.scrollX, midY)
  await wait(1000)
  const leftEdge = window.__bento.parseRotation(window.__bento.transformOf(card))

  window.__bento.move(2, 2)
  await wait(1700)
  const afterLeave = window.__bento.parseRotation(window.__bento.transformOf(card))

  return {
    rightEdge, leftEdge, afterLeave,
    opposesSign: Math.sign(rightEdge.ry) !== Math.sign(leftEdge.ry),
    reachesLimit: Math.abs(rightEdge.ry) > 5,
    withinLimit: Math.abs(rightEdge.ry) <= 8.5 && Math.abs(leftEdge.ry) <= 8.5,
    settlesBack: Math.abs(afterLeave.ry) < 0.8 && Math.abs(afterLeave.rx) < 0.8,
    transformStyle: getComputedStyle(card).transformStyle,
  }
}

function probeContentLift() {
  const card = window.__bento.cards()[0]
  const inner = card.querySelector(':scope > div')
  return {
    transform: inner ? inner.style.transform : null,
    hasTranslateZ: inner ? inner.style.transform.indexOf('translateZ(30px)') !== -1 : false,
  }
}

async function probeMicroWidgets() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const cards = window.__bento.cards()

  const chartCard = cards.find((c) => c.querySelector('canvas'))
  const readChart = () => {
    const m = (chartCard.textContent || '').match(/([\d,]+)\s*tok/)
    return m ? m[0] : null
  }
  const chartA = readChart()
  await wait(1600)
  const chartB = readChart()
  const canvas = chartCard.querySelector('canvas')

  const topoCard = cards.find((c) => c.querySelector('svg [role="button"]'))
  const nodes = Array.from(topoCard.querySelectorAll('svg [role="button"]'))
  const caption = topoCard.querySelector('p')
  const capBefore = caption ? caption.textContent.trim() : null
  nodes[nodes.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(400)
  const capAfter = caption ? caption.textContent.trim() : null

  const termCard = cards.find((c) => (c.textContent || '').includes('zsh'))
  const termA = (termCard.textContent || '').length
  await wait(1800)
  const termB = (termCard.textContent || '').length

  return {
    chart: {
      a: chartA, b: chartB, changed: chartA !== chartB,
      canvasW: canvas.width, canvasH: canvas.height,
      canvasDrawn: canvas.width > 0 && canvas.height > 0,
    },
    topology: { nodeCount: nodes.length, capBefore, capAfter, changed: capBefore !== capAfter },
    terminal: { lenA: termA, lenB: termB, typing: termA !== termB },
  }
}

const targets = await (await fetch(CDP_HTTP + '/json/list')).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })

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

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})

const run = async (fnOrExpr) => {
  const expression = typeof fnOrExpr === 'function' ? '(' + fnOrExpr.toString() + ')()' : fnOrExpr
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) {
    return { __error: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text }
  }
  return res.result?.value
}

const moveMouse = (x, y) => send('Input.dispatchMouseEvent', {
  type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse',
})

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(6500)

await run("document.getElementById('gallery')?.scrollIntoView({ block: 'start' }); true")
await sleep(1800)

const report = {}
report.install = await run(installHelpers)

if (!report.install || report.install.__error) {
  report.fatal = 'helpers failed to install'
} else {
  report.structure = await run(probeStructure)
  report.localCoordinates = await run(probeLocalCoordinates)
  report.outsideGlow = await run(probeOutsideGlow)
  report.tilt = await run(probeTilt)
  report.contentLift = await run(probeContentLift)
  report.microWidgets = await run(probeMicroWidgets)
}

mkdirSync('screenshots', { recursive: true })
await run('window.__bento.move(2, 2); true')
await sleep(1000)
const shotRest = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/20-bento-rest.png', Buffer.from(shotRest.data, 'base64'))

const hoverPoint = await run(function hoverPoint() {
  const card = window.__bento.cards()[0]
  const r = card.getBoundingClientRect()
  return { x: Math.round(r.left + r.width * 0.45), y: Math.round(r.top + 24) }
})
await moveMouse(hoverPoint.x, hoverPoint.y)
await sleep(1000)
const shotHover = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/21-bento-hover.png', Buffer.from(shotHover.data, 'base64'))

report.exceptions = exceptions
report.consoleErrors = consoleErrors
writeFileSync('screenshots/bento-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
ws.close()