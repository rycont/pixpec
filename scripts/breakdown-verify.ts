#!/usr/bin/env tsx
/**
 * breakdown-verify — DFS post-order codegen verification, reading the
 * cache produced by `breakdown-prepare`. ZERO cfigma calls; runs offline
 * against `<projectRoot>/.pixpec-out/_breakdown-cache/`.
 *
 *   tsx breakdown-verify.ts [--max-blob 8] [--max-de Inf]
 *                           [--root DIR]
 *
 * Per node: runGenerate (uses cached IR) → ensureExport → runDumpChromium
 *   → place pre-exported figma PNG → pixpec-measure. Halts at first failure
 *   so you can fix the codegen and re-run.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { runGenerate } from '../src/generator/cli.ts'
import { runDumpChromium } from '../src/dump-chromium.ts'
import { Renderer } from '../src/render.ts'
import { runAnalyze } from '../src/analyze.ts'
import { writeRggMaps } from '../src/rgg.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const MEASURE_BIN = resolve(HERE, '../measure-rs/target/release/pixpec-measure')

const args = process.argv.slice(2)
const opt = (k: string, d?: string) => {
  const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d
}
const maxBlob = parseInt(opt('--max-blob', '16')!, 10)
const maxDe = parseFloat(opt('--max-de', 'Infinity')!)
const onlyNode = opt('--only')
const projectRoot = resolve(opt('--root', process.cwd())!)
const cacheDir = resolve(projectRoot, '.pixpec-out/_breakdown-cache')
const reportPath = resolve(projectRoot, '.pixpec-out/_breakdown-report.md')
const componentsPath = resolve(projectRoot, 'src/components')

// ───────── Step 0: cleanup existing BD_ components ─────────
import { readdir, rm } from 'node:fs/promises'
const existing = await readdir(componentsPath, { withFileTypes: true })
let cleanCount = 0
for (const ent of existing) {
  if (ent.isDirectory() && ent.name.startsWith('BD_')) {
    await rm(resolve(componentsPath, ent.name), { recursive: true, force: true })
    cleanCount++
  }
}
if (cleanCount > 0) console.log(`[verify] cleaned up ${cleanCount} BD_ components`)

if (!existsSync(resolve(cacheDir, 'manifest.json'))) {
  console.error(`no cache at ${cacheDir} — run breakdown-prepare first`)
  process.exit(2)
}

type Bbox = { x: number; y: number; width: number; height: number }
type Node = {
  id: string; name: string; depth: number; type: string
  w?: number; h?: number; bbox?: Bbox; render?: Bbox
  componentName?: string // Populated if it's a registered instance
  masterVariantId?: string | null // Populated for instances → master COMPONENT id
}
const manifest = JSON.parse(await readFile(resolve(cacheDir, 'manifest.json'), 'utf8')) as
  { rootNodeId: string; tab: string; fileKey: string; nodes: Node[] }

const safeName = (id: string) => `BD_${id.replace(/[^A-Za-z0-9]/g, '_')}`

/** Measure error subtypes — surfaced verbatim to the user instead of just
 * "Command failed". DimMismatch carries the parsed sizes. */
class DimMismatchError extends Error {
  constructor(public figW: number, public figH: number, public chrW: number, public chrH: number) {
    super(`dim mismatch: figma ${figW}x${figH} vs chrom ${chrW}x${chrH}`)
  }
}
class MeasureError extends Error {
  constructor(public causedBy: string) { super(causedBy) }
}

