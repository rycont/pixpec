/**
 * Driver: read danah's __pixpec-fonts.json, emit work/pixpec-text.slint.
 */
import { writeFile, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPixpecText } from '../../src/emitter/slint/build-text.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../../danah/src/fonts/__pixpec-fonts.json')
const OUT = resolve(HERE, 'work/pixpec-text.slint')

const fonts = JSON.parse(await readFile(SRC, 'utf8'))
const slint = buildPixpecText(fonts as Parameters<typeof buildPixpecText>[0], { outputScale: 8 })
await writeFile(OUT, slint)
console.log(`[pixpec-text] wrote ${OUT} (${slint.split('\n').length} lines)`)
