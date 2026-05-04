/**
 * pixpec dump-chromium — renders DS impl via Vite + Chromium and screenshots
 * each case to PNG. Output: <root>/.pixpec-out/<ComponentName>/chromium/<case>.png
 *
 * Chunks DOM to keep per-shot capture fast (page DOM size dominates cost).
 * Lib function + CLI entrypoint.
 */
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import type { Component } from './types.ts'
import { Renderer } from './render.ts'
import { loadConfig } from './init.ts'

export interface DumpChromiumOptions {
  component: Component<unknown>
  outDir: string
  projectRoot: string
  scale?: number
  verbose?: boolean
}

export async function dumpChromium(opts: DumpChromiumOptions): Promise<void> {
  const { component: comp, outDir, projectRoot, scale, verbose } = opts
  await mkdir(outDir, { recursive: true })

  const server: ViteDevServer = await createServer({
    root: projectRoot,
    server: { port: 0 },
    logLevel: 'warn',
  })
  await server.listen()
  const baseUrl = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? 'http://localhost'
  const renderer = await Renderer.create()
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
        deviceScaleFactor: scale ?? 2,
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
    await renderer.close()
    await server.close()
  }
}

export async function runDumpChromium(componentName: string): Promise<void> {
  const { cfg, root } = await loadConfig()
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentMod = (await import(resolve(root, componentsDir, componentName, 'index.ts'))) as Record<string, unknown>
  const comp = componentMod[componentName] as Component<unknown> | undefined
  if (!comp || !Array.isArray(comp.cases)) {
    throw new Error(`Component '${componentName}' not exported from ${componentsDir}/${componentName}/index.ts`)
  }
  // Re-extract Panda CSS so impl style changes show up.
  const { spawnSync } = await import('node:child_process')
  spawnSync(
    './node_modules/.bin/panda',
    ['cssgen', '--outfile', 'styled-system/styles.css'],
    { cwd: root, stdio: 'inherit' },
  )
  const outDir = resolve(root, `.pixpec-out/${comp.name}/chromium`)
  console.log(`[dump-chromium] ${comp.name}: ${comp.cases.length} cases → ${outDir}`)
  const t0 = Date.now()
  await dumpChromium({
    component: comp,
    outDir,
    projectRoot: root,
    scale: cfg.scale,
    verbose: true,
  })
  console.log(`[dump-chromium] done in ${Date.now() - t0}ms`)
}
