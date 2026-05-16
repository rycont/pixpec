/**
 * Raw figma dump → Design AST compiler.
 *
 * Walks a `RawNode` tree DFS and classifies each node into a `DNode` of the
 * appropriate kind. Stateless apart from the per-call `CompileOptions`
 * registry (used to resolve `INSTANCE` nodes against registered components).
 * No figma calls — purely a transform
 * over the raw dump produced by `pixpec/src/dumper`.
 *
 * Detach decision (step 8) lives in `detach.ts`; this module imports it and
 * applies the verdict per INSTANCE.
 *
 * Token resolution: every numeric/color property that figma binds to a
 * variable becomes the token path string when the bound variable's intrinsic
 * value matches the node's effective value. Anything else becomes a flat
 * literal, for example `{ kind: "literal", value: 12, unit: "px" }`.
 */

import type {
  DNode,
  DDataScope,
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
  LengthValue,
  Color,
  ColorLiteral,
  Paint,
  Shadow,
  Value,
  AxisSize,
  TextStyleValue,
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
  RawGradientPaint,
  RawImagePaint,
  RawConstraints,
  RawTextRun,
  RawDropShadowEffect,
} from "../dumper/raw-node.ts";
import type { Registry } from "./registry.ts";
import { resolveRegistryVariant } from "./registry.ts";
import { indexDNodeClasses, materializeDNode, materializeDNodes } from "./nodes/index.ts";
import type { DNodeClass } from "./nodes/index.ts";

