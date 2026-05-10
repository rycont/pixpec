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
} from './design-ast.ts'
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
  StrokeCap,
  FlowDirection,
} from './design-ast.ts'
import type { RawNode, RawSolidPaint, RawConstraints, RawTextRun } from '../dumper/raw-node.ts'
import type { Registry } from './registry.ts'
import { shouldDetach } from './detach.ts'

export interface CompileOptions {
  /** Component registry (built by registry.ts from each component's index.ts). */
  registry: Registry
  /** Variant bindings spec — per-master-node-id { attr.text/visible,
   *  instanceProps } map. Walker stamps matching descendants with
   *  contentBinding/visibilityBinding so the emitter renders prop-driven
   *  trees. Keyed by stripPrefix(node.id) so nested-instance overrides
   *  match the master node ids in cases.ts. */
  bindings?: import('./registry.ts').NodeBindings
  /** Figma variable id → semantic token path (e.g. "VariableID:..." →
   *  "content.standard.primary"). */
  tokenMap?: Record<string, string>
  /** Figma variable id → intrinsic numeric value (FLOAT vars only). When
   *  a numeric property is bound to a variable but the node's effective
   *  value differs (e.g. a scaled instance whose cornerRadius resolved
   *  to 6.857 while the bound variable's value is 6), the binding is
   *  dropped and the AST carries the raw literal — emitters render the
   *  figma-authoritative pixel result. */
  tokenValueMap?: Record<string, number>
}

const SHAPELIKE = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE'])
const VECTORLIKE = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'GROUP'])
const FRAMELIKE = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET'])

/** Shape-like figma node with neither paint nor stroke renders to nothing —
 *  drop these at compile time so the emitter doesn't produce empty SVG
 *  wrappers. (The figma "underline shown only when active" pattern uses an
 *  invisible LINE on the inactive variant.) */
function isInvisibleShape(c: RawNode): boolean {
  if (!SHAPELIKE.has(c.type)) return false
  const hasFill = Array.isArray(c.fills) && c.fills.some((f) => f && f.visible !== false)
  const hasStroke = Array.isArray(c.strokes) && c.strokes.some((s) => s && s.visible !== false)
  return !hasFill && !hasStroke
}

function stripPrefix(id: string): string {
  return id.includes(';') ? id.substring(id.lastIndexOf(';') + 1) : id
}

function rgbaHex(c: { r: number; g: number; b: number }, opacity = 1): string {
  const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255)
  if (opacity >= 0.999) return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `rgba(${r},${g},${b},${opacity.toFixed(3)})`
}

function firstSolidFill(fills?: RawNode['fills']): RawSolidPaint | null {
  if (!Array.isArray(fills)) return null
  for (const f of fills) {
    if (f && f.type === 'SOLID' && f.visible !== false) return f as RawSolidPaint
  }
  return null
}

function sizingFromRaw(s?: 'FIXED' | 'HUG' | 'FILL'): Sizing {
  return s === 'HUG' ? Sizing.Hug : s === 'FILL' ? Sizing.Fill : Sizing.Fixed
}

function anchorFromConstraint(c?: RawConstraints['horizontal']): Anchor | undefined {
  return c === 'MIN' ? Anchor.Start
    : c === 'CENTER' ? Anchor.Center
    : c === 'MAX' ? Anchor.End
    : c === 'STRETCH' ? Anchor.Stretch
    : c === 'SCALE' ? Anchor.Scale
    : undefined
}

function alignFromRaw(a?: 'MIN' | 'CENTER' | 'MAX'): Align {
  return a === 'CENTER' ? Align.Center : a === 'MAX' ? Align.End : Align.Start
}

function justifyFromRaw(a?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'): Justify {
  return a === 'CENTER' ? Justify.Center
    : a === 'MAX' ? Justify.End
    : a === 'SPACE_BETWEEN' ? Justify.SpaceBetween
    : Justify.Start
}

// ---------------------------------------------------------------------------
// Size / Color picker — token-vs-literal discrimination.
// ---------------------------------------------------------------------------

function px(n: number): Size { return { value: n, unit: 'px' } }

/** Pick a `Size` value: token path when the bound variable's intrinsic
 *  numeric value matches `actual`; otherwise the raw literal. Undefined
 *  when the actual value is missing. */
