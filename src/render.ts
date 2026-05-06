/**
 * Chromium renderer driven via raw CDP (target-level WebSocket).
 *
 * Why raw CDP target-level: any path that goes through browser-level
 * session multiplexing (Target.attachToTarget+flatten OR Playwright wrapper)
 * perturbs Skia glyph advance. Verified empirically (Wanted Sans Variable
 * "초기화" 12px):
 *   raw target-level ws:           advance 31.11  (matches figma)
 *   browser-level + sessionId:     advance 33.12
 *   Playwright wrapper:            advance 33.12
 * 31.11 is what figma's `Math.ceil(advance - 0.05)` rule needs to match.
 *
 * Process-level viewport (chrome --window-size flag) — NEVER call
 * `Emulation.setDeviceMetricsOverride`, which also perturbs advance.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

// Mirror agent-browser's flag set verbatim. agent-browser produces stable
// figma-matching Skia advance (31.11 for "초기화" 12px, 5/5 runs); deviations
// from this set (e.g. adding --font-render-hinting=none) destabilize advance.
const LOCKED_FLAGS = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-backgrounding-occluded-windows',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--disable-features=Translate',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
  '--noerrdialogs',
  '--ozone-platform=headless',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader-webgl',
]

/** Layout-side device pixel ratio. Fixed at 1 — only dpr=1 produces unbinned
 * Skia advance matching figma's text engine. */
const VERIFY_DPR = 1

function findChromeExecutable(): string {
  for (const p of [
    process.env.CHROME_PATH,
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    if (p && existsSync(p)) return p
  }
  throw new Error('No Chrome executable found. Set CHROME_PATH env var.')
}

interface CdpResponse { id: number; result?: unknown; error?: { message: string } }
interface CdpEvent { method: string; params: unknown }
type EventListener = (params: unknown) => void

/** Minimal CDP client over a target-level WebSocket. No sessionId multiplexing. */
class CdpClient {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, EventListener[]>()

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as CdpResponse | CdpEvent
      if ('id' in msg) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
      } else {
        const ls = this.listeners.get(msg.method)
        if (ls) for (const l of ls) l(msg.params)
      }
    })
  }
  async ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
  }
  send<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    if (process.env.PIXPEC_CDP_LOG) {
      const exp = (params as { expression?: string })?.expression
      process.stderr.write(`[cdp] ${method}${exp ? ' ' + exp.slice(0, 60) : ''}\n`)
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject })
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }
  on(method: string, listener: EventListener): () => void {
    const arr = this.listeners.get(method) ?? []
    arr.push(listener)
    this.listeners.set(method, arr)
    return () => {
      const next = this.listeners.get(method)?.filter((l) => l !== listener) ?? []
      this.listeners.set(method, next)
    }
  }
  waitForEvent(method: string, timeoutMs = 120_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => { off(); clearTimeout(timer); resolve(params) })
      const timer = setTimeout(() => { off(); reject(new Error(`waitForEvent ${method} timeout`)) }, timeoutMs)
    })
  }
  close(): void { this.ws.close() }
}

async function findFreePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

async function launchChrome(
  extraArgs: string[],
  viewport: { width: number; height: number },
): Promise<{ proc: ChildProcess; targetWsUrl: string; userDataDir: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'pixpec-chrome-'))
  const port = await findFreePort()
  const exe = findChromeExecutable()
  // Process-level viewport — avoids Emulation.setDeviceMetricsOverride
  // which perturbs Skia advance.
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    ...LOCKED_FLAGS,
    `--window-size=${viewport.width},${viewport.height}`,
    `--ozone-override-screen-size=${viewport.width},${viewport.height}`,
    ...extraArgs,
  ]
  const proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout?.on('data', () => {})
  proc.stderr?.on('data', () => {})
  let targetWsUrl: string | undefined
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) { targetWsUrl = page.webSocketDebuggerUrl; break }
    } catch { /* not ready */ }
    await sleep(100)
  }
  if (!targetWsUrl) {
    proc.kill()
    throw new Error('Chrome failed to expose CDP page target within 15s')
  }
  return { proc, targetWsUrl, userDataDir }
}

export interface RenderUrlOptions {
  url: string
  outPath: string
  viewport: { width: number; height: number }
  outputScale: number
  remBase: number
  clipSelector?: string
  waitForFonts?: boolean
  settleMs?: number
}

export interface BatchSession {
  waitMounted(expectedCount: number): Promise<void>
  screenshot(selector: string, outPath: string): Promise<void>
  screenshotMany(items: { selector: string; outPath: string }[]): Promise<void>
  close(): Promise<void>
}

export class Renderer {
  private enabled = false
  private constructor(
    private proc: ChildProcess,
    private cdp: CdpClient,
    private userDataDir: string,
  ) {}

  static async create(
    extraArgs: string[] = [],
    viewport: { width: number; height: number } = { width: 4000, height: 8000 },
  ): Promise<Renderer> {
    const { proc, targetWsUrl, userDataDir } = await launchChrome(extraArgs, viewport)
    const cdp = new CdpClient(targetWsUrl)
    await cdp.ready()
    return new Renderer(proc, cdp, userDataDir)
  }

