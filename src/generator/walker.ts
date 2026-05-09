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
  /** When true, the root nodeId — even if it's a registered INSTANCE — gets
   * walked as a FRAME (full layout + children IR captured) instead of
   * collapsed to `kind: 'component'`. Used by breakdown-prepare so verify
   * can render the root from IR alone, without depending on the registered
   * React impl. Nested INSTANCEs of the same registered set still emit as
   * `kind: 'component'`. */
  expandRootInstance?: boolean
  /** When true, EVERY INSTANCE (root + nested) walks as a FRAME — codegen
   * never emits a registered React component, IR carries the full tree.
   * Used when verifying a container whose children's React impls aren't
   * synthesized yet (e.g. Tab containing TabItem before the per-variant
   * compose step) — sidesteps the missing impl with raw IR rendering. */
  expandAllInstances?: boolean
  /** Per-figma-node binding map (Variant.bindings shape). Walker stamps
   * each matching IR node with `boundProp` (TEXT) / `boundProps`
   * (Component) annotations so codegen emits `{props.<key>}` instead
   * of the master literal. Caller (generate) discovers this via the
   * owning component's cases.ts; walker just consumes the map. */
  bindings?: Record<string, {
    attr?: { text?: string; color?: string; visible?: string }
    instanceProps?: Record<string, string>
  }>
}

