/**
 * Raw figma dumper — Node.js side.
 *
 * Sends a stateless walk script to the figma plugin runtime via cfigma exec.
 * Receives a `RawNode` tree (figma node properties verbatim, no
 * classification, no registry awareness). The compiler downstream is the
 * sole consumer.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RawNode } from './raw-node.ts'

const execFileAsync = promisify(execFile)

export interface DumpOptions {
  cfigmaBin: string
  /** Figma file key (or human-readable tab pattern). */
  tab: string
  /** Root node id to walk. */
  nodeId: string
  /** Optional CDP port override for cfigma's bridge. */
  cdpPort?: string
}

export async function dump(opts: DumpOptions): Promise<RawNode> {
  const code = pluginScript(opts.nodeId)
  const { stdout } = await execFileAsync(
    opts.cfigmaBin,
    ['--tab', opts.tab, 'exec', code],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CFIGMA_CDP_PORT: opts.cdpPort ?? process.env.CFIGMA_CDP_PORT ?? '9222' },
    },
  )
  const parsed = JSON.parse(stdout) as RawNode | { error: string }
  if ('error' in parsed) throw new Error(`pixpec dump: ${parsed.error}`)
  return parsed
}

/** Plugin script body — runs inside figma. Walks the node tree from
 *  `rootId` and returns a RawNode tree as plain JSON. */
