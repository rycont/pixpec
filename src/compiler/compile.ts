/**
 * Raw figma dump → Design AST compiler.
 *
 * Walks a `RawNode` tree DFS and classifies each node into a `DNode` of the
 * appropriate kind. Stateless apart from the per-call `CompileOptions`
 * registry (used to resolve `INSTANCE` nodes against registered components
 * and to apply per-node prop bindings). No figma calls — purely a transform
 * over the raw dump produced by `pixpec/src/dumper`.
 *
 * Detach decision (step 8) lives in `detach.ts`; this module imports it and
 * applies the verdict per INSTANCE.
 *
 * Token resolution: every numeric/color property that figma binds to a
 * variable becomes either a `{ tokenPath }` (when the bound variable's
 * intrinsic value matches the node's effective value) or a literal
 * `{ value, unit: 'px' }` / `{ color, opacity? }`. The picker lives in the
 * `pickSize` / `pickColor` helpers below.
 */

import type {
  DNode,
  DFlex,
  DStack,
  DBox,
  DText,
  DTextRun,
  DShape,
  DVector,
  DImage,
  DInstance,
  DUnknown,
  DNodeBase,
  Padding,
  CornerRadii,
  Size,
  Color,
  Shadow,
} from "./design-ast.ts";
import {
  NodeKind,
  Sizing,
  Anchor,
  Align,
  Justify,
  Positioning,
  TextAutoResize,
  TextDecoration,
  TextAlign,
  ShapeKind,
  StrokeAlign,
  StrokeCap,
  FlowDirection,
} from "./design-ast.ts";
import type {
  RawNode,
  RawSolidPaint,
  RawImagePaint,
  RawConstraints,
  RawTextRun,
  RawDropShadowEffect,
} from "../dumper/raw-node.ts";
import type { Registry } from "./registry.ts";
import { resolveRegistryVariant } from "./registry.ts";
import { shouldDetach } from "./detach.ts";
import { rawForPropsFromFigma } from "./props-context.ts";

export interface CompileOptions {
  /** Component registry (built by registry.ts from each component's index.ts). */
  registry: Registry;
  /** Variant bindings spec — per-master-node-id { attr.text/visible,
   *  component } map. Walker stamps matching descendants with
   *  contentBinding/visibilityBinding so the emitter renders prop-driven
   *  trees. Keyed by stripPrefix(node.id) so nested-instance overrides
   *  match the master node ids in cases.ts. */
  bindings?: import("./registry.ts").NodeBindings;
  /** Figma variable id → semantic token path (e.g. "VariableID:..." →
   *  "content.standard.primary"). */
  tokenMap?: Record<string, string>;
  /** Figma variable id → intrinsic numeric value (FLOAT vars only). When
   *  a numeric property is bound to a variable but the node's effective
   *  value differs (e.g. a scaled instance whose cornerRadius resolved
   *  to 6.857 while the bound variable's value is 6), the binding is
   *  dropped and the AST carries the raw literal — emitters render the
   *  figma-authoritative pixel result. */
  tokenValueMap?: Record<string, number>;
  /** Figma variable id → resolved CSS color. Color bindings are kept only
   *  when this matches the node's effective Figma paint. */
  tokenColorMap?: Record<string, string>;
  /** Optional callback used to fold pure-visual subtrees (non-autolayout
   *  Frame / Group / Shape with no INSTANCE / TEXT descendants) into a
   *  single DVector. The compiler hits this whenever it detects such a
   *  subtree; the caller wires it to a cfigma SVG export. Without it,
   *  the compiler falls back to recursing children individually (which
   *  loses absolute-position info on non-autolayout frames). */
  exportSvg?: (nodeId: string) => Promise<string>;
  /** Compile every INSTANCE from its resolved raw subtree instead of emitting
   *  a DInstance component reference. Intended for breakdown/debug output. */
  detachInstances?: boolean;
}

/** Subtree predicate: every descendant (including the node itself) must
 *  be either a non-autolayout FRAME/COMPONENT, a GROUP, or a shape/vector
 *  primitive. INSTANCE, TEXT, and autolayout containers disqualify the
 *  subtree from a single-svg fold. */
function isPureVisualSubtree(n: RawNode): boolean {
  if (n.type === "TEXT" || n.type === "INSTANCE" || n.type === "COMPONENT_SET")
    return false;
  if (FRAMELIKE.has(n.type) || n.type === "GROUP") {
    for (const c of n.children ?? []) {
      if (c.visible === false) continue;
      if (!isPureVisualSubtree(c)) return false;
    }
    return true;
  }
  if (SHAPELIKE.has(n.type) || VECTORLIKE.has(n.type)) return true;
  return false;
}

function isDetachedPureVisualInstance(n: RawNode): boolean {
  if (n.type !== "INSTANCE") return false;
  for (const c of n.children ?? []) {
    if (c.visible === false) continue;
    if (!isPureVisualSubtree(c)) return false;
  }
  return true;
}

/** All shape/vector descendants carry constraints `{ horizontal: 'SCALE',
 *  vertical: 'SCALE' }`. Required to safely export the subtree as a single
 *  SVG with `preserveAspectRatio="none"` — every other constraint mode
 *  (STRETCH/MIN/MAX/CENTER) needs per-child positioning that a single
 *  viewBox transform can't reproduce. */