export async function walk(opts: WalkOptions): Promise<IRNode> {
  const code = `
const REGISTRY = ${JSON.stringify(opts.registry)};
const ROOT_ID = ${JSON.stringify(opts.nodeId)};
const EXPAND_ROOT_INSTANCE = ${opts.expandRootInstance ? 'true' : 'false'};
const EXPAND_ALL_INSTANCES = ${opts.expandAllInstances ? 'true' : 'false'};
const BINDINGS = ${JSON.stringify(opts.bindings ?? {})};
function pixpecPropName(name) {
  const stripped = String(name).replace(/[\\x00-\\x1f\\x7f]/g, '').replace(/#[^#]*$/, '').trim();
  const parts = stripped.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return 'prop';
  const normalized = parts[0][0].toLowerCase() + parts[0].slice(1)
    + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
  return normalized === 'style' ? 'styleVariant' : normalized;
}
function pixpecCleanValue(value) {
  if (typeof value === 'string') return value.replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g, '');
  if (Array.isArray(value)) return value.map(pixpecCleanValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pixpecCleanValue(v)]));
  }
  return value;
}
function pixpecSetProp(out, name, value) {
  value = pixpecCleanValue(value);
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
          fields.includes('fills') ||
          // textStyleId rebind cascades fontSize/font/lineHeight/etc. from
          // the new style — same effective divergence as a direct font
          // override, so detach and walk the actual text properties.
          fields.includes('textStyleId')
        )) return true;
        // DESCENDANT FIXED-sized dim override — designer scaled an inner
        // node off its master dim (figma "drag corner" on a child). The
        // registered component API has no prop for arbitrary descendant
        // dim, so render the actual override tree (e.g. Input's IconButton
        // 28→32 with inner Icon 20→22.857). Skip the instance ITSELF —
        // top-level dim resize is the standard pattern (Icon master 24
        // commonly used at 16/20) and the registered component receives
        // it via componentLayoutStyles or its own size prop.
        if (ov.id !== node.id
            && (fields.includes('width') || fields.includes('height'))
            && (target.layoutSizingHorizontal === 'FIXED' || target.layoutSizingVertical === 'FIXED')) return true;
      }
      // Fallback: figma's overrides API misses textStyle drift (instance text
      // diverges from its bound textStyle without surfacing as a field
      // override — happens when library publish sync leaves stale values).
      // Walk every TEXT descendant and compare effective vs textStyle defn.
      const textNodes = [];
      const collectText = (n) => {
        if (!n.visible) return;
        if (n.type === 'TEXT') { textNodes.push(n); return; }
        if (n.type === 'INSTANCE') return;  // nested instances handled separately
        for (const c of (n.children || [])) collectText(c);
      };
      for (const c of (node.children || [])) collectText(c);
      for (const t of textNodes) {
        if (!t.textStyleId || typeof t.textStyleId !== 'string') continue;
        let st;
        try { st = await figma.getStyleByIdAsync(t.textStyleId); } catch (_) { continue; }
        if (!st) continue;
        if (st.fontName && t.fontName && (st.fontName.family !== t.fontName.family || st.fontName.style !== t.fontName.style)) return true;
        if (typeof st.fontSize === 'number' && st.fontSize !== t.fontSize) return true;
        const stLh = st.lineHeight, nLh = t.lineHeight;
        if (stLh && nLh && (stLh.unit !== nLh.unit || stLh.value !== nLh.value)) return true;
        if (typeof st.paragraphSpacing === 'number' && st.paragraphSpacing !== t.paragraphSpacing) return true;
      }
      return false;
    })();
    // expandRootInstance: caller (breakdown-prepare) wants the root walked
    // as a frame so verify can render from IR alone, not via the registered
    // React impl. Nested same-set INSTANCEs are unaffected.
    const expandThisRoot = EXPAND_ROOT_INSTANCE && node.id === ROOT_ID;
    if (structural || expandThisRoot || EXPAND_ALL_INSTANCES) {
      // Fall through to FRAME-style walking. INSTANCE's children/.layoutMode/etc.
      // already reflect overrides applied on top of the master.
      // Drop into the FRAME branch by treating the node as if type were FRAME.
    } else {
    const props = {};
    for (const [k, v] of Object.entries(node.componentProperties)) {
      pixpecSetProp(props, k, v.value);
    }
    // Capture every TEXT-characters override on the instance keyed by the
    // master-relative descendant id (figma reports instance child ids as
    // I<inst>;<masterDescId> -- strip prefix). The registered component's
    // propsFromFigma reads textOverrides[descId] when init detected the
    // single-varying-text pattern and bound it to a typed prop (commonly
    // "label"). Walker stays shape-agnostic; init owns the binding.
    const textOverrides = {};
    // Key textOverrides by the TEXT layer NAME instead of master descId.
    // Layer names stay constant across variants (figma copies child names
    // when authoring variants); ids diverge per variant copy. Looking up
    // by name in propsFromFigma collapses N variant id branches to one
    // string lookup. Last write wins on same-name duplicates (rare; init
    // surfaces ambiguity in detection).
    const nestedProps = {};
    const isOwn = (n) => {
      let pp = n.parent;
      while (pp && pp.id !== node.id) {
        if (pp.type === 'INSTANCE') return false;
        pp = pp.parent;
      }
      return true;
    };
    for (const ov of (node.overrides || [])) {
      const fields = ov.overriddenFields || [];
      const t = await figma.getNodeByIdAsync(ov.id);
      if (!t) continue;
      if (t.type === 'TEXT' && fields.includes('characters')) {
        textOverrides[t.name] = t.characters;
        continue;
      }
      // Nested INSTANCE componentProperties override — capture as
      // nestedProps[layerName][propKey] = value. Init scan flagged which
      // (layerName, propKey) pairs to expose; walker just dumps everything.
      if (t.type === 'INSTANCE' && isOwn(t) && fields.includes('componentProperties')) {
        const layer = nestedProps[t.name] = nestedProps[t.name] || {};
        for (const [pk, pv] of Object.entries(t.componentProperties || {})) {
          layer[pk] = pv.value;
        }
      }
    }
    // Snapshot children as IR — passed as second arg to propsFromFigma so
    // DS components that wrap N nested instances (Tab → Tab_Items) can
    // navigate the tree and extract per-child data into array props.
    const snapshotChildren = [];
    if (node.children) {
      for (const c of node.children) {
        if (c.visible === false) continue;
        const childIr = await ir(c);
        if (childIr) snapshotChildren.push(childIr);
      }
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
    // Layout-property overrides on the instance — figma instances can change
    // padding/gap/alignment without detaching. Capture only the keys whose
    // value diverges from the master so codegen can forward them as style
    // props on the registered component invocation. (Empty object → no
    // override; codegen skips emit.)
    const main = node.mainComponent;
    const layoutOverride = {};
    const cmpNum = (k, instV, mainV) => {
      if (typeof instV === 'number' && typeof mainV === 'number' && instV !== mainV) layoutOverride[k] = instV;
    };
    cmpNum('paddingTop', node.paddingTop, main && main.paddingTop);
    cmpNum('paddingRight', node.paddingRight, main && main.paddingRight);
    cmpNum('paddingBottom', node.paddingBottom, main && main.paddingBottom);
    cmpNum('paddingLeft', node.paddingLeft, main && main.paddingLeft);
    cmpNum('gap', node.itemSpacing, main && main.itemSpacing);
    // Per-node binding annotation: figmaPropKey → ownerPropKey for any
    // INSTANCE attrs the variant's bindings spec covers (e.g. nested
    // Icon's Type → owner's iconType prop).
    const __binding = BINDINGS[node.id];
    const __boundProps = __binding && __binding.instanceProps;
    return {
      ...base,
      kind: 'component',
      componentName: REGISTRY[key],
      ...(__boundProps && Object.keys(__boundProps).length ? { boundProps: __boundProps } : {}),
      raw: { id: node.id, name: node.name, mainComponentName: node.mainComponent?.name,
             componentSetKey: key, props, exposed, defaults,
             width: node.width, height: node.height,
             sizingH, sizingV,
             mainWidth: node.mainComponent?.width, mainHeight: node.mainComponent?.height,
             mainSizingH, mainSizingV,
             textOverrides: Object.keys(textOverrides).length ? textOverrides : undefined,
             nestedProps: Object.keys(nestedProps).length ? nestedProps : undefined },
      rotation: typeof node.rotation === 'number' && Math.abs(node.rotation) >= 0.01 ? node.rotation : undefined,
      sizingH, sizingV,
      mainSizingH, mainSizingV,
      mainWidth: node.mainComponent?.width, mainHeight: node.mainComponent?.height,
      width: node.width, height: node.height,
      layoutOverride: Object.keys(layoutOverride).length ? layoutOverride : undefined,
      children: snapshotChildren.length ? snapshotChildren : undefined,
    };
    } // close else branch — falls through to FRAME walk for detached instances
  }
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    // "Leaf-only non-autolayout" optimization: when this frame has no auto-
    // layout AND every descendant is a render-leaf (TEXT/shape/vector), our
    // CSS-flow decomposition has nothing to express — children sit at sub-
    // pixel absolute positions that browsers snap differently than figma's
    // single-pass rasterizer. Treat the whole subtree as one image kind and
    // let figma.exportAsync produce the SVG; one raster, exact parity.
    const isLeafOnly = (n) => {
      if (!n.visible) return true;
      const t = n.type;
      if (t === 'TEXT' || t === 'RECTANGLE' || t === 'ELLIPSE' || t === 'POLYGON'
          || t === 'STAR' || t === 'LINE' || t === 'VECTOR'
          || t === 'BOOLEAN_OPERATION' || t === 'GROUP') return true;
      if (t === 'INSTANCE') {
        let p = n.mainComponent; while (p && p.type !== 'COMPONENT_SET') p = p.parent;
        const key = p?.key ?? n.mainComponent?.key;
        if (key && REGISTRY[key]) return false;
      }
      if (t === 'FRAME' || t === 'COMPONENT' || t === 'INSTANCE') {
        if (n.layoutMode && n.layoutMode !== 'NONE') return false;
        return (n.children ?? []).every(isLeafOnly);
      }
      return false;
    };
    const noAutolayout = !node.layoutMode || node.layoutMode === 'NONE';
    if (noAutolayout && (node.children ?? []).length > 0
        && (node.children ?? []).every(isLeafOnly)) {
      return {
        ...base, kind: 'image',
        width: node.width, height: node.height,
        sizingH: mapSizing(node.layoutSizingHorizontal),
        sizingV: mapSizing(node.layoutSizingVertical),
        // Round to 2 decimals — figma float precision (0.3 → 0.30000001192092896)
      // doesn't match panda's atomic class name op_0.3; the runtime value
      // would generate a class with no rule. Designers use 1-decimal values.
      opacity: typeof node.opacity === 'number' && node.opacity < 0.999 ? Math.round(node.opacity * 100) / 100 : undefined,
      };
    }
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
    // strokeWeight === figma.mixed (Symbol) when individualStrokeWeights are
    // set per side. Capture per-side so codegen can emit borderTop/Bottom/etc
    // instead of a 4-side insetBorder. Pre-stringify to dodge CDP (Symbol
    // can't serialize) and read individual fields directly.
    // Round to 2 decimals — figma reports scaled-instance stroke at full
    // float precision (e.g. 1.1428570747375488 from a 32/28 scale) which
    // becomes a Panda atomic class name with no extractable rule.
    const rawStrokeWeight = stroke ? (typeof node.strokeWeight === 'number' ? node.strokeWeight : 1) : 0;
    const strokeWeight = Math.round(rawStrokeWeight * 100) / 100;
    const r2 = (v) => Math.round(v * 100) / 100;
    const strokeTopWeight = stroke ? r2(typeof node.strokeTopWeight === 'number' ? node.strokeTopWeight : strokeWeight) : 0;
    const strokeRightWeight = stroke ? r2(typeof node.strokeRightWeight === 'number' ? node.strokeRightWeight : strokeWeight) : 0;
    const strokeBottomWeight = stroke ? r2(typeof node.strokeBottomWeight === 'number' ? node.strokeBottomWeight : strokeWeight) : 0;
    const strokeLeftWeight = stroke ? r2(typeof node.strokeLeftWeight === 'number' ? node.strokeLeftWeight : strokeWeight) : 0;
    const mixedStroke = typeof node.strokeWeight !== 'number'
      && (strokeTopWeight !== strokeRightWeight || strokeRightWeight !== strokeBottomWeight || strokeBottomWeight !== strokeLeftWeight);
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
      background: bg,
      ...(typeof node.cornerRadius === 'number'
        ? { borderRadius: node.cornerRadius }
        : {
            borderRadiusTopLeft: typeof node.topLeftRadius === 'number' ? node.topLeftRadius : 0,
            borderRadiusTopRight: typeof node.topRightRadius === 'number' ? node.topRightRadius : 0,
            borderRadiusBottomRight: typeof node.bottomRightRadius === 'number' ? node.bottomRightRadius : 0,
            borderRadiusBottomLeft: typeof node.bottomLeftRadius === 'number' ? node.bottomLeftRadius : 0,
          }),
      strokeColor, strokeWeight,
      strokeTopWeight: mixedStroke ? strokeTopWeight : undefined,
      strokeRightWeight: mixedStroke ? strokeRightWeight : undefined,
      strokeBottomWeight: mixedStroke ? strokeBottomWeight : undefined,
      strokeLeftWeight: mixedStroke ? strokeLeftWeight : undefined,
      cornerSmoothing: node.cornerSmoothing || 0,
      clipsContent: !!node.clipsContent,
      tokenIds,
      rotation: typeof node.rotation === 'number' && Math.abs(node.rotation) >= 0.01 ? node.rotation : undefined,
      // Node-level opacity (figma "Layer opacity" slider). Disabled-state
      // variants typically carry root opacity 0.3 — without capturing this,
      // codegen renders at full opacity and disabled vs enabled diff explodes.
      // Round to 2 decimals — figma float precision (0.3 → 0.30000001192092896)
      // doesn't match panda's atomic class name op_0.3; the runtime value
      // would generate a class with no rule. Designers use 1-decimal values.
      opacity: typeof node.opacity === 'number' && node.opacity < 0.999 ? Math.round(node.opacity * 100) / 100 : undefined,
      // Min/max constraints — figma frames often set minHeight (or
      // minWidth) larger than HUG content so the box stays at a designed
      // dim even when text shrinks. CSS HUG without these renders smaller.
      minWidth: typeof node.minWidth === 'number' ? node.minWidth : undefined,
      maxWidth: typeof node.maxWidth === 'number' ? node.maxWidth : undefined,
      minHeight: typeof node.minHeight === 'number' ? node.minHeight : undefined,
      maxHeight: typeof node.maxHeight === 'number' ? node.maxHeight : undefined,
      children,
    };
  }
  if (node.type === 'TEXT') {
    // Leading/trailing whitespace doesn't translate cleanly: figma counts it
    // toward text width (advance), chromium collapses it under default
    // white-space:normal. Even with pre-wrap the centering algorithm differs
    // (figma centers visible ink, chromium centers advance box) — there is
    // no clean CSS rendering of the same intent. Surface as a hard error
    // so the designer can fix the figma node instead.
    // Preserve figma's whitespace width semantics in CSS: leading/trailing
    // spaces and runs of 2+ spaces get collapsed under default white-space
    // rules. Substitute U+00A0 (no-break space) so the advance is kept
    // without forcing white-space:pre (which would also break soft-wrap).
    // Single inter-word spaces are left as-is so line breaks still work.
    let pixpecText = node.characters;
    if (typeof pixpecText === 'string') {
      const NBSP = '\\u00A0';
      pixpecText = pixpecText.replace(/ {2,}/g, (m) => NBSP.repeat(m.length - 1) + ' ');
      pixpecText = pixpecText.replace(/^( +)/, (m) => NBSP.repeat(m.length));
      pixpecText = pixpecText.replace(/( +)$/, (m) => NBSP.repeat(m.length));
    }
    // figma per-character styling: getStyledTextSegments returns {start,end,
    // characters,fills,fontName,fontSize,...} for each run of identical
    // styling. When > 1 segment, the text has mixed colors/fonts/sizes per
    // range — codegen needs to emit nested spans per run instead of a
    // single styled span. Single segment case bypasses this and uses the
    // node-level fields below.
    const segments = (typeof node.getStyledTextSegments === 'function')
      ? node.getStyledTextSegments(['fills', 'fontName', 'fontSize', 'fontWeight', 'lineHeight', 'textDecoration'])
      : [];
    const runs = segments.length > 1 ? segments.map((seg) => {
      const segFill = Array.isArray(seg.fills) && seg.fills[0]?.type === 'SOLID' ? seg.fills[0] : null;
      let segText = seg.characters;
      if (typeof segText === 'string') {
        const NBSP = '\\u00A0';
        // Boundary-position spaces between styled runs collapse under Skia's
        // Korean text shaping (advance ≈ 0 instead of font's natural ~0.6em).
        // figma renders them at full advance. Substitute leading/trailing
        // ASCII spaces with NBSP (U+00A0) which Skia preserves verbatim.
        segText = segText.replace(/^ +/, (m) => NBSP.repeat(m.length));
        segText = segText.replace(/ +$/, (m) => NBSP.repeat(m.length));
        segText = segText.replace(/ {2,}/g, (m) => NBSP.repeat(m.length - 1) + ' ');
      }
      return {
        text: segText,
        color: segFill ? rgbaHex(segFill.color, segFill.opacity ?? 1) : undefined,
        colorTokenId: segFill?.boundVariables?.color?.id,
        fontFamily: typeof seg.fontName?.family === 'string' ? seg.fontName.family : undefined,
        fontWeight: typeof seg.fontWeight === 'number' ? seg.fontWeight : undefined,
        fontSize: typeof seg.fontSize === 'number' ? seg.fontSize : undefined,
        lineHeight: typeof seg.lineHeight === 'object' && seg.lineHeight.unit === 'PIXELS' ? seg.lineHeight.value : undefined,
        textDecoration: typeof seg.textDecoration === 'string' && seg.textDecoration !== 'NONE' ? seg.textDecoration : undefined,
      };
    }) : undefined;
    const fill = (Array.isArray(node.fills) && node.fills[0]?.type === 'SOLID') ? node.fills[0] : null;
    const tbv = node.boundVariables || {};
    const tokenIds = {
      color: fill?.boundVariables?.color?.id,
      lineHeight: tbv.lineHeight?.id,
      paragraphSpacing: tbv.paragraphSpacing?.id,
      fontSize: tbv.fontSize?.id,
    };
    // Compare effective vs textStyle definition — figma plugin API has no
    // "is overridden" flag, so we resolve the textStyle and diff each field.
    // Any divergence means the codegen MUST emit the explicit value (typo
    // wrapper alone won't match figma's render).
    const textStyleOverrides = {};
    if (node.textStyleId && typeof node.textStyleId === 'string') {
      try {
        const st = await figma.getStyleByIdAsync(node.textStyleId);
        if (st) {
          if (st.fontName && node.fontName && (st.fontName.family !== node.fontName.family || st.fontName.style !== node.fontName.style)) {
            textStyleOverrides.fontName = node.fontName;
          }
          if (typeof st.fontSize === 'number' && st.fontSize !== node.fontSize) {
            textStyleOverrides.fontSize = node.fontSize;
          }
          const stLh = st.lineHeight, nLh = node.lineHeight;
          if (stLh && nLh && (stLh.unit !== nLh.unit || stLh.value !== nLh.value)) {
            textStyleOverrides.lineHeight = nLh;
          }
          if (typeof st.paragraphSpacing === 'number' && st.paragraphSpacing !== node.paragraphSpacing) {
            textStyleOverrides.paragraphSpacing = node.paragraphSpacing;
          }
          if (st.textCase && node.textCase && st.textCase !== node.textCase) {
            textStyleOverrides.textCase = node.textCase;
          }
          if (st.textDecoration && node.textDecoration && st.textDecoration !== node.textDecoration) {
            textStyleOverrides.textDecoration = node.textDecoration;
          }
          const stLs = st.letterSpacing, nLs = node.letterSpacing;
          if (stLs && nLs && (stLs.unit !== nLs.unit || stLs.value !== nLs.value)) {
            textStyleOverrides.letterSpacing = nLs;
          }
        }
      } catch (_) { /* style fetch failed (deleted style etc.) — skip override diff */ }
    }
    // Per-node binding annotation: bindings spec may map this node id
    // to { attr.text: ownerKey } so codegen emits a prop reference
    // instead of the literal content.
    const __binding = BINDINGS[node.id];
    const __boundProp = __binding && __binding.attr && __binding.attr.text;
    return {
      ...base, kind: 'text',
      content: pixpecText,
      ...(__boundProp ? { boundProp: __boundProp } : {}),
      fontSize: node.fontSize,
      // Capture figma fontName.family verbatim. fontWeight is figma's
      // resolved numeric CSS weight — no fragile name→number mapping.
      // Italic is dropped (figma has no separate italic axis; italic faces
      // are distinct font files exposed via fontName.style — out of scope).
      fontFamily: typeof node.fontName?.family === 'string' ? node.fontName.family : undefined,
      fontWeight: typeof node.fontWeight === 'number' ? node.fontWeight : undefined,
      lineHeight: typeof node.lineHeight === 'object' && node.lineHeight.unit === 'PIXELS' ? node.lineHeight.value : node.fontSize,
      paragraphSpacing: typeof node.paragraphSpacing === 'number' ? node.paragraphSpacing : 0,
      color: fill ? rgbaHex(fill.color, fill.opacity ?? 1) : '#000000',
      // figma textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH'.
      // Codegen maps to CSS text-decoration values.
      textDecoration: typeof node.textDecoration === 'string' && node.textDecoration !== 'NONE' ? node.textDecoration : undefined,
      // Per-character styled runs when figma TEXT has mixed fills/fonts/etc
      // across ranges. Codegen emits nested spans per run when present.
      runs,
      tokenIds,
      textAlign: node.textAlignHorizontal?.toLowerCase(),
      textStyleId: typeof node.textStyleId === 'string' ? node.textStyleId : undefined,
      textStyleOverrides: Object.keys(textStyleOverrides).length ? textStyleOverrides : undefined,
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
    // RECTANGLE with IMAGE fill — figma renders raster image. Treat as
    // image kind so resolveImages exports the bitmap and codegen emits an
    // <img>. SOLID-only fill check below would ignore IMAGE and produce
    // an empty rect.
    if (Array.isArray(node.fills) && node.fills.some(f => f.type === 'IMAGE' && f.visible !== false)) {
      return {
        ...base, kind: 'image',
        width: node.width, height: node.height,
        sizingH: mapSizing(node.layoutSizingHorizontal),
        sizingV: mapSizing(node.layoutSizingVertical),
        opacity: typeof node.opacity === 'number' && node.opacity < 0.999 ? Math.round(node.opacity * 100) / 100 : undefined,
      };
    }
    const fill = (Array.isArray(node.fills) && node.fills[0]?.type === 'SOLID' && node.fills[0]?.visible !== false) ? node.fills[0] : null;
    const stroke = (Array.isArray(node.strokes) && node.strokes[0]?.type === 'SOLID' && node.strokes[0]?.visible !== false) ? node.strokes[0] : null;
    // Skip only zero-area degenerate shapes (e.g. designer left a 0-height
    // LINE). Positive-area shapes with no fill/stroke must be PRESERVED —
    // they often act as layout spacers (e.g. toggle's invisible "off-side
    // knob" reservation that keeps the pill width stable across on/off).
    // Codegen emits fill="none" so they make zero visual contribution while
    // still occupying layout slots in flex.
    const zeroArea = !(node.width > 0) || !(node.height > 0);
    if (zeroArea && !fill && !stroke) return null;
    return {
      ...base, kind: 'shape',
      shape: shapeMap[node.type],
      width: node.width, height: node.height,
      fill: fill ? rgbaHex(fill.color, fill.opacity ?? 1) : undefined,
      fillTokenId: fill?.boundVariables?.color?.id,
      strokeColor: stroke ? rgbaHex(stroke.color, stroke.opacity ?? 1) : undefined,
      strokeWeight: stroke ? (typeof node.strokeWeight === 'number' ? node.strokeWeight : 1) : 0,
      // figma strokeCap controls endpoint shape on open paths. ROUND adds
      // a half-circle (radius = strokeWeight/2) at each endpoint — without
      // forwarding this, chromium's svg defaults to butt and the line ink
      // ends square, diverging from figma by ~strokeWeight/2 px on each
      // side (visible on TabItem's bottom indicator line).
      ...(stroke && (node.strokeCap === 'ROUND' || node.strokeCap === 'SQUARE')
        ? { strokeCap: node.strokeCap === 'ROUND' ? 'round' : 'square' }
        : {}),
      // cornerRadius is figma.mixed (Symbol, non-serializable) when corners
      // differ — capture per-corner values in that case.
      ...(typeof node.cornerRadius === 'number'
        ? { borderRadius: node.cornerRadius }
        : {
            borderRadiusTopLeft: typeof node.topLeftRadius === 'number' ? node.topLeftRadius : 0,
            borderRadiusTopRight: typeof node.topRightRadius === 'number' ? node.topRightRadius : 0,
            borderRadiusBottomRight: typeof node.bottomRightRadius === 'number' ? node.bottomRightRadius : 0,
            borderRadiusBottomLeft: typeof node.bottomLeftRadius === 'number' ? node.bottomLeftRadius : 0,
          }),
      rotation: typeof node.rotation === 'number' && Math.abs(node.rotation) >= 0.01 ? node.rotation : undefined,
      // Round to 2 decimals — figma float precision (0.3 → 0.30000001192092896)
      // doesn't match panda's atomic class name op_0.3; the runtime value
      // would generate a class with no rule. Designers use 1-decimal values.
      opacity: typeof node.opacity === 'number' && node.opacity < 0.999 ? Math.round(node.opacity * 100) / 100 : undefined,
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
      `  figma: { componentSetKey: ${JSON.stringify(u.componentKey ?? '<unknown>')}, propsFromFigma: (raw) => ({...}) }\n` +
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
    if (!c.figma) continue
    const keys = Array.isArray(c.figma.componentSetKey) ? c.figma.componentSetKey : [c.figma.componentSetKey]
    for (const k of keys) reg[k] = c.name
  }
  return reg
}