  private async enable(): Promise<void> {
    if (this.enabled) return
    await this.cdp.send('Page.enable')
    await this.cdp.send('Runtime.enable')
    this.cdp.on('Runtime.consoleAPICalled', (params) => {
      const p = params as { type: string; args: Array<{ value?: unknown }> }
      if (p.type === 'error' || process.env.PIXPEC_DEBUG) {
        const text = p.args.map((a) => typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value ?? '')).join(' ')
        process.stderr.write(`[browser:${p.type}] ${text}\n`)
      }
    })
    this.cdp.on('Runtime.exceptionThrown', (params) => {
      const p = params as { exceptionDetails: { text: string; exception?: { description?: string } } }
      process.stderr.write(`[browser:exception] ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}\n`)
    })
    this.enabled = true
  }

  private buildInitScript(remPx: number): string {
    // Warm Skia advance cache to figma-matching state BEFORE entry.ts
    // commits layout. Without warmup, Skia oscillates between binned/unbinned
    // advance for the first several measureText calls; whichever state is
    // active at layout time gets baked into the rendered output.
    return `(function(){
  var apply=function(){if(document.documentElement)document.documentElement.style.fontSize="${remPx}px";};
  apply();
  document.addEventListener("readystatechange",apply);
  // Skia advance warmup. Repeated measureText calls settle the binning state.
  var c=document.createElement("canvas").getContext("2d");
  for(var i=0;i<50;i++){c.font='500 12px "Wanted Sans Variable"';c.measureText("초기화");c.font='500 14px "Wanted Sans Variable"';c.measureText("~");}
})();`
  }

  private async eval<T>(expression: string, awaitPromise = false): Promise<T> {
    const r = await this.cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
    )
    if (r.exceptionDetails) {
      throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    }
    return r.result.value as T
  }

  private async navigateAndWaitReady(url: string, remPx: number, opts: { waitForFonts?: boolean; settleMs?: number }): Promise<void> {
    // Inject html font-size before any page script runs.
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: this.buildInitScript(remPx) })
    void opts.waitForFonts
    void opts.settleMs
    const loaded = this.cdp.waitForEvent('Page.loadEventFired')
    await this.cdp.send('Page.navigate', { url })
    await loaded
    // @font-face fetch can outlive load event (font-display:block blocks
    // render but not the event). Wait for fonts.status="loaded" then call
    // __pixpecReady to apply harness post-mount fixes (SVG snap, Y-shift).
    await sleep(800)
    await this.eval(`(window.__pixpecReady && !window.__pixpecReadyDone && window.__pixpecReady.then(()=>{window.__pixpecReadyDone = true}), true)`)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (await this.eval<boolean>(`window.__pixpecReadyDone === true || typeof window.__pixpecReady === "undefined"`)) break
      await sleep(20)
    }
  }

  /** Poll `document.fonts.status === "loaded"` without awaitPromise. */
  private async pollFontsLoaded(): Promise<boolean> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const ok = await this.eval<boolean>(`document.fonts.status === "loaded"`)
      if (ok) return true
      await sleep(50)
    }
    return false
  }

  /** Poll `window.__pixpecReady === undefined || window.__pixpecReadyDone === true`.
   * Harness must set the latter when the Promise resolves. */
  private async pollPixpecReady(): Promise<void> {
    // First check if the harness even has the Promise.
    const hasReady = await this.eval<boolean>(`typeof window.__pixpecReady !== "undefined"`)
    if (!hasReady) return
    // Add a then() that flips a flag — done via addScriptToEvaluateOnNewDocument
    // doesn't help post-load; just inject inline.
    await this.eval(
      `(window.__pixpecReady && !window.__pixpecReadyDone && window.__pixpecReady.then(()=>{window.__pixpecReadyDone = true}), true)`,
    )
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const done = await this.eval<boolean>(`window.__pixpecReadyDone === true`)
      if (done) return
      await sleep(20)
    }
    process.stderr.write('[pixpec] __pixpecReady did not resolve in 30s\n')
  }

  async renderUrl(opts: RenderUrlOptions): Promise<void> {
    await this.enable()
    const remPx = opts.remBase * opts.outputScale / VERIFY_DPR
    await this.navigateAndWaitReady(opts.url, remPx, opts)
    const targetSel = opts.clipSelector ?? '#pixpec-target'
    const bounds = await this.eval<{ x: number; y: number; w: number; h: number } | null>(
      `(()=>{const el=document.querySelector(${JSON.stringify(targetSel)});if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`,
    )
    if (!bounds) throw new Error(`renderUrl: target ${targetSel} not found`)
    const { data } = await this.cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h, scale: VERIFY_DPR },
      captureBeyondViewport: true,
      fromSurface: true,
    })
    await writeFile(opts.outPath, Buffer.from(data, 'base64'))
  }

  async openBatch(opts: { url: string; viewport: { width: number; height: number }; outputScale: number; remBase: number }): Promise<BatchSession> {
    await this.enable()
    const remPx = opts.remBase * opts.outputScale / VERIFY_DPR
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: this.buildInitScript(remPx) })
    const loaded = this.cdp.waitForEvent('Page.loadEventFired')
    await this.cdp.send('Page.navigate', { url: opts.url })
    await loaded
    // Wait for @font-face load (see navigateAndWaitReady comment).
    await sleep(800)
    const dpr = VERIFY_DPR
    const cdp = this.cdp
    const evalFn = <T,>(expression: string, awaitPromise = false): Promise<T> => this.eval<T>(expression, awaitPromise)
    return {
      waitMounted: async (expectedCount: number) => {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const n = await evalFn<number>(`document.querySelectorAll('[data-case]').length`)
          if ((n ?? 0) >= expectedCount) break
          await sleep(50)
        }
        // Wait for fonts (load event fires before @font-face fetch completes).
        await sleep(800)
        // Run __pixpecReady (harness SVG snap + Y-shift).
        await evalFn(`(window.__pixpecReady && !window.__pixpecReadyDone && window.__pixpecReady.then(()=>{window.__pixpecReadyDone = true}), true)`)
        const readyDeadline = Date.now() + 30_000
        while (Date.now() < readyDeadline) {
          if (await evalFn<boolean>(`window.__pixpecReadyDone === true || typeof window.__pixpecReady === "undefined"`)) break
          await sleep(20)
        }
      },
      screenshot: async (selector: string, outPath: string) => {
        const b = await evalFn<{ x: number; y: number; w: number; h: number } | null>(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`,
        )
        if (!b) throw new Error(`screenshot: selector not found: ${selector}`)
        const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
          clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: dpr },
          captureBeyondViewport: true,
          fromSurface: true,
        })
        await writeFile(outPath, Buffer.from(data, 'base64'))
      },
      screenshotMany: async (items) => {
        const selectors = items.map((it) => it.selector)
        const bounds = await evalFn<Array<{ x: number; y: number; w: number; h: number } | null>>(
          `(${JSON.stringify(selectors)}).map(s=>{const el=document.querySelector(s);if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})`,
        )
        for (let i = 0; i < bounds.length; i++) {
          if (!bounds[i]) throw new Error(`screenshotMany: selector not found: ${selectors[i]}`)
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const b of bounds) {
          if (!b) continue
          if (b.x < minX) minX = b.x
          if (b.y < minY) minY = b.y
          if (b.x + b.w > maxX) maxX = b.x + b.w
          if (b.y + b.h > maxY) maxY = b.y + b.h
        }
        const PAD = 1
        const clipX = minX - PAD
        const clipY = minY - PAD
        const unionW = maxX - minX + 2 * PAD
        const unionH = maxY - minY + 2 * PAD
        const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
          clip: { x: clipX, y: clipY, width: unionW, height: unionH, scale: dpr },
          captureBeyondViewport: true,
          fromSurface: true,
        })
        const fullBuf = Buffer.from(data, 'base64')
        const sharp = (await import('sharp')).default
        const meta = await sharp(fullBuf).metadata()
        const fullW = meta.width ?? Math.round(unionW * dpr)
        const fullH = meta.height ?? Math.round(unionH * dpr)
        await Promise.all(
          items.map(async (item, i) => {
            const b = bounds[i]!
            const left = Math.max(0, Math.round((b.x - clipX) * dpr))
            const top = Math.max(0, Math.round((b.y - clipY) * dpr))
            const wantW = Math.round(b.w * dpr)
            const wantH = Math.round(b.h * dpr)
            const haveW = Math.min(wantW, fullW - left)
            const haveH = Math.min(wantH, fullH - top)
            if (haveW <= 0 || haveH <= 0) {
              throw new Error(`screenshotMany: degenerate bounds for ${selectors[i]}: extract=(${left},${top},${haveW},${haveH}) full=${fullW}×${fullH}`)
            }
            const padded = haveW < wantW || haveH < wantH
            if (padded) {
              process.stderr.write(`\n[!!! WARNING !!!] screenshotMany: extract clipped for ${selectors[i]}\n  bound=(${b.x},${b.y},${b.w},${b.h}) want=${wantW}×${wantH} have=${haveW}×${haveH}\n  Padding right/bottom with RED #ff0000.\n\n`)
              const cropped = await sharp(fullBuf).extract({ left, top, width: haveW, height: haveH }).toBuffer()
              await sharp({ create: { width: wantW, height: wantH, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
                .composite([{ input: cropped, top: 0, left: 0 }]).png().toFile(item.outPath)
            } else {
              await sharp(fullBuf).extract({ left, top, width: wantW, height: wantH }).png().toFile(item.outPath)
            }
          }),
        )
      },
      close: async () => { /* target-level connection persists with Renderer */ },
    }
  }

  async close(): Promise<void> {
    this.cdp.close()
    this.proc.kill()
    await rm(this.userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}
