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

const isComp = (v: unknown): v is { name: string; figma?: { componentSetKey: string } } =>
  !!v && typeof v === 'object' && 'name' in v && 'figma' in v

const componentsDir = tomlGet('componentsDir') ?? 'src/components'
const componentsPath = resolve(projectRoot, componentsDir)

const registeredKeys = new Set<string>()
const { readdir } = await import('node:fs/promises')
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

const rootMeta = await bridge.exec<{ type: string; name: string }>(tab!, 
  `const n = await figma.getNodeByIdAsync(${JSON.stringify(rootNodeId)}); return { type: n.type, name: n.name }`)

if (rootMeta.type === 'COMPONENT_SET') {
  console.error(`\n✗ ERROR: Root node "${rootMeta.name}" (${rootNodeId}) is a COMPONENT_SET.`)
  console.error(`Breakdown cannot be run on a component set (contains multiple variants).`)
  console.error(`Please provide a specific variant (COMPONENT) node ID or an INSTANCE node ID.`)
  process.exit(1)
}

const treeWalkCode = `
const REGISTRY = new Set(${JSON.stringify(Array.from(registeredKeys))});
const getRegisteredName = (n) => {
  if (n.type !== 'INSTANCE') return null;
  let p = n.mainComponent; while (p && p.type !== 'COMPONENT_SET') p = p.parent;
  const key = p?.key ?? n.mainComponent?.key;
  return REGISTRY.has(key) ? n.name : null; // simplified name mapping for now
};
const getMasterVariantId = async (n) => {
  if (n.type !== 'INSTANCE') return null;
  const main = n.mainComponent ?? (n.getMainComponentAsync ? await n.getMainComponentAsync() : null);
  return main?.id ?? null;
};
const out = [];
const walk = async (n, depth) => {
  if (!n.visible) return;
  if (n.type === 'TEXT') return;

  const compName = getRegisteredName(n);
  // Registered instances are leaves for the breakdown tree (atomic = don't
  // recurse into their internals — they have their own component-level
  // validation). They ARE still verified at standalone instance level so
  // composition tests catch instance-prop regressions; if standalone fails,
  // the user is told to re-run breakdown on the master variant.
  if (!compName) {
    for (const c of n.children ?? []) await walk(c, depth + 1);
  }

  if (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE') {
    const bbox = n.absoluteBoundingBox;
    const render = n.absoluteRenderBounds;
    // Keep NATIVE fractional dims — both chromium (via IR) and the figma
    // PNG export already render at native; verify equalizes for measure-rs's
    // 8-divisibility by padding both sides identically (white) up to the
    // next 8-multiple. No snap, no stretch.
    const masterId = await getMasterVariantId(n);
    out.push({
      id: n.id, name: n.name, depth, type: n.type,
      w: n.width, h: n.height,
      bbox: bbox ?? undefined,
      render: render ?? undefined,
      componentName: compName,
      masterVariantId: masterId,
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
  id: string; name: string; depth: number; type: string
  w?: number; h?: number; bbox?: Bbox; render?: Bbox
  componentName?: string | null
  masterVariantId?: string | null
}
const nodes: Node[] = await bridge.exec<Node[]>(tab, treeWalkCode)
let targets = nodes
const instanceCount = targets.filter(n => n.componentName).length
console.log(`[prepare] ${targets.length} candidate nodes (${instanceCount} registered instances + ${targets.length - instanceCount} frames/components)`)

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

// Filter out targets the IR walk classified as descendants of an `image`
// kind subtree (leaf-only non-autolayout frames). They aren't independently
// addressable — the parent subtree's single SVG export covers their pixels.
const beforeFilter = targets.length
targets = targets.filter((n) => subtreeById.has(n.id))
const dropped = beforeFilter - targets.length
if (dropped > 0) console.log(`[prepare] dropped ${dropped} nodes covered by parent SVG dump`)

let written = 0
for (const n of targets) {
  const ir = subtreeById.get(n.id)!
  const payload = { ir, fileKey, wrapper: wrapperFromIr(ir) }
  await writeFile(breakdownCachePath(projectRoot, n.id), JSON.stringify(payload))
  written++
}
console.log(`[prepare] wrote ${written} IR cache files`)

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
    // useAbsoluteBounds: true → export is layout bbox dim (absoluteBoundingBox)
    // instead of the default absoluteRenderBounds (ink-only). Matches chromium
    // screenshot dim which uses layout bbox. Without this, frames with tiny
    // ink area (e.g. 600×48 frame with single-line low-alpha bg) export as
    // 600×1 and the verify dim mismatch can't be padded meaningfully.
    const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 8 }, useAbsoluteBounds: true });
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
    componentName: n.componentName,
    masterVariantId: n.masterVariantId,
  })),
}
await writeFile(resolve(cacheDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`[prepare] wrote manifest → ${resolve(cacheDir, 'manifest.json')}`)
console.log(`[prepare] DONE — run breakdown-verify next (no cfigma needed)`)
