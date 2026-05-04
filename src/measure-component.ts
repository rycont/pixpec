// DEPRECATED 2026-05-02 — replaced by Rust npm bin `pixpec-measure`
// (measure-rs/). Source kept commented out for reference only; do not
// import. Will be deleted once consumers stop pulling on the old types.

// /**
//  * pixpec measure — compares pre-dumped Figma + Chromium PNGs from
//  * .pixpec-out/<comp>/{figma,chromium}/. Scans the directories independently
//  * — does NOT consult cases.ts, Component, or noise(). Pure file-in/file-out.
//  *
//  * Output: .pixpec-out/<comp>/results.json with {case, dE_hsb, dx, dy} per pair.
//  * RGG maps for top-N worst dE → .pixpec-out/<comp>/rgg/<case>/.
//  */
// import { writeFile, readdir, mkdir } from 'node:fs/promises'
// import { join, resolve } from 'node:path'
// import { measureBatch } from './measure-pool.ts'
// import { writeRggMaps } from './rgg.ts'
// import { loadConfig } from './init.ts'
//
// export interface MeasureRecord {
//   case: string
//   dE_hsb: number
//   axis: { dH: number; dS: number; dV: number }
//   dx: number
//   dy: number
//   artifacts: { figma: string; impl: string }
// }
//
// export interface MeasureComponentOptions {
//   figmaDir: string
//   chromiumDir: string
//   outDir: string
//   rggTopN?: number
//   verbose?: boolean
// }
//
// async function listPngs(dir: string): Promise<Set<string>> {
//   try {
//     const files = await readdir(dir)
//     return new Set(files.filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)))
//   } catch {
//     return new Set()
//   }
// }
//
// export async function measureComponent(
//   opts: MeasureComponentOptions,
// ): Promise<MeasureRecord[]> {
//   const { figmaDir, chromiumDir, outDir, rggTopN = 5, verbose } = opts
//   const figmaSet = await listPngs(figmaDir)
//   const chromSet = await listPngs(chromiumDir)
//   if (figmaSet.size === 0) throw new Error(`no PNGs in ${figmaDir}`)
//   if (chromSet.size === 0) throw new Error(`no PNGs in ${chromiumDir}`)
//   const common = [...figmaSet].filter((n) => chromSet.has(n)).sort()
//   const figmaOnly = [...figmaSet].filter((n) => !chromSet.has(n))
//   const chromOnly = [...chromSet].filter((n) => !figmaSet.has(n))
//   if (verbose) {
//     console.log(`figma: ${figmaSet.size}, chromium: ${chromSet.size}, paired: ${common.length}`)
//     if (figmaOnly.length > 0) console.log(`  figma-only: ${figmaOnly.length} (skipped)`)
//     if (chromOnly.length > 0) console.log(`  chromium-only: ${chromOnly.length} (skipped)`)
//   }
//
//   const jobs = common.map((name) => ({
//     figmaPath: join(figmaDir, `${name}.png`),
//     implPath: join(chromiumDir, `${name}.png`),
//   }))
//   const t0 = Date.now()
//   const measures = await measureBatch(jobs)
//   if (verbose) console.log(`measureBatch: ${Date.now() - t0}ms`)
//
//   const records: MeasureRecord[] = common.map((name, i) => ({
//     case: name,
//     dE_hsb: measures[i].dE_hsb,
//     axis: { dH: measures[i].dH_weighted, dS: measures[i].dS, dV: measures[i].dV },
//     dx: measures[i].dx,
//     dy: measures[i].dy,
//     artifacts: { figma: jobs[i].figmaPath, impl: jobs[i].implPath },
//   }))
//
//   // RGG for top-N worst dE.
//   const top = records
//     .map((r, i) => ({ r, i }))
//     .sort((a, b) => b.r.dE_hsb - a.r.dE_hsb)
//     .slice(0, rggTopN)
//   for (const { i } of top) {
//     const m = measures[i]
//     const rggDir = join(outDir, 'rgg', common[i])
//     await mkdir(rggDir, { recursive: true })
//     await writeRggMaps(jobs[i].figmaPath, jobs[i].implPath, rggDir, {
//       shiftX: m.dx,
//       shiftY: m.dy,
//     })
//   }
//   if (verbose && top.length > 0) {
//     console.log(`RGG: top-${top.length} worst dE → ${outDir}/rgg/`)
//   }
//
//   await mkdir(outDir, { recursive: true })
//   await writeFile(join(outDir, 'results.json'), JSON.stringify(records, null, 2))
//   return records
// }
//
// export async function runMeasure(componentName: string): Promise<void> {
//   const { root } = await loadConfig()
//   const baseDir = resolve(root, `.pixpec-out/${componentName}`)
//   const figmaDir = join(baseDir, 'figma')
//   const chromiumDir = join(baseDir, 'chromium')
//   console.log(`[measure] ${componentName}`)
//   const records = await measureComponent({
//     figmaDir,
//     chromiumDir,
//     outDir: baseDir,
//     verbose: true,
//   })
//   // Quick stats
//   const arr = records.map((r) => r.dE_hsb)
//   const sorted = [...arr].sort((a, b) => a - b)
//   const median = sorted[Math.floor(sorted.length / 2)]
//   const max = sorted[sorted.length - 1]
//   console.log(
//     `\n${records.length} measured. dE: median=${median.toFixed(1)} max=${max.toFixed(1)}`,
//   )
//   console.log(`results → ${baseDir}/results.json`)
// }
