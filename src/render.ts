/**
 * Chromium renderer with locked flags. One browser instance per Runner;
 * each render() creates a short-lived context to keep state clean.
 *
 * The `--disable-lcd-text` and `--font-render-hinting=none` flags are part
 * of pixpec's contract — they remove the largest sources of cross-platform
 * dE noise. Override only at your own risk (and document why).
 */
import type { Browser, BrowserContext } from '@playwright/test'
import { chromium } from '@playwright/test'

const LOCKED_FLAGS = ['--disable-lcd-text', '--font-render-hinting=none']

/** Layout-side device pixel ratio for verify capture. Fixed at 2.
 *
 * Chrom's Skia computes glyph advance with dpr-dependent sub-pixel positioning
 * binning even when font-render-hinting is disabled. Empirically (Wanted Sans
 * "~" 14px Medium):
 *   dpr=8 → advance 7.574 (binning artifact, 1.36c smaller than figma's view)
 *   dpr=2 → advance 8.935 (matches figma's text engine output)
 *
 * For high target output scale (e.g. figma export scale=8), we keep layout at
 * dpr=2 (correct advance) but drive output density via CDP screenshot scale +
 * a runtime html font-size scale-up (rem-base supersampling). 8 device px per
 * figma unit = 2 dpr × 4 rem-multiplier — same density as native dpr=8 but
 * with text advance computed in dpr=2's precision regime. */
const VERIFY_DPR = 2

export interface RenderUrlOptions {
  /** URL to navigate to (e.g. pixpec harness route on DS's Vite). */
  url: string
  /** Output PNG path. */
  outPath: string
  /** Viewport dimensions. */
  viewport: { width: number; height: number }
  /** Output device-px per CSS-px density. Pair with cfigma --scale for pixel
   * parity. Layout always runs at VERIFY_DPR (=2) for stable Skia advance;
   * `outputScale > VERIFY_DPR` upsamples via runtime html font-size scaling. */
  outputScale: number
  /** Design system rem base in CSS px (pixpec.toml `remBase`, default 16).
   * Verify mode sets `html { font-size: remBase × outputScale / VERIFY_DPR }px`
   * so all rem-based emitted values supersample by `outputScale / VERIFY_DPR`. */
  remBase: number
  /** CSS selector to clip the screenshot to. Also used as the mount probe. */
  clipSelector?: string
  /** Wait for `document.fonts.ready`. Default true. */
  waitForFonts?: boolean
  /** Extra settle delay in ms. */
  settleMs?: number
}

export interface BatchSession {
  /** Wait for the harness to mount `expectedCount` `[data-case]` elements. */
  waitMounted(expectedCount: number): Promise<void>
  /** Element-screenshot a single case selector (e.g. `[data-case="..."] > *`). */
  screenshot(selector: string, outPath: string): Promise<void>
  /**
   * Bulk capture: fetch all element bounds in one page.evaluate, then call
   * CDP Page.captureScreenshot(clip, captureBeyondViewport) per case.
   * Bypasses Playwright actionability/scrollIntoView overhead. ~5-10× faster
   * than `screenshot()` looped, especially on huge pages.
   */
  screenshotMany(items: { selector: string; outPath: string }[]): Promise<void>
  /** Tear down the context used for this batch. */
  close(): Promise<void>
}

export class Renderer {
  private constructor(private browser: Browser) {}

