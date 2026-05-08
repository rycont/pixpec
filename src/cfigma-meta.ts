/**
 * Fetch component metadata via cfigma exec.
 *
 * Sends a Figma plugin-API snippet to the user's connected tab; the plugin
 * walks the requested component (or component-set) and extracts:
 *   - propertyDefinitions (VARIANT / TEXT / BOOLEAN / INSTANCE_SWAP)
 *   - per-variant: id, name, propValues (variant + bound TEXT/BOOLEAN/INSTANCE_SWAP values)
 *
 * The same primitive `cfigma --tab <p> exec <code>` from figma.ts; we just
 * send a different code body.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function cleanControlValue<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') as T
  }
  if (Array.isArray(value)) return value.map(cleanControlValue) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cleanControlValue(v)]),
    ) as T
  }
  return value
}

export type FigmaPropType = 'VARIANT' | 'TEXT' | 'BOOLEAN' | 'INSTANCE_SWAP'

export interface FigmaPropertyDefinition {
  type: FigmaPropType
  defaultValue: unknown
  variantOptions?: string[]
}

export interface FigmaInstanceSwapValue {
  kind: 'instance'
  mainComponentId: string | null
  mainComponentName: string | null
}

export type FigmaPropValue =
  | string
  | boolean
  | FigmaInstanceSwapValue
  | null

/** Per-variant schema for an exposed nested instance slot — used by init
 * to emit a properly-typed sub-interface instead of `Record<string, unknown>`. */
export interface FigmaExposedInstanceSchema {
  /** componentSet key (preferred) or component key for figma binding. */
  mainKey: string | null
  /** componentSet name (e.g. "Icon", "Button"). */
  mainName: string | null
  /** Property definitions of the slot's componentSet — same shape as the
   * top-level componentPropertyDefinitions. Drives TS type emission. */
  propertyDefinitions: Record<string, FigmaPropertyDefinition>
}

export interface FigmaVariantMeta {
  id: string
  name: string
  /**
   * Prop name → resolved value for this variant. Combines:
   *   - VARIANT / TEXT / BOOLEAN / INSTANCE_SWAP props from the variant itself
   *   - Nested-instance slots that the designer marked as `exposedInstances`
   *     in figma — keyed by the layer name (duplicate names get `_2`, `_3`
   *     suffixes), values are the slot's own resolved componentProperties.
   */
  propValues: Record<string, FigmaPropValue>
  /** Schema for each exposed nested-instance slot (same keys as propValues
   * for slots that came from exposedInstances). init aggregates these
   * across variants and emits a typed sub-interface per slot. */
  exposedSchemas?: Record<string, FigmaExposedInstanceSchema>
}

export interface FigmaComponentMeta {
  /** 'set' for ComponentSet (with variants), 'single' for standalone Component. */
  kind: 'set' | 'single'
  id: string
  name: string
  /** Stable component-set key for figma binding (used by registered DS
   * components to declare which figma master they implement). */
  key?: string
  propertyDefinitions: Record<string, FigmaPropertyDefinition>
  variants: FigmaVariantMeta[]
}