function pickSize(actual: number | undefined, varId: string | undefined, opts: CompileOptions): Size | undefined {
  if (actual === undefined) return undefined
  if (varId && opts.tokenMap?.[varId]) {
    const intrinsic = opts.tokenValueMap?.[varId]
    if (typeof intrinsic === 'number' && Math.abs(intrinsic - actual) < 1e-3) {
      return { tokenPath: opts.tokenMap[varId] }
    }
  }
  return px(actual)
}

/** Pick a `Color` value: token path when bound (color tokens don't get
 *  scaled the way numerics do, so binding implies the resolved color
 *  matches the token's intrinsic). Otherwise the literal hex/rgba. */
function pickColor(paint: RawSolidPaint | null | undefined, varId: string | undefined, opts: CompileOptions): Color | undefined {
  if (!paint) return undefined
  const tokenPath = varId ? opts.tokenMap?.[varId] : undefined
  if (tokenPath) {
    return paint.opacity !== undefined && paint.opacity < 0.999
      ? { tokenPath, opacity: paint.opacity }
      : { tokenPath }
  }
  return paint.opacity !== undefined && paint.opacity < 0.999
    ? { color: rgbaHex(paint.color, 1), opacity: paint.opacity }
    : { color: rgbaHex(paint.color, paint.opacity ?? 1) }
}

/** Pick a variable id from a figma `boundVariables[property]` slot (figma
 *  often nests as an array of one alias). */
function varId(bv: unknown, key: string): string | undefined {
  const slot = (bv as Record<string, unknown> | undefined)?.[key]
  if (Array.isArray(slot)) {
    const first = slot[0] as { id?: string } | undefined
    return first?.id
  }
  return (slot as { id?: string } | undefined)?.id
}

// ---------------------------------------------------------------------------
// Per-kind compilers.
// ---------------------------------------------------------------------------

function buildBase(n: RawNode, opts: CompileOptions, parent?: RawNode): DNodeBase {
  const out: DNodeBase = { sourceId: n.id, sourceName: n.name }
  if (typeof n.opacity === 'number' && n.opacity < 1) out.opacity = n.opacity
  if (typeof n.rotation === 'number' && Math.abs(n.rotation) >= 0.01) out.rotation = n.rotation
  if (n.layoutPositioning === 'ABSOLUTE') {
    out.positioning = Positioning.Absolute
    out.inset = { left: n.x ?? 0, top: n.y ?? 0 }
    if (parent && typeof parent.width === 'number' && typeof n.width === 'number') {
      out.inset.right = parent.width - (n.x ?? 0) - n.width
    }
    if (parent && typeof parent.height === 'number' && typeof n.height === 'number') {
      out.inset.bottom = parent.height - (n.y ?? 0) - n.height
    }
    if (n.constraints) {
      const h = anchorFromConstraint(n.constraints.horizontal)
      const v = anchorFromConstraint(n.constraints.vertical)
      if (h || v) out.anchor = { horizontal: h, vertical: v }
    }
  }
  if (typeof n.layoutSizingHorizontal === 'string' || typeof n.layoutSizingVertical === 'string') {
    out.sizing = {
      horizontal: sizingFromRaw(n.layoutSizingHorizontal),
      vertical: sizingFromRaw(n.layoutSizingVertical),
    }
  }
  const bareId = stripPrefix(n.id)
  const binding = opts.bindings?.[bareId]
  if (binding?.attr?.visible) out.visibilityBinding = binding.attr.visible
  return out
}

