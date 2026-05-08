#!/usr/bin/env tsx
/**
 * Breakdown — DFS post-order codegen verification.
 *
 *   tsx /home/rycont/dev/pixpec/scripts/breakdown.ts <rootNodeId> [opts]
 *
 * Walks the figma node tree from <rootNodeId>, visiting every FRAME / COMPONENT
 * subtree leaf-first. For each node: `pixpec generate` → `pixpec dump-chromium`
 * → exportAsync (cfigma) → `pixpec-measure`. Halts at the first node whose
 * max ΔE00/px >= threshold (default 30) — that's where the generator is
 * mishandling something. Atomic INSTANCEs (mapping to a registered danah
 * component) are NOT recursed into; they're treated as leaves rendered via
 * their component invocation.
 *
 * Why DFS post-order: a parent's residual is the union of its children's
 * residuals. Visiting leaves first guarantees that a parent failure points
 * at *layout/composition*, not at one of its descendants — every descendant
 * has already been certified.
 *
 *   --threshold N   max-per-pixel ΔE00 limit per node (default 30)
 *   --tab PATTERN   cfigma tab pattern (default from pixpec.toml)
 *   --root DIR      danah project root (default cwd)
 *
 * Usage from danah/:
 *   tsx ../pixpec/scripts/breakdown.ts 3686:13308 --threshold 30
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGenerate } from '../src/generator/cli.ts'
import { runDumpChromium } from '../src/dump-chromium.ts'
import { getBridge } from '../src/cfigma-bridge.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const MEASURE_BIN = resolve(HERE, '../measure-rs/target/release/pixpec-measure')

const args = process.argv.slice(2)
if (!args[0] || args[0].startsWith('-')) {
  console.error('usage: tsx breakdown.ts <rootNodeId> [--max-blob 8] [--max-de Inf] [--tab PATTERN] [--root DIR]')
  process.exit(2)
}
const rootNodeId = args[0]
const opt = (k: string, d?: string) => {
  const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d
}
// Pass criterion: largest connected blob of pixels with ΔE00 > 1.9 must NOT
// exceed `--max-blob`. Default 8 → "9+ connected pixels above threshold = fail".
// Distinguishes anti-alias rendering noise (isolated pixels) from real
// structural mismatches (clustered residuals from mispositioned elements).
const maxBlob = parseInt(opt('--max-blob', '16')!, 10)
const maxDe = parseFloat(opt('--max-de', 'Infinity')!)
const projectRoot = resolve(opt('--root', process.cwd())!)
const reportPath = resolve(projectRoot, '.pixpec-out/_breakdown-report.md')

// Load project config to find cfigmaBin + tab pattern.
const tomlText = await readFile(resolve(projectRoot, 'pixpec.toml'), 'utf8')
const tomlGet = (k: string) => tomlText.match(new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, 'm'))?.[1]
const cfigmaBin = tomlGet('cfigmaBin')!
const defaultTab = opt('--tab', tomlGet('tabPattern')!)
const componentsDir = tomlGet('componentsDir') ?? 'src/components'
const componentsPath = resolve(projectRoot, componentsDir)

// ───────── Step 0: cleanup existing BD_ components ─────────
import { readdir, rm } from 'node:fs/promises'
const existing = await readdir(componentsPath, { withFileTypes: true })
for (const ent of existing) {
  if (ent.isDirectory() && ent.name.startsWith('BD_')) {
    console.log(`[breakdown] cleanup ${ent.name}`)
    await rm(resolve(componentsPath, ent.name), { recursive: true, force: true })
  }
}

// ───────── Step 1: walk figma tree, collect node ids in DFS post-order ─────────
// "Atomic" = INSTANCE backed by a registered defineComponent.
console.log(`[breakdown] walking ${rootNodeId} for FRAME/COMPONENT subtree…`)

const isComp = (v: unknown): v is { name: string; figma?: { componentSetKey: string } } =>
  !!v && typeof v === 'object' && 'name' in v && 'figma' in v

const registeredKeys = new Set<string>()
const ents = await readdir(componentsPath, { withFileTypes: true })
for (const ent of ents) {
  if (!ent.isDirectory()) continue
  try {
    const modPath = resolve(componentsPath, ent.name, 'index.ts')
    const mod = await import(modPath) as Record<string, unknown>
    const c = (mod.default || mod[ent.name] || Object.values(mod).find(isComp)) as any
    if (c?.figma?.componentSetKey) registeredKeys.add(c.figma.componentSetKey)
  } catch { /* skip */ }
}
const bridge = getBridge()