export interface CompileOptions {
  /** Component registry (built by registry.ts from each component's index.ts). */
  registry: Registry;
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
  /** Compile only the root INSTANCE as its resolved raw subtree. Intended for
   *  component usage cases: the usage root is the concrete case frame, while
   *  nested instances should still resolve through the registry normally. */
  detachRootInstance?: boolean;
  /** When a dependency cannot be resolved from the registry but the raw dump
   *  contains the instance's resolved children, keep compiling by expanding
   *  that subtree. Intended for remote visual dependencies whose source
   *  library tab is not open. */
  detachUnregisteredInstances?: boolean;
  /** Internal compile context: instance override fields keyed by bare
   * descendant node id. Used to represent SVG paint overrides without
   * treating the SVG's baked-in original fill as a DVector override. */
  overrideFields?: Map<string, Set<string>>;
  /** Figma textStyleId → human-readable design token name. */
  typographyMap?: Record<string, string>;
  remBase?: number;
  paintOpacityMultiplier?: number;
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

function colorLiteral(
  c: { r: number; g: number; b: number },
  opacity = 1,
): Color {
  const value: ColorLiteral = {
    r: Math.round(c.r * 255),
    g: Math.round(c.g * 255),
    b: Math.round(c.b * 255),
  };
  const a = normalizeNumber(opacity);
  if (a < 0.999) value.a = a;
  return literalValue(value);
}

function normalizeNumber(value: number, precision = 3): number {
  const normalized = +value.toFixed(precision);
  return Object.is(normalized, -0) ? 0 : normalized;
}

function firstSolidFill(fills?: RawNode["fills"]): RawSolidPaint | null {
  if (!Array.isArray(fills)) return null;
  for (const f of fills) {
    if (f && f.type === "SOLID" && f.visible !== false)
      return f as RawSolidPaint;
  }
  return null;
}

function firstGradientFill(fills?: RawNode["fills"]): RawGradientPaint | null {
  if (!Array.isArray(fills)) return null;
  for (const f of fills) {
    if (f && f.type === "GRADIENT_LINEAR" && f.visible !== false)
      return f as RawGradientPaint;
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

function px(n: number): LengthValue {
  return { kind: "literal", value: { value: normalizeNumber(n), unit: "px" } };
}

function pxToRem(n: number, remBase: number): string {
  return `${+(n / remBase).toFixed(6)}rem`;
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
): LengthValue | undefined {
  if (actual === undefined) return undefined;
  const tokenPath = lookupTokenPath(varId, opts.tokenMap);
  if (tokenPath) {
    const intrinsic = lookupTokenNumber(varId, opts.tokenValueMap);
    if (typeof intrinsic === "number" && Math.abs(intrinsic - actual) < 1e-3) {
      return tokenPath;
    }
  }
  return px(actual);
}

/** Pick a `Color` value: token path when bound (color tokens don't get
 *  scaled the way numerics do, so binding implies the resolved color
 *  matches the token's intrinsic). Otherwise the raw structured color. */
function pickColor(
  paint: RawSolidPaint | null | undefined,
  varId: string | undefined,
  opts: CompileOptions,
): Color | undefined {
  if (!paint) return undefined;
  const opacity = (paint.opacity ?? 1) * (opts.paintOpacityMultiplier ?? 1);
  const tokenPath = lookupTokenPath(varId, opts.tokenMap);
  if (tokenPath) {
    const intrinsic = lookupTokenColor(varId, opts.tokenColorMap);
    const actual = rgbaHex(paint.color, opacity);
    if (intrinsic && colorsEquivalent(intrinsic, actual)) return tokenPath;
  }
  return colorLiteral(paint.color, opacity);
}

function gradientPaintToPaint(paint: RawGradientPaint | null | undefined): Paint | undefined {
  if (!paint?.gradientStops?.length) return undefined;
  const angle = gradientCssAngle(paint);
  return literalValue({
    kind: "linearGradient",
    angle,
    stops: [...paint.gradientStops]
      .sort((a, b) => a.position - b.position)
      .map((stop) => ({
        offset: +stop.position.toFixed(4),
        color: colorLiteral(
          { r: stop.color.r, g: stop.color.g, b: stop.color.b },
          (stop.color.a ?? 1) * (paint.opacity ?? 1),
        ),
      })),
  });
}

function gradientCssAngle(paint: RawGradientPaint): number {
  const transform = paint.gradientTransform;
  if (!transform) return 180;
  const dx = transform[0]?.[0];
  const dy = transform[0]?.[1];
  if (typeof dx !== "number" || typeof dy !== "number") return 180;
  if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) return 180;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return +(((deg % 360) + 360) % 360).toFixed(3);
}

function pickPaint(
  solid: RawSolidPaint | null | undefined,
  gradient: RawGradientPaint | null | undefined,
  varId: string | undefined,
  opts: CompileOptions,
): Paint | undefined {
  return pickColor(solid, varId, opts) ?? gradientPaintToPaint(gradient);
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
    color: colorLiteral(effect.color, typeof effect.color.a === "number" ? effect.color.a : 1),
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
  if (n.componentPropertyReferences?.visible && !opts.detachRootInstance) {
    out.visible = propValue(publicComponentPropName(n.componentPropertyReferences.visible));
  } else if (n.visible === false) {
    out.visible = literalValue(false);
  }
  if (typeof n.opacity === "number" && n.opacity < 1) out.opacity = n.opacity;
  if (typeof n.rotation === "number" && Math.abs(n.rotation) >= 0.01)
    out.rotation = n.rotation;
  if (parent && n.layoutPositioning === "ABSOLUTE") {
    out.absolute = { inset: { left: px(n.x ?? 0), top: px(n.y ?? 0) } };
    if (
      parent &&
      typeof parent.width === "number" &&
      typeof n.width === "number"
    ) {
      out.absolute.inset!.right = px(parent.width - (n.x ?? 0) - n.width);
    }
    if (
      parent &&
      typeof parent.height === "number" &&
      typeof n.height === "number"
    ) {
      out.absolute.inset!.bottom = px(parent.height - (n.y ?? 0) - n.height);
    }
    if (n.constraints) {
      const h = anchorFromConstraint(n.constraints.horizontal);
      const v = anchorFromConstraint(n.constraints.vertical);
      if (h || v) out.absolute.anchor = { horizontal: h, vertical: v };
    }
  }
  out.renderBoundsOffset = renderBoundsOffsetFromRaw(n);
  return out;
}

function literalValue<T>(value: T): Value<T> {
  return { kind: "literal", value };
}

function propValue(name: string): Value<never> {
  return { kind: "expression", type: "prop", name };
}

function publicComponentPropName(rawKey: string): string {
  return String(rawKey).replace(/#[^#]*$/, "").replace(/\s+/g, "");
}

function axisSize(n: RawNode, axis: "horizontal" | "vertical", opts: CompileOptions): AxisSize | undefined {
  const rawSizing = axis === "horizontal" ? n.layoutSizingHorizontal : n.layoutSizingVertical;
  const sizing = sizingFromRaw(rawSizing);
  if (sizing === Sizing.Fill) return Sizing.Fill;
  if (sizing === Sizing.Hug) return Sizing.Hug;
  const value = axis === "horizontal" ? nodeWidth(n) : nodeHeight(n);
  const variable = axis === "horizontal" ? nodeWidthVar(n) : nodeHeightVar(n);
  return pickSize(value, variable, opts);
}

function fixedSize(n: RawNode, axis: "horizontal" | "vertical", opts: CompileOptions): LengthValue | undefined {
  const value = axis === "horizontal" ? nodeWidth(n) : nodeHeight(n);
  const variable = axis === "horizontal" ? nodeWidthVar(n) : nodeHeightVar(n);
  return pickSize(value, variable, opts);
}

function nonZeroSize(size: LengthValue | undefined): LengthValue | undefined {
  if (!size) return undefined;
  if (typeof size !== "string" && size.kind === "literal" && Math.abs(size.value.value) < 0.001) return undefined;
  return size;
}

function textStyleName(id: string | undefined, opts: CompileOptions): string | undefined {
  if (!id) return undefined;
  const map = opts.typographyMap;
  if (!map) return undefined;
  const exact = map[id];
  if (exact) return exact;
  return Object.entries(map).find(([key]) => key.startsWith(id))?.[1];
}

function directPaintBinding(n: RawNode, opts: CompileOptions): string | undefined {
  return undefined;
}

function hasVisiblePaint(n: RawNode): boolean {
  if (n.isMask || isInvisibleShape(n)) return false;
  return Array.isArray(n.fills) && n.fills.some((f) => f && f.visible !== false);
}

function foldedPaintBinding(n: RawNode, opts: CompileOptions): string | undefined {
  const direct = directPaintBinding(n, opts);
  if (direct) return direct;
  const props = new Set<string>();
  let painted = 0;
  const visit = (node: RawNode) => {
    if (node.visible === false) return;
    if ((SHAPELIKE.has(node.type) || VECTORLIKE.has(node.type)) && hasVisiblePaint(node)) {
      painted += 1;
      const prop = directPaintBinding(node, opts);
      if (prop) props.add(prop);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(n);
  if (painted === 0 || props.size !== 1) return undefined;
  const [prop] = props;
  let boundPainted = 0;
  const countBound = (node: RawNode) => {
    if (node.visible === false) return;
    if ((SHAPELIKE.has(node.type) || VECTORLIKE.has(node.type)) && hasVisiblePaint(node)) {
      if (directPaintBinding(node, opts) === prop) boundPainted += 1;
    }
    for (const child of node.children ?? []) countBound(child);
  };
  countBound(n);
  return boundPainted === painted ? prop : undefined;
}

function exactComponentProps(n: RawNode): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [key, prop] of Object.entries(n.componentProperties ?? {})) {
    if (typeof prop.value === "string" || typeof prop.value === "boolean") {
      out[key] = prop.value;
    }
  }
  return out;
}

function indexDNodes(nodes: DNode[]): Map<string, DNodeClass> {
  return indexDNodeClasses(materializeDNodes(nodes));
}

function exposedProps(
  raw: RawNode,
  compiledChildren: DNode[],
): Record<string, unknown> {
  const byId = indexDNodes(compiledChildren);
  const out: Record<string, unknown> = {};
  for (const exposed of raw.exposedInstances ?? []) {
    const node = byId.get(exposed.id);
    const props = node?.instanceProps();
    if (props) out[exposed.id] = props;
  }
  return out;
}

function fieldConsumer(compiledChildren: DNode[], remBase = 16) {
  const byId = indexDNodes(compiledChildren);
  const byBareId = indexDNodesByBareId(compiledChildren);
  const consumed = new Set<string>();
  return {
    consumed,
    consume(nodeId: string, field: string): unknown {
      consumed.add(`${nodeId}\0${field}`);
      const node = byId.get(nodeId) ?? byBareId.get(stripPrefix(nodeId));
      if (!node) return undefined;
      return normalizeConsumedField(node.readField(field));
    },
  };
}

function normalizeConsumedField(value: unknown): unknown {
  return normalizePropValue(value);
}

function normalizePropValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizePropValue);
  const record = value as Record<string, unknown>;
  if (record.kind === "expression") return undefined;
  return value;
}

function hasUnconsumedDNodeDiff(
  master: DNode | undefined,
  usageChildren: DNode[],
  consumedFields: Set<string>,
): boolean {
  if (!master) return usageChildren.length > 0;
  const masterNodes = indexDNodes(containerChildren(master));
  const usageNodes = indexDNodes(usageChildren);
  const usageNodesByBareId = indexDNodesByBareId(usageChildren);
  for (const [nodeId, masterNode] of masterNodes) {
    const usageNode = usageNodes.get(nodeId) ?? usageNodesByBareId.get(stripPrefix(nodeId));
    if (!usageNode || usageNode.kind !== masterNode.kind) return true;
    for (const diff of masterNode.visualDiff(usageNode)) {
      if (consumedFields.has(`${nodeId}\0${diff.field}`)) continue;
      return true;
    }
  }
  return false;
}

function indexDNodesByBareId(nodes: DNode[]): Map<string, DNodeClass> {
  const out = new Map<string, DNodeClass>();
  for (const [id, node] of indexDNodes(nodes)) out.set(stripPrefix(id), node);
  return out;
}

function containerChildren(node: DNode): DNode[] {
  if (node.kind === NodeKind.DataScope) return containerChildren((node as DDataScope).child);
  return materializeDNode(node).children().map((child) => child.toJSON());
}

function withInstanceOverrideFields(opts: CompileOptions, n: RawNode): CompileOptions {
  if (!n.overrides?.length) return opts;
  const overrideFields = new Map<string, Set<string>>();
  for (const [nodeId, fields] of opts.overrideFields ?? []) {
    overrideFields.set(nodeId, new Set(fields));
  }
  for (const override of n.overrides) {
    const nodeId = stripPrefix(override.id);
    const fields = overrideFields.get(nodeId) ?? new Set<string>();
    for (const field of override.overriddenFields ?? []) fields.add(field);
    if (fields.size > 0) overrideFields.set(nodeId, fields);
  }
  return { ...opts, overrideFields };
}

function renderBoundsOffsetFromRaw(n: RawNode): { x: LengthValue; y: LengthValue } | undefined {
  const bb = n.absoluteBoundingBox;
  const rb = n.absoluteRenderBounds;
  if (!bb || !rb) return undefined;
  const x = rb.x - bb.x;
  const y = rb.y - bb.y;
  if (Math.abs(x) < 0.001 && Math.abs(y) < 0.001) return undefined;
  return { x: px(x), y: px(y) };
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
  const color = pickColor(fill, colorVarId, opts) ?? literalValue({ r: 0, g: 0, b: 0 });
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
  const baseStyle: TextStyleValue | undefined = n.componentPropertyReferences?.textStyleId && !opts.detachRootInstance
    ? propValue(publicComponentPropName(n.componentPropertyReferences.textStyleId))
    : textStyleName(n.textStyleId, opts);
  const textStyle: TextStyleValue = baseStyle ?? literalValue({
    fontFamily: n.fontName?.family,
    fontWeight: n.fontWeight,
    fontSize,
    lineHeight,
    paragraphSpacing,
  });
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
    content: !opts.detachInstances && !opts.detachRootInstance && n.componentPropertyReferences?.characters
      ? propValue(publicComponentPropName(n.componentPropertyReferences.characters))
      : literalValue(sanitizeTextContent(n.characters ?? "")),
    textStyle,
    color,
    textDecoration: decoration,
    textAlign: align,
    width: axisSize(n, "horizontal", opts) ?? px(n.width ?? 0),
    autoResize,
    runs,
  };
  const bareId = stripPrefix(n.id);
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
      width: fixedSize(n, "horizontal", opts) ?? px(0),
      height: fixedSize(n, "vertical", opts) ?? px(0),
      dataUrl: imageFill.dataUrl,
      renderedDataUrl: n.renderedDataUrl,
      imageScaleMode: imageFill.scaleMode,
      imageTransform: imageFill.imageTransform,
    };
  }
  const fill = firstSolidFill(n.fills);
  const gradientFill = firstGradientFill(n.fills);
  const stroke = firstSolidFill(n.strokes);
  const gradientStroke = firstGradientFill(n.strokes);
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
    width: fixedSize(n, "horizontal", opts) ?? px(0),
    height: fixedSize(n, "vertical", opts) ?? px(0),
    fill: pickPaint(fill, gradientFill, fillVarId, opts),
    stroke: stroke || gradientStroke
      ? {
          paint: pickPaint(stroke, gradientStroke, strokeVarId, opts) ?? {
            kind: "literal",
            value: { r: 0, g: 0, b: 0 },
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
): LengthValue | CornerRadii | undefined {
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

function overriddenField(n: RawNode, opts: CompileOptions, field: string): boolean {
  return opts.overrideFields?.get(stripPrefix(n.id))?.has(field) ?? false;
}

function solidFillOverride(n: RawNode, opts: CompileOptions): Color {
  const visible = (n.fills ?? []).filter((paint) => paint.visible !== false);
  if (visible.length === 0) {
    return literalValue({ r: 0, g: 0, b: 0, a: 0 });
  }
  if (visible.length !== 1 || visible[0]?.type !== "SOLID") {
    throw new Error(
      `pixpec compile: SVG paint override for ${n.id} (${n.name}) is not a single solid fill`,
    );
  }
  const fill = visible[0] as RawSolidPaint;
  const fillVarId = varId(fill.boundVariables, "color");
  const value = pickColor(fill, fillVarId, opts);
  if (!value) {
    throw new Error(
      `pixpec compile: SVG paint override for ${n.id} (${n.name}) could not be resolved`,
    );
  }
  return value;
}

async function compileVector(
  n: RawNode,
  opts: CompileOptions,
  parent?: RawNode,
): Promise<DVector | DImage> {
  const w = pickSize(n.width, undefined, opts) ?? px(0);
  const h = pickSize(n.height, undefined, opts) ?? px(0);
  const fillProp = directPaintBinding(n, opts);
  const fillOverride = overriddenField(n, opts, "fills")
    ? solidFillOverride(n, opts)
    : undefined;
  let svg = n.svg;
  if (!svg && opts.exportSvg) {
    svg = await exportSvgForRawNode(n, opts);
  }
  if (svg) {
    return {
      ...buildBase(n, opts, parent),
      kind: NodeKind.Vector,
      width: w,
      height: h,
      fill: fillProp
        ? { kind: "expression", type: "prop", name: fillProp }
        : fillOverride
          ? fillOverride
          : undefined,
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
  const gradientFill = firstGradientFill(n.fills);
  const stroke = firstSolidFill(n.strokes);
  const gradientStroke = firstGradientFill(n.strokes);
  const childRaws = (n.children ?? []).filter(
    (c) => c.visible !== false && (c.isMask || !isInvisibleShape(c)),
  );
  const children = await compileChildren(childRaws, opts, n, rawSubtree, direction === "none");
  const bgVarId =
    varId(fill?.boundVariables, "color") ?? varId(n.boundVariables, "fills");
  const strokeVarId = varId(stroke?.boundVariables, "color");
  const strokeWidth = pickSize(
    typeof n.strokeWeight === "number" ? n.strokeWeight : undefined,
    varId(n.boundVariables, "strokeWeight"),
    opts,
  );
  const background = pickPaint(fill, gradientFill, bgVarId, opts);
  const common = {
    ...buildBase(n, opts, parent),
    width: axisSize(n, "horizontal", opts),
    height: axisSize(n, "vertical", opts),
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
    background,
    border: stroke || gradientStroke
      ? {
          paint: pickPaint(stroke, gradientStroke, strokeVarId, opts) ?? {
            kind: "literal",
            value: { r: 0, g: 0, b: 0 },
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
    cornerSmoothing: typeof n.cornerSmoothing === "number" ? normalizeNumber(n.cornerSmoothing) : undefined,
    clip: n.clipsContent ? true : undefined,
    children,
  };
  if (direction === "row") {
    return {
      ...common,
      kind: NodeKind.Flex,
      direction: FlowDirection.Row,
      gap: nonZeroSize(pickSize(n.itemSpacing, varId(n.boundVariables, "itemSpacing"), opts)),
      counterGap: n.layoutWrap === "WRAP"
        ? nonZeroSize(pickSize(n.counterAxisSpacing, varId(n.boundVariables, "counterAxisSpacing"), opts))
        : undefined,
      align: alignFromRaw(n.counterAxisAlignItems),
      justify: justifyFromRaw(n.primaryAxisAlignItems),
      wrap: n.layoutWrap === "WRAP" ? true : undefined,
    };
  }
  if (direction === "column") {
    return {
      ...common,
      kind: NodeKind.Stack,
      direction: FlowDirection.Column,
      gap: nonZeroSize(pickSize(n.itemSpacing, varId(n.boundVariables, "itemSpacing"), opts)),
      counterGap: n.layoutWrap === "WRAP"
        ? nonZeroSize(pickSize(n.counterAxisSpacing, varId(n.boundVariables, "counterAxisSpacing"), opts))
        : undefined,
      align: alignFromRaw(n.counterAxisAlignItems),
      justify: justifyFromRaw(n.primaryAxisAlignItems),
      wrap: n.layoutWrap === "WRAP" ? true : undefined,
    };
  }
  return { ...common, kind: NodeKind.Box };
}

function maskOpacity(n: RawNode): number {
  const fill = firstSolidFill(n.fills);
  return (n.opacity ?? 1) * (fill?.opacity ?? 1);
}

async function compileChildren(
  childRaws: RawNode[],
  opts: CompileOptions,
  parent: RawNode,
  rawSubtree: boolean,
  applyAbsolutePosition: boolean,
): Promise<DNode[]> {
  const children: DNode[] = [];
  let maskOpacityMultiplier = opts.paintOpacityMultiplier ?? 1;
  for (const childRaw of childRaws) {
    if (childRaw.isMask) {
      maskOpacityMultiplier *= maskOpacity(childRaw);
      continue;
    }
    const childOpts =
      maskOpacityMultiplier === (opts.paintOpacityMultiplier ?? 1)
        ? opts
        : { ...opts, paintOpacityMultiplier: maskOpacityMultiplier };
    const child = await compileNode(childRaw, childOpts, parent, rawSubtree);
    if (applyAbsolutePosition) applyAbsoluteChildPosition(child, childRaw, parent);
    children.push(child);
  }
  return children;
}

function applyAbsoluteChildPosition(
  out: DNode,
  n: RawNode,
  parent: RawNode,
): void {
  if (out.absolute) return;
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
  out.absolute = { inset: { left: px(left), top: px(top) } };
  if (
    typeof parent.width === "number" &&
    typeof n.width === "number"
  ) {
    out.absolute.inset!.right = px(parent.width - left - n.width);
  }
  if (
    typeof parent.height === "number" &&
    typeof n.height === "number"
  ) {
    out.absolute.inset!.bottom = px(parent.height - top - n.height);
  }
  if (n.constraints) {
    const h = anchorFromConstraint(n.constraints.horizontal);
    const v = anchorFromConstraint(n.constraints.vertical);
    if (h || v) out.absolute.anchor = { horizontal: h, vertical: v };
  }
}

async function compileInstance(
  n: RawNode,
  opts: CompileOptions,
  parent?: RawNode,
  rawSubtree = false,
): Promise<DNode> {
  const childOpts = withInstanceOverrideFields(opts, n);
  if (opts.detachInstances) return compileContainer(n, childOpts, parent, true);

  const setKey = n.mainComponent?.parentKey ?? n.mainComponent?.key;
  const entry = setKey ? opts.registry.get(setKey) : undefined;
  if (!entry) {
    if (opts.detachUnregisteredInstances && (n.children?.length ?? 0) > 0) {
      // Detached subtree has no surrounding component to provide prop values,
      // so inline any componentPropertyReferences (Label/visible/textStyleId)
      // to their concrete raw values instead of dangling `props.X` refs.
      return compileContainer(n, { ...childOpts, detachRootInstance: true }, parent, false);
    }
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
  const compiledChildren = await compileChildren(
    (n.children ?? []).filter((c) => c.visible !== false && (c.isMask || !isInvisibleShape(c))),
    childOpts,
    n,
    false,
    false,
  );
  let props: Record<string, unknown> = {};
  const fields = fieldConsumer(compiledChildren, opts.remBase);
  props =
    variant?.propsFromFigma?.(
      exactComponentProps(n),
      exposedProps(n, compiledChildren),
      fields,
    ) ?? {};
  if (hasUnconsumedDNodeDiff(variant?.ast, compiledChildren, fields.consumed))
    return compileContainer(n, { ...opts, detachRootInstance: true }, parent, false);
  const out: DInstance = {
    ...buildBase(n, opts, parent),
    kind: NodeKind.Instance,
    componentName: entry.componentName,
    props,
    width: axisSize(n, "horizontal", opts),
    height: axisSize(n, "vertical", opts),
  };
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
  return out;
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
    width: fixedSize(n, "horizontal", opts) ?? px(0),
    height: fixedSize(n, "vertical", opts) ?? px(0),
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
        const fillProp = foldedPaintBinding(n, opts);
        return {
          ...buildBase(n, opts, parent),
          kind: NodeKind.Vector,
          width:
            pickSize(n.width, varId(n.boundVariables, "width"), opts) ??
            px(n.width ?? 0),
          height:
            pickSize(n.height, varId(n.boundVariables, "height"), opts) ??
            px(n.height ?? 0),
          fill: fillProp
            ? { kind: "expression", type: "prop", name: fillProp }
            : undefined,
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
  if (opts.detachRootInstance && raw.type === "INSTANCE") {
    return compileContainer(raw, withInstanceOverrideFields(opts, raw), undefined, false);
  }
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
