/**
 * Figma node tree walker — emits IR via cfigma exec.
 *
 * Runs in plugin context (the script body is sent to figma via cfigma exec).
 * Reads node properties, classifies (INSTANCE matching registered key →
 * IRComponent; FRAME → IRFrame; TEXT → IRText; etc), serializes to JSON,
 * returns to Node.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Component } from '../types.ts'
import type { IRNode } from './ir.ts'

const execFileAsync = promisify(execFile)

export interface WalkOptions {
  cfigmaBin: string
  tab: string
  cdpPort?: string
  /** Map of componentSetKey → componentName (built from defineComponent registry). */
  registry: Record<string, string>
  /** Root node id to walk. */
  nodeId: string
}

export async function walk(opts: WalkOptions): Promise<IRNode> {
  const code = `
const REGISTRY = ${JSON.stringify(opts.registry)};
async function ir(node) {
  if (!node) return null;
  const base = { figmaId: node.id, figmaName: node.name };
  if (node.type === 'INSTANCE') {
    let p = node.mainComponent;
    while (p && p.type !== 'COMPONENT_SET') p = p.parent;
    const key = p?.key;
    if (key && REGISTRY[key]) {
      // Serialize componentProperties + exposed nested instances.
      const props = {};
      for (const [k, v] of Object.entries(node.componentProperties)) {
        props[k] = v.value;
        // Also expose qualified-name → value (e.g., "Size") for fromInstance.
        const short = k.split('#')[0];
        if (!(short in props)) props[short] = v.value;
      }
      const exposed = (node.exposedInstances || []).map(e => {
        const ep = {};
        for (const [k, v] of Object.entries(e.componentProperties)) {
          ep[k] = v.value;
          const short = k.split('#')[0];
          if (!(short in ep)) ep[short] = v.value;
        }
        return { name: e.name, mainComponentName: e.mainComponent?.name, props: ep };
      });
      return {
        ...base,
        kind: 'component',
        componentName: REGISTRY[key],
        raw: { id: node.id, name: node.name, mainComponentName: node.mainComponent?.name,
               componentSetKey: key, props, exposed },
      };
    }
    // Fallthrough: instance of unregistered component → treat as frame
  }
  if (node.type === 'FRAME' || node.type === 'INSTANCE' || node.type === 'COMPONENT') {
    const dir = node.layoutMode === 'HORIZONTAL' ? 'row' : node.layoutMode === 'VERTICAL' ? 'column' : 'none';
    const fill = (Array.isArray(node.fills) && node.fills[0]?.type === 'SOLID') ? node.fills[0] : null;
    const bg = fill ? rgbaHex(fill.color, fill.opacity ?? 1) : undefined;
    const children = [];
    for (const c of node.children || []) {
      if (!c.visible) continue;
      const child = await ir(c);
      if (child) children.push(child);
    }
    return {
      ...base, kind: 'frame',
      layout: {
        direction: dir,
        paddingTop: node.paddingTop || 0, paddingRight: node.paddingRight || 0,
        paddingBottom: node.paddingBottom || 0, paddingLeft: node.paddingLeft || 0,
        gap: node.itemSpacing || 0,
        alignItems: mapAlign(node.counterAxisAlignItems),
        justifyContent: mapAlign(node.primaryAxisAlignItems),
      },
      width: node.width, height: node.height,
      background: bg, borderRadius: node.cornerRadius,
      children,
    };
  }
  if (node.type === 'TEXT') {
    const fill = (Array.isArray(node.fills) && node.fills[0]?.type === 'SOLID') ? node.fills[0] : null;
    return {
      ...base, kind: 'text',
      content: node.characters,
      fontSize: node.fontSize, fontWeight: node.fontName?.style === 'Bold' ? 700 : 500,
      lineHeight: typeof node.lineHeight === 'object' && node.lineHeight.unit === 'PIXELS' ? node.lineHeight.value : node.fontSize,
      color: fill ? rgbaHex(fill.color, fill.opacity ?? 1) : '#000000',
      textAlign: node.textAlignHorizontal?.toLowerCase(),
      textStyleId: typeof node.textStyleId === 'string' ? node.textStyleId : undefined,
    };
  }
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') {
    const fills = (Array.isArray(node.fills) ? node.fills : []).map(f => f.type === 'SOLID' ? rgbaHex(f.color, f.opacity ?? 1) : '?');
    return { ...base, kind: 'vector', fills, width: node.width, height: node.height };
  }
  return { ...base, kind: 'unknown', type: node.type, width: node.width || 0, height: node.height || 0 };
}
function rgbaHex(c, opacity) {
  const r = Math.round(c.r*255), g = Math.round(c.g*255), b = Math.round(c.b*255);
  if (opacity >= 0.999) return '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('');
  return 'rgba(' + r + ',' + g + ',' + b + ',' + opacity.toFixed(3) + ')';
}
function mapAlign(a) {
  return a === 'CENTER' ? 'center' : a === 'MAX' ? 'end' : a === 'SPACE_BETWEEN' ? 'space-between' : 'start';
}
const root = await figma.getNodeByIdAsync(${JSON.stringify(opts.nodeId)});
if (!root) return { error: 'node_not_found' };
return ir(root);
`
  const { stdout } = await execFileAsync(opts.cfigmaBin,
    ['--tab', opts.tab, 'exec', code],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CFIGMA_CDP_PORT: opts.cdpPort ?? process.env.CFIGMA_CDP_PORT ?? '9222' } })
  return JSON.parse(stdout) as IRNode
}

/** Build registry from a list of components with figma bindings. */
export function buildRegistry(components: Array<Component<unknown>>): Record<string, string> {
  const reg: Record<string, string> = {}
  for (const c of components) {
    if (c.figma) reg[c.figma.componentSetKey] = c.name
  }
  return reg
}
