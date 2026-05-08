/**
 * Chromium renderer (Playwright-based).
 *
 * The `--disable-lcd-text` and `--font-render-hinting=none` flags are part
 * of pixpec's contract — they remove the largest sources of cross-platform
 * dE noise. Override only at your own risk (and document why).
 */
import type { Browser, BrowserContext } from '@playwright/test'
import { chromium } from '@playwright/test'

const LOCKED_FLAGS = ['--disable-lcd-text', '--font-render-hinting=none']

/** Layout-side device pixel ratio. Fixed at 1.
 *
 * Skia's glyph advance is dpr-dependent due to sub-pixel positioning binning.
 * Only dpr=1 produces unbinned advance matching figma's text engine output
 * (verified: dpr=1 → 31.11, dpr=2 → 33.12 for "초기화" 12px). For target
 * output scale, layout runs at dpr=1 with html font-size = remBase × scale,
 * so all rem-based codegen output is supersampled by `outputScale`. */
const VERIFY_DPR = 1

/** @font-face load grace period after Page load event.
 *
 * font-display:block blocks rendering but NOT the load event — initial layout
 * commits with fallback font metrics if not held. Verified: at load+0,
 * fontStatus="loading" + canvas advance reflects fallback (33.12 for "초기화"
 * 12px); at load+500ms, fontStatus="loaded" + advance is real (31.11). 800ms
 * leaves headroom for slow font fetches. */
const FONT_SETTLE_MS = 800

export interface RenderUrlOptions {
  url: string
  outPath: string
  viewport: { width: number; height: number }
  /** Output device-px per CSS-px. Layout runs at VERIFY_DPR=1; rem-base
   * supersampling delivers `outputScale × design-unit` device px in the PNG. */
  outputScale: number
  /** Design system rem base (pixpec.toml `remBase`, default 16). */
  remBase: number
  clipSelector?: string
  waitForFonts?: boolean
  settleMs?: number
}

export interface BatchSession {
  reload(): Promise<void>
  waitMounted(expectedCount: number): Promise<void>
  screenshot(selector: string, outPath: string): Promise<void>
  screenshotMany(items: { selector: string; outPath: string }[]): Promise<void>
  navigateTo(url: string): Promise<void>
  close(): Promise<void>
}

const buildInitScript = (remPx: number): string =>
  `(function(){var apply=function(){if(document.documentElement)document.documentElement.style.fontSize="${remPx}px";};apply();document.addEventListener("readystatechange",apply);})();`

export class Renderer {
  private constructor(private browser: Browser) {}

  static async create(extraArgs: string[] = []): Promise<Renderer> {
    const browser = await chromium.launch({ args: [...LOCKED_FLAGS, ...extraArgs] })
    return new Renderer(browser)
  }

  async renderUrl(opts: RenderUrlOptions): Promise<void> {
    const remPx = opts.remBase * opts.outputScale / VERIFY_DPR
    const ctx: BrowserContext = await this.browser.newContext({
      viewport: opts.viewport,
      deviceScaleFactor: VERIFY_DPR,
    })
    try {
      const page = await ctx.newPage()
      await page.addInitScript({ content: buildInitScript(remPx) })
      page.on('console', (m) => {
        if (m.type() === 'error' || process.env.PIXPEC_DEBUG) {
          console.error(`[browser:${m.type()}] ${m.text()}`)
        }
      })
      page.on('pageerror', (e) => console.error(`[browser:exception] ${e.message}`))
      await page.goto(opts.url, { waitUntil: 'load', timeout: 120_000 })
      const targetSel = opts.clipSelector ?? '#pixpec-target'
      await page.locator(`${targetSel} > *`).first().waitFor()
      // @font-face load is async even with font-display:block.
      if (opts.waitForFonts !== false) await page.waitForTimeout(FONT_SETTLE_MS)
      // Harness post-mount work (SVG snap, Y-shift) — see __pixpec-entry.ts.
      await page.evaluate(
        () =>
          (window as unknown as { __pixpecReady?: Promise<void> }).__pixpecReady ??
          Promise.resolve(),
      )
      if (opts.settleMs) await page.waitForTimeout(opts.settleMs)
      await page.locator(targetSel).screenshot({ path: opts.outPath })
    } finally {
      await ctx.close()
    }
  }

