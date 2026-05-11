/**
 * Sweep TEXT_BASELINE_NUDGE_PX over a range, re-render the failing leaf
 * (4108:1697 — body/strong 16px text in segmented control), measure each
 * iteration. Goal: confirm whether the residual is purely y-shift (single
 * minimum on the curve) and whether the optimal scales with font-size.
 *
 * Doesn't go through the emitter — patches the .slint padding values
 * directly on a copy. Throwaway.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = resolve(HERE, '../../../danah/.pixpec-out/_slint-bd/4108_1695/BD_4108_1697')
const RENDER_BIN = resolve(HERE, 'render-rs/target/release/slint-poc-render')
const MEASURE_BIN = resolve(HERE, '../../measure-rs/target/release/pixpec-measure')

const slintPath = resolve(BASE, 'BD_4108_1697.slint')
const baseSrc = await readFile(slintPath, 'utf8')

const sweep = [-0.5, -0.375, -0.25, -0.125, 0, 0.0625, 0.125, 0.1875, 0.25]
console.log('nudge_design_px  device_px  blob  dE_max  dE_sum')
for (const nudge of sweep) {
  // Replace the existing nudge values (current 0.1875) with the test nudge.
  const patched = baseSrc
    .replace(/spacing-200 - 0\.1875px/g, `spacing-200 - ${nudge}px`)
    .replace(/spacing-200 \+ 0\.1875px/g, `spacing-200 + ${nudge}px`)
  await writeFile(slintPath, patched)

  await execFileAsync(RENDER_BIN, [
    slintPath,
    resolve(BASE, '_work/chromium/BD_4108_1697.png'),
    '96', '40', '8',
  ])
  await execFileAsync(MEASURE_BIN, [resolve(BASE, '_work')])
  const r = JSON.parse(await readFile(resolve(BASE, '_work/results.json'), 'utf8')) as Array<{
    blob_max_size: number; dE00_max: number; dE00: number
  }>
  const m = r[0]
  console.log(
    `${nudge.toFixed(4).padStart(15)}  ${(nudge * 8).toFixed(2).padStart(8)}  ${String(m.blob_max_size).padStart(4)}  ${m.dE00_max.toFixed(2).padStart(6)}  ${m.dE00.toFixed(0).padStart(6)}`,
  )
}

// Restore original.
await writeFile(slintPath, baseSrc)
console.log('\n[restored original .slint]')