function pluginScript(rootId: string): string {
  return `
const ROOT_ID = ${JSON.stringify(rootId)};
const FRAMELIKE = new Set(['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET']);
const SHAPELIKE = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE']);
const VECTORLIKE = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'GROUP']);
function clean(value) {
  if (typeof value === 'string') return value.replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g, '');
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = clean(value[k]);
    return out;
  }
  return value;
}
function safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}
async function dumpNode(node) {
  if (!node) return null;
  if (node.visible === false) return null;
  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    width: node.width,
    height: node.height,
    x: node.x,
    y: node.y,
  };
  if (typeof node.rotation === 'number' && Math.abs(node.rotation) >= 0.01) out.rotation = node.rotation;
  if (typeof node.opacity === 'number' && node.opacity < 0.999) out.opacity = node.opacity;
  if (node.layoutPositioning) out.layoutPositioning = node.layoutPositioning;
  if (node.constraints) out.constraints = { horizontal: node.constraints.horizontal, vertical: node.constraints.vertical };
  if (node.componentPropertyReferences) out.componentPropertyReferences = clean(node.componentPropertyReferences);
  if (node.boundVariables && Object.keys(node.boundVariables).length) out.boundVariables = clean(node.boundVariables);

  if (FRAMELIKE.has(node.type)) {
    out.layoutMode = node.layoutMode;
    out.primaryAxisSizingMode = node.primaryAxisSizingMode;
    out.counterAxisSizingMode = node.counterAxisSizingMode;
    out.layoutSizingHorizontal = node.layoutSizingHorizontal;
    out.layoutSizingVertical = node.layoutSizingVertical;
    if (typeof node.layoutGrow === 'number') out.layoutGrow = node.layoutGrow;
    out.paddingTop = node.paddingTop;
    out.paddingRight = node.paddingRight;
    out.paddingBottom = node.paddingBottom;
    out.paddingLeft = node.paddingLeft;
    out.itemSpacing = node.itemSpacing;
    if (typeof node.counterAxisSpacing === 'number') out.counterAxisSpacing = node.counterAxisSpacing;
    out.counterAxisAlignItems = node.counterAxisAlignItems;
    out.primaryAxisAlignItems = node.primaryAxisAlignItems;
    if (node.layoutWrap) out.layoutWrap = node.layoutWrap;
    if (Array.isArray(node.fills)) out.fills = clean(node.fills);
    if (Array.isArray(node.strokes) && node.strokes.length) out.strokes = clean(node.strokes);
    if (typeof node.strokeWeight === 'number') out.strokeWeight = node.strokeWeight;
    else if (node.strokeWeight === figma.mixed) {
      out.strokeWeight = 'mixed';
      out.strokeTopWeight = node.strokeTopWeight;
      out.strokeRightWeight = node.strokeRightWeight;
      out.strokeBottomWeight = node.strokeBottomWeight;
      out.strokeLeftWeight = node.strokeLeftWeight;
    }
    if (node.strokeAlign) out.strokeAlign = node.strokeAlign;
    if (typeof node.cornerRadius === 'number') out.cornerRadius = node.cornerRadius;
    else if (node.cornerRadius === figma.mixed) {
      out.cornerRadius = 'mixed';
      out.topLeftRadius = node.topLeftRadius;
      out.topRightRadius = node.topRightRadius;
      out.bottomRightRadius = node.bottomRightRadius;
      out.bottomLeftRadius = node.bottomLeftRadius;
    }
    if (typeof node.cornerSmoothing === 'number' && node.cornerSmoothing > 0) out.cornerSmoothing = node.cornerSmoothing;
    if (node.clipsContent !== undefined) out.clipsContent = node.clipsContent;
    if (typeof node.minWidth === 'number') out.minWidth = node.minWidth;
    if (typeof node.maxWidth === 'number') out.maxWidth = node.maxWidth;
    if (typeof node.minHeight === 'number') out.minHeight = node.minHeight;
    if (typeof node.maxHeight === 'number') out.maxHeight = node.maxHeight;
  }

  if (node.type === 'INSTANCE') {
    const mc = node.mainComponent;
    if (mc) {
      let parent = mc.parent;
      while (parent && parent.type !== 'COMPONENT_SET') parent = parent.parent;
      out.mainComponent = {
        id: mc.id,
        key: mc.key,
        name: mc.name,
        parentKey: parent && parent.key || undefined,
        parentName: parent && parent.name || undefined,
      };
    }
    if (node.componentProperties) {
      const cp = {};
      for (const k of Object.keys(node.componentProperties)) {
        const v = node.componentProperties[k];
        cp[k] = { type: v.type, value: v.value, boundVariables: v.boundVariables };
      }
      out.componentProperties = clean(cp);
    }
    if (Array.isArray(node.overrides)) {
      out.overrides = node.overrides.map(o => ({ id: o.id, overriddenFields: (o.overriddenFields || []).slice() }));
    }
    if (Array.isArray(node.exposedInstances) && node.exposedInstances.length) {
      out.exposedInstances = node.exposedInstances.map(i => ({ id: i.id, name: i.name }));
    }
  }

  if (node.type === 'TEXT') {
    out.characters = node.characters;
    if (node.fontName && node.fontName !== figma.mixed) out.fontName = { family: node.fontName.family, style: node.fontName.style };
    if (typeof node.fontSize === 'number') out.fontSize = node.fontSize;
    if (typeof node.fontWeight === 'number') out.fontWeight = node.fontWeight;
    if (node.lineHeight && node.lineHeight !== figma.mixed) out.lineHeight = { unit: node.lineHeight.unit, value: node.lineHeight.value };
    if (typeof node.paragraphSpacing === 'number') out.paragraphSpacing = node.paragraphSpacing;
    if (node.letterSpacing && node.letterSpacing !== figma.mixed) out.letterSpacing = { unit: node.letterSpacing.unit, value: node.letterSpacing.value };
    out.textAlignHorizontal = node.textAlignHorizontal;
    out.textAlignVertical = node.textAlignVertical;
    out.textAutoResize = node.textAutoResize;
    if (typeof node.textCase === 'string') out.textCase = node.textCase;
    if (typeof node.textDecoration === 'string') out.textDecoration = node.textDecoration;
    if (typeof node.textStyleId === 'string') out.textStyleId = node.textStyleId;
    if (Array.isArray(node.fills)) out.fills = clean(node.fills);
    const segs = safe(() => node.getStyledTextSegments(['fills', 'fontName', 'fontSize', 'fontWeight', 'lineHeight', 'textDecoration', 'letterSpacing', 'textCase']), null);
    if (segs && segs.length > 1) out.styledTextSegments = clean(segs.map(s => ({
      characters: s.characters,
      fills: s.fills,
      fontName: s.fontName,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      textDecoration: s.textDecoration,
      letterSpacing: s.letterSpacing,
      textCase: s.textCase,
    })));
  }

  if (SHAPELIKE.has(node.type)) {
    if (Array.isArray(node.fills)) out.fills = clean(node.fills);
    if (Array.isArray(node.strokes) && node.strokes.length) out.strokes = clean(node.strokes);
    if (typeof node.strokeWeight === 'number') out.strokeWeight = node.strokeWeight;
    if (node.strokeAlign) out.strokeAlign = node.strokeAlign;
    if (typeof node.strokeCap === 'string') out.strokeCap = node.strokeCap;
    if (typeof node.cornerRadius === 'number') out.cornerRadius = node.cornerRadius;
    else if (node.cornerRadius === figma.mixed) {
      out.cornerRadius = 'mixed';
      out.topLeftRadius = node.topLeftRadius;
      out.topRightRadius = node.topRightRadius;
      out.bottomRightRadius = node.bottomRightRadius;
      out.bottomLeftRadius = node.bottomLeftRadius;
    }
  }

  if (VECTORLIKE.has(node.type)) {
    try {
      const bytes = await node.exportAsync({ format: 'SVG_STRING' });
      out.svg = bytes;
    } catch (_) {
      out.svgExportFailed = true;
    }
    // Surface fills/strokes so the compiler can compute effectiveFill for
    // currentColor-style components (e.g. <Icon>) that need their tint
    // forwarded as a parent CSS color. GROUPs themselves don't paint, but
    // we recurse into them via the children walk below so inner VECTORs
    // are reachable.
    if (Array.isArray(node.fills)) out.fills = clean(node.fills);
    if (Array.isArray(node.strokes) && node.strokes.length) out.strokes = clean(node.strokes);
  }

  // Recurse into children — INSTANCEs include their nested structure (the
  // compiler decides whether to keep as DInstance or detach to children).
  if (Array.isArray(node.children) && !VECTORLIKE.has(node.type)) {
    out.children = [];
    for (const c of node.children) {
      const dumped = await dumpNode(c);
      if (dumped) out.children.push(dumped);
    }
  }
  return out;
}

const root = await figma.getNodeByIdAsync(${JSON.stringify(rootId)});
if (!root) return { error: 'node_not_found: ' + ${JSON.stringify(rootId)} };
return await dumpNode(root);
`
}