function compileText(n: RawNode, opts: CompileOptions, parent?: RawNode): DText {
  const fill = firstSolidFill(n.fills)
  const bv = n.boundVariables
  // Figma binds text-level fills via boundVariables.fills (may be array)
  // OR per-paint boundVariables.color on the SOLID paint itself.
  const colorVarId = varId(fill?.boundVariables, 'color') ?? varId(bv, 'fills')
  const color = pickColor(fill, colorVarId, opts) ?? { color: '#000000' }
  const fontSize = pickSize(n.fontSize, varId(bv, 'fontSize'), opts) ?? px(16)
  const lhRaw = n.lineHeight && n.lineHeight.unit === 'PIXELS'
    ? (n.lineHeight.value ?? n.fontSize ?? 0)
    : (n.fontSize ?? 0)
  const lineHeight = pickSize(lhRaw, varId(bv, 'lineHeight'), opts) ?? px(lhRaw)
  const paragraphSpacing = pickSize(n.paragraphSpacing, varId(bv, 'paragraphSpacing'), opts)
  const decoration = n.textDecoration === 'UNDERLINE' ? TextDecoration.Underline
    : n.textDecoration === 'STRIKETHROUGH' ? TextDecoration.LineThrough
    : undefined
  const align: TextAlign | undefined = n.textAlignHorizontal === 'CENTER' ? TextAlign.Center
    : n.textAlignHorizontal === 'RIGHT' ? TextAlign.Right
    : n.textAlignHorizontal === 'JUSTIFIED' ? TextAlign.Justify
    : n.textAlignHorizontal === 'LEFT' ? TextAlign.Left
    : undefined
  const autoResize: TextAutoResize =
    n.textAutoResize === 'WIDTH_AND_HEIGHT' ? TextAutoResize.Hug
      : n.textAutoResize === 'HEIGHT' ? TextAutoResize.FixedWidth
      : n.textAutoResize === 'TRUNCATE' ? TextAutoResize.Truncate
      : TextAutoResize.FixedBoth
  const runs: DTextRun[] | undefined = n.styledTextSegments?.map((seg: RawTextRun) => {
    const segFill = firstSolidFill(seg.fills)
    return {
      text: seg.characters,
      color: pickColor(segFill, undefined, opts),
      fontFamily: seg.fontName?.family,
      fontWeight: seg.fontWeight,
      fontSize: seg.fontSize !== undefined ? px(seg.fontSize) : undefined,
      lineHeight: seg.lineHeight && seg.lineHeight.unit === 'PIXELS' && seg.lineHeight.value !== undefined
        ? px(seg.lineHeight.value)
        : undefined,
      textDecoration: seg.textDecoration === 'UNDERLINE' ? TextDecoration.Underline
        : seg.textDecoration === 'STRIKETHROUGH' ? TextDecoration.LineThrough
        : undefined,
    }
  })
  const out: DText = {
    ...buildBase(n, opts, parent),
    kind: NodeKind.Text,
    content: n.characters ?? '',
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
  }
  const bareId = stripPrefix(n.id)
  const binding = opts.bindings?.[bareId]
  if (binding?.attr?.text) out.contentBinding = binding.attr.text
  return out
}

function compileShape(n: RawNode, opts: CompileOptions, parent?: RawNode): DShape {
  const fill = firstSolidFill(n.fills)
  const stroke = firstSolidFill(n.strokes)
  const fillVarId = varId(fill?.boundVariables, 'color')
  const strokeVarId = varId(stroke?.boundVariables, 'color')
  const strokeWidthVarId = varId(n.boundVariables, 'strokeWeight')
  const strokeWidth = pickSize(typeof n.strokeWeight === 'number' ? n.strokeWeight : undefined, strokeWidthVarId, opts)
  const out: DShape = {
    ...buildBase(n, opts, parent),
    kind: NodeKind.Shape,
    shape: n.type === 'LINE' ? ShapeKind.Line
      : n.type === 'RECTANGLE' ? ShapeKind.Rect
      : n.type === 'ELLIPSE' ? ShapeKind.Ellipse
      : n.type === 'POLYGON' ? ShapeKind.Polygon
      : ShapeKind.Star,
    width: pickSize(n.width, varId(n.boundVariables, 'width'), opts) ?? px(0),
    height: pickSize(n.height, varId(n.boundVariables, 'height'), opts) ?? px(0),
    fill: pickColor(fill, fillVarId, opts),
    stroke: stroke ? {
      paint: pickColor(stroke, strokeVarId, opts) ?? { color: '#000000' },
      width: strokeWidth ?? px(typeof n.strokeWeight === 'number' ? n.strokeWeight : 1),
      cap: n.strokeCap === 'ROUND' ? StrokeCap.Round : n.strokeCap === 'SQUARE' ? StrokeCap.Square : undefined,
    } : undefined,
    cornerRadius: cornerFromRaw(n, opts),
  }
  return out
}

