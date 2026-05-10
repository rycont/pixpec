#!/usr/bin/env -S npx tsx
/**
 * pixpec CLI — dispatcher.
 *
 *   pixpec init <componentId>            scaffold a component dir from Figma
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
import { runGenerate } from './generator/cli.ts'
import { runVerify } from './verify.ts'
import { runVerifyGenerated } from './verify-generated.ts'
import { runGenerateV2 } from './generate-v2.ts'

const [, , cmd, ...rest] = process.argv

async function main() {
  switch (cmd) {
    case 'init': {
      const componentId = rest[0]
      if (!componentId) {
        console.error('usage: pixpec init <fileKey>:<nodeId>  (or just <nodeId>; init scans configured tabs in order)')
        process.exit(2)
      }
      const r = await init({ componentId })
      console.log(
        `scaffolded ${r.componentName} (${r.variantCount} variants) → ${r.componentDir}`,
      )
      console.log(`  files: props.ts, cases.ts, defaults.ts, index.ts (always rewritten)`)
      console.log(`         impl.tsx (stub — preserved on re-init)`)
      console.log(`         generated/ (empty — populated by breakdown)`)
      console.log(``)
      console.log(`Next: run breakdown for each variant so generated/<id>.tsx exists,`)
      console.log(`then synthesize impl.tsx by composing the per-variant trees.`)
      console.log(``)
      // Resolve the on-disk pixpec scripts dir relative to this cli.ts file.
      const { fileURLToPath } = await import('node:url')
      const { dirname: dn, resolve: rs } = await import('node:path')
      const scriptsDir = rs(dn(fileURLToPath(import.meta.url)), '../scripts')
      console.log(`  # prepare+verify each variant:`)
      for (const id of r.variantIds) {
        console.log(`  pnpm exec tsx ${scriptsDir}/breakdown-prepare.ts ${id} \\`)
        console.log(`    && pnpm exec tsx ${scriptsDir}/breakdown-verify.ts`)
      }
      console.log(``)
      console.log(`Once every variant passes verify, compose ${r.componentName}/impl.tsx`)
      console.log(`from the per-variant outputs in ${r.componentDir}/generated/.`)
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
    case 'generate': {
      const nodeId = rest[0]
      if (!nodeId) { console.error('usage: pixpec generate <nodeId> [--tab X] [--out path.tsx]'); process.exit(2) }
      const tabIdx = rest.indexOf('--tab')
      const nameIdx = rest.indexOf('--name')
      await runGenerate(nodeId, {
        tab: tabIdx >= 0 ? rest[tabIdx + 1] : undefined,
        name: nameIdx >= 0 ? rest[nameIdx + 1] : undefined,
      })
      break
    }
    case 'generate-v2': {
      const componentId = rest[0]
      if (!componentId || !componentId.includes(':')) {
        console.error('usage: pixpec generate-v2 <fileKey>:<nodeId> [--emitter NAME] [--name Comp]')
        process.exit(2)
      }
      const emIdx = rest.indexOf('--emitter')
      const nameIdx = rest.indexOf('--name')
      const r = await runGenerateV2(componentId, {
        emitter: emIdx >= 0 ? rest[emIdx + 1] : undefined,
        componentName: nameIdx >= 0 ? rest[nameIdx + 1] : undefined,
      })
      console.log(`[generate-v2] ${r.componentName} → ${r.outPath}`)
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
      console.log('  init <componentId>             scaffold a component dir from Figma')
      console.log('  verify <Component>             prepare+verify every entry in cases.ts (bails on first ✗)')
      console.log('  verify-generated <Component>   verify generated/<safeId>.tsx ↔ figma main case per variant')
      console.log('  dump-figma <Component> [tab]   export Figma frames to .pixpec-out/<C>/figma/')
      console.log('  dump-chromium <Component>      render + screenshot to .pixpec-out/<C>/chromium/')
      console.log('  analyze <Component> <case>     per-blob shift+shape diagnosis [--crop]')
      console.log('\nseparate bins (not subcommands):')
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
