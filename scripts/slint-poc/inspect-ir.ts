/**
 * Throwaway: dump → compile a real figma node and dump the DNode tree
 * to stdout. Use to verify what the AST actually contains (vs what I
 * speculate it contains).
 *
 *   tsx inspect-ir.ts <fileKey:nodeId>
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dump } from '../../src/dumper/index.ts'
import { compile } from '../../src/compiler/index.ts'
import { loadConfig } from '../../src/init.ts'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: tsx inspect-ir.ts <fileKey:nodeId>')
  process.exit(2)
}
const i = arg.indexOf(':')
const fileKey = arg.slice(0, i)
const nodeId = arg.slice(i + 1)

const DANAH_ROOT = resolve(import.meta.dirname, '../../../danah')
const { cfg } = await loadConfig(DANAH_ROOT)

// Load the same tokenMap that generate.ts builds.
const tokenMap: Record<string, string> = {}
const tokenValueMap: Record<string, number> = {}
try {
  const ft = JSON.parse(await readFile(resolve(DANAH_ROOT, 'tokens/figma-tokens.json'), 'utf8')) as {
    variables: Array<{ id: string; key?: string; name: string; resolvedType: string; valuesByMode?: Record<string, unknown> }>
  }
  for (const v of ft.variables) {
    const tokenPath = v.name.replace(/[\x00-\x1f]/g, '')
      .split('/').map((s) => s.replace(/\s+/g, '').replace(/^./, (c) => c.toLowerCase()))
      .join('.')
    tokenMap[v.id] = tokenPath
    if (v.key) tokenMap[v.key] = tokenPath
    if (v.resolvedType === 'FLOAT' && v.valuesByMode) {
      const num = Object.values(v.valuesByMode).find((x): x is number => typeof x === 'number')
      if (typeof num === 'number') {
        tokenValueMap[v.id] = num
        if (v.key) tokenValueMap[v.key] = num
      }
    }
  }
} catch (e) {
  console.error('[inspect] tokens load failed:', (e as Error).message)
}

console.error(`[inspect] dumping ${fileKey}:${nodeId} from ${cfg.tabPattern}…`)
const raw = await dump({ cfigmaBin: cfg.cfigmaBin!, tab: fileKey, nodeId })
console.error(`[inspect] compiling…`)
const dnode = await compile(raw, { registry: new Map(), tokenMap, tokenValueMap })
console.log(JSON.stringify(dnode, null, 2))
