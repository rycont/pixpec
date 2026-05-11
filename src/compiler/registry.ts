/**
 * Component registry — loads each component's index.ts from disk and
 * builds a key → metadata map the compiler uses to resolve INSTANCE nodes.
 *
 * Each registered component carries:
 *   - `componentName` (PascalCase, matches the directory)
 *   - `dir` (absolute path — emitter uses it for relative imports)
 *   - `propsFromFigma` (figma raw → typed props mapper, from defineComponent)
 *   - `defaults` (master prop values — for prop-emission elision)
 *   - `bindings` (per-variant per-node binding spec from cases.ts)
 *   - `masterSnapshot` (raw figma tree of each master variant — used by
 *     detach.ts to compare instance overrides against)
 *
 * The compiler runs entirely off disk — no figma calls. Init writes
 * everything the compiler needs into the component directory.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RawNode } from '../dumper/raw-node.ts'

export interface NodeBindingValue {
  attr?: { text?: string; visible?: string; color?: string; fill?: string; textStyle?: string }
  instanceProps?: Record<string, string>
}

/** Per-master-node-id → which figma fields are bound to which prop. */
export type NodeBindings = Record<string, NodeBindingValue>

export interface RegistryEntry {
  componentName: string
  dir: string
  /** Defaults the master variants render at — used by emitters to elide
   *  redundant prop emissions on instance call sites. */
  defaults?: Record<string, unknown>
  /** Caller-side prop hydrator: figma raw → typed props record. */
  propsFromFigma?: (raw: unknown, children?: unknown) => Record<string, unknown>
  /** Aggregated bindings across all variants (master node id → bindings). */
  bindings: NodeBindings
  /** Per-variant raw master snapshot, keyed by variant key (cross-file
   *  durable id). detach.ts reads these to compare an instance's overrides
   *  against the corresponding master descendant. */
  masterSnapshot: Record<string, RawNode>
}

export type Registry = Map<string, RegistryEntry>

/**
 * Scan `componentsDir` and load every `index.ts` that exports a
 * `defineComponent` result. The componentSetKey from the export's
 * `figma.componentSetKey` becomes the registry key.
 */
export async function loadRegistry(componentsDir: string): Promise<Registry> {
  const reg: Registry = new Map()
  if (!existsSync(componentsDir)) return reg
  const ents = readdirSync(componentsDir, { withFileTypes: true })
  for (const ent of ents) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith('BD_')) continue // breakdown scratch dirs
    const dir = resolve(componentsDir, ent.name)
    const indexPath = join(dir, 'index.ts')
    if (!existsSync(indexPath)) continue
    const entry = await loadOne(dir, indexPath)
    if (entry) {
      // The index.ts may declare one or more componentSetKey strings via
      // figma.componentSetKey (string | string[]).
      for (const key of entry.keys) reg.set(key, entry.value)
    }
  }
  return reg
}

interface LoadedEntry { keys: string[]; value: RegistryEntry }

async function loadOne(dir: string, indexPath: string): Promise<LoadedEntry | null> {
  let mod: Record<string, unknown>
  try {
    mod = (await import(`${pathToFileURL(indexPath).href}?t=${Date.now()}`)) as Record<string, unknown>
  } catch {
    return null
  }
  const candidates = Object.values(mod).filter((v): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && 'name' in v && 'variants' in v,
  )
  if (candidates.length === 0) return null
  const comp = candidates[0]
  const componentName = String(comp.name)
  const figma = (comp.figma as { componentSetKey?: string | string[]; propsFromFigma?: (...a: unknown[]) => Record<string, unknown> } | undefined)
  const csk = figma?.componentSetKey
  const keys = Array.isArray(csk) ? csk : (csk ? [csk] : [])
  if (keys.length === 0) return null
  const defaults = (mod.defaults as Record<string, unknown> | undefined)
    ?? (comp.defaults as Record<string, unknown> | undefined)

  const bindings = aggregateBindings(comp.variants)
  const masterSnapshot = loadMasterSnapshot(dir)
  return {
    keys,
    value: {
      componentName,
      dir,
      defaults,
      propsFromFigma: figma?.propsFromFigma as RegistryEntry['propsFromFigma'],
      bindings,
      masterSnapshot,
    },
  }
}

function aggregateBindings(variants: unknown): NodeBindings {
  const out: NodeBindings = {}
  if (!Array.isArray(variants)) return out
  for (const v of variants as Array<{ bindings?: NodeBindings }>) {
    if (!v.bindings) continue
    for (const [nodeId, b] of Object.entries(v.bindings)) {
      const cur = out[nodeId] ?? {}
      if (b.attr) cur.attr = { ...(cur.attr ?? {}), ...b.attr }
      if (b.instanceProps) cur.instanceProps = { ...(cur.instanceProps ?? {}), ...b.instanceProps }
      out[nodeId] = cur
    }
  }
  return out
}

function loadMasterSnapshot(dir: string): Record<string, RawNode> {
  const path = join(dir, 'master-snapshot.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, RawNode>
  } catch {
    return {}
  }
}
