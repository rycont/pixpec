/**
 * pixpec dump-figma — exports a component's Figma frames to PNG.
 * Output: <root>/.pixpec-out/<ComponentName>/figma/<case>.png
 *
 * Single-purpose; independent of Chromium dump (parallelizable).
 * Lib function + CLI entrypoint.
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Component } from './types.ts'
import { exportFigmaNodes } from './figma.ts'
import { switchToPageContaining } from './cfigma-meta.ts'
import { loadConfig } from './init.ts'

export interface DumpFigmaOptions {
  component: Component<unknown>
  outDir: string
  tabPattern: string
  scale?: number
  bridge?: string
  cfigmaBin?: string
}

export async function dumpFigma(opts: DumpFigmaOptions): Promise<void> {
  const { component: comp, outDir, tabPattern, scale, bridge, cfigmaBin } = opts
  await mkdir(outDir, { recursive: true })
  if (comp.cases.length === 0) return
  await switchToPageContaining({
    tabPattern,
    nodeId: comp.cases[0].nodeId,
    cfigmaBin,
  })
  await exportFigmaNodes({
    tabPattern,
    nodeIds: comp.cases.map((c) => c.nodeId),
    outDir,
    scale: scale ?? 2,
    bridge,
    cfigmaBin,
  })
}

export async function runDumpFigma(componentName: string, tabOverride?: string): Promise<void> {
  const { cfg, root } = await loadConfig()
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentMod = (await import(resolve(root, componentsDir, componentName, 'index.ts'))) as Record<string, unknown>
  const comp = componentMod[componentName] as Component<unknown> | undefined
  if (!comp || !Array.isArray(comp.cases)) {
    throw new Error(`Component '${componentName}' not exported from ${componentsDir}/${componentName}/index.ts`)
  }
  const outDir = resolve(root, `.pixpec-out/${comp.name}/figma`)
  console.log(`[dump-figma] ${comp.name}: ${comp.cases.length} cases → ${outDir}`)
  const t0 = Date.now()
  await dumpFigma({
    component: comp,
    outDir,
    tabPattern: tabOverride ?? cfg.tabPattern,
    scale: cfg.scale,
    bridge: cfg.bridge,
    cfigmaBin: cfg.cfigmaBin,
  })
  console.log(`[dump-figma] done in ${Date.now() - t0}ms`)
}
