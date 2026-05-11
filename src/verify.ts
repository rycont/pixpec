/**
 * `pixpec verify <Component>` — render every case via the synthesized
 * impl in chromium, then diff each output against the cached figma
 * reference PNGs (run `pixpec dump-figma <Component>` once beforehand
 * to populate those). Two batched ops, no per-case round-trip:
 *
 *   1. runDumpChromium(<Component>)         one chromium session, all cases
 *   2. pixpec-measure <componentDir>        batch dE diff over the dir
 *
 * Falls back to per-case `breakdown-verify` only when impl is still a stub
 * — that path uses IR-direct rendering and is the right tool *before*
 * impl is synthesized. Once impl exists, this is the fast loop.
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

export interface VerifyOptions {
  blobThreshold?: string
  maxBlob?: string
}

export async function runVerify(
  componentName: string,
  opts: VerifyOptions = {},
): Promise<{ pass: number; fail: number; total: number; failed: string[] }> {
  const { cfg, root } = await loadConfig()
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentDir = resolve(root, componentsDir, componentName)
  if (!existsSync(componentDir)) throw new Error(`pixpec verify: no component dir ${componentDir}`)
  const figmaDir = resolve(root, '.pixpec-out', componentName, 'figma')
  if (!existsSync(figmaDir)) {
    throw new Error(
      `pixpec verify: no figma references at ${figmaDir}. ` +
      `Run \`pixpec dump-figma ${componentName}\` first.`,
    )
  }
  console.log(`[verify] rendering ${componentName} cases via chromium…`)
  await runDumpChromium(componentName)
  // Pad both sides to next multiple of 8 (measure-rs's downsample factor)
  // with white. Padding is identical on both → contributes 0 ΔE. Mirrors
  // the placeFigmaPng/padChromiumPng pass in breakdown-verify.
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
        .extend({ top: 0, left: 0, right: pw - w, bottom: ph - h, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
      await writeFile(p, buf)
    }
  }
  const measureArgs = [
    resolve(root, '.pixpec-out', componentName),
    ...(opts.blobThreshold ? ['--blob-threshold', opts.blobThreshold] : []),
  ]
  console.log(`[verify] measuring…`)
  await execFileAsync(MEASURE_BIN, measureArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const results = JSON.parse(await readFile(resolve(root, '.pixpec-out', componentName, 'results.json'), 'utf8')) as
    Array<{ case: string; blob_max_size: number; dE00_max: number; dE00: number }>
  const maxBlob = opts.maxBlob ? parseInt(opts.maxBlob, 10) : 24
  // results.case is the on-disk basename = sanitize(figmaId). Print as-is;
  // figmaId itself IS the human-traceable identifier (back to figma URL).
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