const runMeasure = async (dir: string) => {
  try {
    await execFileAsync(MEASURE_BIN, [dir],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? ''
    const msg = (e as Error).message ?? ''
    const dim = (stderr + msg).match(/dim mismatch: figma (\d+)x(\d+) vs chrom (\d+)x(\d+)/)
    if (dim) throw new DimMismatchError(+dim[1], +dim[2], +dim[3], +dim[4])
    // Look for any "Caused by:" tail or the last non-empty line in stderr.
    const tail = stderr.split('\n').map(s => s.trim()).filter(Boolean).slice(-3).join(' | ')
    throw new MeasureError(tail || msg)
  }
}

/** Generate RGG maps in-process (skip the cli-rgg subprocess). */
const runRggSafe = async (componentName: string) => {
  try {
    const baseDir = resolve(projectRoot, '.pixpec-out', componentName)
    const records = JSON.parse(await readFile(join(baseDir, 'results.json'), 'utf8')) as
      Array<{ case: string; artifacts: { figma: string; impl: string } }>
    for (const r of records) {
      const rggDir = join(baseDir, 'rgg', r.case)
      await mkdir(rggDir, { recursive: true })
      await writeRggMaps(r.artifacts.figma, r.artifacts.impl, rggDir, { shiftX: 0, shiftY: 0 })
    }
  } catch (e) {
    console.error(`  (rgg failed: ${(e as Error).message.split('\n')[0]})`)
  }
}

const SCALE = 8
/** Round UP to next multiple of SCALE so measure-rs's downsample-by-8 always
 * fits. Padding is applied identically on both sides (figma + chromium) with
 * the wrapper bg color, so the padded region contributes zero diff. */
const padToMul = (v: number) => Math.ceil(v / SCALE) * SCALE

/** Add right/bottom white padding to make `srcBuf` exactly `padW × padH`. */
const padWhite = async (srcBuf: Buffer, padW: number, padH: number): Promise<Buffer> => {
  const meta = await sharp(srcBuf).metadata()
  const w = meta.width!, h = meta.height!
  if (w === padW && h === padH) return srcBuf
  return sharp(srcBuf)
    .extend({
      top: 0, left: 0,
      right: padW - w, bottom: padH - h,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .toBuffer()
}

const placeFigmaPng = async (n: Node, outPath: string): Promise<{ padW: number; padH: number }> => {
  const safe = n.id.replace(/[^A-Za-z0-9]/g, '_')
  const srcPath = resolve(cacheDir, 'figma-png', `${safe}.png`)
  await mkdir(dirname(outPath), { recursive: true })

  let pipeline = sharp(srcPath)

  // Crop overflow ink (figma exportAsync uses absoluteRenderBounds which can
  // extend outside absoluteBoundingBox). Bring back to layout bbox before pad.
  if (n.bbox && n.render) {
    const overflowTop = n.bbox.y - n.render.y
    const overflowLeft = n.bbox.x - n.render.x
    if (overflowTop > 0 || overflowLeft > 0) {
      pipeline = pipeline.extract({
        left: Math.max(0, Math.round(overflowLeft * SCALE)),
        top: Math.max(0, Math.round(overflowTop * SCALE)),
        width: Math.round(n.bbox.width * SCALE),
        height: Math.round(n.bbox.height * SCALE),
      })
    }
  }

  const cropped = await pipeline.toBuffer()
  const meta = await sharp(cropped).metadata()
  // Figma exportAsync uses absoluteRenderBounds — when ink area < layout
  // bbox (e.g. transparent frame with tiny text), the export is smaller
  // than the layout dim. Chromium screenshot uses layout dim. Pad figma
  // up to layout dim before adding the multiple-of-8 padding.
  const layoutW = n.bbox ? Math.round(n.bbox.width * SCALE) : meta.width!
  const layoutH = n.bbox ? Math.round(n.bbox.height * SCALE) : meta.height!
  const padW = padToMul(Math.max(meta.width!, layoutW))
  const padH = padToMul(Math.max(meta.height!, layoutH))
  const padded = await padWhite(cropped, padW, padH)
  await writeFile(outPath, padded)
  return { padW, padH }
}

/** Pad the chromium screenshot to the same dim so measure-rs sees identical
 * canvas sizes. Padding is white (matches boxWrapper bg), zero diff in pad. */
const padChromiumPng = async (chrPath: string, padW: number, padH: number) => {
  const buf = await readFile(chrPath)
  const padded = await padWhite(buf, padW, padH)
  await writeFile(chrPath, padded)
}

/** Walk components dir, find a cases.ts referencing this nodeId, copy the
 * BD_<safeId>/impl.tsx into <componentDir>/generated/<safeId>.tsx. The
 * compose step uses these per-variant trees as the literal source of
 * truth for synthesizing impl.tsx. */
const maybeMirrorGenerated = async (nodeId: string, bdComponentName: string) => {
  const bdImpl = resolve(projectRoot, 'src/components', bdComponentName, 'impl.tsx')
  if (!existsSync(bdImpl)) return
  const ents = await readdir(componentsPath, { withFileTypes: true })
  for (const ent of ents) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith('BD_')) continue
    const casesPath = resolve(componentsPath, ent.name, 'cases.ts')
    if (!existsSync(casesPath)) continue
    const casesSrc = await readFile(casesPath, 'utf8')
    if (!casesSrc.includes(JSON.stringify(nodeId))) continue
    const genDir = resolve(componentsPath, ent.name, 'generated')
    await mkdir(genDir, { recursive: true })
    const safe = nodeId.replace(/[^A-Za-z0-9]/g, '_')
    const dst = resolve(genDir, `${safe}.tsx`)
    const src = await readFile(bdImpl, 'utf8')
    // BD_<id>/ sits at src/components/BD_*/, imports relative paths.
    // Copying to src/components/<Owner>/generated/ adds one extra dir level
    // → every `../...` relative import needs an extra leading `../`.
    const fixed = src.replace(/from\s+(['"])(\.\.\/[^'"]+)\1/g, "from $1../$2$1")
    await writeFile(dst, fixed)
    return
  }
}

const measure = async (componentName: string): Promise<{ max: number; sum: number; blob: number }> => {
  const dir = resolve(projectRoot, '.pixpec-out', componentName)
  await runMeasure(dir)
  const r = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'))[0] as
    { dE00: number; dE00_max: number; blob_max_size: number }
  return { max: r.dE00_max, sum: r.dE00, blob: r.blob_max_size }
}

await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath,
  `# Breakdown report — root ${manifest.rootNodeId}\n\nthreshold: largest connected blob (ΔE00 > 1.9) <= ${maxBlob}, max ΔE00/px <= ${maxDe}\n\n`)

// ───────── Step 1: Generate all components ─────────
process.stdout.write(`[verify] generating ${manifest.nodes.length} components… `)
const originalLog = console.log
console.log = () => {} // Suppress runGenerate logs

const { loadConfig } = await import('../src/init.ts')
// We need to import the functions directly since commonjs/esm interop might be tricky with re-exports.
// Actually, runGenerate is exported from cli.ts, and discoverComponents is also there.
const { discoverComponents } = await import('../src/generator/cli.ts')
const { cfg, root: projectRootPath } = await loadConfig()
const componentsDir = cfg.componentsDir ?? 'src/components'
const components = await discoverComponents(projectRootPath, componentsDir)

try {
  const CONCURRENCY = 32
  const pool = [...manifest.nodes]
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (pool.length > 0) {
      const n = pool.shift()!
      const componentName = safeName(n.id)
      await runGenerate(n.id, { tab: manifest.tab, name: componentName, components })
    }
  })
  await Promise.all(workers)
} finally {
  console.log = originalLog
}
process.stdout.write(`done\n`)

type Failure = {
  node: Node; max: number; sum: number; blob: number; componentName: string
  kind?: 'threshold' | 'dim' | 'error'
  dimErr?: DimMismatchError
  errMsg?: string
}
let firstFailure: Failure | null = null
let passed = 0
let renderer: Renderer | null = null

const getRenderer = async () => {
  renderer ??= await Renderer.create()
  return renderer
}

try {
  for (const n of manifest.nodes) {
    const componentName = safeName(n.id)
    process.stdout.write(`  [${'··'.repeat(n.depth)}] ${n.id} ${n.name} (${n.type} ${n.w}x${n.h})… `)
    try {
      await runDumpChromium(componentName, { renderer: await getRenderer() })
      const { padW, padH } = await placeFigmaPng(n,
        resolve(projectRoot, '.pixpec-out', componentName, 'figma', `${componentName}_main.png`))
      await padChromiumPng(
        resolve(projectRoot, '.pixpec-out', componentName, 'chromium', `${componentName}_main.png`),
        padW, padH)
      const r = await measure(componentName)
      // Drop a clean per-variant generated tree into the parent component's
      // generated/ dir if init has scaffolded one (looked up by figma id in
      // cases.ts). The compose step (AI / hand) reads from there.
      await maybeMirrorGenerated(n.id, componentName)
      const ok = r.blob <= maxBlob && r.max <= maxDe
      process.stdout.write(`blob=${r.blob} max=${r.max.toFixed(2)} sum=${r.sum.toFixed(0)} ${ok ? '✓' : '✗'}\n`)
      await appendFile(reportPath,
        `- ${ok ? '✓' : '✗'} ${'  '.repeat(n.depth)}\`${n.id}\` ${n.name} — blob=${r.blob} max=${r.max.toFixed(2)} sum=${r.sum.toFixed(0)}\n`)
      if (ok) { passed++; continue }
      firstFailure = { node: n, max: r.max, sum: r.sum, blob: r.blob, componentName }
      break
    } catch (e) {
      if (e instanceof DimMismatchError) {
        process.stdout.write(`✗ DIM MISMATCH ${e.figW}x${e.figH} (figma) vs ${e.chrW}x${e.chrH} (chrom)\n`)
        await appendFile(reportPath, `- ✗ ${'  '.repeat(n.depth)}\`${n.id}\` ${n.name} — DIM MISMATCH figma ${e.figW}x${e.figH} vs chrom ${e.chrW}x${e.chrH}\n`)
        firstFailure = { node: n, max: NaN, sum: NaN, blob: NaN, componentName, kind: 'dim', dimErr: e } as typeof firstFailure
        break
      }
      const msg = e instanceof Error ? e.message : String(e)
      process.stdout.write(`ERROR: ${msg.split('\n')[0]}\n`)
      await appendFile(reportPath, `- ⚠ ${'  '.repeat(n.depth)}\`${n.id}\` ${n.name} — error: ${msg.split('\n')[0]}\n`)
      firstFailure = { node: n, max: NaN, sum: NaN, blob: NaN, componentName, kind: 'error', errMsg: msg } as typeof firstFailure
      break
    }
  }
} finally {
  await renderer?.close()
}

console.log(`\n[verify] ${passed} passed`)
if (firstFailure) {
  const { node: n, componentName } = firstFailure
  const outDir = resolve(projectRoot, '.pixpec-out', componentName)
  const caseName = `${componentName}_main`

  if (n.componentName) {
    console.log(`\n💡 TIP: This is an INSTANCE of the registered component "${n.componentName}".`)
    console.log(`   The instance failed standalone-render parity — verify the master`)
    console.log(`   definition next to localize the bug to the component itself:`)
    if (n.masterVariantId) {
      console.log(`\n   pnpm exec tsx ${resolve(HERE, 'breakdown-prepare.ts')} ${n.masterVariantId}`)
      console.log(`   pnpm exec tsx ${resolve(HERE, 'breakdown-verify.ts')}`)
    } else {
      console.log(`   (master variant id not captured — re-run breakdown-prepare to refresh manifest)`)
    }
  }

  // Headline: classify the failure so the user knows immediately what
  // class of fix is needed (regenerate? layout? color? raster engine gap?).
  if (firstFailure.kind === 'dim' && firstFailure.dimErr) {
    const e = firstFailure.dimErr
    console.log(`\n✗ FAILED at ${n.id} (${n.name}) — DIMENSION MISMATCH`)
    console.log(`  figma:    ${e.figW}x${e.figH} px (= ${e.figW/8}x${e.figH/8} css @ DPR=8)`)
    console.log(`  chromium: ${e.chrW}x${e.chrH} px (= ${e.chrW/8}x${e.chrH/8} css)`)
    const dh = (e.chrH - e.figH) / 8, dw = (e.chrW - e.figW) / 8
    console.log(`  delta:    Δw=${dw}c  Δh=${dh}c`)
    console.log(`\nLikely causes:`)
    if (Math.abs(dh) > Math.abs(dw)) {
      console.log(`  - vertical: missing flex-wrap, content collapsed on cross-axis,`)
      console.log(`    or a child with sub-pixel height (parent sV=HUG).`)
    } else if (Math.abs(dw) > 0) {
      console.log(`  - horizontal: missing flex/width on a FILL child, missing min-width:0,`)
      console.log(`    or a wrapping container shrunk to content.`)
    }
  } else if (firstFailure.kind === 'error') {
    console.log(`\n✗ FAILED at ${n.id} (${n.name}) — RUNTIME ERROR`)
    console.log(firstFailure.errMsg ?? '(no message)')
  } else {
    const { max, sum, blob } = firstFailure
    console.log(`\n✗ FAILED at ${n.id} (${n.name}) — DIFF THRESHOLD`)
    console.log(`  blob=${blob} (limit ${maxBlob})  max ΔE/px=${max.toFixed(2)}  sum ΔE=${sum.toFixed(0)}`)

    // Auto-run analyze + rgg so the user gets the full diagnostic without
    // a second command. analyze is best-effort; rgg always written.
    console.log(`\n  generating diagnostics…`)
    try {
      await runAnalyze(componentName, caseName, false)
    } catch (e) {
      console.error(`  (analyze failed: ${(e as Error).message.split('\n')[0]})`)
    }
    await runRggSafe(componentName)
    const segPath = join(outDir, 'analysis', caseName, 'segments.json')
    if (existsSync(segPath)) {
      try {
        const segs = JSON.parse(await readFile(segPath, 'utf8')) as Array<{
          blob_id: number; size: number; bbox: [number, number, number, number]
          shift?: { dx: number; dy: number }; max_de?: number
        }>
        const top = segs.slice(0, 5)
        if (top.length) {
          console.log(`\n  top ${top.length} blob(s):`)
          for (const s of top) {
            const sh = s.shift ? `shift Δ(${s.shift.dx?.toFixed?.(1)},${s.shift.dy?.toFixed?.(1)})` : ''
            console.log(`    #${s.blob_id} size=${s.size} bbox=${JSON.stringify(s.bbox)} ${sh}${s.max_de ? ` max=${s.max_de.toFixed(1)}` : ''}`)
          }
        }
      } catch { /* segments.json parse failed; ignore */ }
    }
  }

  console.log(`\nArtifacts:`)
  console.log(`  fig:  .pixpec-out/${componentName}/figma/${caseName}.png`)
  console.log(`  chr:  .pixpec-out/${componentName}/chromium/${caseName}.png`)
  console.log(`  rgg:  .pixpec-out/${componentName}/rgg/${caseName}/rgg-{h,s,v}.png`)
  if (firstFailure.kind !== 'threshold') {
    console.log(`\nFor diff-threshold cases, breakdown-verify auto-runs analyze + rgg.`)
    console.log(`To regenerate by hand:`)
    console.log(`  pnpm pixpec analyze ${componentName} ${caseName}`)
    console.log(`  pnpm pixpec-rgg ${componentName}`)
  }
  console.log(`\nFix, then rerun.`)
  console.log(`Full report: ${reportPath}`)
  process.exit(1)
}
console.log(`\n✓ All ${manifest.nodes.length} nodes passed (largest blob <= ${maxBlob} pixels above ΔE=2.0). Full report: ${reportPath}`)