  static async create(extraArgs: string[] = []): Promise<Renderer> {
    const browser = await chromium.launch({
      args: [...LOCKED_FLAGS, ...extraArgs],
    })
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
      // Set html font-size BEFORE any page script runs. Codegen emits all
      // figma-px values as rem; this scales the rem base so layout is
      // (outputScale / VERIFY_DPR)× supersampled while Skia advance stays
      // in dpr=2's precision regime. String-form (not function) so tsx's
      // esbuild transpile doesn't inject __name wrappers that fail in chrom.
      await page.addInitScript({
        content: `(function(){
  var apply = function(){ if (document.documentElement) document.documentElement.style.fontSize = "${remPx}px"; };
  apply();
  document.addEventListener("readystatechange", apply);
})();`,
      })
      page.on('console', (m) => {
        if (m.type() === 'error' || process.env.PIXPEC_DEBUG) {
          console.error(`[browser:${m.type()}] ${m.text()}`)
        }
      })
      page.on('pageerror', (e) => console.error(`[browser:exception] ${e.message}`))
      await page.goto(opts.url, { waitUntil: 'load', timeout: 120_000 })
      const targetSel = opts.clipSelector ?? '#pixpec-target'
      await page.locator(`${targetSel} > *`).first().waitFor()
      if (opts.waitForFonts !== false) {
        await page.evaluate(() => (document as Document).fonts.ready)
      }
      // Harness may expose `window.__pixpecReady: Promise<void>` for post-mount
      // work (e.g. SVG sub-pixel snap). Await if present.
      await page.evaluate(
        () =>
          (window as unknown as { __pixpecReady?: Promise<void> }).__pixpecReady ??
          Promise.resolve(),
      )
      if (opts.settleMs) await page.waitForTimeout(opts.settleMs)
      // Output is dpr × CSS. With html font-size scaled by outputScale/VERIFY_DPR,
      // CSS dim is (outputScale/VERIFY_DPR)× design-unit; capture at dpr=VERIFY_DPR
      // gives device px = outputScale × design-unit, matching figma export scale.
      await page.locator(targetSel).screenshot({ path: opts.outPath })
    } finally {
      await ctx.close()
    }
  }

  /**
   * Open a long-lived page that mounts ALL cases of a component at once
   * (`?batch=1` harness mode). Caller takes element-screenshots per case
   * via the returned session. ~5–10× faster than per-case `renderUrl` since
   * navigation, font load, and Vite compile happen once.
   */
  async openBatch(opts: {
    url: string
    viewport: { width: number; height: number }
    /** Output device-px per CSS-px density. See RenderUrlOptions.outputScale. */
    outputScale: number
    /** Design system rem base. See RenderUrlOptions.remBase. */
    remBase: number
  }): Promise<BatchSession> {
    const remPx = opts.remBase * opts.outputScale / VERIFY_DPR
    const ctx: BrowserContext = await this.browser.newContext({
      viewport: opts.viewport,
      deviceScaleFactor: VERIFY_DPR,
    })
    const page = await ctx.newPage()
    await page.addInitScript({
      content: `(function(){
  var apply = function(){ if (document.documentElement) document.documentElement.style.fontSize = "${remPx}px"; };
  apply();
  document.addEventListener("readystatechange", apply);
})();`,
    })
    page.on('console', (m) => {
      if (m.type() === 'error' || process.env.PIXPEC_DEBUG) {
        console.error(`[browser:${m.type()}] ${m.text()}`)
      }
    })
    page.on('pageerror', (e) => console.error(`[browser:exception] ${e.message}`))
    await page.goto(opts.url, { waitUntil: 'load', timeout: 120_000 })
    const cdp = await ctx.newCDPSession(page)
    // Capture density = VERIFY_DPR. CSS is already (outputScale/VERIFY_DPR)×
    // supersampled via html font-size, so dpr-density-only capture lands at
    // outputScale × design-unit (matches figma export at scale=outputScale).
    const dpr = VERIFY_DPR
    return {
      async waitMounted(expectedCount: number) {
        await page.waitForFunction(
          (n) => document.querySelectorAll('[data-case]').length >= n,
          expectedCount,
          { timeout: 60_000 },
        )
        await page.evaluate(() => (document as Document).fonts.ready)
        await page.evaluate(
          () =>
            (window as unknown as { __pixpecReady?: Promise<void> }).__pixpecReady ??
            Promise.resolve(),
        )
      },
      async screenshot(selector: string, outPath: string) {
        await page.locator(selector).first().screenshot({ path: outPath })
      },
      async screenshotMany(items) {
        // 1. Bulk-fetch bounds via single page.evaluate.
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
        // 2. Compute the union bbox of all cases. Single CDP screenshot of
        //    that region (avoids 500 round-trips). Then crop locally with sharp.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const b of bounds) {
          if (!b) continue
          if (b.x < minX) minX = b.x
          if (b.y < minY) minY = b.y
          if (b.x + b.w > maxX) maxX = b.x + b.w
          if (b.y + b.h > maxY) maxY = b.y + b.h
        }
        // Pad union by 1 CSS px each side so CDP/dpr rounding never makes the
        // screenshot ½ device-px shorter than the per-item extracts demand.
        const PAD = 1
        const clipX = minX - PAD
        const clipY = minY - PAD
        const unionW = (maxX - minX) + 2 * PAD
        const unionH = (maxY - minY) + 2 * PAD
        const { data } = (await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: clipX, y: clipY, width: unionW, height: unionH, scale: dpr },
          captureBeyondViewport: true,
          fromSurface: true,
        })) as { data: string }
        const fullBuf = Buffer.from(data, 'base64')

        // Sharp crops in parallel — output is device-px so scale CSS bounds by dpr.
        // Clamp extract to actual PNG dims (CDP clip + dpr scale produces ±1 px
        // rounding diffs vs `unionW * dpr` and crops at the edge can spill over).
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
            // Clamp extract to actual PNG bounds. If clamped, pad RIGHT/BOTTOM
            // with white so the output stays at the bounds dimensions — measure
            // expects figma/chromium pairs to match.
            const haveW = Math.min(wantW, fullW - left)
            const haveH = Math.min(wantH, fullH - top)
            if (haveW <= 0 || haveH <= 0) {
              throw new Error(
                `screenshotMany: degenerate bounds for ${selectors[i]}: ` +
                  `bound=(${b.x},${b.y},${b.w},${b.h}) → extract=(${left},${top},${haveW},${haveH}) full=${fullW}×${fullH}`,
              )
            }
            const padded = haveW < wantW || haveH < wantH
            if (padded) {
              process.stderr.write(
                `\n[!!! WARNING !!!] screenshotMany: extract clipped for ${selectors[i]}\n` +
                  `  bound=(${b.x},${b.y},${b.w},${b.h}) want=${wantW}×${wantH} have=${haveW}×${haveH} full=${fullW}×${fullH}\n` +
                  `  Padding right/bottom with RED #ff0000 to ${wantW}×${wantH}. The red is intentional — it\n` +
                  `  poisons downstream dE measurements so this bug cannot go silent. Investigate.\n\n`,
              )
              const cropped = await sharp(fullBuf)
                .extract({ left, top, width: haveW, height: haveH })
                .toBuffer()
              await sharp({
                create: {
                  width: wantW,
                  height: wantH,
                  channels: 4,
                  background: { r: 255, g: 0, b: 0, alpha: 1 },
                },
              })
                .composite([{ input: cropped, top: 0, left: 0 }])
                .png()
                .toFile(item.outPath)
            } else {
              await sharp(fullBuf)
                .extract({ left, top, width: wantW, height: wantH })
                .png()
                .toFile(item.outPath)
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