function cornerFromRaw(n: RawNode, opts: CompileOptions): Size | CornerRadii | undefined {
  if (typeof n.cornerRadius === 'number') {
    return pickSize(n.cornerRadius || undefined, varId(n.boundVariables, 'cornerRadius') ?? varId(n.boundVariables, 'topLeftRadius'), opts)
  }
  if (n.cornerRadius === 'mixed') {
    return {
      tl: pickSize(n.topLeftRadius ?? 0, varId(n.boundVariables, 'topLeftRadius'), opts) ?? px(0),
      tr: pickSize(n.topRightRadius ?? 0, varId(n.boundVariables, 'topRightRadius'), opts) ?? px(0),
      br: pickSize(n.bottomRightRadius ?? 0, varId(n.boundVariables, 'bottomRightRadius'), opts) ?? px(0),
      bl: pickSize(n.bottomLeftRadius ?? 0, varId(n.boundVariables, 'bottomLeftRadius'), opts) ?? px(0),
    }
  }
  return undefined
}

function paddingFromRaw(n: RawNode, opts: CompileOptions): Padding | undefined {
  const t = n.paddingTop ?? 0, r = n.paddingRight ?? 0, b = n.paddingBottom ?? 0, l = n.paddingLeft ?? 0
  if (!t && !r && !b && !l) return undefined
  return {
    top: pickSize(t, varId(n.boundVariables, 'paddingTop'), opts) ?? px(t),
    right: pickSize(r, varId(n.boundVariables, 'paddingRight'), opts) ?? px(r),
    bottom: pickSize(b, varId(n.boundVariables, 'paddingBottom'), opts) ?? px(b),
    left: pickSize(l, varId(n.boundVariables, 'paddingLeft'), opts) ?? px(l),
  }
}

function compileVector(n: RawNode, opts: CompileOptions, parent?: RawNode): DVector | DImage {
  const w = pickSize(n.width, undefined, opts) ?? px(0)
  const h = pickSize(n.height, undefined, opts) ?? px(0)
  if (n.svg) {
    return { ...buildBase(n, opts, parent), kind: NodeKind.Vector, width: w, height: h, svg: n.svg }
  }
  return { ...buildBase(n, opts, parent), kind: NodeKind.Image, width: w, height: h }
}

function compileContainer(n: RawNode, opts: CompileOptions, parent?: RawNode): DFlex | DStack | DBox {
  const direction = n.layoutMode === 'HORIZONTAL' ? 'row'
    : n.layoutMode === 'VERTICAL' ? 'column'
    : 'none'
  const fill = firstSolidFill(n.fills)
  const stroke = firstSolidFill(n.strokes)
  const childRaws = (n.children ?? []).filter((c) => c.visible !== false && !isInvisibleShape(c))
  const children = childRaws.map((c) => compileNode(c, opts, n))
  const bgVarId = varId(fill?.boundVariables, 'color') ?? varId(n.boundVariables, 'fills')
  const strokeVarId = varId(stroke?.boundVariables, 'color')
  const strokeWidth = pickSize(typeof n.strokeWeight === 'number' ? n.strokeWeight : undefined, varId(n.boundVariables, 'strokeWeight'), opts)
  const common = {
    ...buildBase(n, opts, parent),
    width: pickSize(n.width, varId(n.boundVariables, 'width'), opts),
    height: pickSize(n.height, varId(n.boundVariables, 'height'), opts),
    minWidth: pickSize(n.minWidth, varId(n.boundVariables, 'minWidth'), opts),
    maxWidth: pickSize(n.maxWidth, varId(n.boundVariables, 'maxWidth'), opts),
    minHeight: pickSize(n.minHeight, varId(n.boundVariables, 'minHeight'), opts),
    maxHeight: pickSize(n.maxHeight, varId(n.boundVariables, 'maxHeight'), opts),
    padding: paddingFromRaw(n, opts),
    background: pickColor(fill, bgVarId, opts),
    border: stroke ? {
      paint: pickColor(stroke, strokeVarId, opts) ?? { color: '#000000' },
      width: n.strokeWeight === 'mixed'
        ? {
            top: pickSize(n.strokeTopWeight, undefined, opts) ?? px(0),
            right: pickSize(n.strokeRightWeight, undefined, opts) ?? px(0),
            bottom: pickSize(n.strokeBottomWeight, undefined, opts) ?? px(0),
            left: pickSize(n.strokeLeftWeight, undefined, opts) ?? px(0),
          }
        : (strokeWidth ?? px(typeof n.strokeWeight === 'number' ? n.strokeWeight : 1)),
    } : undefined,
    cornerRadius: cornerFromRaw(n, opts),
    cornerSmoothing: n.cornerSmoothing,
    clip: n.clipsContent,
    children,
  }
  if (direction === 'row') {
    return {
      ...common,
      kind: NodeKind.Flex, direction: FlowDirection.Row,
      gap: pickSize(n.itemSpacing, varId(n.boundVariables, 'itemSpacing'), opts),
      counterGap: pickSize(n.counterAxisSpacing, varId(n.boundVariables, 'counterAxisSpacing'), opts),
      align: alignFromRaw(n.counterAxisAlignItems),
      justify: justifyFromRaw(n.primaryAxisAlignItems),
      wrap: n.layoutWrap === 'WRAP',
    }
  }
  if (direction === 'column') {
    return {
      ...common,
      kind: NodeKind.Stack, direction: FlowDirection.Column,
      gap: pickSize(n.itemSpacing, varId(n.boundVariables, 'itemSpacing'), opts),
      counterGap: pickSize(n.counterAxisSpacing, varId(n.boundVariables, 'counterAxisSpacing'), opts),
      align: alignFromRaw(n.counterAxisAlignItems),
      justify: justifyFromRaw(n.primaryAxisAlignItems),
      wrap: n.layoutWrap === 'WRAP',
    }
  }
  return { ...common, kind: NodeKind.Box }
}

