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

const [, , cmd, ...rest] = process.argv

async function main() {
  switch (cmd) {
    case 'init': {
      const componentId = rest[0]
      if (!componentId) {
        console.error('usage: pixpec init <componentId>')
        process.exit(2)
      }
      const r = await init({ componentId })
      console.log(
        `scaffolded ${r.componentName} (${r.variantCount} variants) → ${r.componentDir}`,
      )
      console.log(`  exported ${r.exportedImages.length} images`)
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
