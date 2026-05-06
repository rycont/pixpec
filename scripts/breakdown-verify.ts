#!/usr/bin/env tsx
/**
 * breakdown-verify — DFS post-order codegen verification, reading the
 * cache produced by `breakdown-prepare`. ZERO cfigma calls; runs offline
 * against `<projectRoot>/.pixpec-out/_breakdown-cache/`.
 *
 *   tsx breakdown-verify.ts [--max-blob 8] [--max-de Inf] [--skip-passed]
 *                           [--root DIR]
 *
 * Per node: runGenerate (uses cached IR) → ensureExport → runDumpChromium
 *   → place pre-exported figma PNG → pixpec-measure. Halts at first failure
 *   so you can fix the codegen and re-run with `--skip-passed`.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const skipPassed = args.includes('--skip-passed')
const projectRoot = resolve(opt('--root', process.cwd())!)
const cacheDir = resolve(projectRoot, '.pixpec-out/_breakdown-cache')
const reportPath = resolve(projectRoot, '.pixpec-out/_breakdown-report.md')

if (!existsSync(resolve(cacheDir, 'manifest.json'))) {
  console.error(`no cache at ${cacheDir} — run breakdown-prepare first`)
  process.exit(2)
}

type Bbox = { x: number; y: number; width: number; height: number }
type Node = {
  id: string; name: string; depth: number; type: string
  w?: number; h?: number; bbox?: Bbox; render?: Bbox
}
const manifest = JSON.parse(await readFile(resolve(cacheDir, 'manifest.json'), 'utf8')) as
  { rootNodeId: string; tab: string; fileKey: string; nodes: Node[] }

const safeName = (id: string) => `Gen_${id.replace(/[^A-Za-z0-9]/g, '_')}`
const indexEntry = (name: string) =>
  `export { ${name} } from './components/${name}/index.ts'`
const ensureExport = async (name: string) => {
  const idxPath = resolve(projectRoot, 'src/index.ts')
  const txt = await readFile(idxPath, 'utf8')
  if (txt.includes(`from './components/${name}/`)) return
  await writeFile(idxPath, txt.trimEnd() + '\n' + indexEntry(name) + '\n')
}

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

const placeFigmaPng = async (n: Node, outPath: string) => {
  const safe = n.id.replace(/[^A-Za-z0-9]/g, '_')
  const srcPath = resolve(cacheDir, 'figma-png', `${safe}.png`)
  await mkdir(dirname(outPath), { recursive: true })
  const buf = await readFile(srcPath)
  if (!n.bbox || !n.render) { await writeFile(outPath, buf); return }
  const bbox = n.bbox, render = n.render
  const overflowTop = bbox.y - render.y
  const overflowLeft = bbox.x - render.x
  const overflowRight = (render.x + render.width) - (bbox.x + bbox.width)
  const overflowBottom = (render.y + render.height) - (bbox.y + bbox.height)
  if (overflowTop > 0 || overflowLeft > 0 || overflowRight > 0 || overflowBottom > 0) {
    const sharp = (await import('sharp')).default
    const SCALE = 8
    const cropTop = Math.round(overflowTop * SCALE)
    const cropLeft = Math.round(overflowLeft * SCALE)
    const cropW = Math.round(bbox.width * SCALE)
    const cropH = Math.round(bbox.height * SCALE)
    const cropped = await sharp(buf)
      .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
      .toBuffer()
    await writeFile(outPath, cropped)
  } else {
    await writeFile(outPath, buf)
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
    const outDir = resolve(projectRoot, '.pixpec-out', componentName)
    if (skipPassed && existsSync(join(outDir, 'results.json'))) {
      try {
        const r = JSON.parse(await readFile(join(outDir, 'results.json'), 'utf8'))[0]
        if (typeof r.blob_max_size === 'number' && r.blob_max_size <= maxBlob && (typeof r.dE00_max !== 'number' || r.dE00_max <= maxDe)) {
          skipped++
          process.stdout.write(`  [${'··'.repeat(n.depth)}] ${n.id} ${n.name}: cached blob=${r.blob_max_size} max=${(r.dE00_max ?? 0).toFixed(2)} ✓\n`)
          continue
        }
      } catch { /* fall through */ }
    }
    process.stdout.write(`  [${'··'.repeat(n.depth)}] ${n.id} ${n.name} (${n.type} ${n.w}x${n.h})… `)
    try {
      await runGenerate(n.id, { tab: manifest.tab })
      await ensureExport(componentName)
      await runDumpChromium(componentName, { renderer: await getRenderer() })
      await placeFigmaPng(n,
        resolve(projectRoot, '.pixpec-out', componentName, 'figma', `${componentName}_main.png`))
      const r = await measure(componentName)
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

console.log(`\n[verify] ${passed} passed, ${skipped} skipped (cached)`)
if (firstFailure) {
  const { node: n, componentName } = firstFailure
  const outDir = resolve(projectRoot, '.pixpec-out', componentName)
  const caseName = `${componentName}_main`

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
  console.log(`\nFix, then rerun with --skip-passed.`)
  console.log(`Full report: ${reportPath}`)
  process.exit(1)
}
console.log(`\n✓ All ${manifest.nodes.length} nodes passed (largest blob <= ${maxBlob} pixels above ΔE=1.9). Full report: ${reportPath}`)