function allChildrenSafeToFold(
  n: RawNode,
): true | { node: string; horizontal?: string; vertical?: string } {
  for (const c of n.children ?? []) {
    if (c.visible === false) continue;
    // GROUP / BOOLEAN_OPERATION are containers — figma often leaves their
    // own `constraints` undefined and lets the inner shapes carry the real
    // resize semantics. Recurse without checking the container itself.
    if (
      FRAMELIKE.has(c.type) ||
      c.type === "INSTANCE" ||
      c.type === "GROUP" ||
      c.type === "BOOLEAN_OPERATION"
    ) {
      const r = allChildrenSafeToFold(c);
      if (r !== true) return r;
      continue;
    }
    if (SHAPELIKE.has(c.type) || VECTORLIKE.has(c.type)) {
      const h = c.constraints?.horizontal;
      const v = c.constraints?.vertical;
      if (h !== "SCALE" || v !== "SCALE") {
        return {
          node: `${c.name} (${c.id})`,
          horizontal: h,
          vertical: v,
        };
      }
    }
  }
  return true;
}

const SHAPELIKE = new Set(["RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE"]);
const VECTORLIKE = new Set(["VECTOR", "BOOLEAN_OPERATION"]);
const FRAMELIKE = new Set(["FRAME", "COMPONENT", "COMPONENT_SET"]);

/** Shape-like figma node with neither paint nor stroke renders to nothing —
 *  drop these at compile time so the emitter doesn't produce empty SVG
 *  wrappers. (The figma "underline shown only when active" pattern uses an
 *  invisible LINE on the inactive variant.) */
function isInvisibleShape(c: RawNode): boolean {
  if (!SHAPELIKE.has(c.type)) return false;
  if (/^bounding box$/i.test(c.name.trim())) return true;
  const hasFill =
    Array.isArray(c.fills) && c.fills.some((f) => f && f.visible !== false);
  const hasStroke =
    Array.isArray(c.strokes) && c.strokes.some((s) => s && s.visible !== false);
  return !hasFill && !hasStroke;
}

function stripPrefix(id: string): string {
  return id.includes(";") ? id.substring(id.lastIndexOf(";") + 1) : id;
}

function rgbaHex(c: { r: number; g: number; b: number }, opacity = 1): string {
  const r = Math.round(c.r * 255),
    g = Math.round(c.g * 255),
    b = Math.round(c.b * 255);
  if (opacity >= 0.999)
    return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `rgba(${r},${g},${b},${opacity.toFixed(3)})`;
}

function firstSolidFill(fills?: RawNode["fills"]): RawSolidPaint | null {
  if (!Array.isArray(fills)) return null;
  for (const f of fills) {
    if (f && f.type === "SOLID" && f.visible !== false)
      return f as RawSolidPaint;
  }
  return null;
}

function firstImageFill(fills?: RawNode["fills"]): RawImagePaint | null {
  if (!Array.isArray(fills)) return null;
  for (const f of fills) {
    if (f && f.type === "IMAGE" && f.visible !== false)
      return f as RawImagePaint;
  }
  return null;
}

function sizingFromRaw(s?: "FIXED" | "HUG" | "FILL"): Sizing {
  return s === "HUG" ? Sizing.Hug : s === "FILL" ? Sizing.Fill : Sizing.Fixed;
}

function anchorFromConstraint(
  c?: RawConstraints["horizontal"],
): Anchor | undefined {
  return c === "MIN"
    ? Anchor.Start
    : c === "CENTER"
      ? Anchor.Center
      : c === "MAX"
        ? Anchor.End
        : c === "STRETCH"
          ? Anchor.Stretch
          : c === "SCALE"
            ? Anchor.Scale
            : undefined;
}

function alignFromRaw(a?: "MIN" | "CENTER" | "MAX"): Align {
  return a === "CENTER" ? Align.Center : a === "MAX" ? Align.End : Align.Start;
}

function justifyFromRaw(
  a?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN",
): Justify {
  return a === "CENTER"
    ? Justify.Center
    : a === "MAX"
      ? Justify.End
      : a === "SPACE_BETWEEN"
        ? Justify.SpaceBetween
        : Justify.Start;
}

// ---------------------------------------------------------------------------
// Size / Color picker — token-vs-literal discrimination.
// ---------------------------------------------------------------------------

function px(n: number): Size {
  return { value: n, unit: "px" };
}

function isOrthogonalSwapRotation(n: RawNode): boolean {
  if (typeof n.rotation !== "number") return false;
  const normalized = ((n.rotation % 360) + 360) % 360;
  return Math.abs(normalized - 90) < 0.01 || Math.abs(normalized - 270) < 0.01;
}

function nodeWidth(n: RawNode): number | undefined {
  return isOrthogonalSwapRotation(n) ? n.height : n.width;
}

function nodeHeight(n: RawNode): number | undefined {
  return isOrthogonalSwapRotation(n) ? n.width : n.height;
}

function nodeWidthVar(n: RawNode): string | undefined {
  return isOrthogonalSwapRotation(n)
    ? varId(n.boundVariables, "height")
    : varId(n.boundVariables, "width");
}

function nodeHeightVar(n: RawNode): string | undefined {
  return isOrthogonalSwapRotation(n)
    ? varId(n.boundVariables, "width")
    : varId(n.boundVariables, "height");
}

function tokenLookupKeys(varId: string): string[] {
  const keys = [varId];
  const remoteMatch = /^VariableID:([^/]+)\//.exec(varId);
  if (remoteMatch) keys.push(remoteMatch[1]);
  return keys;
}

function lookupTokenPath(
  varId: string | undefined,
  tokenMap: Record<string, string> | undefined,
): string | undefined {
  if (!varId || !tokenMap) return undefined;
  for (const key of tokenLookupKeys(varId)) {
    const path = tokenMap[key];
    if (path) return path;
  }
  return undefined;
}