function compileInstance(n: RawNode, opts: CompileOptions, parent?: RawNode): DNode {
  const setKey = n.mainComponent?.parentKey ?? n.mainComponent?.key
  const entry = setKey ? opts.registry.get(setKey) : undefined
  if (!entry) {
    throw new Error(
      `pixpec compile: encountered INSTANCE ${n.id} (${n.name}) of unregistered component ` +
      `(componentSet key ${setKey ?? '<unknown>'}). Run \`pixpec init\` for that component first, ` +
      `or detach the instance in figma.`,
    )
  }
  if (shouldDetach(n, entry)) return compileContainer(n, opts, parent)

  const rawForFigma = {
    id: n.id,
    name: n.name,
    mainComponentName: n.mainComponent?.name ?? '',
    componentSetKey: setKey ?? '',
    props: extractPropsRecord(n.componentProperties),
    exposed: (n.exposedInstances ?? []).map((i) => i.name),
    textOverrides: collectTextOverrides(n),
    nestedProps: collectNestedInstanceProps(n),
  }
  let props: Record<string, unknown> = {}
  try { props = entry.propsFromFigma?.(rawForFigma, undefined) ?? {} } catch { /* best-effort */ }
  const out: DInstance = {
    ...buildBase(n, opts, parent),
    kind: NodeKind.Instance,
    componentName: entry.componentName,
    props,
    defaultProps: entry.defaults,
    width: pickSize(n.width, varId(n.boundVariables, 'width'), opts),
    height: pickSize(n.height, varId(n.boundVariables, 'height'), opts),
  }
  // Surface per-instance-property bindings from the variant spec so the
  // emitter can render `<Icon Type={iconType}/>` etc.
  const bareId = stripPrefix(n.id)
  const ipb = opts.bindings?.[bareId]?.instanceProps
  if (ipb && Object.keys(ipb).length > 0) out.instancePropBindings = { ...ipb }
  const layoutOverrides: NonNullable<DInstance['layoutOverrides']> = {}
  let any = false
  for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const) {
    const v = (n as Record<string, unknown>)[k] as number | undefined
    if (typeof v === 'number') {
      layoutOverrides[k] = pickSize(v, varId(n.boundVariables, k), opts)
      any = true
    }
  }
  if (typeof n.itemSpacing === 'number') {
    layoutOverrides.gap = pickSize(n.itemSpacing, varId(n.boundVariables, 'itemSpacing'), opts)
    any = true
  }
  if (any) out.layoutOverrides = layoutOverrides
  // currentColor extraction — find the first inner VECTOR/BOOLEAN_OPERATION
  // and surface its effective SOLID fill so emitter plugins (e.g. danah's
  // iconCurrentColor) can forward it as a parent CSS color attribute. This
  // mirrors the legacy walker's `walkExtend` logic that ran inside figma.
  const eff = findEffectiveVectorFill(n)
  if (eff) {
    out.effectiveFill = eff.color
    if (eff.tokenId) out.effectiveFillTokenId = eff.tokenId
  }
  return out
}