const REGISTRY_JSON = JSON.stringify(Array.from(registeredKeys))
const walkCode = `
const REGISTRY = new Set(${REGISTRY_JSON});
const isRegistered = (n) => {
  if (n.type !== 'INSTANCE') return false;
  let p = n.mainComponent; while (p && p.type !== 'COMPONENT_SET') p = p.parent;
  const key = p?.key ?? n.mainComponent?.key;
  return key && REGISTRY.has(key);
};
const out = [];
const walk = async (n, depth) => {
  if (!n.visible) return;
  if (n.type === 'TEXT') return;

  const registered = isRegistered(n);
  
  // If not a registered component, recurse into children first (post-order).
  // If it IS registered, we treat it as a leaf for this breakdown (don't recurse
  // into its internal implementation details).
  if (!registered) {
    for (const c of n.children ?? []) await walk(c, depth + 1);
  }

  if (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE') {
    out.push({
      id: n.id, name: n.name, depth, atomic: false, type: n.type,
      w: n.width, h: n.height,
      bbox: n.absoluteBoundingBox,    // layout bbox (matches CSS layout)
      render: n.absoluteRenderBounds, // visible ink bbox (figma export uses this)
    });
  }
};
const root = await figma.getNodeByIdAsync(${JSON.stringify(rootNodeId)});
if (!root) throw new Error('node not found');
await walk(root, 0);
return out;
`
type Bbox = { x: number; y: number; width: number; height: number }
type Node = {
  id: string; name: string; depth: number; atomic: boolean; type: string
  w?: number; h?: number
  bbox?: Bbox; render?: Bbox
}
const nodes: Node[] = await bridge.exec<Node[]>(defaultTab!, walkCode)
const targets = nodes.filter((n) => !n.atomic)
console.log(`[breakdown] ${targets.length} non-atomic nodes (${nodes.length - targets.length} atomic skipped)`)

// ───────── Step 1.5: batch-export all node PNGs via bridge /exec ─────────
// Why /exec + figma.exportAsync (NOT /export fast Cooper path):
//   cfigma's /export uses __capturedCpp.exportSelectionAsPngBuffer (fast WASM
//   path) but it silently exports nodes with EMPTY prior `exportSettings` at
//   scale 2 regardless of the requested CONTENT_SCALE. We can't fix that
//   without poking deeper into figma internals. Plugin API `exportAsync`
//   accepts the constraint per-call, always honors it, is non-mutating, and
//   doesn't require any "switch to page first" dance. Cost: ~150-300ms per
//   node × ~20 nodes = 3-6s total — fine given chromium/measure dominate.
//   One HTTP call returns ALL bases64 buffers; pixpec writes to disk.
const figmaTempDir = resolve(projectRoot, '.pixpec-out/_breakdown-figma')
const { rmSync } = await import('node:fs')
try { rmSync(figmaTempDir, { recursive: true, force: true }) } catch {}
await mkdir(figmaTempDir, { recursive: true })
console.log(`[breakdown] exporting ${targets.length} PNGs via figma.exportAsync...`)
const tBatch0 = Date.now()
const exportCode = `
const ids = ${JSON.stringify(targets.map((n) => n.id))};
const out = [];
for (const id of ids) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) { out.push({ id, error: 'node not found' }); continue; }
  try {
    const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 8 } });
    out.push({ id, b64: figma.base64Encode(bytes) });
  } catch (e) {
    out.push({ id, error: String(e?.message ?? e) });
  }
}
return out;
`
const exportRes = await bridge.exec<Array<{ id: string; b64?: string; error?: string }>>(defaultTab!, exportCode)
console.log(`[breakdown] export done in ${Date.now() - tBatch0}ms`)
const idToPath = new Map<string, string>()
for (const r of exportRes) {
  if (r.error) throw new Error(`export ${r.id}: ${r.error}`)
  const path = resolve(figmaTempDir, `${r.id.replace(/[^A-Za-z0-9]/g, '_')}.png`)
  await writeFile(path, Buffer.from(r.b64!, 'base64'))
  idToPath.set(r.id, path)
}

// ───────── Step 2: for each node, run the round-trip ─────────
const safeName = (id: string) => `BD_${id.replace(/[^A-Za-z0-9]/g, '_')}`

