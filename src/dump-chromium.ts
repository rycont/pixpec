/**
 * pixpec dump-chromium — renders DS impl via an EXTERNAL Vite dev server +
 * Chromium and screenshots each case to PNG.
 * Output: <root>/.pixpec-out/<ComponentName>/chromium/<case>.png
 *
 * The Vite server is NOT started by this command — the user runs it
 * separately (`pnpm dev` or the project's preferred script) with VR_TEST=1
 * set so vite.config.ts swaps leaf components for their impl.vr-aligned
 * variants (ADR-0024 sub-pixel parity). Decoupling avoids ~3-5s of vite cold
 * start on every dump call, critical for breakdown loops.
 *
 * The dev server URL is read from `pixpec.toml` (`devServerUrl`) or the
 * `PIXPEC_DEV_URL` env var, defaulting to `http://localhost:5180`.
 *
 * Lib function + CLI entrypoint.
 */
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Component } from './types.ts'
import { Renderer } from './render.ts'
import { loadConfig } from './init.ts'

export interface DumpChromiumOptions {
  component: Component<unknown>
  outDir: string
  /** Base URL of an externally-launched Vite dev server. Required. */
  devUrl: string
  scale?: number
  /** Design system rem base in CSS px. Default 16. */
  remBase?: number
  verbose?: boolean
  /** Reuse an existing Chromium instance across repeated dump calls. */
  renderer?: Renderer
}

export async function dumpChromium(opts: DumpChromiumOptions): Promise<void> {
  const { component: comp, outDir, devUrl, scale, remBase, verbose } = opts
  await mkdir(outDir, { recursive: true })

  // Probe the dev server up-front so the failure mode is a clear message
  // ("vite not running") rather than a generic playwright timeout 60s later.
  const baseUrl = devUrl.replace(/\/$/, '')
  try {
    const res = await fetch(baseUrl, { method: 'GET' })
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
  } catch (e) {
    throw new Error(
      `dump-chromium: cannot reach dev server at ${baseUrl}\n` +
      `  Start it first: VR_TEST=1 pnpm dev   (or your project's dev script)\n` +
      `  Override URL via pixpec.toml \`devServerUrl\` or PIXPEC_DEV_URL env.\n` +
      `  Underlying: ${(e as Error).message}`,
    )
  }
  const renderer = opts.renderer ?? await Renderer.create()
  const ownsRenderer = !opts.renderer
  try {
    const CHUNK = comp.batchChunk ?? 500
    const N = comp.cases.length
    const PARALLEL = comp.batchParallel ?? 2

    // Build chunk descriptors.
    const chunks: { s: number; e: number }[] = []
    for (let s = 0; s < N; s += CHUNK) chunks.push({ s, e: Math.min(s + CHUNK, N) })

    // Worker fn that processes ONE chunk via its own session (= its own
    // browser context = its own tab). Multiple workers run concurrently.
    const runChunk = async ({ s, e }: { s: number; e: number }) => {
      const url = `${baseUrl}/?component=${encodeURIComponent(comp.name)}&batch=1&from=${s}&to=${e}`
      const t0 = Date.now()
      const session = await renderer.openBatch({
        url,
        viewport: comp.viewport ?? { width: 4000, height: 8000 },
        outputScale: scale ?? 2,
        remBase: remBase ?? 16,
      })
      const tNav = Date.now()
      await session.waitMounted(e - s)
      const tMount = Date.now()
      const items = []
      for (let i = s; i < e; i++) {
        // If case has explicit `wrapper`, the wrapper IS the screenshot target
        // (its dim must match figma frame exactly). Otherwise, the wrapper is
        // just harness padding and we screenshot the inner impl element.
        const hasWrapper = !!(comp.cases[i] as { wrapper?: unknown }).wrapper
        const sel = hasWrapper
          ? `[data-case="${comp.cases[i].name.replace(/"/g, '\\"')}"]`
          : `[data-case="${comp.cases[i].name.replace(/"/g, '\\"')}"] > *`
        items.push({
          selector: sel,
          outPath: join(outDir, `${comp.cases[i].name}.png`),
        })
      }
      await session.screenshotMany(items)
      const tShots = Date.now()
      await session.close()
      if (verbose) {
        console.log(
          `  chunk [${s}..${e}) nav=${tNav - t0}ms mount=${tMount - tNav}ms shots=${tShots - tMount}ms`,
        )
      }
    }

    // Pull-based concurrency: PARALLEL workers each grab next chunk until done.
    let nextIdx = 0
    const worker = async () => {
      while (nextIdx < chunks.length) {
        const idx = nextIdx++
        await runChunk(chunks[idx])
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker))
  } finally {
    if (ownsRenderer) await renderer.close()
  }
}

export async function runDumpChromium(
  componentName: string,
  opts: { renderer?: Renderer } = {},
): Promise<void> {
  const { cfg, root } = await loadConfig()
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentMod = (await import(resolve(root, componentsDir, componentName, 'index.ts'))) as Record<string, unknown>
  const comp = componentMod[componentName] as Component<unknown> | undefined
  if (!comp || !Array.isArray(comp.cases)) {
    throw new Error(`Component '${componentName}' not exported from ${componentsDir}/${componentName}/index.ts`)
  }
  const outDir = resolve(root, `.pixpec-out/${comp.name}/chromium`)
  const devUrl = process.env.PIXPEC_DEV_URL
    ?? (cfg as { devServerUrl?: string }).devServerUrl
    ?? 'http://localhost:5180'
  console.log(`[dump-chromium] ${comp.name}: ${comp.cases.length} cases → ${outDir} (vite=${devUrl})`)
  const t0 = Date.now()
  await dumpChromium({
    component: comp,
    outDir,
    devUrl,
    scale: cfg.scale,
    remBase: cfg.remBase,
    verbose: true,
    renderer: opts.renderer,
  })
  console.log(`[dump-chromium] done in ${Date.now() - t0}ms`)
}
