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

export interface FigmaVariantMeta {
  id: string
  name: string
  /**
   * Prop name → resolved value for this variant. Combines:
   *   - VARIANT / TEXT / BOOLEAN / INSTANCE_SWAP props from the variant itself
   *   - Nested instance overrides at the variant-master level: each outer
   *     INSTANCE child shows up as a key (using the layer name; duplicates
   *     get `_2`, `_3` suffixes), with its own resolved componentProperties.
   *
   * pixpec init writes these into cases.ts as boilerplate; the impl picks
   * which to expose as part of the component's React prop API.
   */
  propValues: Record<string, FigmaPropValue>
}

export interface FigmaComponentMeta {
  /** 'set' for ComponentSet (with variants), 'single' for standalone Component. */
  kind: 'set' | 'single'
  id: string
  name: string
  propertyDefinitions: Record<string, FigmaPropertyDefinition>
  variants: FigmaVariantMeta[]
}

const PLUGIN_TEMPLATE = (componentId: string) => `
const targetId = ${JSON.stringify(componentId)};
const node = figma.root.findOne((n) => n.id === targetId);
if (!node) throw new Error('component not found: ' + targetId);

function stripHashKey(k) { return String(k).replace(/#[^#]*$/, ''); }

function extractVariant(v) {
  const propValues = Object.assign({}, v.variantProperties || {});

  // Step 1: Figma component-property bindings (TEXT / BOOLEAN / INSTANCE_SWAP).
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
    if (n.children) for (const c of n.children) visit(c);
  };
  visit(v);

  // Step 2: walk outer-level INSTANCE descendants (don't descend into found
  // instances). Each carries its resolved componentProperties — including
  // overrides set at the variant-master level. We surface them as keyed
  // entries on propValues so the impl can choose what to expose as React props.
  const outer = [];
  const collectOuter = (n) => {
    if (n.type === 'INSTANCE') { outer.push(n); return; }
    if (n.children) for (const c of n.children) collectOuter(c);
  };
  if (v.children) for (const c of v.children) collectOuter(c);

  const taken = new Set(Object.keys(propValues));
  for (const inst of outer) {
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
  }

  return { id: v.id, name: v.name, propValues };
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
    propertyDefinitions: stripHash(node.componentPropertyDefinitions),
    variants: node.children
      .filter((c) => c.type === 'COMPONENT')
      .map(extractVariant),
  };
}
if (node.type === 'COMPONENT') {
  return {
    kind: 'single',
    id: node.id,
    name: node.name,
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
  return JSON.parse(stdout) as FigmaComponentMeta
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
