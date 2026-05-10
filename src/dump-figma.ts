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
  /** Force every case to export from this tab. Omit (undefined) to group
   * cases by each entry's own `fileKey` and export per-tab — required for
   * cases.ts that mixes library masters and consuming-app usages. */
  tabPattern?: string
  scale?: number
  bridge?: string
  cfigmaBin?: string
}

export async function dumpFigma(opts: DumpFigmaOptions): Promise<void> {
  const { component: comp, outDir, tabPattern, scale, bridge, cfigmaBin } = opts
  await mkdir(outDir, { recursive: true })
  if (comp.variants.length === 0) return
  // Cases can span multiple figma files (library masters + consuming-app
  // usages, both emitted by usage-based init). Each Case.figmaId carries
  // its fileKey as a `<fileKey>:<nodeId>` prefix; group by that prefix
  // and run one exportFigmaNodes per tab. An explicit tabPattern arg
  // forces every export through that tab (legacy single-file usage).
  const { splitFigmaId } = await import('./types.ts')
  // Flatten variants → usecases. Each usecase is a real figma node we
  // need the reference PNG of; variant buckets themselves hold no
  // standalone figma node beyond the ones inside their usecases.
  type Uc = { figmaId: string }
  const flat = (comp.variants as Array<{ usecases?: Uc[] }>).flatMap((v) => v.usecases ?? [])
  if (flat.length === 0) return
  const grouped = new Map<string, string[]>()
  // nodeId → full figmaId; output filenames use sanitize(figmaId) so
  // figma↔chromium↔measure all key on the SAME identifier.
  const figmaIdByNode = new Map<string, string>()
  for (const c of flat) {
    const { fileKey, nodeId } = splitFigmaId(c.figmaId)
    const key = tabPattern ?? fileKey
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(nodeId)
    figmaIdByNode.set(nodeId, c.figmaId)
  }
  // cfigma's export uses figma.setSelection which requires every id to
  // live on the SAME page. A real DS file scatters cases across pages
  // (Tabs page, Tabs Used page, etc.), so we ask figma which page owns
  // each id and run a per-page batch export within each tab.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const bin = cfigmaBin ?? 'cfigma'
  for (const [tab, ids] of grouped) {
    // figma.getNodeById is page-scoped; loadAllPagesAsync makes every page's
    // tree available so a single query can place any id on the right page.
    // Without it, ids whose page isn't currently active resolve to null and
    // get silently dropped from the export batch.
    const queryCode = `
      await figma.loadAllPagesAsync();
      const ids = ${JSON.stringify(ids)};
      const out = [];
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) { out.push({ id, page: null }); continue; }
        let p = n;
        while (p && p.type !== 'PAGE') p = p.parent;
        out.push({ id, page: p ? p.id : null });
      }
      return out;
    `
    const { stdout } = await execFileAsync(bin, ['--tab', tab, 'exec', queryCode], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const rows = JSON.parse(stdout) as Array<{ id: string; page: string | null }>
    const byPage = new Map<string, string[]>()
    for (const r of rows) {
      if (!r.page) continue
      if (!byPage.has(r.page)) byPage.set(r.page, [])
      byPage.get(r.page)!.push(r.id)
    }
    // cfigma now names each output `<sanitize(id)>.<ext>` (we pass `--by-id`
    // through exportFigmaNodes), so per-page batches no longer collide on
    // node names. Rename each export directly to `<caseName>.<ext>` for
    // measure-rs's filename-based figma↔chromium pairing.
    const { rename } = await import('node:fs/promises')
    for (const [, pageIds] of byPage) {
      await switchToPageContaining({ tabPattern: tab, nodeId: pageIds[0], cfigmaBin })
      const idToFile = await exportFigmaNodes({
        tabPattern: tab,
        nodeIds: pageIds,
        outDir,
        scale: scale ?? 2,
        bridge,
        cfigmaBin,
      })
      for (const [id, filePath] of idToFile) {
        const figmaId = figmaIdByNode.get(id)
        if (!figmaId) continue
        const extn = filePath.slice(filePath.lastIndexOf('.'))
        const safe = figmaId.replace(/[^A-Za-z0-9]/g, '_')
        const targetPath = `${outDir}/${safe}${extn}`
        if (filePath !== targetPath) await rename(filePath, targetPath)
      }
    }
  }
}

export async function runDumpFigma(componentName: string, tabOverride?: string): Promise<void> {
  const { cfg, root } = await loadConfig()
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentMod = (await import(resolve(root, componentsDir, componentName, 'index.ts'))) as Record<string, unknown>
  const comp = componentMod[componentName] as Component<unknown> | undefined
  if (!comp || !Array.isArray(comp.variants)) {
    throw new Error(`Component '${componentName}' not exported from ${componentsDir}/${componentName}/index.ts`)
  }
  const outDir = resolve(root, `.pixpec-out/${comp.name}/figma`)
  console.log(`[dump-figma] ${comp.name}: ${comp.variants.length} cases → ${outDir}`)
  const t0 = Date.now()
  await dumpFigma({
    component: comp,
    outDir,
    // Only force a single tab when the caller explicitly passed one.
    // Default (undefined) lets dumpFigma group by each case's own fileKey.
    tabPattern: tabOverride,
    scale: cfg.scale,
    bridge: cfg.bridge,
    cfigmaBin: cfg.cfigmaBin,
  })
  console.log(`[dump-figma] done in ${Date.now() - t0}ms`)
}
