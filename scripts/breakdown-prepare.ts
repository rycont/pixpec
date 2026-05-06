#!/usr/bin/env tsx
/**
 * breakdown-prepare — fetch every figma artifact `breakdown-verify` will
 * need, then never touch cfigma again for that root.
 *
 *   tsx breakdown-prepare.ts <rootNodeId> --tab "PATTERN" [--root DIR]
 *
 * Writes to <projectRoot>/.pixpec-out/_breakdown-cache/:
 *   manifest.json                  tree metadata (id/name/type/depth/bbox/render)
 *   ir/<safeId>.json               per-subtree {ir, fileKey, wrapper}; runGenerate
 *                                  reads these instead of walking figma again.
 *   figma-png/<safeId>.png         reference PNGs (DPR=8) used by placeFigmaPng.
 *
 * Cost model:
 *   - 1 cfigma /exec to walk the tree (collect ids + bboxes)
 *   - 1 cfigma /exec to walk root → IR (resolveImages handles all SVG icons)
 *   - 1 cfigma /exec to batch-export every node's PNG (figma.exportAsync DPR=8)
 *   - 1 cfigma exec via cfigmaBin for getFileKey
 * Total: 3 bridge calls + 1 subprocess, regardless of node count.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { getBridge } from '../src/cfigma-bridge.ts'
import { buildRootPayload, walkIrSubtrees, wrapperFromIr, breakdownCachePath } from '../src/generator/cli.ts'
import type { IRNode } from '../src/generator/ir.ts'

const args = process.argv.slice(2)
if (!args[0] || args[0].startsWith('-')) {
  console.error('usage: tsx breakdown-prepare.ts <rootNodeId> --tab "PATTERN" [--root DIR]')
  process.exit(2)
}
const rootNodeId = args[0]
const opt = (k: string, d?: string) => {
  const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d
}
const projectRoot = resolve(opt('--root', process.cwd())!)
const pngChunk = Math.max(1, Number(opt('--png-chunk', '24')) || 24)

const tomlText = await readFile(resolve(projectRoot, 'pixpec.toml'), 'utf8')
const tomlGet = (k: string) => tomlText.match(new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, 'm'))?.[1]
const tab = opt('--tab', tomlGet('tabPattern'))
if (!tab) { console.error('--tab required (or set tabPattern in pixpec.toml)'); process.exit(2) }

const cacheDir = resolve(projectRoot, '.pixpec-out/_breakdown-cache')
const irDir = resolve(cacheDir, 'ir')
const pngDir = resolve(cacheDir, 'figma-png')
try { rmSync(cacheDir, { recursive: true, force: true }) } catch {}
await mkdir(irDir, { recursive: true })
await mkdir(pngDir, { recursive: true })

// ───── tree walk: collect non-atomic targets + bboxes ─────
console.log(`[prepare] walking ${rootNodeId} for FRAME/COMPONENT subtree…`)
const indexMod = await import(resolve(projectRoot, 'src/index.ts')) as Record<string, unknown>
const isComp = (v: unknown): v is { figma?: { componentSetKey?: string } } =>
  !!v && typeof v === 'object' && 'figma' in v
const registeredKeys = new Set(Object.values(indexMod)
  .filter(isComp).map((c) => c.figma?.componentSetKey).filter(Boolean))

const bridge = getBridge()
const treeWalkCode = `
const REGISTRY = new Set(${JSON.stringify(Array.from(registeredKeys))});
const isAtomicInstance = (n) => {
  if (n.type !== 'INSTANCE') return false;
  let p = n.mainComponent; while (p && p.type !== 'COMPONENT_SET') p = p.parent;
  const key = p?.key ?? n.mainComponent?.key;
  return key && REGISTRY.has(key);
};
const out = [];
const walk = (n, depth) => {
  if (!n.visible) return;
  if (n.type === 'TEXT') return;
  if (isAtomicInstance(n)) { out.push({id:n.id,name:n.name,depth,atomic:true,type:n.type}); return; }
  for (const c of n.children ?? []) walk(c, depth + 1);
  if (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE') {
    out.push({
      id: n.id, name: n.name, depth, atomic: false, type: n.type,
      w: n.width, h: n.height,
      bbox: n.absoluteBoundingBox, render: n.absoluteRenderBounds,
    });
  }
};
const root = await figma.getNodeByIdAsync(${JSON.stringify(rootNodeId)});
if (!root) throw new Error('node not found');
walk(root, 0);
return out;
`
type Bbox = { x: number; y: number; width: number; height: number }
type Node = {
  id: string; name: string; depth: number; atomic: boolean; type: string
  w?: number; h?: number; bbox?: Bbox; render?: Bbox
}
const nodes: Node[] = await bridge.exec<Node[]>(tab, treeWalkCode)
const targets = nodes.filter((n) => !n.atomic)
console.log(`[prepare] ${targets.length} non-atomic nodes (${nodes.length - targets.length} atomic skipped)`)

// ───── single root walk → full IR tree (with image SVGs resolved) ─────
console.log(`[prepare] walking IR + resolving image SVGs…`)
const t0 = Date.now()
const { ir: rootIr, fileKey } = await buildRootPayload(rootNodeId, tab)
console.log(`[prepare] IR + images done in ${Date.now() - t0}ms (fileKey=${fileKey})`)

// Index every subtree in the walked IR by figmaId so we can write per-node caches.
const subtreeById = new Map<string, IRNode>()
for (const { id, ir } of walkIrSubtrees(rootIr)) {
  subtreeById.set(id, ir)
}

let written = 0, missing = 0
for (const n of targets) {
  const ir = subtreeById.get(n.id)
  if (!ir) { missing++; continue }
  const payload = { ir, fileKey, wrapper: wrapperFromIr(ir) }
  await writeFile(breakdownCachePath(projectRoot, n.id), JSON.stringify(payload))
  written++
}
console.log(`[prepare] wrote ${written} IR cache files (missing: ${missing})`)

// ───── batch-export reference PNGs (DPR=8) ─────
console.log(`[prepare] exporting ${targets.length} reference PNGs (DPR=8, chunk=${pngChunk})…`)
const tPng = Date.now()
const makePngCode = (ids: string[]) => `
const ids = ${JSON.stringify(ids)};
const out = [];
for (const id of ids) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) { out.push({ id, error: 'not found' }); continue; }
  try {
    const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 8 } });
    out.push({ id, b64: figma.base64Encode(bytes) });
  } catch (e) { out.push({ id, error: String(e?.message ?? e) }); }
}
return out;
`
let pngOk = 0
const ids = targets.map((n) => n.id)
for (let i = 0; i < ids.length; i += pngChunk) {
  const chunk = ids.slice(i, i + pngChunk)
  const exportRes = await bridge.exec<Array<{ id: string; b64?: string; error?: string }>>(tab, makePngCode(chunk))
  for (const r of exportRes) {
    if (r.error || !r.b64) { console.warn(`[prepare] export ${r.id}: ${r.error}`); continue }
    const safe = r.id.replace(/[^A-Za-z0-9]/g, '_')
    await writeFile(resolve(pngDir, `${safe}.png`), Buffer.from(r.b64, 'base64'))
    pngOk++
  }
  console.log(`[prepare]   png chunk ${Math.min(i + pngChunk, ids.length)}/${ids.length} (${pngOk} ok)`)
}
console.log(`[prepare] PNG export done in ${Date.now() - tPng}ms (${pngOk}/${targets.length})`)

// ───── manifest ─────
const manifest = {
  rootNodeId, tab, fileKey,
  nodes: targets.map((n) => ({
    id: n.id, name: n.name, depth: n.depth, type: n.type,
    w: n.w, h: n.h, bbox: n.bbox, render: n.render,
  })),
}
await writeFile(resolve(cacheDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`[prepare] wrote manifest → ${resolve(cacheDir, 'manifest.json')}`)
console.log(`[prepare] DONE — run breakdown-verify next (no cfigma needed)`)
