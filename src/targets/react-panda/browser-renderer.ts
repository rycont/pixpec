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
    screenshotMany(
        items: { selector: string; outPath: string; clipToElement?: boolean }[],
    ): Promise<void>
    navigateTo(url: string): Promise<void>
    close(): Promise<void>
}

const buildInitScript = (remPx: number): string =>
    `(function(){var apply=function(){if(document.documentElement)document.documentElement.style.fontSize="${remPx}px";};apply();document.addEventListener("readystatechange",apply);})();`

async function waitForFontSettle(
    page: Awaited<ReturnType<BrowserContext['newPage']>>,
): Promise<void> {
    await page
        .evaluate(async () => {
            if ('fonts' in document)
                await (document as Document & { fonts: FontFaceSet }).fonts.ready
        })
        .catch(() => undefined)
    await page.waitForTimeout(FONT_SETTLE_MS)
}

export class Renderer {
    private constructor(
        private browser: Browser,
        private extraArgs: string[],
    ) {}

    static async create(extraArgs: string[] = []): Promise<Renderer> {
        const browser = await chromium.launch({
            args: [...LOCKED_FLAGS, ...extraArgs],
        })
        return new Renderer(browser, extraArgs)
    }

    /** Discard the underlying browser and launch a fresh one. Used to recover
     *  from compositor/renderer crashes mid-capture. */
    async restart(): Promise<void> {
        try { await this.browser.close() } catch {}
        this.browser = await chromium.launch({
            args: [...LOCKED_FLAGS, ...this.extraArgs],
        })
    }

