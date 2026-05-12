#!/usr/bin/env -S npx tsx
/**
 * pixpec CLI — dispatcher.
 *
 *   pixpec init <fileKey>:<nodeId>       scaffold/refresh a component dir from Figma
 *   pixpec generate <fileKey>:<nodeId>   dump → compile → emit one node's source
 *   pixpec breakdown <fileKey>:<nodeId>  emit a view plus DFS subtree artifacts
 *   pixpec verify-generated <Component>  pixel-verify generated/ vs Figma
 *   pixpec dump-figma <Component> [tab]  export Figma frames → .pixpec-out/<C>/figma/
 *   pixpec dump-chromium <Component>     render + screenshot → .pixpec-out/<C>/chromium/
 *   pixpec analyze <Component> <case>    per-blob shift+shape diagnosis
 *
 * Measurement is its own npm bin (Rust): `pixpec-measure <component_dir>`.
 * RGG visualization is its own npm bin: `pixpec-rgg <Component>`.
 */
import { init } from './init.ts'
import { runDumpFigma } from './dump-figma.ts'
import { runDumpChromium } from './dump-chromium.ts'
import { runAnalyze } from './analyze.ts'
import { runVerify } from './verify.ts'
import { runVerifyGenerated } from './verify-generated.ts'
import { runGenerate } from './generate.ts'
import { runBreakdown } from './breakdown.ts'

const [, , cmd, ...rest] = process.argv

async function main() {
  switch (cmd) {
    case 'init': {
      const componentId = rest[0]
      if (!componentId) {
        console.error('usage: pixpec init <fileKey>:<nodeId>')
        process.exit(2)
      }
      const r = await init({ componentId })
      console.log(
        `scaffolded ${r.componentName} (${r.variantCount} variants) → ${r.componentDir}`,
      )
      break
    }
    case 'generate': {
      const componentId = rest[0]
      if (!componentId || !componentId.includes(':')) {
        console.error('usage: pixpec generate <fileKey>:<nodeId> [--emitter NAME] [--name Comp]')
        process.exit(2)
      }
      const emIdx = rest.indexOf('--emitter')
      const nameIdx = rest.indexOf('--name')
      const r = await runGenerate(componentId, {
        emitter: emIdx >= 0 ? rest[emIdx + 1] : undefined,
        componentName: nameIdx >= 0 ? rest[nameIdx + 1] : undefined,
      })
      console.log(`[generate] ${r.componentName} → ${r.outPath}`)
      break
    }
    case 'breakdown': {
      const figmaId = rest[0]
      if (!figmaId || !figmaId.includes(':')) {
        console.error('usage: pixpec breakdown <fileKey>:<nodeId> [--emitter NAME] [--name ViewName]')
        process.exit(2)
      }
      const emIdx = rest.indexOf('--emitter')
      const nameIdx = rest.indexOf('--name')
      const r = await runBreakdown(figmaId, {
        emitter: emIdx >= 0 ? rest[emIdx + 1] : undefined,
        name: nameIdx >= 0 ? rest[nameIdx + 1] : undefined,
      })
      console.log(
        `[breakdown] ${r.viewName} → ${r.viewDir} ` +
        `(${r.entryCount} nodes, codegen ${r.failedCount} failed, verify ${r.verifyFailedCount}/${r.verifiedCount} failed)`,
      )
      break
    }
    case 'dump-figma': {
      const componentName = rest[0]
      const tabOverride = rest[1]
      if (!componentName) {
        console.error('usage: pixpec dump-figma <Component> [tabPattern]')
        process.exit(2)
      }
      await runDumpFigma(componentName, tabOverride)
      break
    }
    case 'dump-chromium': {
      const componentName = rest[0]
      if (!componentName) {
        console.error('usage: pixpec dump-chromium <Component>')
        process.exit(2)
      }
      await runDumpChromium(componentName)
      break
    }
    case 'verify': {
      const componentName = rest[0]
      if (!componentName) {
        console.error('usage: pixpec verify <Component> [--blob-threshold X] [--max-blob N]')
        process.exit(2)
      }
      const btIdx = rest.indexOf('--blob-threshold')
      const mbIdx = rest.indexOf('--max-blob')
      const r = await runVerify(componentName, {
        blobThreshold: btIdx >= 0 ? rest[btIdx + 1] : undefined,
        maxBlob: mbIdx >= 0 ? rest[mbIdx + 1] : undefined,
      })
      if (r.fail > 0) process.exit(1)
      break
    }
    case 'analyze': {
      const componentName = rest[0]
      const caseName = rest[1]
      const crop = rest.includes('--crop')
      if (!componentName || !caseName) {
        console.error('usage: pixpec analyze <Component> <case_name> [--crop]')
        process.exit(2)
      }
      await runAnalyze(componentName, caseName, crop)
      break
    }
    case undefined:
    case '--help':
    case '-h':
      console.log('pixpec — visual regression frame for design systems\n')
      console.log('commands:')
      console.log('  init <fileKey>:<nodeId>        scaffold/refresh a component dir from Figma')
      console.log('  generate <fileKey>:<nodeId>    emit one node via dumper → compiler → emitter')
      console.log('  breakdown <fileKey>:<nodeId>   emit src/view output plus DFS subtrees')
      console.log('  verify-generated <Component>   pixel-verify generated/ vs Figma')
      console.log('  verify <Component>             full verify pipeline (legacy)')
      console.log('  dump-figma <Component> [tab]   export Figma frames')
      console.log('  dump-chromium <Component>      render + screenshot')
      console.log('  analyze <Component> <case>     per-blob shift+shape diagnosis [--crop]')
      console.log('\nseparate bins:')
      console.log('  pixpec-measure <dir>           Rust HSB-Euclidean dE → results.json')
      console.log('  pixpec-rgg <Component>         top-N worst RGG H/S/V diff maps')
      break
    default:
      console.error(`unknown command: ${cmd}`)
      process.exit(2)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e)
  process.exit(1)
})
    case 'verify-generated': {
      const componentName = rest[0]
      if (!componentName) {
        console.error('usage: pixpec verify-generated <Component> [--blob-threshold X] [--max-blob N]')
        process.exit(2)
      }
      const btIdx = rest.indexOf('--blob-threshold')
      const mbIdx = rest.indexOf('--max-blob')
      const r = await runVerifyGenerated(componentName, {
        blobThreshold: btIdx >= 0 ? rest[btIdx + 1] : undefined,
        maxBlob: mbIdx >= 0 ? rest[mbIdx + 1] : undefined,
      })
      if (r.fail > 0) process.exit(1)
      break
    }
