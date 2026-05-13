#!/usr/bin/env -S npx tsx
/**
 * pixpec CLI — dispatcher.
 *
 *   pixpec init <fileKey>:<nodeId>       scaffold/refresh a component dir from Figma
 *   pixpec generate <fileKey>:<nodeId>   dump → compile → emit one node's source
 *   pixpec breakdown <fileKey>:<nodeId>  emit a view plus DFS subtree artifacts
 *   pixpec capture src <Component>       capture source artifacts
 *   pixpec capture dst <Component>       capture destination artifacts
 *   pixpec verify <Component>            capture + pixel-verify src vs dst
 *   pixpec analyze <Component> <case>    per-blob shift+shape diagnosis
 *
 * Measurement is its own npm bin (Rust): `pixpec-measure <component_dir>`.
 * RGG visualization is its own npm bin: `pixpec-rgg <Component>`.
 */
import { init } from './init.ts'
import { runAnalyze } from './analyze.ts'
import { runVerify } from './verify.ts'
import { runGenerateTargets } from './generate.ts'
import { runBreakdown } from './breakdown.ts'
import { runCapture, type CaptureSide } from './capture/index.ts'

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
        console.error('usage: pixpec generate <fileKey>:<nodeId> [--target NAME] [--name Comp]')
        process.exit(2)
      }
      const targetIdx = rest.indexOf('--target')
      const nameIdx = rest.indexOf('--name')
      const results = await runGenerateTargets(componentId, {
        target: targetIdx >= 0 ? rest[targetIdx + 1] : undefined,
        componentName: nameIdx >= 0 ? rest[nameIdx + 1] : undefined,
      })
      for (const r of results) console.log(`[generate:${r.target}] ${r.componentName} → ${r.outPath}`)
      break
    }
    case 'breakdown': {
      const figmaId = rest[0]
      if (!figmaId || !figmaId.includes(':')) {
        console.error('usage: pixpec breakdown <fileKey>:<nodeId> [--target NAME] [--name ViewName] [--detach-instances] [--scale N] [--verify] [--verify-source-id ID] [--max-blob N] [--blob-threshold X]')
        process.exit(2)
      }
      const targetIdx = rest.indexOf('--target')
      const nameIdx = rest.indexOf('--name')
      const scaleIdx = rest.indexOf('--scale')
      const mbIdx = rest.indexOf('--max-blob')
      const btIdx = rest.indexOf('--blob-threshold')
      const vsiIdx = rest.indexOf('--verify-source-id')
      const r = await runBreakdown(figmaId, {
        target: targetIdx >= 0 ? rest[targetIdx + 1] : undefined,
        name: nameIdx >= 0 ? rest[nameIdx + 1] : undefined,
        detachInstances: rest.includes('--detach-instances'),
        verify: rest.includes('--verify'),
        scale: scaleIdx >= 0 ? Number(rest[scaleIdx + 1]) : undefined,
        maxBlob: mbIdx >= 0 ? Number(rest[mbIdx + 1]) : undefined,
        blobThreshold: btIdx >= 0 ? rest[btIdx + 1] : undefined,
        verifySourceId: vsiIdx >= 0 ? rest[vsiIdx + 1] : undefined,
      })
      console.log(
        `[breakdown] ${r.viewName} → ${r.viewDir} ` +
        `(${r.entryCount} nodes)`,
      )
      if (r.verify) {
        console.log(`[breakdown:verify] ${r.verify.pass} passed, ${r.verify.skipped} skipped / ${r.verify.total} DFS entries`)
      }
      break
    }
    case 'capture': {
      const side = rest[0] as CaptureSide | undefined
      const componentName = rest[1]
      if ((side !== 'src' && side !== 'dst') || !componentName) {
        console.error('usage: pixpec capture <src|dst> <Component> [--backend NAME] [--tab TAB]')
        process.exit(2)
      }
      const backendIdx = rest.indexOf('--backend')
      const tabIdx = rest.indexOf('--tab')
      await runCapture(side, componentName, {
        backend: backendIdx >= 0 ? rest[backendIdx + 1] as never : undefined,
        tabPattern: tabIdx >= 0 ? rest[tabIdx + 1] : undefined,
        clearOutDir: true,
      })
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
      const targetIdx = rest.indexOf('--target')
      const r = await runVerify(componentName, {
        blobThreshold: btIdx >= 0 ? rest[btIdx + 1] : undefined,
        maxBlob: mbIdx >= 0 ? rest[mbIdx + 1] : undefined,
        target: targetIdx >= 0 ? rest[targetIdx + 1] : undefined,
      })
      if (r.fail > 0) process.exit(1)
      break
    }
    case 'analyze': {
      const componentName = rest[0]
      const caseName = rest[1]
      const crop = rest.includes('--crop')
      const targetIdx = rest.indexOf('--target')
      if (!componentName || !caseName) {
        console.error('usage: pixpec analyze <Component> <case_name> [--target NAME] [--crop]')
        process.exit(2)
      }
      await runAnalyze(componentName, caseName, crop, targetIdx >= 0 ? rest[targetIdx + 1] : undefined)
      break
    }
    case undefined:
    case '--help':
    case '-h':
      console.log('pixpec — visual regression frame for design systems\n')
      console.log('commands:')
      console.log('  init <fileKey>:<nodeId>        scaffold/refresh a component dir from Figma')
      console.log('  generate <fileKey>:<nodeId>    generate one node via src dump → compiler → target')
      console.log('  breakdown <fileKey>:<nodeId>   emit src/view output plus DFS subtrees [--detach-instances] [--scale N] [--verify]')
      console.log('  capture src <Component>        capture source artifacts [--backend figma]')
      console.log('  capture dst <Component>        capture destination artifacts [--backend target]')
      console.log('  verify <Component>             capture + pixel-verify src vs dst [--target name]')
      console.log('  analyze <Component> <case>     per-blob shift+shape diagnosis [--target name] [--crop]')
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
