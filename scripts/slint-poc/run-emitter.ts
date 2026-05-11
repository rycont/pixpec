/**
 * Throwaway driver: build a synthetic chip DNode, lower via slintEmitter,
 * write to disk, render via slint-poc-render, measure against the cached
 * figma reference. Smoke-checks that the emitter reproduces the
 * hand-authored chip.slint result (blob_max_size=7 from earlier PoC pass).
 */
import { writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { slintEmitter } from '../../src/emitter/slint/index.ts'
import {
  type DFlex,
  type DText,
  NodeKind,
  FlowDirection,
  Align,
  Justify,
  TextAutoResize,
} from '../../src/compiler/design-ast.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const WORK = resolve(HERE, 'work')
const RENDER_BIN = resolve(HERE, 'render-rs/target/release/slint-poc-render')
const MEASURE_BIN = resolve(ROOT, 'measure-rs/target/release/pixpec-measure')

// Synthetic DNode mirroring the danah Chip "뉴진스" instance the PoC pinned.
// Token paths chosen to match what compile() would set against the figma
// variable bindings.
const chipText: DText = {
  sourceId: 'syn-text',
  sourceName: 'label',
  kind: NodeKind.Text,
  content: '뉴진스',
  // textStyleRef points at the panda textStyles compound entry; the
  // emitter spreads it into Tokens.<id>.font-* struct-field accesses.
  // Per-axis fields stay unset so the textStyle drives every property.
  textStyleRef: 'footnote.regular',
  // figma lineHeight is informational here — Slint Text ignores it.
  // Carrying it makes the AST round-trip lossless and keeps the
  // measure-rs test honest about which lowering has the gap.
  fontSize: undefined as unknown as DText['fontSize'],
  lineHeight: undefined as unknown as DText['lineHeight'],
  color: { tokenPath: 'content.standard.secondary' },
  width: 32,
  autoResize: TextAutoResize.Hug,
}
const chipRoot: DFlex = {
  sourceId: 'syn-chip',
  sourceName: 'Chip',
  kind: NodeKind.Flex,
  direction: FlowDirection.Row,
  width: { value: 56, unit: 'px' },
  height: { value: 32, unit: 'px' },
  padding: {
    top: { tokenPath: 'spacing.150' },
    right: { tokenPath: 'spacing.300' },
    bottom: { tokenPath: 'spacing.150' },
    left: { tokenPath: 'spacing.300' },
  },
  align: Align.Center,
  justify: Justify.Center,
  background: { tokenPath: 'components.translucent.primary' },
  cornerRadius: { tokenPath: 'radius.300' },
  children: [chipText],
}

const result = slintEmitter.emit(chipRoot, {
  componentName: 'Chip',
  designSystem: {},
  tokensImportPath: 'work/tokens.slint',
  pixpecTextImportPath: 'work/pixpec-text.slint',
  fontImports: ['../../../danah/src/fonts/WantedSansVariable/WantedSansVariable.ttf'],
} as Parameters<typeof slintEmitter.emit>[1]) as { source: string; fileExtension: string }

const outSlint = resolve(HERE, 'chip-emitted.slint')
await writeFile(outSlint, result.source)
console.log(`[emit] wrote ${outSlint} (${result.source.split('\n').length} lines)`)
console.log('---SOURCE---')
console.log(result.source)
console.log('---/SOURCE---')

// Render → measure.
const outPng = resolve(WORK, 'chromium/chip.png')
await execFileAsync(RENDER_BIN, [outSlint, outPng, '56', '32', '8'])
console.log(`[render] wrote ${outPng}`)
await execFileAsync(MEASURE_BIN, [WORK])
const r = JSON.parse(await readFile(resolve(WORK, 'results.json'), 'utf8')) as Array<{
  case: string; dE00: number; dE00_max: number; blob_max_size: number; blob_max_bbox: [number, number, number, number]
}>
const m = r[0]
console.log(`[measure] dE_max=${m.dE00_max.toFixed(2)} blob=${m.blob_max_size} bbox=${JSON.stringify(m.blob_max_bbox)}`)
const ok = m.blob_max_size <= 24
console.log(ok ? '✓ PASS (blob ≤ 24)' : '✗ FAIL — emitter output regresses vs hand-authored')
process.exit(ok ? 0 : 1)
