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
  /** Raw JS source from CodegenPlugin.walkExtend, concatenated. Spliced into
   * the cfigma exec script — runs after the IR is built for each node, with
   * `node` (live FigmaNode) and `ir` (the just-built IR object) in scope. */
  walkExtend?: string
}

export async function walk(opts: WalkOptions): Promise<IRNode> {
  const code = `
const REGISTRY = ${JSON.stringify(opts.registry)};
function pixpecPropName(name) {
  const stripped = String(name).replace(/[\\x00-\\x1f\\x7f]/g, '').replace(/#[^#]*$/, '').trim();
  const parts = stripped.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return 'prop';
  const normalized = parts[0][0].toLowerCase() + parts[0].slice(1)
    + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
  return normalized === 'style' ? 'styleVariant' : normalized;
}
function pixpecSetProp(out, name, value) {
  out[name] = value;
  const short = String(name).split('#')[0];
  if (!(short in out)) out[short] = value;
  const camel = pixpecPropName(name);
  if (!(camel in out)) out[camel] = value;
}
async function ir(node) {
  const result = await __pixpecIr(node);
  if (result && typeof result === 'object' && !result.__unregisteredInstance) {
    // Plugin walkExtend — DS-specific data extraction. Hooks see node and
    // ir (= the built IR being mutated). Multiple plugins concatenated.
    const ir = result;
    ${opts.walkExtend ?? ''}
  }
  return result;
}
async function __pixpecIr(node) {
  if (!node) return null;
  const base = { figmaId: node.id, figmaName: node.name };
  if (node.type === 'INSTANCE') {
    let p = node.mainComponent;
    while (p && p.type !== 'COMPONENT_SET') p = p.parent;
    const key = p?.key ?? node.mainComponent?.key;
    if (!key || !REGISTRY[key]) {
      // Hard error: every INSTANCE must be backed by a registered defineComponent.
      // Returning a sentinel that the Node side will detect & throw with full context.
      return { __unregisteredInstance: true, figmaId: node.id, figmaName: node.name,
               componentKey: key, mainComponentName: node.mainComponent?.name };
    }
    // Detach detection: when an instance carries structural divergence from
    // its master that the registered component cannot reproduce via props,
    // walk it as a raw frame so we get the actual figma node tree. Single
    // pass over node.overrides -- figma reports overridden fields per
    // descendant, no need to fetch the master and diff manually.
    //
    // Triggers (any one detaches):
    //   - visible on a descendant NOT bound to a BOOLEAN componentProperty
    //     (designer hid/showed a master-defined element directly)
    //   - fontName / fontSize on a TEXT descendant
    //   - fills on a TEXT descendant (token rebind, e.g.
    //     content.standard.primary -> secondary)
    const structural = await (async () => {
      for (const ov of (node.overrides || [])) {
        const fields = ov.overriddenFields || [];
        const target = await figma.getNodeByIdAsync(ov.id);
        if (!target) continue;
        if (fields.includes('visible') && !target.componentPropertyReferences?.visible) return true;
        if (target.type === 'TEXT' && (
          fields.includes('fontName') ||
          fields.includes('fontSize') ||
          fields.includes('fills')
        )) return true;
      }
      return false;
    })();
    if (structural) {
      // Fall through to FRAME-style walking. INSTANCE's children/.layoutMode/etc.
      // already reflect overrides applied on top of the master.
      // Drop into the FRAME branch by treating the node as if type were FRAME.
    } else {
    const props = {};
    for (const [k, v] of Object.entries(node.componentProperties)) {
      pixpecSetProp(props, k, v.value);
    }
    // Component-set-level defaults (componentPropertyDefinitions). Codegen
    // uses these to omit redundant prop emissions on the instance.
    const defaults = {};
    if (p?.componentPropertyDefinitions) {
      for (const [k, def] of Object.entries(p.componentPropertyDefinitions)) {
        pixpecSetProp(defaults, k, def.defaultValue);
      }
    }
    const exposed = (node.exposedInstances || []).map(e => {
      const ep = {};
      for (const [k, v] of Object.entries(e.componentProperties)) {
        pixpecSetProp(ep, k, v.value);
      }
      return { name: e.name, mainComponentName: e.mainComponent?.name, props: ep };
    });
    const sizingH = mapSizing(node.layoutSizingHorizontal);
    const sizingV = mapSizing(node.layoutSizingVertical);
    const mainSizingH = mapSizing(node.mainComponent?.layoutSizingHorizontal);
    const mainSizingV = mapSizing(node.mainComponent?.layoutSizingVertical);
    return {
      ...base,
      kind: 'component',
      componentName: REGISTRY[key],
      raw: { id: node.id, name: node.name, mainComponentName: node.mainComponent?.name,
             componentSetKey: key, props, exposed, defaults,
             width: node.width, height: node.height,
             sizingH, sizingV,
             mainWidth: node.mainComponent?.width, mainHeight: node.mainComponent?.height,
             mainSizingH, mainSizingV },
      rotation: typeof node.rotation === 'number' && Math.abs(node.rotation) >= 0.01 ? node.rotation : undefined,
      sizingH, sizingV,
      mainSizingH, mainSizingV,
      mainWidth: node.mainComponent?.width, mainHeight: node.mainComponent?.height,
      width: node.width, height: node.height,
    };
    } // close else branch — falls through to FRAME walk for detached instances
  }
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    const dir = node.layoutMode === 'HORIZONTAL' ? 'row' : node.layoutMode === 'VERTICAL' ? 'column' : 'none';
    // Respect fills[].visible: a fill toggled OFF in figma is captured in
    // the data but is not painted in the raster — emitting it would invent
    // a background that figma never showed.
    const fill = (Array.isArray(node.fills) && node.fills[0]?.type === 'SOLID' && node.fills[0]?.visible !== false) ? node.fills[0] : null;
    const bg = fill ? rgbaHex(fill.color, fill.opacity ?? 1) : undefined;
    // Strokes — figma renders 1px (or N px) outlines on frames. Captures the
    // first SOLID stroke; codegen emits as inset boxShadow to avoid CSS
    // border's outset addition to layout dim.
    const stroke = (Array.isArray(node.strokes) && node.strokes[0]?.type === 'SOLID' && node.strokes[0]?.visible !== false) ? node.strokes[0] : null;
    const strokeColor = stroke ? rgbaHex(stroke.color, stroke.opacity ?? 1) : undefined;
    const strokeWeight = stroke ? (typeof node.strokeWeight === 'number' ? node.strokeWeight : 1) : 0;
    // figma boundVariables — when a property's value is bound to a design
    // token, we capture the variable id so codegen can emit a panda token
    // reference (e.g. 'background.standard.primary') instead of raw hex/px.
    const bgTokenId = fill?.boundVariables?.color?.id;
    const strokeColorTokenId = stroke?.boundVariables?.color?.id;
    const bv = node.boundVariables || {};
    const tokenIds = {
      background: bgTokenId,
      gap: bv.itemSpacing?.id,
      paddingTop: bv.paddingTop?.id, paddingRight: bv.paddingRight?.id,
      paddingBottom: bv.paddingBottom?.id, paddingLeft: bv.paddingLeft?.id,
      width: bv.width?.id, height: bv.height?.id,
      borderRadius: bv.topLeftRadius?.id,
      strokeColor: strokeColorTokenId,
      strokeWeight: bv.strokeWeight?.id,
    };
    const children = [];
    for (const c of node.children || []) {
      if (!c.visible) continue;
      const child = await ir(c);
      if (!child) continue;
      // figma layoutPositioning: ABSOLUTE → child sits outside flex flow.
      // Codegen emits position:absolute + left/top from c.x/c.y so it
      // overlays the parent without contributing to layout sizing.
      if (c.layoutPositioning === 'ABSOLUTE') {
        child.absolute = true;
        child.absX = c.x;
        child.absY = c.y;
      }
      children.push(child);
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
        sizingH: mapSizing(node.layoutSizingHorizontal),
        sizingV: mapSizing(node.layoutSizingVertical),
        wrap: node.layoutWrap === 'WRAP',
        counterGap: node.counterAxisSpacing || 0,
      },
      width: node.width, height: node.height,
      background: bg, borderRadius: node.cornerRadius,
      strokeColor, strokeWeight,
      cornerSmoothing: node.cornerSmoothing || 0,
      clipsContent: !!node.clipsContent,
      tokenIds,
      rotation: typeof node.rotation === 'number' && Math.abs(node.rotation) >= 0.01 ? node.rotation : undefined,
      children,
    };
  }
  if (node.type === 'TEXT') {
    const fill = (Array.isArray(node.fills) && node.fills[0]?.type === 'SOLID') ? node.fills[0] : null;
    const tbv = node.boundVariables || {};
    const tokenIds = {
      color: fill?.boundVariables?.color?.id,
      lineHeight: tbv.lineHeight?.id,
      paragraphSpacing: tbv.paragraphSpacing?.id,
      fontSize: tbv.fontSize?.id,
    };
    return {
      ...base, kind: 'text',
      content: node.characters,
      fontSize: node.fontSize, fontWeight: node.fontName?.style === 'Bold' ? 700 : 500,
      lineHeight: typeof node.lineHeight === 'object' && node.lineHeight.unit === 'PIXELS' ? node.lineHeight.value : node.fontSize,
      paragraphSpacing: typeof node.paragraphSpacing === 'number' ? node.paragraphSpacing : 0,
      color: fill ? rgbaHex(fill.color, fill.opacity ?? 1) : '#000000',
      tokenIds,
      textAlign: node.textAlignHorizontal?.toLowerCase(),
      textStyleId: typeof node.textStyleId === 'string' ? node.textStyleId : undefined,
      autoResize: mapAutoResize(node.textAutoResize),
      width: node.width,
      sizingH: mapSizing(node.layoutSizingHorizontal),
      sizingV: mapSizing(node.layoutSizingVertical),
    };
  }
  // GROUP / VECTOR / BOOLEAN_OPERATION — opaque visuals (icons, illustrations).
  // Recreating these accurately as DOM/CSS is unreliable (GROUP children are
  // absolutely positioned vectors at sub-pixel coords). Emit as 'image' kind;
  // runGenerate fills dataUrl by exporting the figma node as PNG.
  if (node.type === 'GROUP' || node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') {
    return {
      ...base, kind: 'image',
      width: node.width, height: node.height,
      sizingH: mapSizing(node.layoutSizingHorizontal),
      sizingV: mapSizing(node.layoutSizingVertical),
    };
  }
  // Geometric shape primitives — emit as SVG to preserve sub-pixel rasterization.
  // chromium snaps HTML <div> left-edge to integer css px; SVG path rendering
  // preserves sub-pixel position (verified empirically — see SnapGridProbe).
  const shapeMap = { 'RECTANGLE':'rect', 'ELLIPSE':'ellipse', 'POLYGON':'polygon', 'STAR':'star', 'LINE':'line' };
  if (shapeMap[node.type]) {
    const fill = (Array.isArray(node.fills) && node.fills[0]?.type === 'SOLID' && node.fills[0]?.visible !== false) ? node.fills[0] : null;
    const stroke = (Array.isArray(node.strokes) && node.strokes[0]?.type === 'SOLID' && node.strokes[0]?.visible !== false) ? node.strokes[0] : null;
    return {
      ...base, kind: 'shape',
      shape: shapeMap[node.type],
      width: node.width, height: node.height,
      fill: fill ? rgbaHex(fill.color, fill.opacity ?? 1) : undefined,
      fillTokenId: fill?.boundVariables?.color?.id,
      strokeColor: stroke ? rgbaHex(stroke.color, stroke.opacity ?? 1) : undefined,
      strokeWeight: stroke ? (typeof node.strokeWeight === 'number' ? node.strokeWeight : 1) : 0,
      borderRadius: node.cornerRadius,
      rotation: typeof node.rotation === 'number' && Math.abs(node.rotation) >= 0.01 ? node.rotation : undefined,
      sizingH: mapSizing(node.layoutSizingHorizontal),
      sizingV: mapSizing(node.layoutSizingVertical),
    };
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
function mapSizing(s) {
  return s === 'HUG' ? 'hug' : s === 'FILL' ? 'fill' : 'fixed';
}
function mapAutoResize(a) {
  return a === 'WIDTH_AND_HEIGHT' ? 'hug' : a === 'HEIGHT' ? 'fixed-width' : a === 'TRUNCATE' ? 'truncate' : 'fixed-both';
}
const root = await figma.getNodeByIdAsync(${JSON.stringify(opts.nodeId)});
if (!root) return { error: 'node_not_found' };
return ir(root);
`
  const { stdout } = await execFileAsync(opts.cfigmaBin,
    ['--tab', opts.tab, 'exec', code],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CFIGMA_CDP_PORT: opts.cdpPort ?? process.env.CFIGMA_CDP_PORT ?? '9222' } })
  const parsed = JSON.parse(stdout) as IRNode
  // Walk the tree post-fetch to surface any unregistered INSTANCE with full context.
  assertAllInstancesRegistered(parsed, opts.registry)
  return parsed
}

