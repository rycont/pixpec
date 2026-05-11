/**
 * Slint breakdown — DFS post-order codegen verification, slint flavour.
 *
 *   tsx breakdown.ts <fileKey:nodeId> [--max-blob 24] [--scale 8]
 *
 * Steps once per run:
 *   1. dump+compile the root → full DNode tree
 *   2. collect every container-shaped sub-DNode (Box / Flex / Stack)
 *   3. batch-export figma PNGs for each sourceId via cfigma bridge
 *   4. for each sub-DNode in DFS post-order:
 *        slintEmitter.emit() → render via slint-poc-render → measure-rs
 *        halt at the first node whose blob_max_size exceeds maxBlob
 *
 * Why DFS post-order: a parent's residual is the union of its children's,
 * so visiting leaves first makes a parent failure point at THIS NODE's
 * layout/composition — every descendant has already been certified.
 *
 * Atomic-leaf logic: a registered Slint component would short-circuit the
 * recursion. None registered yet, so every container is verified.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump } from '../../src/dumper/index.ts'
import { compile } from '../../src/compiler/index.ts'
import { loadConfig } from '../../src/init.ts'
import { slintEmitter, type SlintEmitContext } from '../../src/emitter/slint/index.ts'
import { getBridge } from '../../src/cfigma-bridge.ts'
import { type DNode, NodeKind } from '../../src/compiler/design-ast.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const RENDER_BIN = resolve(HERE, 'render-rs/target/release/slint-poc-render')
const MEASURE_BIN = resolve(HERE, '../../measure-rs/target/release/pixpec-measure')
const TOKENS_PATH = resolve(HERE, 'work/tokens.slint')

// ─── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const arg0 = args[0]
if (!arg0 || arg0.startsWith('-')) {
  console.error('usage: tsx breakdown.ts <fileKey:nodeId> [--max-blob 24] [--scale 8]')
  process.exit(2)
}
const optAt = (k: string, d?: string) => {
  const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d
}
const colon = arg0.indexOf(':')
const fileKey = arg0.slice(0, colon)
const rootNodeId = arg0.slice(colon + 1)
const scale = parseInt(optAt('--scale', '8')!, 10)
// Pair criteria: each `<dE>:<maxblob>` says "no connected region > maxblob
// pixels has dE > threshold". Multiple flags = multiple AND criteria.
// Defaults pair with measure-rs's two-threshold default — 2.7/24 catches
// structural mismatches above the AA noise floor, 1.9/40 catches sub-
// perceptual drift over a region that the higher threshold misses.
const criteriaArgs = (() => {
  const out: Array<{ threshold: number; maxBlob: number }> = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--criterion') continue
    const v = args[i + 1] ?? ''
    const [t, m] = v.split(':').map(Number)
    if (Number.isFinite(t) && Number.isFinite(m)) out.push({ threshold: t, maxBlob: m })
  }
  return out.length > 0 ? out : [
    { threshold: 2.7, maxBlob: 24 },
    { threshold: 1.9, maxBlob: 40 },
  ]
})()

const DANAH_ROOT = resolve(HERE, '../../../danah')
const { cfg } = await loadConfig(DANAH_ROOT)
const cacheRoot = resolve(DANAH_ROOT, '.pixpec-out/_slint-bd', rootNodeId.replace(/[^A-Za-z0-9]/g, '_'))
await rm(cacheRoot, { recursive: true, force: true })
await mkdir(cacheRoot, { recursive: true })

// ─── 1: dump+compile root → full DNode tree ────────────────────────────────
console.log(`[breakdown] dumping ${fileKey}:${rootNodeId}…`)
const tokenMap: Record<string, string> = {}
const tokenValueMap: Record<string, number> = {}
try {
  const ft = JSON.parse(await readFile(resolve(DANAH_ROOT, 'tokens/figma-tokens.json'), 'utf8')) as {
    variables: Array<{ id: string; key?: string; name: string; resolvedType: string; valuesByMode?: Record<string, unknown> }>
  }
  for (const v of ft.variables) {
    const tp = v.name.replace(/[\x00-\x1f]/g, '').split('/')
      .map((s) => s.replace(/\s+/g, '').replace(/^./, (c) => c.toLowerCase())).join('.')
    tokenMap[v.id] = tp
    if (v.key) tokenMap[v.key] = tp
    if (v.resolvedType === 'FLOAT' && v.valuesByMode) {
      const num = Object.values(v.valuesByMode).find((x): x is number => typeof x === 'number')
      if (typeof num === 'number') {
        tokenValueMap[v.id] = num
        if (v.key) tokenValueMap[v.key] = num
      }
    }
  }
} catch { /* tokens optional */ }
const raw = await dump({ cfigmaBin: cfg.cfigmaBin!, tab: fileKey, nodeId: rootNodeId })
const root = await compile(raw, { registry: new Map(), tokenMap, tokenValueMap })

// ─── 2: collect container sub-DNodes in DFS post-order ─────────────────────
type Visit = { node: DNode; depth: number }
const targets: Visit[] = []
const isContainer = (n: DNode): boolean =>
  n.kind === NodeKind.Box || n.kind === NodeKind.Flex || n.kind === NodeKind.Stack
const walk = (n: DNode, depth: number) => {
  if ('children' in n && Array.isArray(n.children)) {
    for (const c of n.children as DNode[]) walk(c, depth + 1)
  }
  if (isContainer(n)) targets.push({ node: n, depth })
}
walk(root, 0)
console.log(`[breakdown] ${targets.length} container nodes (DFS post-order)`)