/** Walk an INSTANCE's descendants and return the first VECTOR-like node's
 *  effective SOLID fill (color + bound-variable id). Empty/all-hidden fills
 *  are reported as transparent so the emitter can forward color suppression
 *  (matches legacy iconCurrentColor walker semantics). */
function findEffectiveVectorFill(n: RawNode): { color: string; tokenId?: string } | undefined {
  if (n.visible === false) return undefined
  if (n.type === 'VECTOR' || n.type === 'BOOLEAN_OPERATION') {
    if (!Array.isArray(n.fills)) return undefined
    const f0 = n.fills[0]
    if (f0 && f0.type === 'SOLID' && (f0 as RawSolidPaint).visible !== false) {
      const sf = f0 as RawSolidPaint
      const tokenId = varId(sf.boundVariables, 'color')
      return { color: rgbaHex(sf.color, sf.opacity ?? 1), tokenId }
    }
    if (n.fills.length === 0 || n.fills.every((f) => f && f.visible === false)) {
      return { color: 'transparent' }
    }
    return undefined
  }
  for (const c of n.children ?? []) {
    const r = findEffectiveVectorFill(c)
    if (r) return r
  }
  return undefined
}

function compileUnknown(n: RawNode, opts: CompileOptions, parent?: RawNode): DUnknown {
  return {
    ...buildBase(n, opts, parent),
    kind: NodeKind.Unknown,
    sourceType: n.type,
    width: pickSize(n.width, undefined, opts) ?? px(0),
    height: pickSize(n.height, undefined, opts) ?? px(0),
  }
}

function compileNode(n: RawNode, opts: CompileOptions, parent?: RawNode): DNode {
  if (n.type === 'TEXT') return compileText(n, opts, parent)
  if (SHAPELIKE.has(n.type)) return compileShape(n, opts, parent)
  if (VECTORLIKE.has(n.type)) return compileVector(n, opts, parent)
  if (n.type === 'INSTANCE') return compileInstance(n, opts, parent)
  if (FRAMELIKE.has(n.type)) return compileContainer(n, opts, parent)
  return compileUnknown(n, opts, parent)
}

/** Compile a raw dump tree into a Design AST tree. */
export function compile(raw: RawNode, opts: CompileOptions): DNode {
  return compileNode(raw, opts, undefined)
}

// ---- helpers ---------------------------------------------------------------

function extractPropsRecord(cp?: RawNode['componentProperties']): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  if (!cp) return out
  for (const [k, v] of Object.entries(cp)) {
    if (typeof v.value === 'boolean' || typeof v.value === 'string') out[k] = v.value
  }
  return out
}

function collectTextOverrides(n: RawNode): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (node: RawNode, ownerId: string) => {
    if (node.type === 'INSTANCE' && node.id !== ownerId) return
    if (node.type === 'TEXT' && typeof node.characters === 'string') out[node.name] = node.characters
    if (node.children) for (const c of node.children) visit(c, ownerId)
  }
  if (n.children) for (const c of n.children) visit(c, n.id)
  return out
}

function collectNestedInstanceProps(n: RawNode): Record<string, Record<string, string | boolean>> {
  const out: Record<string, Record<string, string | boolean>> = {}
  const visit = (node: RawNode, ownerId: string) => {
    if (node.type === 'INSTANCE' && node.id !== ownerId) {
      out[node.name] = extractPropsRecord(node.componentProperties)
      return
    }
    if (node.children) for (const c of node.children) visit(c, ownerId)
  }
  if (n.children) for (const c of n.children) visit(c, n.id)
  return out
}
