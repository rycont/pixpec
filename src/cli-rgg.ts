#!/usr/bin/env -S npx tsx
/**
 * pixpec-rgg — write per-axis HSV diff maps (rgg-h/s/v.png) for the top-N
 * worst-dE cases of a component.
 *
 * Reads component-local `.pixpec/verify/figma__<target>/measure/results.json`
 * and writes RGG maps to `.pixpec/verify/figma__<target>/rgg/<case>/`.
 *
 * No shift correction — figma↔chromium pairs are expected to be aligned
 * at the impl level (see ADR-0026 y-shift, font-face-parity.md).
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeRggMaps } from './rgg.ts'
import { loadConfig } from './init.ts'
import { componentPixpecDir, verifyMeasureDir } from './capture/index.ts'
import { resolveOneConfiguredTarget } from './targets/index.ts'

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
  const targetFlag = args.indexOf('--target')
  if (!componentName) {
    console.error('usage: pixpec-rgg <Component> [--top N]')
    process.exit(2)
  }
  const { cfg, root } = await loadConfig()
  const target = resolveOneConfiguredTarget(cfg, targetFlag >= 0 ? args[targetFlag + 1] : undefined)
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentDir = resolve(root, componentsDir, componentName)
  const baseDir = verifyMeasureDir(componentDir, 'figma', target)
  const resultsPath = join(baseDir, 'results.json')
  const records = JSON.parse(await readFile(resultsPath, 'utf8')) as MeasureRecord[]
  const top = [...records].sort((a, b) => b.dE00 - a.dE00).slice(0, topN)
  console.log(`[rgg] ${componentName}: top-${top.length} of ${records.length}`)
  for (const r of top) {
    const rggDir = join(componentPixpecDir(componentDir), 'verify', `figma__${target}`, 'rgg', r.case)
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
