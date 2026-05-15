/**
 * Figma PNG export via cfigma (CDP-attached Chrome with Figma open).
 *
 * Prerequisites (user-managed, NOT pixpec's job):
 *   1. Chrome launched with `--remote-debugging-port=9222 --user-data-dir=...`,
 *      Figma signed in, design file open.
 *   2. `cfigma --tab "<pattern>" reload` once per session.
 *   3. `cfigma bridge` running in another shell (or supplied via opts).
 *
 * Single-node export uses cfigma's default output naming. Batch export passes
 * `--by-id`, so each file is predictable as `<sanitize(nodeId)>.<ext>`.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface CfigmaExportSummary {
    ok?: boolean
    nodes?: number
    written?: number
    failed?: number
    out_dir?: string
}

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

function parseCfigmaExportSummary(stdout: string): CfigmaExportSummary | null {
    const start = stdout.lastIndexOf('\n{')
    const jsonText = (start >= 0 ? stdout.slice(start + 1) : stdout).trim()
    if (!jsonText.startsWith('{')) return null
    try {
        return JSON.parse(jsonText) as CfigmaExportSummary
    } catch {
        return null
    }
}

function assertCfigmaExportSucceeded(
    stdout: string,
    expectedNodes: number,
    context: string,
    bridge?: string,
): void {
    const summary = parseCfigmaExportSummary(stdout)
    if (!summary) return

    const written = summary.written ?? 0
    const failed = summary.failed ?? 0
    const nodes = summary.nodes ?? expectedNodes
    if (summary.ok === false || failed > 0 || written < expectedNodes) {
        const bridgeUrl = bridge ?? 'http://127.0.0.1:9876'
        throw new Error(
            `${context}: cfigma export failed (nodes=${nodes}, written=${written}, failed=${failed}). ` +
                `Check that cfigma bridge is running at ${bridgeUrl}.`,
        )
    }
}

// Mirror cfigma's filename.sanitize for --by-id exports.
function sanitizeCfigmaFilename(raw: string): string {
    let s = raw
    try {
        s = s.normalize('NFC')
    } catch {
        // no-op
    }
    s = s.replace(/[\u0000-\u001f\u007f]/g, '')
    s = s.replace(/[\/\\]+/g, '_')
    s = s.replace(/\s+/g, '_')
    s = s.replace(/[^A-Za-z0-9._\-ᄀ-ᇿ㄰-㆏가-힯一-鿿]/g, '_')
    s = s.replace(/_+/g, '_')
    s = s.replace(/^[_.]+/, '').replace(/[_.]+$/, '')
    return (s || 'node').slice(0, 150)
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

export async function preflightCfigmaExport(opts: {
    tabPattern: string
    nodeId: string
    bridge?: string
    cfigmaBin?: string
}): Promise<void> {
    const bin = opts.cfigmaBin ?? 'cfigma'
    const bridgeUrl = opts.bridge ?? 'http://127.0.0.1:9876'
    const outDir = await mkdtemp(join(tmpdir(), 'pixpec-cfigma-preflight-'))
    const args = [
        '--tab',
        opts.tabPattern,
        'export',
        '--ids',
        opts.nodeId,
        '--by-id',
        '--out',
        outDir,
        '--format',
        'PNG',
        '--scale',
        '1',
        '--bridge',
        bridgeUrl,
    ]
    try {
        const { stdout } = await execFileAsync(bin, args, {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        })
        assertCfigmaExportSucceeded(stdout, 1, 'cfigma preflight', bridgeUrl)
        const expected = sanitizeCfigmaFilename(opts.nodeId) + '.png'
        const files = await readdir(outDir)
        if (!files.includes(expected)) {
            throw new Error(`cfigma preflight: export did not create ${expected}`)
        }
        console.error(`    [cfigma preflight] OK (${opts.nodeId})`)
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        throw new Error(
            [
                `pixpec init: cfigma export preflight failed for node ${opts.nodeId}.`,
                `bridge: ${bridgeUrl}`,
                'Make sure the cfigma bridge is running and the Figma tab has been reloaded:',
                `  ${bin} bridge`,
                `  ${bin} --tab ${JSON.stringify(opts.tabPattern)} reload`,
                `cause: ${detail}`,
            ].join('\n'),
        )
    } finally {
        await rm(outDir, { recursive: true, force: true })
    }
}

/**
 * Batch-export N nodes via a SINGLE cfigma call. Returns a nodeId → absolute
 * PNG path mapping.
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
    // (tab, page) batch by source capture, and wiping here would erase prior
    // batches' files (this dropped 34/37 cases on multi-page TabItem dumps).
    await mkdir(opts.outDir, { recursive: true })

    // Step 1: query node existence before export.
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
    const nameRows = JSON.parse(nameJson) as Array<{
        id: string
        name: string | null
    }>

    // Step 2: single export call. `--by-id` makes cfigma name each output
    // file by the sanitized node id (1:1 with input ids), eliminating the
    // figma-layer-name collision dance — different nodes labeled "Tab_Item"
    // each land at their own `<sanitize(id)>.png` instead of fighting for
    // the bare-name slot.
    const args = [
        '--tab',
        opts.tabPattern,
        'export',
        '--ids',
        opts.nodeIds.join(','),
        '--by-id',
        '--out',
        opts.outDir,
        '--format',
        format,
    ]
    if (format === 'PNG' || format === 'JPG')
        args.push('--scale', String(opts.scale ?? 1))
    if (opts.bridge) args.push('--bridge', opts.bridge)
    const { stdout: exportStdout } = await execFileAsync(bin, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
    assertCfigmaExportSucceeded(
        exportStdout,
        opts.nodeIds.length,
        'exportFigmaNodes',
        opts.bridge,
    )
    const t2 = Date.now()
    console.error(`    [exportFigmaNodes] export ${t2 - t1}ms`)

    // Step 3: list output files + map id → file by sanitized id match.
    const filesOnDisk = (await readdir(opts.outDir)).filter((f) =>
        f.endsWith('.' + ext),
    )
    const map = new Map<string, string>()
    // With --by-id, cfigma names each export `<sanitize(id)>.<ext>` — the
    // mapping is 1:1 with no collision logic on either side. We only need
    // to confirm each requested id has its file on disk.
    for (const r of nameRows) {
        if (!r.name)
            throw new Error(`exportFigmaNodes: node not found for id ${r.id}`)
        const expected = sanitizeCfigmaFilename(r.id) + '.' + ext
        if (!filesOnDisk.includes(expected)) {
            throw new Error(
                `exportFigmaNodes: no output file for nodeId=${r.id} (expected ${expected})`,
            )
        }
        map.set(r.id, join(opts.outDir, expected))
    }
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
    const { stdout: exportStdout } = await execFileAsync(bin, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
    assertCfigmaExportSucceeded(exportStdout, 1, 'exportFigmaNode', opts.bridge)
    const files = (await readdir(opts.outDir)).filter((f) =>
        f.endsWith('.' + ext),
    )
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