interface UnregisteredSentinel {
  __unregisteredInstance: true
  figmaId: string
  figmaName: string
  componentKey?: string
  mainComponentName?: string
}

function assertAllInstancesRegistered(n: unknown, registry: Record<string, string>): void {
  if (!n || typeof n !== 'object') return
  const node = n as Record<string, unknown>
  if (node.__unregisteredInstance) {
    const u = node as unknown as UnregisteredSentinel
    throw new Error(
      `Unregistered figma INSTANCE encountered.\n` +
      `  figmaId: ${u.figmaId}\n` +
      `  name: ${u.figmaName}\n` +
      `  mainComponent: ${u.mainComponentName ?? '<none>'}\n` +
      `  componentSetKey: ${u.componentKey ?? '<none>'}\n` +
      `Register a defineComponent in src/index.ts with figma binding:\n` +
      `  figma: { componentSetKey: ${JSON.stringify(u.componentKey ?? '<unknown>')}, fromInstance: (raw) => ({...}) }\n` +
      `Currently registered keys: ${Object.keys(registry).join(', ') || '<none>'}`,
    )
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((c) => assertAllInstancesRegistered(c, registry))
    else if (v && typeof v === 'object') assertAllInstancesRegistered(v, registry)
  }
}

/** Build registry from a list of components with figma bindings. */
export function buildRegistry(components: Array<Component<unknown>>): Record<string, string> {
  const reg: Record<string, string> = {}
  for (const c of components) {
    if (c.figma) reg[c.figma.componentSetKey] = c.name
  }
  return reg
}