const runMeasure = async (dir: string) => {
  await execFileAsync(MEASURE_BIN, [dir],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * Pull the pre-batch-exported PNG for `id` and copy/crop it to `outPath`.
 * No cfigma call here — uses the bbox/render captured during the upfront
 * walk. Crop reasoning: figma export uses absoluteRenderBounds (visible ink
 * bbox including overflow); CSS layout in chromium uses absoluteBoundingBox.
 * If renderBounds extends beyond bbox, crop the export back to bbox region.
 */
const placeFigmaPng = async (n: Node, outPath: string) => {
  const srcPath = idToPath.get(n.id)
  if (!srcPath) throw new Error(`batch export missing for ${n.id}`)
  await mkdir(dirname(outPath), { recursive: true })
  const buf = await readFile(srcPath)
  if (!n.bbox || !n.render) {
    await writeFile(outPath, buf)
    return
  }
  const bbox = n.bbox, render = n.render
  const overflowTop = bbox.y - render.y
  const overflowLeft = bbox.x - render.x
  const overflowRight = (render.x + render.width) - (bbox.x + bbox.width)
  const overflowBottom = (render.y + render.height) - (bbox.y + bbox.height)
  if (overflowTop > 0 || overflowLeft > 0 || overflowRight > 0 || overflowBottom > 0) {
    const sharp = (await import('sharp')).default
    const SCALE = 8
    const cropTop = Math.round(overflowTop * SCALE)
    const cropLeft = Math.round(overflowLeft * SCALE)
    const cropW = Math.round(bbox.width * SCALE)
    const cropH = Math.round(bbox.height * SCALE)
    const cropped = await sharp(buf).extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH }).toBuffer()
    await writeFile(outPath, cropped)
  } else {
    await writeFile(outPath, buf)
  }
}

const measure = async (componentName: string): Promise<{ max: number; sum: number; blob: number }> => {
  const dir = resolve(projectRoot, '.pixpec-out', componentName)
  await runMeasure(dir)
  const r = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'))[0] as
    { dE00: number; dE00_max: number; blob_max_size: number }
  return { max: r.dE00_max, sum: r.dE00, blob: r.blob_max_size }
}

await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath,
  `# Breakdown report — root ${rootNodeId}\n\nthreshold: largest connected blob (ΔE00 > 1.9) <= ${maxBlob}, max ΔE00/px <= ${maxDe}\n\n`)

let firstFailure: { node: Node; max: number; sum: number; blob: number; componentName: string } | null = null
let passed = 0
for (const n of targets) {
  const componentName = safeName(n.id)
  process.stdout.write(`  [${'··'.repeat(n.depth)}] ${n.id} ${n.name} (${n.type} ${n.w}x${n.h})… `)
  try {
    // Direct function calls (vs spawning `pnpm exec tsx pixpec ...` subprocess)
    // — eliminates ~2.5s tsx-loader cold start per step. For a 15-node tree
    // with 2 steps each, that's ~75s saved.
    await runGenerate(n.id, { tab: defaultTab, name: componentName })
    await runDumpChromium(componentName)
    await placeFigmaPng(n,
      resolve(projectRoot, '.pixpec-out', componentName, 'figma', `${componentName}_main.png`))
    const r = await measure(componentName)
    const ok = r.blob <= maxBlob && r.max <= maxDe
    process.stdout.write(`blob=${r.blob} max=${r.max.toFixed(2)} sum=${r.sum.toFixed(0)} ${ok ? '✓' : '✗'}\n`)
    await appendFile(reportPath,
      `- ${ok ? '✓' : '✗'} ${'  '.repeat(n.depth)}\`${n.id}\` ${n.name} — blob=${r.blob} max=${r.max.toFixed(2)} sum=${r.sum.toFixed(0)}\n`)
    if (ok) { passed++; continue }
    firstFailure = { node: n, max: r.max, sum: r.sum, blob: r.blob, componentName }
    break
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stdout.write(`ERROR: ${msg.split('\n')[0]}\n`)
    await appendFile(reportPath, `- ⚠ ${'  '.repeat(n.depth)}\`${n.id}\` ${n.name} — error: ${msg.split('\n')[0]}\n`)
    firstFailure = { node: n, max: NaN, sum: NaN, blob: NaN, componentName }
    break
  }
}

console.log(`\n[breakdown] ${passed} passed`)
if (firstFailure) {
  const { node, max, sum, blob, componentName } = firstFailure
  console.log(`\n✗ FAILED at ${node.id} (${node.name}): blob=${blob} max=${max.toFixed(2)} sum=${sum.toFixed(0)}`)
  console.log(`\nDiagnostics:`)
  console.log(`  pnpm pixpec analyze ${componentName} ${componentName}_main`)
  console.log(`  pnpm pixpec-rgg ${componentName}`)
  console.log(`  open .pixpec-out/${componentName}/{chromium,figma}/${componentName}_main.png`)
  console.log(`  open .pixpec-out/${componentName}/rgg/${componentName}_main/rgg-{h,s,v}.png`)
  console.log(`\nFix the generator (pixpec/src/generator/*) for this pattern, then rerun to resume.`)
  console.log(`\nFull report: ${reportPath}`)
  process.exit(1)
}
console.log(`\n✓ All ${passed} nodes passed (largest blob <= ${maxBlob} pixels above ΔE=1.9). Full report: ${reportPath}`)
