/**
 * `pixpec verify-generated <Component>` — validates the per-variant
 * `generated/<safeId>.tsx` files DIRECTLY against every figma usecase,
 * before impl synthesis. Each usecase is rendered through its variant's
 * main-case generated tree (the only generated file that exists per
 * variant) with defaults+props merged — so we exercise both codegen
 * fidelity AND prop parameterization without any impl involvement.
 *
 * Pipeline mirrors `verify`:
 *   1. runDumpChromium with { source: 'generated', clearOutDir: true }
 *   2. pad to multiples of 8
 *   3. pixpec-measure → results.json
 *   4. report PASS/FAIL per usecase
 *
 * Precondition: `.pixpec-out/<Component>/figma/` populated by `dump-figma`.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { runDumpChromium } from './dump-chromium.ts'
import { loadConfig } from './init.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const MEASURE_BIN = resolve(HERE, '../measure-rs/target/release/pixpec-measure')

export interface VerifyGeneratedOptions {
  blobThreshold?: string
  maxBlob?: string
}

export async function runVerifyGenerated(
  componentName: string,
  opts: VerifyGeneratedOptions = {},
): Promise<{ pass: number; fail: number; total: number; failed: string[] }> {
  const { cfg, root } = await loadConfig()
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentDir = resolve(root, componentsDir, componentName)
  if (!existsSync(componentDir)) throw new Error(`pixpec verify-generated: no component dir ${componentDir}`)
  const figmaDir = resolve(root, '.pixpec-out', componentName, 'figma')
  if (!existsSync(figmaDir)) {
    throw new Error(
      `pixpec verify-generated: no figma references at ${figmaDir}. ` +
      `Run \`pixpec dump-figma ${componentName}\` first.`,
    )
  }
  console.log(`[verify-generated] rendering ${componentName} usecases (source=generated)…`)
  await runDumpChromium(componentName, { source: 'generated', clearOutDir: true })

  const sharp = (await import('sharp')).default
  const { readdir, writeFile } = await import('node:fs/promises')
  const padToMul = (v: number) => Math.ceil(v / 8) * 8
  for (const sub of ['figma', 'chromium']) {
    const dir = resolve(root, '.pixpec-out', componentName, sub)
    if (!existsSync(dir)) continue
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.png'))) {
      const p = `${dir}/${f}`
      const meta = await sharp(p).metadata()
      const w = meta.width!, h = meta.height!
      const pw = padToMul(w), ph = padToMul(h)
      if (pw === w && ph === h) continue
      const buf = await sharp(p)
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .extend({ top: 0, left: 0, right: pw - w, bottom: ph - h, background: { r: 255, g: 255, b: 255 } })
        .png()
        .toBuffer()
      await writeFile(p, buf)
    }
  }
  const measureArgs = [
    resolve(root, '.pixpec-out', componentName),
    ...(opts.blobThreshold ? ['--blob-threshold', opts.blobThreshold] : []),
  ]
  console.log(`[verify-generated] measuring…`)
  await execFileAsync(MEASURE_BIN, measureArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const results = JSON.parse(await readFile(resolve(root, '.pixpec-out', componentName, 'results.json'), 'utf8')) as
    Array<{ case: string; blob_max_size: number; dE00_max: number; dE00: number }>
  const maxBlob = opts.maxBlob ? parseInt(opts.maxBlob, 10) : 24
  let pass = 0
  const failed: string[] = []
  for (const r of results) {
    const ok = r.blob_max_size <= maxBlob
    console.log(`  ${ok ? '✓' : '✗'} ${r.case} blob=${r.blob_max_size} max=${r.dE00_max.toFixed(2)} sum=${r.dE00.toFixed(0)}`)
    if (ok) pass++
    else failed.push(r.case)
  }
  console.log(`\n${pass}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}`)
  return { pass, fail: failed.length, total: results.length, failed }
}