function lookupTokenNumber(
  varId: string | undefined,
  tokenValueMap: Record<string, number> | undefined,
): number | undefined {
  if (!varId || !tokenValueMap) return undefined;
  for (const key of tokenLookupKeys(varId)) {
    const value = tokenValueMap[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function lookupTokenColor(
  varId: string | undefined,
  tokenColorMap: Record<string, string> | undefined,
): string | undefined {
  if (!varId || !tokenColorMap) return undefined;
  for (const key of tokenLookupKeys(varId)) {
    const value = tokenColorMap[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Pick a `Size` value: token path when the bound variable's intrinsic
 *  numeric value matches `actual`; otherwise the raw literal. Undefined
 *  when the actual value is missing. */
function pickSize(
  actual: number | undefined,
  varId: string | undefined,
  opts: CompileOptions,
): Size | undefined {
  if (actual === undefined) return undefined;
  const tokenPath = lookupTokenPath(varId, opts.tokenMap);
  if (tokenPath) {
    const intrinsic = lookupTokenNumber(varId, opts.tokenValueMap);
    if (typeof intrinsic === "number" && Math.abs(intrinsic - actual) < 1e-3) {
      return { tokenPath };
    }
  }
  return px(actual);
}

/** Pick a `Color` value: token path when bound (color tokens don't get
 *  scaled the way numerics do, so binding implies the resolved color
 *  matches the token's intrinsic). Otherwise the literal hex/rgba. */
function pickColor(
  paint: RawSolidPaint | null | undefined,
  varId: string | undefined,
  opts: CompileOptions,
): Color | undefined {
  if (!paint) return undefined;
  const tokenPath = lookupTokenPath(varId, opts.tokenMap);
  if (tokenPath) {
    const intrinsic = lookupTokenColor(varId, opts.tokenColorMap);
    const actual = rgbaHex(paint.color, paint.opacity ?? 1);
    if (intrinsic && colorsEquivalent(intrinsic, actual)) return { tokenPath };
  }
  if (paint.opacity !== undefined && paint.opacity < 0.999) {
    return { color: rgbaHex(paint.color, paint.opacity) };
  }
  return { color: rgbaHex(paint.color, paint.opacity ?? 1) };
}

function colorsEquivalent(a: string, b: string): boolean {
  const ca = parseCssColor(a);
  const cb = parseCssColor(b);
  if (!ca || !cb) return false;
  return ca.every((value, index) => Math.abs(value - cb[index]) <= 1);
}

function parseCssColor(value: string): [number, number, number, number] | undefined {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  const rgba = /^rgba\((\d+),(\d+),(\d+),([0-9.]+)\)$/.exec(value);
  if (!rgba) return undefined;
  return [
    Number(rgba[1]),
    Number(rgba[2]),
    Number(rgba[3]),
    Math.round(Number(rgba[4]) * 255),
  ];
}

function firstDropShadow(
  effects?: RawNode["effects"],
): RawDropShadowEffect | null {
  if (!Array.isArray(effects)) return null;
  return (
    effects.find(
      (e): e is RawDropShadowEffect =>
        e?.type === "DROP_SHADOW" && e.visible !== false,
    ) ?? null
  );
}

function shadowFromRaw(n: RawNode): Shadow | undefined {
  const effect = firstDropShadow(n.effects);
  if (!effect) return undefined;
  return {
    x: px(effect.offset?.x ?? 0),
    y: px(effect.offset?.y ?? 0),
    blur: px(effect.radius ?? 0),
    spread: effect.spread ? px(effect.spread) : undefined,
    color: {
      color: rgbaHex(
        effect.color,
        typeof effect.color.a === "number" ? effect.color.a : 1,
      ),
    },
  };
}

/** Pick a variable id from a figma `boundVariables[property]` slot (figma
 *  often nests as an array of one alias). */
function varId(bv: unknown, key: string): string | undefined {
  const slot = (bv as Record<string, unknown> | undefined)?.[key];
  if (Array.isArray(slot)) {
    const first = slot[0] as { id?: string } | undefined;
    return first?.id;
  }
  return (slot as { id?: string } | undefined)?.id;
}

// ---------------------------------------------------------------------------
// Per-kind compilers.
// ---------------------------------------------------------------------------

function buildBase(
  n: RawNode,
  opts: CompileOptions,
  parent?: RawNode,
): DNodeBase {
  const out: DNodeBase = { sourceId: n.id, sourceName: n.name };
  if (typeof n.opacity === "number" && n.opacity < 1) out.opacity = n.opacity;
  if (typeof n.rotation === "number" && Math.abs(n.rotation) >= 0.01)
    out.rotation = n.rotation;
  if (parent && n.layoutPositioning === "ABSOLUTE") {
    out.positioning = Positioning.Absolute;
    out.inset = { left: n.x ?? 0, top: n.y ?? 0 };
    if (
      parent &&
      typeof parent.width === "number" &&
      typeof n.width === "number"
    ) {
      out.inset.right = parent.width - (n.x ?? 0) - n.width;
    }
    if (
      parent &&
      typeof parent.height === "number" &&
      typeof n.height === "number"
    ) {
      out.inset.bottom = parent.height - (n.y ?? 0) - n.height;
    }
    if (n.constraints) {
      const h = anchorFromConstraint(n.constraints.horizontal);
      const v = anchorFromConstraint(n.constraints.vertical);
      if (h || v) out.anchor = { horizontal: h, vertical: v };
    }
  }
  if (
    typeof n.layoutSizingHorizontal === "string" ||
    typeof n.layoutSizingVertical === "string"
  ) {
    const swapAxes = isOrthogonalSwapRotation(n);
    out.sizing = {
      horizontal: sizingFromRaw(
        swapAxes ? n.layoutSizingVertical : n.layoutSizingHorizontal,
      ),
      vertical: sizingFromRaw(
        swapAxes ? n.layoutSizingHorizontal : n.layoutSizingVertical,
      ),
    };
  }
  const bareId = stripPrefix(n.id);
  const binding = opts.bindings?.[bareId];
  out.renderBoundsOffset = renderBoundsOffsetFromRaw(n);
  if (binding?.node?.visible) out.visibilityBinding = binding.node.visible;
  return out;
}

function renderBoundsOffsetFromRaw(n: RawNode): { x: number; y: number } | undefined {
  const bb = n.absoluteBoundingBox;
  const rb = n.absoluteRenderBounds;
  if (!bb || !rb) return undefined;
  const x = rb.x - bb.x;
  const y = rb.y - bb.y;
  if (Math.abs(x) < 0.001 && Math.abs(y) < 0.001) return undefined;
  return { x, y };
}

function compileText(
  n: RawNode,
  opts: CompileOptions,
  parent?: RawNode,
): DText {
  const fill = firstSolidFill(n.fills);
  const bv = n.boundVariables;
  // Figma binds text-level fills via boundVariables.fills (may be array)
  // OR per-paint boundVariables.color on the SOLID paint itself.
  const colorVarId = varId(fill?.boundVariables, "color") ?? varId(bv, "fills");
  const color = pickColor(fill, colorVarId, opts) ?? { color: "#000000" };
  const fontSize = pickSize(n.fontSize, varId(bv, "fontSize"), opts) ?? px(16);
  const lhRaw =
    n.lineHeight && n.lineHeight.unit === "PIXELS"
      ? (n.lineHeight.value ?? n.fontSize ?? 0)
      : (n.fontSize ?? 0);
  const lineHeight =
    pickSize(lhRaw, varId(bv, "lineHeight"), opts) ?? px(lhRaw);
  const paragraphSpacing = pickSize(
    n.paragraphSpacing,
    varId(bv, "paragraphSpacing"),
    opts,
  );
  const decoration =
    n.textDecoration === "UNDERLINE"
      ? TextDecoration.Underline
      : n.textDecoration === "STRIKETHROUGH"
        ? TextDecoration.LineThrough
        : undefined;
  const align: TextAlign | undefined =
    n.textAlignHorizontal === "CENTER"
      ? TextAlign.Center
      : n.textAlignHorizontal === "RIGHT"
        ? TextAlign.Right
        : n.textAlignHorizontal === "JUSTIFIED"
          ? TextAlign.Justify
          : n.textAlignHorizontal === "LEFT"
            ? TextAlign.Left
            : undefined;
  const autoResize: TextAutoResize =
    n.textAutoResize === "WIDTH_AND_HEIGHT"
      ? TextAutoResize.Hug
      : n.textAutoResize === "HEIGHT"
        ? TextAutoResize.FixedWidth
        : n.textAutoResize === "TRUNCATE"
          ? TextAutoResize.Truncate
          : TextAutoResize.FixedBoth;
  const runs: DTextRun[] | undefined = n.styledTextSegments?.map(
    (seg: RawTextRun) => {
      const segFill = firstSolidFill(seg.fills);
      return {
        text: sanitizeTextContent(seg.characters),
        color: pickColor(segFill, undefined, opts),
        fontFamily: seg.fontName?.family,
        fontWeight: seg.fontWeight,
        fontSize: seg.fontSize !== undefined ? px(seg.fontSize) : undefined,
        lineHeight:
          seg.lineHeight &&
          seg.lineHeight.unit === "PIXELS" &&
          seg.lineHeight.value !== undefined
            ? px(seg.lineHeight.value)
            : undefined,
        textDecoration:
          seg.textDecoration === "UNDERLINE"
            ? TextDecoration.Underline
            : seg.textDecoration === "STRIKETHROUGH"
              ? TextDecoration.LineThrough
              : undefined,
      };
    },
  );
  const out: DText = {
    ...buildBase(n, opts, parent),
    kind: NodeKind.Text,
    content: sanitizeTextContent(n.characters ?? ""),
    fontFamily: n.fontName?.family,
    fontWeight: n.fontWeight,
    fontSize,
    lineHeight,
    paragraphSpacing,
    color,
    textDecoration: decoration,
    textAlign: align,
    textStyleRef: n.textStyleId,
    width: n.width ?? 0,
    autoResize,
    runs,
  };
  const bareId = stripPrefix(n.id);
  const binding = opts.bindings?.[bareId];
  if (binding?.node?.content) out.contentBinding = binding.node.content;
  if (binding?.node?.paint) out.fillBinding = binding.node.paint;
  if (binding?.node?.textStyle) out.textStyleBinding = binding.node.textStyle;
  return out;
}

function sanitizeTextContent(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

async function compileShape(
  n: RawNode,
  opts: CompileOptions,
  parent?: RawNode,
): Promise<DShape | DImage> {
  const imageFill = firstImageFill(n.fills);
  if (imageFill?.dataUrl) {
    return {
      ...buildBase(n, opts, parent),
      kind: NodeKind.Image,
      width: pickSize(nodeWidth(n), nodeWidthVar(n), opts) ?? px(0),
      height:
        pickSize(nodeHeight(n), nodeHeightVar(n), opts) ?? px(0),
      dataUrl: imageFill.dataUrl,
      renderedDataUrl: n.renderedDataUrl,
      imageScaleMode: imageFill.scaleMode,
      imageTransform: imageFill.imageTransform,
    };
  }
  const fill = firstSolidFill(n.fills);
  const stroke = firstSolidFill(n.strokes);
  const fillVarId = varId(fill?.boundVariables, "color");
  const strokeVarId = varId(stroke?.boundVariables, "color");
  const strokeWidthVarId = varId(n.boundVariables, "strokeWeight");
  const strokeWidth = pickSize(
    typeof n.strokeWeight === "number" ? n.strokeWeight : undefined,
    strokeWidthVarId,
    opts,
  );
  const out: DShape = {
    ...buildBase(n, opts, parent),
    kind: NodeKind.Shape,
    shape:
      n.type === "LINE"
        ? ShapeKind.Line
        : n.type === "RECTANGLE"
          ? ShapeKind.Rect
          : n.type === "ELLIPSE"
            ? ShapeKind.Ellipse
            : n.type === "POLYGON"
              ? ShapeKind.Polygon
              : ShapeKind.Star,
    width: pickSize(nodeWidth(n), nodeWidthVar(n), opts) ?? px(0),
    height:
      pickSize(nodeHeight(n), nodeHeightVar(n), opts) ?? px(0),
    fill: pickColor(fill, fillVarId, opts),
    stroke: stroke
      ? {
          paint: pickColor(stroke, strokeVarId, opts) ?? {
            color: "#000000",
          },
          width:
            strokeWidth ??
            px(typeof n.strokeWeight === "number" ? n.strokeWeight : 1),
          align:
            n.strokeAlign === "INSIDE"
              ? StrokeAlign.Inside
              : n.strokeAlign === "OUTSIDE"
                ? StrokeAlign.Outside
                : n.strokeAlign === "CENTER"
                  ? StrokeAlign.Center
                  : undefined,
          cap:
            n.strokeCap === "ROUND"
              ? StrokeCap.Round
              : n.strokeCap === "SQUARE"
                ? StrokeCap.Square
                : undefined,
        }
      : undefined,
    cornerRadius: cornerFromRaw(n, opts),
  };
  return out;
}

function cornerFromRaw(
  n: RawNode,
  opts: CompileOptions,
): Size | CornerRadii | undefined {
  if (typeof n.cornerRadius === "number") {
    return pickSize(
      n.cornerRadius || undefined,
      varId(n.boundVariables, "cornerRadius") ??
        varId(n.boundVariables, "topLeftRadius"),
      opts,
    );
  }
  if (n.cornerRadius === "mixed") {
    return {
      tl:
        pickSize(
          n.topLeftRadius ?? 0,
          varId(n.boundVariables, "topLeftRadius"),
          opts,
        ) ?? px(0),
      tr:
        pickSize(
          n.topRightRadius ?? 0,
          varId(n.boundVariables, "topRightRadius"),
          opts,
        ) ?? px(0),
      br:
        pickSize(
          n.bottomRightRadius ?? 0,
          varId(n.boundVariables, "bottomRightRadius"),
          opts,
        ) ?? px(0),
      bl:
        pickSize(
          n.bottomLeftRadius ?? 0,
          varId(n.boundVariables, "bottomLeftRadius"),
          opts,
        ) ?? px(0),
    };
  }
  return undefined;
}

function paddingFromRaw(n: RawNode, opts: CompileOptions): Padding | undefined {
  const t = n.paddingTop ?? 0,
    r = n.paddingRight ?? 0,
    b = n.paddingBottom ?? 0,
    l = n.paddingLeft ?? 0;
  if (!t && !r && !b && !l) return undefined;
  return {
    top: pickSize(t, varId(n.boundVariables, "paddingTop"), opts) ?? px(t),
    right: pickSize(r, varId(n.boundVariables, "paddingRight"), opts) ?? px(r),
    bottom:
      pickSize(b, varId(n.boundVariables, "paddingBottom"), opts) ?? px(b),
    left: pickSize(l, varId(n.boundVariables, "paddingLeft"), opts) ?? px(l),
  };
}

async function compileVector(
  n: RawNode,
  opts: CompileOptions,
  parent?: RawNode,
): Promise<DVector | DImage> {
  const w = pickSize(n.width, undefined, opts) ?? px(0);
  const h = pickSize(n.height, undefined, opts) ?? px(0);
  let svg = n.svg;
  if (!svg && n.svgExportFailed) svg = svgFromVectorPaths(n);
  if (!svg && opts.exportSvg) {
    try {
      svg = await exportSvgForRawNode(n, opts);
    } catch (error) {
      svg = svgFromVectorPaths(n);
      if (!svg) throw error;
    }
  }
  if (svg) {
    return {
      ...buildBase(n, opts, parent),
      kind: NodeKind.Vector,
      width: w,
      height: h,
      svg,
      renderBoundsOffset: renderBoundsOffsetFromRaw(n),
    };
  }
  return {
    ...buildBase(n, opts, parent),
    kind: NodeKind.Image,
    width: w,
    height: h,
  };
}

function svgFromVectorPaths(n: RawNode): string | undefined {
  if (!Array.isArray(n.vectorPaths) || n.vectorPaths.length === 0) return undefined;
  const width = n.width ?? 0;
  const height = n.height ?? 0;
  const fill = firstSolidFill(n.fills);
  const stroke = firstSolidFill(n.strokes);
  const fillAttr = fill ? ` fill="${escapeXml(rgbaHex(fill.color, fill.opacity ?? 1))}"` : ' fill="none"';
  const strokeAttr = stroke ? ` stroke="${escapeXml(rgbaHex(stroke.color, stroke.opacity ?? 1))}"` : '';
  const paths = n.vectorPaths
    .map((path) => {
      const fillRule = path.windingRule === 'EVENODD' ? ' fill-rule="evenodd"' : '';
      return `<path d="${escapeXml(path.data)}"${fillAttr}${strokeAttr}${fillRule}/>`;
    })
    .join('');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function compileContainer(
  n: RawNode,
  opts: CompileOptions,
  parent?: RawNode,
  rawSubtree = false,
): Promise<DFlex | DStack | DBox> {
  const direction =
    n.layoutMode === "HORIZONTAL"
      ? "row"
      : n.layoutMode === "VERTICAL"
        ? "column"
        : "none";
  const fill = firstSolidFill(n.fills);
  const stroke = firstSolidFill(n.strokes);
  const childRaws = (n.children ?? []).filter(
    (c) => c.visible !== false && !isInvisibleShape(c),
  );
  const children: DNode[] = [];
  for (const c of childRaws) {
    const child = await compileNode(c, opts, n, rawSubtree);
    if (direction === "none") applyAbsoluteChildPosition(child, c, n);
    children.push(child);
  }
  const bgVarId =
    varId(fill?.boundVariables, "color") ?? varId(n.boundVariables, "fills");
  const strokeVarId = varId(stroke?.boundVariables, "color");
  const strokeWidth = pickSize(
    typeof n.strokeWeight === "number" ? n.strokeWeight : undefined,
    varId(n.boundVariables, "strokeWeight"),
    opts,
  );
  const bareId = stripPrefix(n.id);
  const binding = opts.bindings?.[bareId];
  const common = {
    ...buildBase(n, opts, parent),
    width: pickSize(nodeWidth(n), nodeWidthVar(n), opts),
    height: pickSize(nodeHeight(n), nodeHeightVar(n), opts),
    minWidth: pickSize(n.minWidth, varId(n.boundVariables, "minWidth"), opts),
    maxWidth: pickSize(n.maxWidth, varId(n.boundVariables, "maxWidth"), opts),
    minHeight: pickSize(
      n.minHeight,
      varId(n.boundVariables, "minHeight"),
      opts,
    ),
    maxHeight: pickSize(
      n.maxHeight,
      varId(n.boundVariables, "maxHeight"),
      opts,
    ),
    padding: paddingFromRaw(n, opts),
    background: pickColor(fill, bgVarId, opts),
    fillBinding: binding?.node?.paint,
    border: stroke
      ? {
          paint: pickColor(stroke, strokeVarId, opts) ?? {
            color: "#000000",
          },
          width:
            (n.strokeWeight as unknown) === "mixed"
              ? {
                  top: pickSize(n.strokeTopWeight, undefined, opts) ?? px(0),
                  right:
                    pickSize(n.strokeRightWeight, undefined, opts) ?? px(0),
                  bottom:
                    pickSize(n.strokeBottomWeight, undefined, opts) ?? px(0),
                  left: pickSize(n.strokeLeftWeight, undefined, opts) ?? px(0),
                }
              : (strokeWidth ??
                px(typeof n.strokeWeight === "number" ? n.strokeWeight : 1)),
          align:
            n.strokeAlign === "INSIDE"
              ? StrokeAlign.Inside
              : n.strokeAlign === "OUTSIDE"
                ? StrokeAlign.Outside
                : n.strokeAlign === "CENTER"
                  ? StrokeAlign.Center
                  : undefined,
        }
      : undefined,
    shadow: shadowFromRaw(n),
    cornerRadius: cornerFromRaw(n, opts),
    cornerSmoothing: n.cornerSmoothing,
    clip: n.clipsContent,
    children,
  };
  if (direction === "row") {
    return {
      ...common,
      kind: NodeKind.Flex,
      direction: FlowDirection.Row,
      gap: pickSize(
        n.itemSpacing,
        varId(n.boundVariables, "itemSpacing"),
        opts,
      ),
      counterGap: pickSize(
        n.counterAxisSpacing,
        varId(n.boundVariables, "counterAxisSpacing"),
        opts,
      ),
      align: alignFromRaw(n.counterAxisAlignItems),
      justify: justifyFromRaw(n.primaryAxisAlignItems),
      wrap: n.layoutWrap === "WRAP",
    };
  }
  if (direction === "column") {
    return {
      ...common,
      kind: NodeKind.Stack,
      direction: FlowDirection.Column,
      gap: pickSize(
        n.itemSpacing,
        varId(n.boundVariables, "itemSpacing"),
        opts,
      ),
      counterGap: pickSize(
        n.counterAxisSpacing,
        varId(n.boundVariables, "counterAxisSpacing"),
        opts,
      ),
      align: alignFromRaw(n.counterAxisAlignItems),
      justify: justifyFromRaw(n.primaryAxisAlignItems),
      wrap: n.layoutWrap === "WRAP",
    };
  }
  return { ...common, kind: NodeKind.Box };
}

function applyAbsoluteChildPosition(
  out: DNode,
  n: RawNode,
  parent: RawNode,
): void {
  if (out.positioning === Positioning.Absolute) return;
  out.positioning = Positioning.Absolute;
  const left =
    typeof n.absoluteBoundingBox?.x === "number" &&
    typeof parent.absoluteBoundingBox?.x === "number"
      ? n.absoluteBoundingBox.x - parent.absoluteBoundingBox.x
      : (n.x ?? 0);
  const top =
    typeof n.absoluteBoundingBox?.y === "number" &&
    typeof parent.absoluteBoundingBox?.y === "number"
      ? n.absoluteBoundingBox.y - parent.absoluteBoundingBox.y
      : (n.y ?? 0);
  out.inset = { left, top };
  if (
    typeof parent.width === "number" &&
    typeof n.width === "number"
  ) {
    out.inset.right = parent.width - left - n.width;
  }
  if (
    typeof parent.height === "number" &&
    typeof n.height === "number"
  ) {
    out.inset.bottom = parent.height - top - n.height;
  }
  if (n.constraints) {
    const h = anchorFromConstraint(n.constraints.horizontal);
    const v = anchorFromConstraint(n.constraints.vertical);
    if (h || v) out.anchor = { horizontal: h, vertical: v };
  }
}

async function compileInstance(
  n: RawNode,
  opts: CompileOptions,
  parent?: RawNode,
  rawSubtree = false,
): Promise<DNode> {
  if (rawSubtree || opts.detachInstances) return compileContainer(n, opts, parent, true);

  const setKey = n.mainComponent?.parentKey ?? n.mainComponent?.key;
  const entry = setKey ? opts.registry.get(setKey) : undefined;
  if (!entry) {
    throw new Error(
      `pixpec compile: encountered INSTANCE ${n.id} (${n.name}) of unregistered component ` +
        `(componentSet key ${setKey ?? "<unknown>"}). Run \`pixpec init\` for that component first, ` +
        `or detach the instance in figma.`,
    );
  }
  const variant = resolveRegistryVariant(
    entry,
    n.mainComponent?.key,
    n.mainComponent?.name,
  );
  if (shouldDetach(n, entry, variant)) return compileContainer(n, opts, parent, true);

  const rawForFigma = rawForPropsFromFigma(n);
  // Compile child nodes (recursively) so propsFromFigma can aggregate
  // nested-instance data — e.g. a Tab instance collects `tabItems` from
  // its compiled DInstance(TabItem) children. Most components ignore the
  // children arg; Tab-shaped containers depend on it.
  const compiledChildren: DNode[] = [];
  for (const c of n.children ?? [])
    compiledChildren.push(await compileNode(c, opts, n));
  let props: Record<string, unknown> = {};
  try {
    props = variant?.propsFromFigma?.(rawForFigma, compiledChildren) ?? {};
  } catch {
    /* best-effort */
  }
  const out: DInstance = {
    ...buildBase(n, opts, parent),
    kind: NodeKind.Instance,
    componentName: entry.componentName,
    props,
    defaultProps: entry.defaults,
    width: pickSize(nodeWidth(n), nodeWidthVar(n), opts),
    height: pickSize(nodeHeight(n), nodeHeightVar(n), opts),
  };
  // Surface per-instance-property bindings from the variant spec so the
  // emitter can render `<Icon Type={iconType}/>` etc.
  const bareId = stripPrefix(n.id);
  const ipb = opts.bindings?.[bareId]?.component;
  if (ipb && Object.keys(ipb).length > 0) out.instancePropBindings = { ...ipb };
  const fillBinding = opts.bindings?.[bareId]?.node?.paint;
  const childSupportsFill = Object.values(entry.bindings).some(
    (b) => b.node?.paint === "_fill",
  );
  if (fillBinding && childSupportsFill) {
    out.instancePropBindings = {
      ...(out.instancePropBindings ?? {}),
      _fill: fillBinding,
    };
  }
  const layoutOverrides: NonNullable<DInstance["layoutOverrides"]> = {};
  let any = false;
  for (const k of [
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
  ] as const) {
    const v = (n as unknown as Record<string, unknown>)[k] as
      | number
      | undefined;
    if (typeof v === "number" && v !== 0) {
      layoutOverrides[k] = pickSize(v, varId(n.boundVariables, k), opts);
      any = true;
    }
  }
  if (typeof n.itemSpacing === "number" && n.itemSpacing !== 0) {
    layoutOverrides.gap = pickSize(
      n.itemSpacing,
      varId(n.boundVariables, "itemSpacing"),
      opts,
    );
    any = true;
  }
  if (any) out.layoutOverrides = layoutOverrides;
  // currentColor extraction — find the first inner VECTOR/BOOLEAN_OPERATION
  // and surface its effective SOLID fill so emitter plugins (e.g. danah's
  // iconCurrentColor) can forward it as a parent CSS color attribute. This
  // mirrors the legacy walker's `walkExtend` logic that ran inside figma.
  const eff = findEffectiveVectorFill(n);
  if (eff) {
    out.effectiveFill = eff.color;
    if (eff.tokenId) out.effectiveFillTokenId = eff.tokenId;
  }
  return out;
}

/** Walk an INSTANCE's descendants and return the first VECTOR-like node's
 *  effective SOLID fill (color + bound-variable id). Empty/all-hidden fills
 *  are reported as transparent so the emitter can forward color suppression
 *  (matches legacy iconCurrentColor walker semantics). */
function findEffectiveVectorFill(
  n: RawNode,
): { color: string; tokenId?: string } | undefined {
  if (n.visible === false) return undefined;
  if (n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION") {
    if (!Array.isArray(n.fills)) return undefined;
    const f0 = n.fills[0];
    if (f0 && f0.type === "SOLID" && (f0 as RawSolidPaint).visible !== false) {
      const sf = f0 as RawSolidPaint;
      const tokenId = varId(sf.boundVariables, "color");
      return { color: rgbaHex(sf.color, sf.opacity ?? 1), tokenId };
    }
    if (
      n.fills.length === 0 ||
      n.fills.every((f) => f && f.visible === false)
    ) {
      return { color: "transparent" };
    }
    return undefined;
  }
  for (const c of n.children ?? []) {
    const r = findEffectiveVectorFill(c);
    if (r) return r;
  }
  return undefined;
}

function compileUnknown(
  n: RawNode,
  opts: CompileOptions,
  parent?: RawNode,
): DUnknown {
  return {
    ...buildBase(n, opts, parent),
    kind: NodeKind.Unknown,
    sourceType: n.type,
    width: pickSize(nodeWidth(n), undefined, opts) ?? px(0),
    height: pickSize(nodeHeight(n), undefined, opts) ?? px(0),
  };
}

async function compileNode(
  n: RawNode,
  opts: CompileOptions,
  parent?: RawNode,
  rawSubtree = false,
): Promise<DNode> {
  if (n.isMask) {
    return {
      ...compileUnknown(n, opts, parent),
      hidden: true,
    };
  }
  // Fold pure-visual subtrees (non-autolayout Frame/Group/Shape only, no
  // INSTANCE/TEXT inside) into a single DVector via figma SVG export. The
  // alternative — recursing children — loses absolute-position info on
  // non-autolayout frames since per-child positioning isn't reliably
  // captured in the raw dump.
  if (
    opts.exportSvg &&
    (isPureVisualSubtree(n) ||
      (opts.detachInstances && isDetachedPureVisualInstance(n))) &&
    (FRAMELIKE.has(n.type) || n.type === "GROUP" || n.type === "INSTANCE") &&
    (n.children?.length ?? 0) > 0
  ) {
    const safe = allChildrenSafeToFold(n);
    if (safe === true) {
      try {
        const svg = await exportSvgForRawNode(n, opts);
        return {
          ...buildBase(n, opts, parent),
          kind: NodeKind.Vector,
          width:
            pickSize(n.width, varId(n.boundVariables, "width"), opts) ??
            px(n.width ?? 0),
          height:
            pickSize(n.height, varId(n.boundVariables, "height"), opts) ??
            px(n.height ?? 0),
          svg,
          renderBoundsOffset: renderBoundsOffsetFromRaw(n),
        };
      } catch {
        // Some detached-instance descendants have visible vector geometry but
        // Figma refuses direct SVG export. Fall through to the normal
        // container path so children remain proper vector/shape nodes.
      }
    }
  }
  if (n.type === "TEXT") return compileText(n, opts, parent);
  if (SHAPELIKE.has(n.type)) return compileShape(n, opts, parent);
  if (VECTORLIKE.has(n.type)) return compileVector(n, opts, parent);
  if (n.type === "INSTANCE") return compileInstance(n, opts, parent, rawSubtree);
  if (n.type === "GROUP") return compileContainer(n, opts, parent, rawSubtree);
  if (FRAMELIKE.has(n.type)) return compileContainer(n, opts, parent, rawSubtree);
  return compileUnknown(n, opts, parent);
}

async function exportSvgForRawNode(n: RawNode, opts: CompileOptions): Promise<string> {
  if (!opts.exportSvg) throw new Error("pixpec compile: exportSvg callback is not configured");
  const bareId = stripPrefix(n.id);
  try {
    return await opts.exportSvg(bareId);
  } catch (error) {
    if (bareId !== n.id) {
      try {
        return await opts.exportSvg(n.id);
      } catch (fullError) {
        throw new Error(
          `pixpec compile: SVG export failed for ${n.name} (${n.id}; bare ${bareId}): ` +
            `${fullError instanceof Error ? fullError.message : String(fullError)}`,
          { cause: fullError },
        );
      }
    }
    throw new Error(
      `pixpec compile: SVG export failed for ${n.name} (${n.id}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Compile a raw dump tree into a Design AST tree. */
export async function compile(
  raw: RawNode,
  opts: CompileOptions,
): Promise<DNode> {
  return compileNode(raw, opts, undefined);
}

// ---- helpers ---------------------------------------------------------------

function extractPropsRecord(
  cp?: RawNode["componentProperties"],
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (!cp) return out;
  for (const [k, v] of Object.entries(cp)) {
    if (typeof v.value === "boolean" || typeof v.value === "string")
      out[k] = v.value;
  }
  return out;
}

function collectTextOverrides(n: RawNode): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (node: RawNode, ownerId: string) => {
    if (node.type === "INSTANCE" && node.id !== ownerId) return;
    if (node.type === "TEXT" && typeof node.characters === "string")
      out[node.name] = node.characters;
    if (node.children) for (const c of node.children) visit(c, ownerId);
  };
  if (n.children) for (const c of n.children) visit(c, n.id);
  return out;
}

function collectNestedInstanceProps(
  n: RawNode,
): Record<string, Record<string, string | boolean>> {
  const out: Record<string, Record<string, string | boolean>> = {};
  const visit = (node: RawNode, ownerId: string) => {
    if (node.type === "INSTANCE" && node.id !== ownerId) {
      out[node.name] = extractPropsRecord(node.componentProperties);
      return;
    }
    if (node.children) for (const c of node.children) visit(c, ownerId);
  };
  if (n.children) for (const c of n.children) visit(c, n.id);
  return out;
}
