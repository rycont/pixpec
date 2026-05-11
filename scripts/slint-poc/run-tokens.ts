/**
 * Throwaway driver: read danah's panda-tokens.ts, emit tokens.slint into
 * the PoC work dir. Sanity-checks that the chip's referenced tokens
 * actually appear in the output.
 */
import { writeFile, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSlintTokens } from '../../src/emitter/slint/build-tokens.ts'
// @ts-expect-error — danah is a sibling project, not a dep; resolved via path.
import * as panda from '../../../danah/tokens/panda-tokens.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, 'work/tokens.slint')
const FIGMA = resolve(HERE, '../../../danah/tokens/figma-tokens.json')

const figma = JSON.parse(await readFile(FIGMA, 'utf8'))
const slint = buildSlintTokens(
  panda as unknown as Parameters<typeof buildSlintTokens>[0],
  { remBase: 16 },
  figma as Parameters<typeof buildSlintTokens>[2],
)
await writeFile(OUT, slint)

const expectedRefs = [
  'components-translucent-primary',
  'content-standard-secondary',
  'radius-300',
  'spacing-150',
  'spacing-300',
  // SegmentedControl text nodes reference these (figma FLOAT vars,
  // panda-tokens.ts loses them — covered by the figma-tokens fallback).
  'size-body',
  'lineHeight-body',
  'paragraphSpacing-body',
]
const missing = expectedRefs.filter((id) => !slint.includes(`property <color> ${id}:`) && !slint.includes(`property <length> ${id}:`))
console.log(`[slint-tokens] wrote ${OUT} (${slint.split('\n').length} lines)`)
if (missing.length) {
  console.log(`[slint-tokens] WARN — chip-required tokens missing: ${missing.join(', ')}`)
} else {
  console.log('[slint-tokens] OK — all chip-required tokens present')
}
