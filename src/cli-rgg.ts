#!/usr/bin/env -S npx tsx
/**
 * pixpec-rgg — write per-axis HSV diff maps (rgg-h/s/v.png) for the top-N
 * worst-dE cases of a component.
 *
 * Reads `.pixpec-out/<Component>/results.json` (produced by pixpec-measure)
 * and the matching figma/chromium PNGs, writes RGG maps to
 * `.pixpec-out/<Component>/rgg/<case>/`.
 *
 * No shift correction — figma↔chromium pairs are expected to be aligned
 * at the impl level (see ADR-0026 y-shift, font-face-parity.md).
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeRggMaps } from './rgg.ts'
import { loadConfig } from './init.ts'

interface MeasureRecord {
  case: string
  dE00: number
  artifacts: { figma: string; impl: string }
}

async function main() {
  const args = process.argv.slice(2)
  const componentName = args[0]
  const topNFlag = args.indexOf('--top')
  const topN = topNFlag >= 0 ? Number(args[topNFlag + 1]) : 5
  if (!componentName) {
    console.error('usage: pixpec-rgg <Component> [--top N]')
    process.exit(2)
  }
  const { root } = await loadConfig()
  const baseDir = resolve(root, `.pixpec-out/${componentName}`)
  const resultsPath = join(baseDir, 'results.json')
  const records = JSON.parse(await readFile(resultsPath, 'utf8')) as MeasureRecord[]
  const top = [...records].sort((a, b) => b.dE00 - a.dE00).slice(0, topN)
  console.log(`[rgg] ${componentName}: top-${top.length} of ${records.length}`)
  for (const r of top) {
    const rggDir = join(baseDir, 'rgg', r.case)
    await mkdir(rggDir, { recursive: true })
    await writeRggMaps(r.artifacts.figma, r.artifacts.impl, rggDir, {
      shiftX: 0,
      shiftY: 0,
    })
    console.log(`  ${r.case}  ΔE00=${r.dE00.toFixed(1)}`)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e)
  process.exit(1)
})
