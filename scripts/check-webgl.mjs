/**
 * Does the browser behind CDP have WebGL2 at all?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The first attempt to run the architecture probe in CI failed, correctly: on a runner with no
 * GPU the app takes its no-WebGL fallback, so the probe reported `A3_canvas: {found: false}` and
 * the rest of the scene assertions came back false. That is the probe working -- but the failure
 * reads like "the app is broken" when the actual cause is "this machine has no GL".
 *
 * So the probe step asks this question first, separately, and prints the answer. A missing GL
 * context is one clear line instead of fifteen false assertions.
 *
 * Usage: CDP_HTTP=http://127.0.0.1:9411 node scripts/check-webgl.mjs
 */
import WebSocket from 'ws'

const endpoint = process.env.CDP_HTTP ?? 'http://127.0.0.1:9340'

let list
try {
  list = await (await fetch(`${endpoint}/json/list`)).json()
} catch (error) {
  console.error(
    `::error::check-webgl: cannot reach ${endpoint} (${String(error?.message ?? error)})`,
  )
  process.exit(1)
}

const page = list.find((entry) => entry.type === 'page')
if (!page) {
  console.error('::error::check-webgl: no page target')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})

const result = await new Promise((resolve, reject) => {
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id !== 1) return
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  })
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(() => {
          const canvas = document.createElement('canvas')
          const gl = canvas.getContext('webgl2')
          if (!gl) return { ok: false }
          const debug = gl.getExtension('WEBGL_debug_renderer_info')
          return {
            ok: true,
            version: gl.getParameter(gl.VERSION),
            renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown',
          }
        })()`,
        returnByValue: true,
      },
    }),
  )
})
ws.close()

const value = result?.result?.value
if (!value?.ok) {
  console.error('::error::check-webgl: browser has no WebGL2 context')
  console.error(
    '        headless Chrome needs software WebGL requested explicitly on a GPU-less host:',
  )
  console.error('        --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader')
  process.exit(1)
}

console.log(`check-webgl OK — ${value.version} (${value.renderer})`)
