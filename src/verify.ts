/**
 * `pixpec verify <Component>` — capture source and destination artifacts,
 * stage them for the Rust measurer, then report per-case pixel deltas.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { runCurrentCliChild } from './cli-child.ts'
import { loadConfig } from './init.ts'
import { captureDir, loadCaptureComponent, runCapture, stageMeasureInput } from './capture/index.ts'
import { resolveConfiguredTargets } from './targets/index.ts'
import {
  writeComponentReport,
  writeRggForFailedCases,
  type VerifyTargetReport,
} from './component-report.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const MEASURE_BIN = resolve(HERE, '../measure-rs/target/release/pixpec-measure')

export interface VerifyOptions {
  blobThreshold?: string
  maxBlob?: string
  target?: string
  rgg?: boolean
  verbose?: boolean
}

export async function runVerify(
  componentName: string,
  opts: VerifyOptions = {},
): Promise<{ pass: number; fail: number; total: number; failed: string[] }> {
  const { cfg, root } = await loadConfig()
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentDir = resolve(root, componentsDir, componentName)
  if (!existsSync(componentDir)) throw new Error(`pixpec verify: no component dir ${componentDir}`)
  const targets = opts.target ? [opts.target] : resolveConfiguredTargets(cfg)
  const loaded = await loadCaptureComponent(componentName)
  await runCapture('src', componentName, { backend: 'figma', clearOutDir: false })
  let pass = 0
  let fail = 0
  let total = 0
  const failed: string[] = []
  const verifyTargets: VerifyTargetReport[] = []
  for (const target of targets) {
    const r = await runVerifyTarget(componentName, componentDir, root, target, opts)
    pass += r.pass
    fail += r.fail
    total += r.total
    failed.push(...r.failed.map((caseId) => `${target}:${caseId}`))
    verifyTargets.push(r.report)
  }
  await writeComponentReport({
    componentName,
    componentDir,
    component: loaded.component,
    targets,
    verifyTargets,
  })
  return { pass, fail, total, failed }
}

async function runVerifyTarget(
  componentName: string,
  componentDir: string,
  root: string,
  target: string,
  opts: VerifyOptions,
): Promise<{ pass: number; fail: number; total: number; failed: string[]; report: VerifyTargetReport }> {
  console.log(`[verify:${target}] capturing ${componentName} destination artifacts…`)
  if (process.env.PIXPEC_VERIFY_CAPTURE_IN_PROCESS === '1') {
    await runCapture('dst', componentName, { backend: target, clearOutDir: true })
  } else {
    await runCurrentCliChild(['capture', 'dst', componentName, '--backend', target], { cwd: root })
  }
  // Pad both sides to next multiple of 8 (measure-rs's downsample factor)
  // and to the per-case max size. Padding is identical on both → contributes 0 ΔE.
  const sharp = (await import('sharp')).default
  const { readdir, writeFile } = await import('node:fs/promises')
  const padToMul = (v: number) => Math.ceil(v / 8) * 8
  const srcDir = captureDir(componentDir, 'src', 'figma')
  const dstDir = captureDir(componentDir, 'dst', target)
  const dimsByCase = new Map<string, { sw?: number; sh?: number; dw?: number; dh?: number }>()
  for (const [side, dir] of [
    ['src', srcDir],
    ['dst', dstDir],
  ] as const) {
    if (!existsSync(dir)) continue
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.png'))) {
      const p = `${dir}/${f}`
      const meta = await sharp(p).metadata()
      const entry = dimsByCase.get(f) ?? {}
      if (side === 'src') {
        entry.sw = meta.width!
        entry.sh = meta.height!
      } else {
        entry.dw = meta.width!
        entry.dh = meta.height!
      }
      dimsByCase.set(f, entry)
    }
  }
  for (const [f, d] of dimsByCase) {
    const targetW = padToMul(Math.max(d.sw ?? 0, d.dw ?? 0))
    const targetH = padToMul(Math.max(d.sh ?? 0, d.dh ?? 0))
    for (const [dir, w, h] of [
      [srcDir, d.sw, d.sh] as const,
      [dstDir, d.dw, d.dh] as const,
    ]) {
      if (w === undefined || h === undefined) continue
      if (w === targetW && h === targetH) continue
      const p = resolve(dir, f)
      const buf = await sharp(p)
        .extend({
          top: 0,
          left: 0,
          right: targetW - w,
          bottom: targetH - h,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer()
      await writeFile(p, buf)
    }
  }
  const measureBase = await stageMeasureInput({
    componentDir,
    srcBackend: 'figma',
    dstBackend: target,
  })
  const measureArgs = [
    measureBase,
    ...(opts.blobThreshold ? ['--blob-threshold', opts.blobThreshold] : []),
  ]
  console.log(`[verify:${target}] measuring…`)
  await execFileAsync(MEASURE_BIN, measureArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const results = JSON.parse(await readFile(resolve(measureBase, 'results.json'), 'utf8')) as VerifyTargetReport['records']
  const maxBlob = opts.maxBlob ? parseInt(opts.maxBlob, 10) : 24
  // results.case is the on-disk basename = sanitize(figmaId). Print as-is;
  // figmaId itself IS the human-traceable identifier (back to figma URL).
  let pass = 0
  const failed: string[] = []
  const verbose = opts.verbose || process.env.PIXPEC_VERIFY_VERBOSE === '1'
  for (const r of results) {
    const ok = r.blob_max_size <= maxBlob
    if (verbose) {
      console.log(`  ${ok ? '✓' : '✗'} ${r.case} blob=${r.blob_max_size} max=${r.dE00_max.toFixed(2)} sum=${r.dE00.toFixed(0)}`)
    }
    if (ok) pass++
    else failed.push(r.case)
  }
  const failedRecords = results.filter((r) => r.blob_max_size > maxBlob)
  if (opts.rgg || process.env.PIXPEC_VERIFY_RGG === '1') {
    await writeRggForFailedCases({
      componentDir,
      target,
      failed: failedRecords,
    })
  }
  console.log(`\n[${target}] ${pass}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}`)
  return {
    pass,
    fail: failed.length,
    total: results.length,
    failed,
    report: {
      target,
      maxBlob,
      records: results,
      failed: failedRecords,
    },
  }
}
