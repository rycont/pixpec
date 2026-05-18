/**
 * Raw figma dumper — Node.js side.
 *
 * Sends a stateless walk script to the figma plugin runtime via cfigma exec.
 * Receives a `RawNode` tree (figma node properties verbatim, no
 * classification, no registry awareness). The compiler downstream is the
 * sole consumer.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RawNode } from "./raw-node.ts";

const execFileAsync = promisify(execFile);

export interface DumpOptions {
  cfigmaBin: string;
  /** Figma file key (or human-readable tab pattern). */
  tab: string;
  /** Root node id to walk. */
  nodeId: string;
  /** Optional CDP port override for cfigma's bridge. */
  cdpPort?: string;
}

export interface DumpManyOptions extends Omit<DumpOptions, "nodeId"> {
  /** Root node ids to walk in one Figma runtime call. */
  nodeIds: string[];
}

export async function dump(opts: DumpOptions): Promise<RawNode> {
  const code = pluginScript(opts.nodeId);
  const { stdout } = await execFileAsync(
    opts.cfigmaBin,
    ["--tab", opts.tab, "exec", code],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CFIGMA_CDP_PORT: opts.cdpPort ?? process.env.CFIGMA_CDP_PORT ?? "9222",
      },
    },
  );
  const parsed = JSON.parse(stdout) as RawNode | { error: string };
  if ("error" in parsed) throw new Error(`pixpec dump: ${parsed.error}`);
  return parsed;
}

export async function dumpMany(opts: DumpManyOptions): Promise<Map<string, RawNode>> {
  if (opts.nodeIds.length === 0) return new Map();
  const code = pluginScript(opts.nodeIds);
  const { stdout } = await execFileAsync(
    opts.cfigmaBin,
    ["--tab", opts.tab, "exec", code],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        CFIGMA_CDP_PORT: opts.cdpPort ?? process.env.CFIGMA_CDP_PORT ?? "9222",
      },
    },
  );
  const parsed = JSON.parse(stdout) as
    | Array<{ id: string; node: RawNode | null; error?: string }>
    | { error: string };
  if (!Array.isArray(parsed)) {
    throw new Error(`pixpec dumpMany: ${parsed.error}`);
  }
  const out = new Map<string, RawNode>();
  const errors: string[] = [];
  for (const item of parsed) {
    if (item.error) {
      errors.push(`${item.id}: ${item.error}`);
    } else if (item.node) {
      out.set(item.id, item.node);
    } else {
      errors.push(`${item.id}: node_not_found`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`pixpec dumpMany failed:\n${errors.join("\n")}`);
  }
  return out;
}

/** Export a single figma node as an SVG string. Used by the compiler to
 *  fold pure-visual subtrees into a single DVector. */
export async function exportNodeSvg(opts: DumpOptions): Promise<string> {
  const code = `
    const node = await figma.getNodeByIdAsync(${JSON.stringify(opts.nodeId)});
    if (!node) return { error: 'node_not_found: ' + ${JSON.stringify(opts.nodeId)} };
    try {
      let bytes = await node.exportAsync({ format: 'SVG_STRING' });
      // Reconcile two figma quirks: SVG export sometimes rounds viewBox to
      // integers while paths use fractional coords (paths overflow the box),
      // and other times node.width/height are integer-rounded while viewBox
      // carries the precise float dimensions (overwriting would shrink the
      // box and clip paths). Prefer the value with sub-pixel precision; if
      // both look integer, take MAX so the box never shrinks.
      const w = node.width, h = node.height;
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
        const vbMatch = bytes.match(/viewBox="([^"]+)"/);
        let vbW = w, vbH = h;
        if (vbMatch) {
          const parts = vbMatch[1].trim().split(/\\s+/).map(Number);
          if (parts.length === 4 && parts.every(function (n) { return Number.isFinite(n); })) {
            const pickPrecise = function (a, b) {
              const aFrac = Math.abs(a - Math.round(a)) > 0.001;
              const bFrac = Math.abs(b - Math.round(b)) > 0.001;
              if (aFrac && !bFrac) return a;
              if (!aFrac && bFrac) return b;
              return Math.max(a, b);
            };
            vbW = pickPrecise(parts[2], w);
            vbH = pickPrecise(parts[3], h);
          }
        }
        bytes = bytes
          .replace(/viewBox="[^"]+"/, 'viewBox="0 0 ' + vbW + ' ' + vbH + '"')
          .replace(/(\\s)width="[^"]+"/, '$1width="' + vbW + '"')
          .replace(/(\\s)height="[^"]+"/, '$1height="' + vbH + '"');
      }
      return { svg: bytes };
    } catch (e) {
      return { error: 'svg_export_failed: ' + (e && e.message || String(e)) };
    }
  `;
  const { stdout } = await execFileAsync(
    opts.cfigmaBin,
    ["--tab", opts.tab, "exec", code],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CFIGMA_CDP_PORT: opts.cdpPort ?? process.env.CFIGMA_CDP_PORT ?? "9222",
      },
    },
  );
  const parsed = JSON.parse(stdout) as { svg: string } | { error: string };
  if ("error" in parsed)
    throw new Error(`pixpec exportNodeSvg: ${parsed.error}`);
  return parsed.svg;
}

