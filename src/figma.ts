/**
 * Figma PNG export via cfigma (CDP-attached Chrome with Figma open).
 *
 * Prerequisites (user-managed, NOT pixpec's job):
 *   1. Chrome launched with `--remote-debugging-port=9222 --user-data-dir=...`,
 *      Figma signed in, design file open.
 *   2. `cfigma --tab "<pattern>" reload` once per session.
 *   3. `cfigma bridge` running in another shell (or supplied via opts).
 *
 * cfigma names exports `<sanitize(node.name)>.png` (with `__<id>` suffix on
 * name collisions). Since we can't predict the filename from nodeId alone,
 * we export into a fresh per-call dir and pick up the single PNG that lands.
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type FigmaExportFormat = 'PNG' | 'JPG' | 'SVG' | 'PDF'

export interface FigmaExportOptions {
  /** Substring matched against Figma tab title+url; must match exactly one. */
  tabPattern: string
  /** Figma node id (e.g. "123:456"). */
  nodeId: string
  /** Where to put the exported file. Created if missing; emptied first. */
  outDir: string
  /** Output format. Default 'PNG'. */
  format?: FigmaExportFormat
  /** PNG/JPG scale. Ignored for SVG/PDF. cfigma default 1. */
  scale?: number
  /** cfigma bridge URL. Default `http://127.0.0.1:9876`. */
  bridge?: string
  /** Override cfigma binary path (default: `cfigma` on PATH). */
  cfigmaBin?: string
}

const EXT_FOR: Record<FigmaExportFormat, string> = {
  PNG: 'png',
  JPG: 'jpg',
  SVG: 'svg',
  PDF: 'pdf',
}

export interface FigmaBatchExportOptions {
  tabPattern: string
  nodeIds: string[]
  /** Single dir for all PNGs. Created if missing; emptied first. */
  outDir: string
  format?: FigmaExportFormat
  scale?: number
  bridge?: string
  cfigmaBin?: string
}

/**
 * Batch-export N nodes via a SINGLE cfigma call. cfigma names each output by
 * sanitized `node.name`, so we first dump (id → name) via `cfigma exec`, then
 * export, then map each nodeId to its absolute PNG path. Returns the mapping.
 *
 * Replaces N sequential `exportFigmaNode` calls (each ~250ms incl. node spawn)
 * with one call (~30s for ~300 PNGs). Massive speedup on large sweeps.
 */