    async renderUrl(opts: RenderUrlOptions): Promise<void> {
        const remPx = (opts.remBase * opts.outputScale) / VERIFY_DPR
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
            const cdp = await ctx.newCDPSession(page)
            await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
                color: { r: 0, g: 0, b: 0, a: 0 },
            })
            await page.goto(opts.url, { waitUntil: 'load', timeout: 120_000 })
            const targetSel = opts.clipSelector ?? '#pixpec-target'
            await page.locator(`${targetSel} > *`).first().waitFor()
            // @font-face load is async even with font-display:block.
            if (opts.waitForFonts !== false) await waitForFontSettle(page)
            // Harness post-mount work (SVG snap, Y-shift).
            await page.evaluate(
                () =>
                    (
                        window as unknown as {
                            __pixpecSettle?: () => Promise<void>
                            __pixpecReady?: Promise<void>
                        }
                    ).__pixpecSettle?.() ??
                    (window as unknown as { __pixpecReady?: Promise<void> }).__pixpecReady ??
                    Promise.resolve(),
            )
            if (opts.settleMs) await page.waitForTimeout(opts.settleMs)
            await screenshotVisualBounds(page, cdp, targetSel, opts.outPath)
            await cdp.detach().catch(() => {})
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
        caseBox?: { width: number; height: number }
    }): Promise<BatchSession> {
        const remPx = (opts.remBase * opts.outputScale) / VERIFY_DPR
        const ctx: BrowserContext = await this.browser.newContext({
            viewport: opts.viewport,
            deviceScaleFactor: VERIFY_DPR,
        })
        const page = await ctx.newPage()
        await page.addInitScript({ content: buildInitScript(remPx) })
        if (opts.caseBox) {
            await page.addInitScript({
                content: `window.__pixpecGeneratedCaseBox=${JSON.stringify(opts.caseBox)};`,
            })
        }
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
        await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
            color: { r: 0, g: 0, b: 0, a: 0 },
        })
        const dpr = VERIFY_DPR
        let fontsSettled = false
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
                try {
                    await page.waitForFunction(
                        (n) => {
                            if ((window as any).__pixpecError)
                                throw new Error((window as any).__pixpecError)
                            const target = document.querySelector<HTMLElement>('#pixpec-target')
                            const expectedBatch =
                                new URL(window.location.href).searchParams.get('batch') ?? ''
                            return (
                                target?.dataset.pixpecBatch === expectedBatch &&
                                document.querySelectorAll('[data-case]').length >= n
                            )
                        },
                        expectedCount,
                        { timeout: 60_000 },
                    )
                } catch (e) {
                    const mounted = await page
                        .locator('[data-case]')
                        .count()
                        .catch(() => 0)
                    const pixpecError = await page
                        .evaluate(() => (window as any).__pixpecError ?? null)
                        .catch(() => null)
                    const detail = pixpecError
                        ? `\nHarness error: ${pixpecError}`
                        : `\nMounted cases: ${mounted}/${expectedCount}`
                    throw new Error(`${(e as Error).message}${detail}`)
                }
                // Harness post-mount.
                if (!fontsSettled) {
                    await waitForFontSettle(page)
                    fontsSettled = true
                } else {
                    await page
                        .evaluate(async () => {
                            if ('fonts' in document)
                                await (document as Document & { fonts: FontFaceSet }).fonts.ready
                        })
                        .catch(() => undefined)
                }
                await page.evaluate(() => (window as any).__pixpecSettle())
                await page.evaluate(
                    () =>
                        new Promise((resolve) =>
                            requestAnimationFrame(() =>
                                requestAnimationFrame(() => resolve(undefined)),
                            ),
                        ),
                )
                await page.waitForTimeout(100)
                if (lastError) throw lastError
            },
            async screenshot(selector: string, outPath: string) {
                await page.locator(selector).first().screenshot({
                    path: outPath,
                    omitBackground: true,
                })
            },
            async screenshotMany(items) {
                const specs = items.map((it) => ({
                    selector: it.selector,
                    clipToElement: !!it.clipToElement,
                }))
                const selectors = specs.map((it) => it.selector)
                const bounds = (await page.evaluate(`(() => {
          const specs = ${JSON.stringify(specs)};
          const expandForShadow = (
            el,
            box,
          ) => {
            const shadow = window.getComputedStyle(el).boxShadow;
            if (!shadow || shadow === "none" || shadow.includes(" inset"))
              return box;
            let out = { ...box };
            const nums = [...shadow.matchAll(/(-?\\d+(?:\\.\\d+)?)px/g)].map((m) =>
              Number(m[1]),
            );
            for (let i = 0; i + 2 < nums.length; i += 4) {
              const [x, y, blur, spread = 0] = nums.slice(i, i + 4);
              const extent = Math.max(0, blur + spread);
              out = {
                x: Math.min(out.x, box.x + x - extent),
                y: Math.min(out.y, box.y + y - extent),
                w:
                  Math.max(out.x + out.w, box.x + box.w + x + extent) -
                  Math.min(out.x, box.x + x - extent),
                h:
                  Math.max(out.y + out.h, box.y + box.h + y + extent) -
                  Math.min(out.y, box.y + y - extent),
              };
            }
            return out;
          };
          return specs.map((spec) => {
            const el = document.querySelector(spec.selector);
            if (!el) return null;
            const rootRect = el.getBoundingClientRect();
            if (spec.clipToElement) {
              return {
                x: rootRect.x,
                y: rootRect.y,
                w: rootRect.width,
                h: rootRect.height,
                overflow: false,
              };
            }
            const elements = [
              el,
              ...Array.from(el.querySelectorAll("*")),
            ];
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const target of elements) {
              const r = target.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              const box = expandForShadow(target, {
                x: r.x,
                y: r.y,
                w: r.width,
                h: r.height,
              });
              minX = Math.min(minX, box.x);
              minY = Math.min(minY, box.y);
              maxX = Math.max(maxX, box.x + box.w);
              maxY = Math.max(maxY, box.y + box.h);
            }
            if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
            return {
              x: minX,
              y: minY,
              w: maxX - minX,
              h: maxY - minY,
              overflow:
                minX < rootRect.x ||
                minY < rootRect.y ||
                maxX > rootRect.x + rootRect.width ||
                maxY > rootRect.y + rootRect.height,
            };
          });
        })()`)) as Array<{
                    x: number
                    y: number
                    w: number
                    h: number
                    overflow?: boolean
                } | null>
                for (let i = 0; i < bounds.length; i++) {
                    if (!bounds[i])
                        throw new Error(`screenshotMany: selector not found: ${selectors[i]}`)
                }
                const sharp = (await import('sharp')).default
                const captureOne = async (i: number) => {
                    const b = bounds[i]!
                    // Snap clip to integer pixel boundaries — getBoundingClientRect
                    // returns sub-pixel float dims and CDP's clip rounding can shift
                    // the captured icon by one column relative to figma's PNG.
                    const cx = Math.max(0, Math.floor(b.x))
                    const cy = Math.max(0, Math.floor(b.y))
                    const cw = Math.max(1, Math.ceil(b.x + b.w) - cx)
                    const ch = Math.max(1, Math.ceil(b.y + b.h) - cy)
                    const { data } = (await cdp.send('Page.captureScreenshot', {
                        format: 'png',
                        clip: { x: cx, y: cy, width: cw, height: ch, scale: dpr },
                        captureBeyondViewport: true,
                        fromSurface: true,
                        omitBackground: true,
                    } as never)) as { data: string }
                    await sharp(Buffer.from(data, 'base64'), {
                        limitInputPixels: false,
                    })
                        .png()
                        .toFile(items[i].outPath)
                }
                const captureIndividual = async () => {
                    for (let i = 0; i < items.length; i++) {
                        await captureOne(i)
                    }
                }
                if (bounds.some((b) => b?.overflow)) {
                    for (let i = 0; i < items.length; i++) {
                        const b = bounds[i]!
                        const caseId = selectors[i]
                            .match(/\[data-case=(?:"([^"]+)"|'([^']+)'|([^\]]+))\]/)
                            ?.slice(1)
                            .find(Boolean)
                        if (!caseId)
                            throw new Error(
                                `screenshotMany: cannot parse data-case selector: ${selectors[i]}`,
                            )
                        const visibleCount = await page.evaluate((id) => {
                            let count = 0
                            document.querySelectorAll<HTMLElement>('[data-case]').forEach((el) => {
                                const visible = el.getAttribute('data-case') === id
                                el.style.opacity = visible ? '1' : '0'
                                if (visible) count++
                            })
                            return count
                        }, caseId)
                        if (visibleCount !== 1)
                            throw new Error(
                                `screenshotMany: expected one visible case for ${caseId}, got ${visibleCount}`,
                            )
                        await captureOne(i)
                    }
                    await page.evaluate(() => {
                        document.querySelectorAll<HTMLElement>('[data-case]').forEach((el) => {
                            el.style.opacity = ''
                        })
                    })
                    return
                }
                let minX = Infinity,
                    minY = Infinity,
                    maxX = -Infinity,
                    maxY = -Infinity
                for (const b of bounds) {
                    if (!b) continue
                    if (b.x < minX) minX = b.x
                    if (b.y < minY) minY = b.y
                    if (b.x + b.w > maxX) maxX = b.x + b.w
                    if (b.y + b.h > maxY) maxY = b.y + b.h
                }
                const PAD = 1
                const clipX = Math.max(0, minX - PAD)
                const clipY = Math.max(0, minY - PAD)
                const unionW = maxX - clipX + PAD
                const unionH = maxY - clipY + PAD
                const captureParams = {
                    format: 'png',
                    clip: {
                        x: clipX,
                        y: clipY,
                        width: unionW,
                        height: unionH,
                        scale: dpr,
                    },
                    captureBeyondViewport: true,
                    fromSurface: true,
                    omitBackground: true,
                }
                let data: string
                try {
                    const result = (await cdp.send(
                        'Page.captureScreenshot',
                        captureParams as never,
                    )) as { data: string }
                    data = result.data
                } catch (err) {
                    const msg = String(err)
                    if (msg.includes('Unable to capture screenshot')) {
                        await captureIndividual()
                        return
                    }
                    throw err
                }
                const fullBuf = Buffer.from(data, 'base64')
                const rawImage = await sharp(fullBuf, {
                    limitInputPixels: false,
                })
                    .ensureAlpha()
                    .raw()
                    .toBuffer({ resolveWithObject: true })
                const fullW = rawImage.info.width ?? Math.round(unionW * dpr)
                const fullH = rawImage.info.height ?? Math.round(unionH * dpr)
                const fullChannels = rawImage.info.channels ?? 4
                const rawInput = {
                    raw: {
                        width: fullW,
                        height: fullH,
                        channels: fullChannels,
                    },
                    limitInputPixels: false,
                } as const
                await mapLimit(
                    items.map((item, i) => ({ item, i })),
                    Number(process.env.PIXPEC_CAPTURE_CROP_PARALLEL ?? 4),
                    async ({ item, i }) => {
                        const b = bounds[i]!
                        const left = Math.max(0, Math.floor((b.x - clipX) * dpr))
                        const top = Math.max(0, Math.floor((b.y - clipY) * dpr))
                        const right = Math.ceil((b.x + b.w - clipX) * dpr)
                        const bottom = Math.ceil((b.y + b.h - clipY) * dpr)
                        const wantW = Math.max(1, right - left)
                        const wantH = Math.max(1, bottom - top)
                        const haveW = Math.min(wantW, fullW - left)
                        const haveH = Math.min(wantH, fullH - top)
                        if (haveW <= 0 || haveH <= 0) {
                            throw new Error(`screenshotMany: degenerate bounds for ${selectors[i]}`)
                        }
                        const padded = haveW < wantW || haveH < wantH
                        if (padded) {
                            process.stderr.write(
                                `\n[!!! WARNING !!!] screenshotMany: extract clipped for ${selectors[i]}\n  bound=(${b.x},${b.y},${b.w},${b.h}) want=${wantW}×${wantH} have=${haveW}×${haveH}\n  Padding right/bottom with RED #ff0000.\n\n`,
                            )
                            const cropped = await sharp(rawImage.data, rawInput)
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
                            await sharp(rawImage.data, rawInput)
                                .extract({ left, top, width: wantW, height: wantH })
                                .png()
                                .toFile(item.outPath)
                        }
                    },
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

async function mapLimit<T>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<void>,
): Promise<void> {
    const limit = Math.max(1, Math.floor(concurrency))
    let next = 0
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (true) {
                const index = next++
                if (index >= items.length) return
                await mapper(items[index], index)
            }
        }),
    )
}