/** Plugin script body — runs inside figma. Walks the node tree from
 *  `rootId` and returns a RawNode tree as plain JSON. */
function pluginScript(rootId: string | string[]): string {
  return `
const ROOT_IDS = ${JSON.stringify(Array.isArray(rootId) ? rootId : [rootId])};
const FRAMELIKE = new Set(['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET']);
const SHAPELIKE = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE']);
const VECTORLIKE = new Set(['VECTOR', 'BOOLEAN_OPERATION']);
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
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}
function imageMime(bytes) {
  if (bytes && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return 'image/png';
}
async function cleanPaints(paints) {
  const out = [];
  for (const paint of paints) {
    const p = clean(paint);
    if (p && p.type === 'IMAGE' && p.imageHash) {
      try {
        const img = figma.getImageByHash(p.imageHash);
        const bytes = img ? await img.getBytesAsync() : null;
        if (bytes) p.dataUrl = 'data:' + imageMime(bytes) + ';base64,' + bytesToBase64(bytes);
      } catch (e) {
        throw new Error('image_fill_read_failed: ' + p.imageHash + ': ' + (e && e.message ? String(e.message) : String(e)));
      }
    }
    out.push(p);
  }
  return out;
}
function hasCropImageFill(paints) {
  return Array.isArray(paints)
    && paints.some(p => p && p.type === 'IMAGE' && p.visible !== false && p.scaleMode === 'CROP');
}
async function exportNodePngDataUrl(node) {
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
  return 'data:image/png;base64,' + bytesToBase64(bytes);
}
function readOrError(out, key, fn) {
  try {
    return fn();
  } catch (e) {
    const message = e && e.message ? String(e.message) : String(e);
    throw new Error('dump_read_failed: ' + out.type + ' ' + out.id + ' (' + out.name + ') .' + key + ': ' + message);
  }
}
function normalizeComponentProperties(componentProperties) {
  if (!componentProperties) return undefined;
  const cp = {};
  for (const k of Object.keys(componentProperties)) {
    const v = componentProperties[k];
    cp[k] = { type: v.type, value: v.value, boundVariables: v.boundVariables };
  }
  return clean(cp);
}
function normalizeComponentPropertyDefinitions(definitions) {
  if (!definitions) return undefined;
  const out = {};
  for (const k of Object.keys(definitions)) {
    const v = definitions[k];
    out[k] = {
      type: v.type,
      defaultValue: v.defaultValue,
      variantOptions: v.variantOptions,
      preferredValues: v.preferredValues,
    };
  }
  return clean(out);
}
async function readComponentProperties(out, node, mainComponent) {
  try {
    return normalizeComponentProperties(node.componentProperties);
  } catch (e) {
    const message = e && e.message ? String(e.message) : String(e);
    let imported;
    try {
      if (mainComponent && mainComponent.key) imported = await figma.importComponentByKeyAsync(mainComponent.key);
    } catch (_) {
      imported = undefined;
    }
    if (imported) {
      let variantProperties;
      try {
        variantProperties = imported.variantProperties;
      } catch (_) {
        variantProperties = undefined;
      }
      if (variantProperties && Object.keys(variantProperties).length > 0) {
        let definitions = {};
        try {
          const parent = imported.parent;
          if (parent && parent.type === 'COMPONENT_SET') definitions = parent.componentPropertyDefinitions || {};
        } catch (_) {
          definitions = {};
        }
        const cp = {};
        for (const k of Object.keys(variantProperties)) {
          cp[k] = {
            type: definitions[k] && definitions[k].type || 'VARIANT',
            value: variantProperties[k],
            boundVariables: undefined,
          };
        }
        return clean(cp);
      }
    }
    throw new Error('dump_read_failed: ' + out.type + ' ' + out.id + ' (' + out.name + ') .componentProperties: ' + message);
  }
}
async function dumpNode(node) {
  if (!node) return null;
  if (node.visible === false) return null;
  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    isMask: node.isMask,
    width: node.width,
    height: node.height,
    x: node.x,
    y: node.y,
  };
  const absoluteBoundingBox = safe(() => node.absoluteBoundingBox, undefined);
  if (absoluteBoundingBox) out.absoluteBoundingBox = clean(absoluteBoundingBox);
  const absoluteRenderBounds = safe(() => node.absoluteRenderBounds, undefined);
  if (absoluteRenderBounds !== undefined) out.absoluteRenderBounds = clean(absoluteRenderBounds);
  if (typeof node.rotation === 'number' && Math.abs(node.rotation) >= 0.01) out.rotation = node.rotation;
  // Capture relative + absolute 2x3 affine matrices so compile can derive the
  // per-node flip (relative for INNER, absolute for ROOT — INNER cascades via
  // HTML, ROOT needs the ancestor cumulative since the chain isn't rendered).
  const captureMatrix = (key) => {
    const m = safe(() => node[key], undefined);
    if (!m || typeof m !== 'object') return;
    const r0 = m[0], r1 = m[1];
    if (!r0 || !r1) return;
    if (typeof r0[0] !== 'number' || typeof r0[1] !== 'number' || typeof r0[2] !== 'number') return;
    if (typeof r1[0] !== 'number' || typeof r1[1] !== 'number' || typeof r1[2] !== 'number') return;
    out[key] = [[r0[0], r0[1], r0[2]], [r1[0], r1[1], r1[2]]];
  };
  captureMatrix('relativeTransform');
  captureMatrix('absoluteTransform');
  if (node.type === 'INSTANCE' && typeof node.scaleFactor === 'number') out.scaleFactor = node.scaleFactor;
  if (typeof node.opacity === 'number' && node.opacity < 0.999) out.opacity = node.opacity;
  if (node.layoutPositioning) out.layoutPositioning = node.layoutPositioning;
  if (node.layoutSizingHorizontal) out.layoutSizingHorizontal = node.layoutSizingHorizontal;
  if (node.layoutSizingVertical) out.layoutSizingVertical = node.layoutSizingVertical;
  if (typeof node.layoutGrow === 'number') out.layoutGrow = node.layoutGrow;
  if (node.constraints) out.constraints = { horizontal: node.constraints.horizontal, vertical: node.constraints.vertical };
  if (node.componentPropertyReferences) out.componentPropertyReferences = clean(node.componentPropertyReferences);
  if (node.boundVariables && Object.keys(node.boundVariables).length) out.boundVariables = clean(node.boundVariables);
  if ((node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && typeof node.key === 'string') out.key = node.key;
  if ((node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && typeof node.remote === 'boolean') out.remote = node.remote;
  const canReadComponentPropertyDefinitions =
    node.type === 'COMPONENT_SET' ||
    (node.type === 'COMPONENT' && (!node.parent || node.parent.type !== 'COMPONENT_SET'));
  if (canReadComponentPropertyDefinitions) {
    const definitions = safe(() => node.componentPropertyDefinitions, undefined);
    if (definitions) out.componentPropertyDefinitions = normalizeComponentPropertyDefinitions(definitions);
  }
  if (node.type === 'COMPONENT' && node.variantProperties) {
    out.variantProperties = clean(node.variantProperties);
  }

  if (FRAMELIKE.has(node.type)) {
    out.layoutMode = node.layoutMode;
    out.primaryAxisSizingMode = node.primaryAxisSizingMode;
    out.counterAxisSizingMode = node.counterAxisSizingMode;
    out.paddingTop = node.paddingTop;
    out.paddingRight = node.paddingRight;
    out.paddingBottom = node.paddingBottom;
    out.paddingLeft = node.paddingLeft;
    out.itemSpacing = node.itemSpacing;
    if (typeof node.counterAxisSpacing === 'number') out.counterAxisSpacing = node.counterAxisSpacing;
    out.counterAxisAlignItems = node.counterAxisAlignItems;
    out.primaryAxisAlignItems = node.primaryAxisAlignItems;
    if (node.layoutWrap) out.layoutWrap = node.layoutWrap;
    if (Array.isArray(node.fills)) out.fills = await cleanPaints(node.fills);
    if (Array.isArray(node.strokes) && node.strokes.length) out.strokes = clean(node.strokes);
    if (Array.isArray(node.effects) && node.effects.length) out.effects = clean(node.effects);
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
    const mc = readOrError(out, 'mainComponent', () => node.mainComponent);
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
    const componentProperties = await readComponentProperties(out, node, mc);
    if (componentProperties) {
      out.componentProperties = componentProperties;
    }
    const overrides = readOrError(out, 'overrides', () => node.overrides);
    if (Array.isArray(overrides)) {
      out.overrides = overrides.map(o => ({ id: o.id, overriddenFields: (o.overriddenFields || []).slice() }));
    }
    const exposedInstances = readOrError(out, 'exposedInstances', () => node.exposedInstances);
    if (Array.isArray(exposedInstances) && exposedInstances.length) {
      out.exposedInstances = exposedInstances.map(i => ({ id: i.id, name: i.name }));
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
    if (Array.isArray(node.fills)) out.fills = await cleanPaints(node.fills);
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
    if (Array.isArray(node.fills)) out.fills = await cleanPaints(node.fills);
    if (hasCropImageFill(node.fills)) out.renderedDataUrl = await exportNodePngDataUrl(node);
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
      let bytes = await node.exportAsync({ format: 'SVG_STRING' });
      // Prefer sub-pixel-precise dim between existing viewBox and node dim.
      // See exportNodeSvg (line ~95) for the rationale: figma is inconsistent
      // between exports, sometimes rounding viewBox and sometimes node dims.
      const w = node.width, h = node.height;
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
        const vbMatch = bytes.match(/viewBox="([^"]+)"/);
        let vbW = w, vbH = h;
        if (vbMatch) {
          const parts = vbMatch[1].trim().split(/\\s+/).map(Number);
          if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
            const pickPrecise = (a, b) => {
              const aFrac = Math.abs(a - Math.round(a)) > 0.001;
              const bFrac = Math.abs(b - Math.round(b)) > 0.001;
              if (aFrac && !bFrac) return a;
              if (!aFrac && bFrac) return b;
              return Math.max(a, b);
            };
            vbW = pickPrecise(parts[2], w);
            vbH = pickPrecise(parts[3], h);
          }
        }
        bytes = bytes
          .replace(/viewBox="[^"]+"/, 'viewBox="0 0 ' + vbW + ' ' + vbH + '"')
          .replace(/(\\s)width="[^"]+"/, '$1width="' + vbW + '"')
          .replace(/(\\s)height="[^"]+"/, '$1height="' + vbH + '"');
      }
      out.svg = bytes;
    } catch (_) {
      out.svgExportFailed = true;
    }
    if (node.type === 'VECTOR' && Array.isArray(node.vectorPaths)) {
      out.vectorPaths = clean(node.vectorPaths.map((p) => ({
        windingRule: p.windingRule,
        data: p.data,
      })));
    }
    // Surface fills/strokes so the compiler can compute effectiveFill for
    // currentColor-style components (e.g. <Icon>) that need their tint
    // forwarded as a parent CSS color. GROUPs themselves don't paint, but
    // we recurse into them via the children walk below so inner VECTORs
    // are reachable.
    if (Array.isArray(node.fills)) out.fills = await cleanPaints(node.fills);
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

const results = [];
for (const rootId of ROOT_IDS) {
  try {
    const root = await figma.getNodeByIdAsync(rootId);
    if (!root) {
      results.push({ id: rootId, node: null, error: 'node_not_found: ' + rootId });
    } else {
      results.push({ id: rootId, node: await dumpNode(root) });
    }
  } catch (e) {
    results.push({ id: rootId, node: null, error: e && e.message || String(e) });
  }
}
return ${Array.isArray(rootId) ? "results" : "results[0].node || { error: results[0].error }"};
`;
}