  /** Long-lived batch session that mounts all cases at once (`?batch=1` mode).
   * ~5–10× faster than per-case `renderUrl` since navigation, font load, and
   * Vite compile happen once. */
  async openBatch(opts: {
    url: string
    viewport: { width: number; height: number }
    outputScale: number
    remBase: number
  }): Promise<BatchSession> {
    const remPx = opts.remBase * opts.outputScale / VERIFY_DPR
    const ctx: BrowserContext = await this.browser.newContext({
      viewport: opts.viewport,
      deviceScaleFactor: VERIFY_DPR,
    })
    const page = await ctx.newPage()
    await page.addInitScript({ content: buildInitScript(remPx) })
    let lastError: Error | null = null
    page.on('console', (m) => {
      if (m.type() === 'error' || process.env.PIXPEC_DEBUG) {
        console.error(`[browser:${m.type()}] ${m.text()}`)
      }
    })
    page.on('pageerror', (e) => {
      console.error(`[browser:exception] ${e.message}`)
      lastError = e
    })
    await page.goto(opts.url, { waitUntil: 'load', timeout: 120_000 })
    const cdp = await ctx.newCDPSession(page)
    const dpr = VERIFY_DPR
    return {
      async reload() {
        lastError = null
        await page.reload({ waitUntil: 'load' })
      },
      async navigateTo(url: string) {
        if (lastError) throw lastError
        const attempt = async (retryCount = 0) => {
          try {
            await page.evaluate((u) => {
              window.history.pushState({}, '', u)
              return (window as any).__pixpecRender()
            }, url)
          } catch (e) {
            if (retryCount < 3 && String(e).includes('context was destroyed')) {
              // Wait a bit for the reload to finish, then try again.
              await page.waitForTimeout(500)
              return attempt(retryCount + 1)
            }
            throw e
          }
        }
        await attempt()
        if (lastError) throw lastError
      },
      async waitMounted(expectedCount: number) {
        if (lastError) throw lastError
        await page.waitForFunction(
          (n) => {
            if ((window as any).__pixpecError) throw new Error((window as any).__pixpecError);
            return document.querySelectorAll('[data-case]').length >= n;
          },
          expectedCount,
          { timeout: 10_000 },
        )
        // Harness post-mount.
        await page.evaluate(() => (window as any).__pixpecSettle())
        if (lastError) throw lastError
      },
      async screenshot(selector: string, outPath: string) {
        await page.locator(selector).first().screenshot({ path: outPath })
      },
      async screenshotMany(items) {
        const selectors = items.map((it) => it.selector)
        const bounds = await page.evaluate((sels: string[]) => {
          return sels.map((s) => {
            const el = document.querySelector(s) as HTMLElement | null
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { x: r.x, y: r.y, w: r.width, h: r.height }
          })
        }, selectors)
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
        const { data } = (await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: clipX, y: clipY, width: unionW, height: unionH, scale: dpr },
          captureBeyondViewport: true,
          fromSurface: true,
        })) as { data: string }
        const fullBuf = Buffer.from(data, 'base64')
        const sharp = (await import('sharp')).default
        const meta = await sharp(fullBuf, { limitInputPixels: false }).metadata()
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
              throw new Error(`screenshotMany: degenerate bounds for ${selectors[i]}`)
            }
            const padded = haveW < wantW || haveH < wantH
            if (padded) {
              process.stderr.write(`\n[!!! WARNING !!!] screenshotMany: extract clipped for ${selectors[i]}\n  bound=(${b.x},${b.y},${b.w},${b.h}) want=${wantW}×${wantH} have=${haveW}×${haveH}\n  Padding right/bottom with RED #ff0000.\n\n`)
              const cropped = await sharp(fullBuf, { limitInputPixels: false }).extract({ left, top, width: haveW, height: haveH }).toBuffer()
              await sharp({ create: { width: wantW, height: wantH, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
                .composite([{ input: cropped, top: 0, left: 0 }]).png().toFile(item.outPath)
            } else {
              await sharp(fullBuf, { limitInputPixels: false }).extract({ left, top, width: wantW, height: wantH }).png().toFile(item.outPath)
            }
          }),
        )
      },
      async close() {
        await cdp.detach().catch(() => {})
        await ctx.close()
      },
    }
  }

  async close(): Promise<void> {
    await this.browser.close()
  }
}