async function screenshotVisualBounds(
    page: Awaited<ReturnType<BrowserContext['newPage']>>,
    cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>>,
    selector: string,
    outPath: string,
): Promise<void> {
    const readBounds = (sel: string) => {
        const root = document.querySelector(sel) as HTMLElement | null
        if (!root) return null
        const expandForShadow = (
            el: HTMLElement,
            box: { x: number; y: number; width: number; height: number },
        ) => {
            const shadow = window.getComputedStyle(el).boxShadow
            if (!shadow || shadow === 'none' || shadow.includes(' inset')) return box
            let minX = box.x
            let minY = box.y
            let maxX = box.x + box.width
            let maxY = box.y + box.height
            for (const part of shadow.split(/,(?![^(]*\))/)) {
                if (part.includes(' inset')) continue
                const nums = [...part.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
                if (nums.length < 3) continue
                const [x, y, blur, spread = 0] = nums
                const extent = Math.max(0, blur + spread)
                minX = Math.min(minX, box.x + x - extent)
                minY = Math.min(minY, box.y + y - extent)
                maxX = Math.max(maxX, box.x + box.width + x + extent)
                maxY = Math.max(maxY, box.y + box.height + y + extent)
            }
            return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
        }
        const elements = [root, ...Array.from(root.querySelectorAll('*'))] as HTMLElement[]
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const el of elements) {
            const r = el.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) continue
            const b = expandForShadow(el, {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
            })
            if (b.x < minX) minX = b.x
            if (b.y < minY) minY = b.y
            if (b.x + b.width > maxX) maxX = b.x + b.width
            if (b.y + b.height > maxY) maxY = b.y + b.height
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    }
    const initialBounds = await page.evaluate(readBounds, selector)
    if (!initialBounds || initialBounds.width <= 0 || initialBounds.height <= 0) {
        throw new Error(`screenshotVisualBounds: selector not found or empty: ${selector}`)
    }
    const shiftX = Math.max(0, Math.ceil(-initialBounds.x))
    const shiftY = Math.max(0, Math.ceil(-initialBounds.y))
    const previousPadding = await page.evaluate(
        ({ x, y }) => {
            if (x === 0 && y === 0) return null
            const body = document.body
            const style = window.getComputedStyle(body)
            const prev = {
                paddingLeft: body.style.paddingLeft,
                paddingTop: body.style.paddingTop,
            }
            body.style.paddingLeft = `${Number.parseFloat(style.paddingLeft || '0') + x}px`
            body.style.paddingTop = `${Number.parseFloat(style.paddingTop || '0') + y}px`
            return prev
        },
        { x: shiftX, y: shiftY },
    )
    try {
        const bounds = await page.evaluate(readBounds, selector)
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
            throw new Error(
                `screenshotVisualBounds: selector not found or empty after shift: ${selector}`,
            )
        }
        // Snap clip to integer pixel boundaries. getBoundingClientRect returns
        // sub-pixel float dims; CDP's clip apparently rounds the width UP,
        // producing a screenshot one column wider than the rendered box.
        // Floor x/y so the screenshot's leftmost column = the box's leftmost
        // rendered pixel (matching figma's PNG which has zero left padding);
        // ceil width/height so we don't truncate visible content.
        const integerClip = {
            x: Math.floor(bounds.x),
            y: Math.floor(bounds.y),
            width: Math.ceil(bounds.x + bounds.width) - Math.floor(bounds.x),
            height: Math.ceil(bounds.y + bounds.height) - Math.floor(bounds.y),
        }
        const { data } = (await cdp.send('Page.captureScreenshot', {
            format: 'png',
            clip: { ...integerClip, scale: 1 },
            captureBeyondViewport: true,
            fromSurface: true,
            omitBackground: true,
        } as never)) as { data: string }
        const { writeFile } = await import('node:fs/promises')
        await writeFile(outPath, Buffer.from(data, 'base64'))
    } finally {
        if (previousPadding) {
            await page.evaluate((prev) => {
                document.body.style.paddingLeft = prev.paddingLeft
                document.body.style.paddingTop = prev.paddingTop
            }, previousPadding)
        }
    }
}