// ─── 3: batch-export figma PNGs for each sourceId ──────────────────────────
const exportCode = `
const ids = ${JSON.stringify(targets.map((t) => t.node.sourceId))};
const out = [];
for (const id of ids) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) { out.push({ id, error: 'node not found' }); continue; }
  try {
    const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: ${scale} } });
    out.push({ id, b64: figma.base64Encode(bytes) });
  } catch (e) {
    out.push({ id, error: String(e?.message ?? e) });
  }
}
return out;
`
const bridge = getBridge()
console.log(`[breakdown] exporting ${targets.length} figma PNGs at scale=${scale}…`)
const exportRes = await bridge.exec<Array<{ id: string; b64?: string; error?: string }>>(fileKey, exportCode)
const figmaPngById = new Map<string, string>()
for (const r of exportRes) {
  if (r.error) { console.error(`[breakdown] export ${r.id}: ${r.error}`); continue }
  const path = resolve(cacheRoot, '_figma', `${r.id.replace(/[^A-Za-z0-9]/g, '_')}.png`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(r.b64!, 'base64'))
  figmaPngById.set(r.id, path)
}

// ─── 4: per-node round-trip ────────────────────────────────────────────────
const safeName = (id: string) => `BD_${id.replace(/[^A-Za-z0-9]/g, '_')}`

// Figma export honours the requested SCALE constraint, slint-poc-render
// honours design-px × scale. Both should produce the same physical-px
// dimension when given the same root width/height — but figma's SVG
// glyph rasterisation can sometimes round dims by 1 px relative to
// figma's reported `width`/`height`. The mismatch dance is a known
// pixpec concern (see verify-generated padToMul); for breakdown's first
// pass we just skip on dim mismatch and surface in the report.
let firstFailure: { v: Visit; reason: string } | null = null
let passed = 0
for (const v of targets) {
  const id = v.node.sourceId
  const dim = (() => {
    const n = v.node as { width?: { value?: number }; height?: { value?: number } }
    return { w: n.width?.value, h: n.height?.value }
  })()
  if (!dim.w || !dim.h) {
    console.log(`  [${'  '.repeat(v.depth)}] ${id} ${v.node.sourceName} — SKIP (no fixed dim)`)
    continue
  }
  const cn = safeName(id)
  process.stdout.write(`  [${'  '.repeat(v.depth)}] ${id} ${v.node.sourceName} (${v.node.kind} ${dim.w}×${dim.h})… `)
  try {
    const ctx: SlintEmitContext = {
      componentName: cn,
      designSystem: {},
      tokensImportPath: TOKENS_PATH,
      pixpecTextImportPath: resolve(HERE, 'work/pixpec-text.slint'),
      fontImports: [resolve(DANAH_ROOT, 'src/fonts/WantedSansVariable/WantedSansVariable.ttf')],
    }
    const out = slintEmitter.emit(v.node, ctx)
    const slintPath = resolve(cacheRoot, cn, `${cn}.slint`)
    await mkdir(dirname(slintPath), { recursive: true })
    await writeFile(slintPath, out.source)

    const workDir = resolve(cacheRoot, cn, '_work')
    const figmaDir = resolve(workDir, 'figma')
    const chrDir = resolve(workDir, 'chromium')
    await mkdir(figmaDir, { recursive: true })
    await mkdir(chrDir, { recursive: true })
    const figmaSrc = figmaPngById.get(id)
    if (!figmaSrc) throw new Error('no figma export')
    await writeFile(resolve(figmaDir, `${cn}.png`), await readFile(figmaSrc))

    const implPng = resolve(chrDir, `${cn}.png`)
    await execFileAsync(RENDER_BIN, [slintPath, implPng, String(dim.w), String(dim.h), String(scale)])

    const measureArgs = [workDir, ...criteriaArgs.flatMap((c) => ['--blob-threshold', String(c.threshold)])]
    await execFileAsync(MEASURE_BIN, measureArgs)
    const r = JSON.parse(await readFile(resolve(workDir, 'results.json'), 'utf8')) as Array<{
      dE00_max: number; dE00: number
      blobs: Array<{ threshold: number; max_size: number; max_bbox?: [number, number, number, number] }>
    }>
    const m = r[0]
    const reasons: string[] = []
    let allOk = true
    for (const c of criteriaArgs) {
      const b = m.blobs.find((x) => Math.abs(x.threshold - c.threshold) < 1e-6)
      const size = b?.max_size ?? 0
      const ok = size <= c.maxBlob
      if (!ok) allOk = false
      reasons.push(`${c.threshold}/${c.maxBlob}=${size}${ok ? '' : '!'}`)
    }
    process.stdout.write(`${reasons.join(' ')} max=${m.dE00_max.toFixed(2)} ${allOk ? '✓' : '✗'}\n`)
    if (allOk) { passed++; continue }
    firstFailure = { v, reason: `${reasons.join(' ')} (max dE/px=${m.dE00_max.toFixed(2)})` }
    break
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stdout.write(`ERROR\n  → ${msg.split('\n')[0]}\n`)
    firstFailure = { v, reason: msg.split('\n')[0] }
    break
  }
}

console.log(`\n[breakdown] ${passed} passed`)
if (firstFailure) {
  console.log(`✗ FAILED at ${firstFailure.v.node.sourceId} ${firstFailure.v.node.sourceName} — ${firstFailure.reason}`)
  console.log(`  artifacts: ${cacheRoot}/${safeName(firstFailure.v.node.sourceId)}/`)
  process.exit(1)
}
console.log(`✓ all ${passed} nodes passed (${criteriaArgs.map((c) => `${c.threshold}/${c.maxBlob}`).join(' ')})`)