const PLUGIN_TEMPLATE = (componentId: string) => `
const targetId = ${JSON.stringify(componentId)};
// getNodeByIdAsync hits the page index without requiring all pages to be
// loaded — works regardless of which page is currently active.
const node = await figma.getNodeByIdAsync(targetId);
if (!node) throw new Error('component not found: ' + targetId);

function stripHashKey(k) { return String(k).replace(/#[^#]*$/, ''); }

function extractVariant(v) {
  const propValues = Object.assign({}, v.variantProperties || {});

  // Step 1: Figma component-property bindings (TEXT / BOOLEAN / INSTANCE_SWAP).
  // componentPropertyReferences names point into the OWNING component's
  // propertyDefinitions; descending into nested INSTANCEs would leak THEIR
  // ref names (e.g. an inner TextButton's leftIcon prop) onto the variant
  // root. Stop recursion at INSTANCE boundaries — those are handled by
  // Step 2 (exposedInstances) instead.
  const visit = (n) => {
    const refs = n.componentPropertyReferences;
    if (refs) {
      if (refs.characters && n.type === 'TEXT') {
        propValues[stripHashKey(refs.characters)] = n.characters;
      }
      if (refs.visible) {
        propValues[stripHashKey(refs.visible)] = n.visible !== false;
      }
      if (refs.mainComponent && n.type === 'INSTANCE') {
        const mc = n.mainComponent;
        propValues[stripHashKey(refs.mainComponent)] = {
          kind: 'instance',
          mainComponentId: mc ? mc.id : null,
          mainComponentName: mc ? mc.name : null,
        };
      }
    }
    if (n.type === 'INSTANCE') return;
    if (n.children) for (const c of n.children) visit(c);
  };
  if (v.children) for (const c of v.children) visit(c);

  // Step 2: only nested INSTANCEs that the designer explicitly marked
  // "Expose properties" in figma get surfaced as public props. The rest
  // are baked into the variant's render and the codegen reads their
  // resolved values from the IR walk, not from cases.ts. This mirrors
  // figma's own API surface.
  const exposed = v.exposedInstances || [];
  const taken = new Set(Object.keys(propValues));
  const exposedSchemas = {};
  for (const inst of exposed) {
    let key = inst.name;
    let i = 2;
    while (taken.has(key)) { key = inst.name + '_' + i; i++; }
    taken.add(key);

    const innerProps = {};
    const cp = inst.componentProperties || {};
    for (const k of Object.keys(cp)) {
      innerProps[stripHashKey(k)] = cp[k] && 'value' in cp[k] ? cp[k].value : cp[k];
    }
    propValues[key] = innerProps;

    // Capture the slot's componentSet schema so init can emit a proper TS
    // type for its props. Walk up to COMPONENT_SET (so all variants of the
    // referenced component share one definition).
    let main = inst.mainComponent;
    let set = main;
    while (set && set.type !== 'COMPONENT_SET') set = set.parent;
    const root = set || main;
    exposedSchemas[key] = {
      mainKey: root ? root.key : null,
      mainName: root ? root.name : null,
      propertyDefinitions: stripHash(root ? root.componentPropertyDefinitions : {}),
    };
  }

  return { id: v.id, name: v.name, propValues, exposedSchemas };
}

function stripHash(defs) {
  const out = {};
  for (const k of Object.keys(defs || {})) {
    const name = String(k).replace(/#[^#]*$/, '');
    out[name] = defs[k];
  }
  return out;
}

if (node.type === 'COMPONENT_SET') {
  return {
    kind: 'set',
    id: node.id,
    name: node.name,
    key: node.key,
    propertyDefinitions: stripHash(node.componentPropertyDefinitions),
    variants: node.children
      .filter((c) => c.type === 'COMPONENT')
      .map(extractVariant),
  };
}
if (node.type === 'COMPONENT') {
  // Standalone COMPONENT (no variants) — use its own key. When the user
  // later wraps it in a COMPONENT_SET, init can be re-run.
  return {
    kind: 'single',
    id: node.id,
    name: node.name,
    key: node.key,
    propertyDefinitions: stripHash(node.componentPropertyDefinitions),
    variants: [extractVariant(node)],
  };
}
throw new Error('node ' + targetId + ' is ' + node.type + ', not a COMPONENT or COMPONENT_SET');
`

export async function fetchComponentMeta(opts: {
  tabPattern: string
  componentId: string
  cfigmaBin?: string
}): Promise<FigmaComponentMeta> {
  const bin = opts.cfigmaBin ?? 'cfigma'
  const code = PLUGIN_TEMPLATE(opts.componentId)
  const { stdout } = await execFileAsync(
    bin,
    ['--tab', opts.tabPattern, 'exec', code],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  return cleanControlValue(JSON.parse(stdout)) as FigmaComponentMeta
}

/**
 * Walk up from a node to its containing PAGE and set `figma.currentPage` there.
 * cfigma export refuses cross-page selection, so we prep the page once before
 * exporting variant PNGs.
 */
export async function switchToPageContaining(opts: {
  tabPattern: string
  nodeId: string
  cfigmaBin?: string
}): Promise<{ pageId: string; pageName: string } | null> {
  const bin = opts.cfigmaBin ?? 'cfigma'
  const code = `
const target = ${JSON.stringify(opts.nodeId)};
const node = figma.root.findOne((n) => n.id === target);
if (!node) return null;
let p = node;
while (p && p.type !== 'PAGE') p = p.parent;
if (!p) return null;
await figma.setCurrentPageAsync(p);
return { pageId: p.id, pageName: p.name };
`
  const { stdout } = await execFileAsync(
    bin,
    ['--tab', opts.tabPattern, 'exec', code],
    { encoding: 'utf8' },
  )
  return JSON.parse(stdout) as { pageId: string; pageName: string } | null
}