export async function exportFigmaNodes(
  opts: FigmaBatchExportOptions,
): Promise<Map<string, string>> {
  const bin = opts.cfigmaBin ?? 'cfigma'
  const format: FigmaExportFormat = opts.format ?? 'PNG'
  const ext = EXT_FOR[format]
  // Caller owns outDir lifecycle — exportFigmaNodes is called once per
  // (tab, page) batch by dump-figma, and wiping here would erase prior
  // batches' files (this dropped 34/37 cases on multi-page TabItem dumps).
  await mkdir(opts.outDir, { recursive: true })

  // Step 1: query node names + sanitize to predict filenames.
  // cfigma sanitizes name → filename by replacing non-[A-Za-z0-9_.-] with `_`.
  // O(1) lookup per id via figma.getNodeById; figma.root.findOne walks the
  // full document tree per call (~2s × N → seconds for large fileKeys).
  const queryCode = `
    const ids = ${JSON.stringify(opts.nodeIds)};
    const out = [];
    for (const id of ids) {
      const n = figma.getNodeById(id);
      out.push({ id, name: n ? n.name : null });
    }
    return out;
  `
  const t0 = Date.now()
  const { stdout: nameJson } = await execFileAsync(
    bin,
    ['--tab', opts.tabPattern, 'exec', queryCode],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const t1 = Date.now()
  console.error(`    [exportFigmaNodes] query names ${t1 - t0}ms`)
  const nameRows = JSON.parse(nameJson) as Array<{ id: string; name: string | null }>

  // Step 2: single export call. `--by-id` makes cfigma name each output
  // file by the sanitized node id (1:1 with input ids), eliminating the
  // figma-layer-name collision dance — different nodes labeled "Tab_Item"
  // each land at their own `<sanitize(id)>.png` instead of fighting for
  // the bare-name slot.
  const args = [
    '--tab', opts.tabPattern, 'export',
    '--ids', opts.nodeIds.join(','),
    '--by-id',
    '--out', opts.outDir,
    '--format', format,
  ]
  if (format === 'PNG' || format === 'JPG') args.push('--scale', String(opts.scale ?? 1))
  if (opts.bridge) args.push('--bridge', opts.bridge)
  await execFileAsync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const t2 = Date.now()
  console.error(`    [exportFigmaNodes] export ${t2 - t1}ms`)

  // Step 3: list output files + map id → file by sanitized-name match.
  // Mirror cfigma's filename.sanitize exactly (control-char strip + path
  // sep → _, whitespace runs → _, allow ASCII alnum + Hangul + CJK + ._- ,
  // then COLLAPSE consecutive underscores into single, then trim leading/
  // trailing _.  Allow Hangul syllables U+AC00–U+D7AF etc.
  const filesOnDisk = (await readdir(opts.outDir)).filter((f) => f.endsWith('.' + ext))
  const sanitize = (raw: string): string => {
    let s = raw
    try { s = s.normalize('NFC') } catch { /* no-op */ }
    s = s.replace(/[\u0000-\u001f\u007f]/g, '')
    s = s.replace(/[\/\\]+/g, '_')
    s = s.replace(/\s+/g, '_')
    s = s.replace(/[^A-Za-z0-9._\-ᄀ-ᇿ㄰-㆏가-힯一-鿿]/g, '_')
    s = s.replace(/_+/g, '_')
    s = s.replace(/^[_.]+/, '').replace(/[_.]+$/, '')
    return s || 'node'
  }
  const map = new Map<string, string>()
  // Group nodes by sanitized name to detect collisions.
  const byName = new Map<string, Array<{ id: string }>>()
  for (const r of nameRows) {
    if (!r.name) continue
    const sk = sanitize(r.name)
    const arr = byName.get(sk) ?? []
    arr.push({ id: r.id })
    byName.set(sk, arr)
  }
  // With --by-id, cfigma names each export `<sanitize(id)>.<ext>` — the
  // mapping is 1:1 with no collision logic on either side. We only need
  // to confirm each requested id has its file on disk.
  for (const r of nameRows) {
    if (!r.name) throw new Error(`exportFigmaNodes: node not found for id ${r.id}`)
    const expected = sanitize(r.id) + '.' + ext
    if (!filesOnDisk.includes(expected)) {
      throw new Error(
        `exportFigmaNodes: no output file for nodeId=${r.id} (expected ${expected})`,
      )
    }
    map.set(r.id, join(opts.outDir, expected))
  }
  void byName
  return map
}

/**
 * Export one node, return absolute path of the resulting file.
 * Throws if cfigma produces 0 or >1 files.
 */
export async function exportFigmaNode(
  opts: FigmaExportOptions,
): Promise<string> {
  const bin = opts.cfigmaBin ?? 'cfigma'
  const format: FigmaExportFormat = opts.format ?? 'PNG'
  const ext = EXT_FOR[format]
  await rm(opts.outDir, { recursive: true, force: true })
  await mkdir(opts.outDir, { recursive: true })
  const args = [
    '--tab',
    opts.tabPattern,
    'export',
    '--ids',
    opts.nodeId,
    '--out',
    opts.outDir,
    '--format',
    format,
  ]
  if (format === 'PNG' || format === 'JPG') {
    args.push('--scale', String(opts.scale ?? 1))
  }
  if (opts.bridge) args.push('--bridge', opts.bridge)
  await execFileAsync(bin, args, { encoding: 'utf8' })
  const files = (await readdir(opts.outDir)).filter((f) => f.endsWith('.' + ext))
  if (files.length === 0) {
    throw new Error(
      `cfigma export produced no ${ext} for node ${opts.nodeId} (tab=${opts.tabPattern})`,
    )
  }
  if (files.length > 1) {
    throw new Error(
      `cfigma export produced ${files.length} ${ext} files for node ${opts.nodeId} — expected 1: ${files.join(', ')}`,
    )
  }
  return join(opts.outDir, files[0])
}
