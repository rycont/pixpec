/**
 * React + PandaCSS emitter — Design AST → self-contained .tsx source.
 *
 * Mirrors the legacy `src/generator/codegen.ts` output shape (Flex/Stack/Box
 * panda patterns, typography wrappers, styled.svg shapes, conditional
 * visibilityBinding render, FC + Generated/impl exports) but consumes the
 * platform-neutral Design AST (`src/compiler/design-ast.ts`) instead of the
 * legacy IR. The new pipeline is: figma dump → `compile()` → `reactPandaEmitter.emit()`.
 *
 * Token resolution: Size/Color values arrive pre-decided as either
 * `{ tokenPath }` (use the panda token) or `{ value, unit: 'px' } / { color }`
 * (raw literal). No figma var-id lookup happens here — that work was done
 * upstream by the compiler.
 */

import * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import { isJsxSelfClosingElement } from '@typescript/native-preview/ast/is'
import { API } from '@typescript/native-preview/sync'
import { existsSync } from 'node:fs'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CodegenPlugin } from '../../types.ts'
import type {
  DNode,
  DFlex,
  DStack,
  DBox,
  DText,
  DShape,
  DVector,
  DImage,
  DInstance,
  DUnknown,
  Size,
  Color,
  CornerRadii,
} from '../../compiler/design-ast.ts'
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
} from '../../compiler/design-ast.ts'
import type { Emitter, EmitContext, EmitResult, EmitterComponentMeta } from '../types.ts'

// ---------------------------------------------------------------------------
// AST factory helpers — same wrappers as the legacy codegen.
// ---------------------------------------------------------------------------

const noTokenFlags = 0 as ast.TokenFlags
const nodeFlagsConst = 2 as ast.NodeFlags
const noType = undefined as unknown as ast.TypeNode
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const stringLiteral = (s: string): ast.StringLiteral => f.createStringLiteral(s, noTokenFlags)
const numericLiteral = (v: number): ast.NumericLiteral => f.createNumericLiteral(String(v), noTokenFlags)
const keywordExpression = <T extends ast.KeywordExpressionSyntaxKind>(k: T): ast.KeywordExpression<T> =>
  f.createKeywordExpression(k)
const exportModifier = (): ast.ModifierLike =>
  f.createToken(ast.SyntaxKind.ExportKeyword) as ast.ModifierLike
const propertyAssignment = (name: ast.PropertyName, init: ast.Expression): ast.PropertyAssignment =>
  f.createPropertyAssignment(undefined, name, undefined, noType, init)
const callExpression = (e: ast.Expression, args: readonly ast.Expression[]): ast.CallExpression =>
  f.createCallExpression(e, undefined, undefined, args, 0 as ast.NodeFlags)

function valueToExpr(v: unknown): ast.Expression {
  if (v === null) return keywordExpression(ast.SyntaxKind.NullKeyword)
  if (v === undefined) return f.createIdentifier('undefined')
  if (typeof v === 'boolean') return keywordExpression(v ? ast.SyntaxKind.TrueKeyword : ast.SyntaxKind.FalseKeyword)
  if (typeof v === 'number') return numericLiteral(v)
  if (typeof v === 'string') return stringLiteral(v)
  if (Array.isArray(v)) return f.createArrayLiteralExpression(v.map(valueToExpr))
  if (typeof v === 'object') {
    const props = Object.entries(v as Record<string, unknown>).map(([k, val]) => {
      const name = IDENT_RE.test(k) ? f.createIdentifier(k) : stringLiteral(k)
      return propertyAssignment(name, valueToExpr(val))
    })
    return f.createObjectLiteralExpression(props, false)
  }
  return stringLiteral(String(v))
}

function attrsFromObject(obj: Record<string, unknown>): ast.JsxAttributeLike[] {
  const inline: ast.JsxAttributeLike[] = []
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (IDENT_RE.test(k)) {
      const initializer: ast.JsxAttributeValue = typeof v === 'string'
        ? stringLiteral(v)
        : f.createJsxExpression(undefined, valueToExpr(v))
      inline.push(f.createJsxAttribute(f.createIdentifier(k), initializer))
    } else {
      rest[k] = v
    }
  }
  if (Object.keys(rest).length) inline.push(f.createJsxSpreadAttribute(valueToExpr(rest)))
  return inline
}

function jsxAttr(name: string, value: unknown): ast.JsxAttribute {
  const initializer: ast.JsxAttributeValue = typeof value === 'string'
    ? stringLiteral(value)
    : f.createJsxExpression(undefined, valueToExpr(value))
  return f.createJsxAttribute(f.createIdentifier(name), initializer)
}

function styleAttr(style: Record<string, unknown>): ast.JsxAttribute {
  return f.createJsxAttribute(
    f.createIdentifier('style'),
    f.createJsxExpression(undefined, valueToExpr(style)),
  )
}

function appendJsxAttr(jsx: ast.JsxChild, attr: ast.JsxAttribute): ast.JsxChild {
  if (!isJsxSelfClosingElement(jsx)) return jsx
  return f.updateJsxSelfClosingElement(
    jsx, jsx.tagName, jsx.typeArguments,
    f.createJsxAttributes([...jsx.attributes.properties, attr]),
  )
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const ka = Object.keys(a), kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return false
}

// ---------------------------------------------------------------------------
// Size / Color → panda value.
// ---------------------------------------------------------------------------

const px2rem = (v: number, base: number): string => `${+(v / base).toFixed(6)}rem`

function isTokenSize(s: Size | undefined): s is { tokenPath: string } {
  return !!s && 'tokenPath' in s
}
function isLitSize(s: Size | undefined): s is { value: number; unit: 'px' } {
  return !!s && 'value' in s
}

/** Size → panda atomic-prop value. Tokens emit the dot path; literals
 *  emit a rem string (panda passes through literal CSS values). */
function sizeToProp(s: Size | undefined, remBase: number): string | number | undefined {
  if (!s) return undefined
  if (isTokenSize(s)) return s.tokenPath
  // Zero stays as `0` for slimmer atomic class output.
  if (s.value === 0) return 0
  return px2rem(s.value, remBase)
}

/** Numeric value (for non-px props like flex, opacity). */
function sizeToPx(s: Size | undefined): number | undefined {
  if (!s || isTokenSize(s)) return undefined
  return s.value
}

function colorToProp(c: Color | undefined): string | undefined {
  if (!c) return undefined
  if ('tokenPath' in c) return c.tokenPath
  if (c.opacity !== undefined && c.opacity < 0.999) {
    // hex with alpha fallback — emit raw for inline value
    return c.color
  }
  return c.color
}

// ---------------------------------------------------------------------------
// Padding compaction (matches legacy codegen).
// ---------------------------------------------------------------------------

function compactPaddingStyles(styles: Record<string, unknown>): Record<string, unknown> {
  const top = styles.paddingTop
  const right = styles.paddingRight
  const bottom = styles.paddingBottom
  const left = styles.paddingLeft
  const out = { ...styles }
  delete out.paddingTop; delete out.paddingRight
  delete out.paddingBottom; delete out.paddingLeft
  if (top !== undefined && right !== undefined && bottom !== undefined && left !== undefined
      && top === right && top === bottom && top === left) {
    out.p = top
    return out
  }
  if (left !== undefined && right !== undefined && left === right) {
    out.px = left
  } else {
    if (left !== undefined) out.pl = left
    if (right !== undefined) out.pr = right
  }
  if (top !== undefined && bottom !== undefined && top === bottom) {
    out.py = top
  } else {
    if (top !== undefined) out.pt = top
    if (bottom !== undefined) out.pb = bottom
  }
  return out
}

// ---------------------------------------------------------------------------
// Codegen context.
// ---------------------------------------------------------------------------

interface Ctx {
  remBase: number
  componentName: string
  registry: Map<string, EmitterComponentMeta>
  tokenMap: Record<string, string>
  typographyMap: Record<string, string>
  plugins: CodegenPlugin[]
  usedJsxPatterns: Set<string>   // Flex / Stack / Box / styled
  usedTypography: Set<string>
  usedComponents: Set<string>
  usedPropBindings: Set<string>
  usesCss: boolean
}

interface ParentCtx {
  dir: 'row' | 'column' | 'none'
  mainSizing: Sizing
}

const ROOT_PARENT: ParentCtx = { dir: 'none', mainSizing: Sizing.Fixed }

// ---------------------------------------------------------------------------
// Per-node emit functions.
// ---------------------------------------------------------------------------

function propExpression(key: string): ast.JsxExpression {
  return f.createJsxExpression(undefined, f.createIdentifier(key))
}

function emitContainer(n: DFlex | DStack | DBox, ctx: Ctx, parent: ParentCtx): ast.JsxElement {
  const parentDir = parent.dir
  const isRow = n.kind === NodeKind.Flex
  const isCol = n.kind === NodeKind.Stack
  const direction: 'row' | 'column' | 'none' = isRow ? 'row' : isCol ? 'column' : 'none'
  const styles: Record<string, unknown> = {}

  if (direction !== 'none') {
    const flex = n as DFlex | DStack
    // align / justify — always emit align (CSS default `stretch` ≠ figma `start`).
    styles.align = flex.align ?? Align.Start
    const visibleChildren = flex.children.filter((c) => c.positioning !== Positioning.Absolute)
    const justify = flex.justify === Justify.SpaceBetween && visibleChildren.length === 1
      ? Justify.Center
      : (flex.justify ?? Justify.Start)
    if (justify !== Justify.Start) styles.justify = justify
    // gap (skip 0 on row to match legacy compactness; keep on column).
    const gap = sizeToProp(flex.gap, ctx.remBase)
    // Tokens are always considered "nonzero gap"; only explicit `0` literals
    // get elided on row containers.
    const gapIsZeroLiteral = flex.gap !== undefined && !isTokenSize(flex.gap) && (flex.gap as { value: number }).value === 0
    if (flex.justify !== Justify.SpaceBetween && (!gapIsZeroLiteral || direction === 'column')) {
      if (gap !== undefined) styles.gap = gap
    }
    if (flex.wrap) {
      styles.flexWrap = 'wrap'
      styles.alignContent = 'flex-start'
      const cg = sizeToProp(flex.counterGap, ctx.remBase)
      if (cg !== undefined && cg !== gap) {
        if (direction === 'row') styles.rowGap = cg
        else styles.columnGap = cg
      }
    }
  }

  // padding
  if (n.padding) {
    const pt = sizeToProp(n.padding.top, ctx.remBase)
    const pr = sizeToProp(n.padding.right, ctx.remBase)
    const pb = sizeToProp(n.padding.bottom, ctx.remBase)
    const pl = sizeToProp(n.padding.left, ctx.remBase)
    if (pt !== undefined && pt !== 0) styles.paddingTop = pt
    if (pr !== undefined && pr !== 0) styles.paddingRight = pr
    if (pb !== undefined && pb !== 0) styles.paddingBottom = pb
    if (pl !== undefined && pl !== 0) styles.paddingLeft = pl
  }

  // sizing
  const sizingH = n.sizing?.horizontal ?? Sizing.Fixed
  const sizingV = n.sizing?.vertical ?? Sizing.Fixed
  if (sizingH === Sizing.Fill) {
    if (parentDir === 'none') styles.width = '100%'
    else if (parentDir === 'row' && parent.mainSizing !== Sizing.Hug) { styles.flex = 1; styles.minWidth = 0 }
    else if (parentDir === 'column') { styles.alignSelf = 'stretch'; styles.minWidth = 0 }
  } else if (sizingH === Sizing.Fixed && n.width) {
    const w = sizeToProp(n.width, ctx.remBase)
    if (w !== undefined) styles.width = w
    if (parentDir !== 'none') styles.minWidth = 0
  }
  if (sizingV === Sizing.Fill) {
    if (parentDir === 'none') styles.height = '100%'
    else if (parentDir === 'column' && parent.mainSizing !== Sizing.Hug) { styles.flex = 1; styles.minHeight = 0 }
    else if (parentDir === 'row') { styles.alignSelf = 'stretch'; styles.minHeight = 0 }
  } else if (sizingV === Sizing.Fixed && n.height) {
    const h = sizeToProp(n.height, ctx.remBase)
    if (h !== undefined) styles.height = h
    if (parentDir !== 'none') styles.minHeight = 0
  }
  // FIXED main-axis child of FILL/FIXED parent: don't flex-shrink.
  if (parent.mainSizing !== Sizing.Hug) {
    if (parentDir === 'row' && sizingH === Sizing.Fixed) styles.flexShrink = 0
    if (parentDir === 'column' && sizingV === Sizing.Fixed) styles.flexShrink = 0
  }

  // min/max
  if (n.minWidth) styles.minWidth = sizeToProp(n.minWidth, ctx.remBase)
  if (n.maxWidth) styles.maxWidth = sizeToProp(n.maxWidth, ctx.remBase)
  if (n.minHeight) styles.minHeight = sizeToProp(n.minHeight, ctx.remBase)
  if (n.maxHeight) styles.maxHeight = sizeToProp(n.maxHeight, ctx.remBase)

  // background
  if (n.background) {
    const bg = colorToProp(n.background)
    if (bg !== undefined) styles.background = bg
  }
  if (n.opacity !== undefined) styles.opacity = n.opacity

  // border (uniform-only path; per-side via boxShadow inset)
  if (n.border) {
    const w = n.border.width
    const colorStr = colorToProp(n.border.paint)
    if ('top' in w) {
      // mixed per-side
      const colorRef = colorStr ? `var(--colors-${String(colorStr).replace(/\./g, '-')})` : '#000'
      const shadows: string[] = []
      const wt = sizeToPx(w.top), wb = sizeToPx(w.bottom), wl = sizeToPx(w.left), wr = sizeToPx(w.right)
      if (wt) shadows.push(`inset 0 ${px2rem(wt, ctx.remBase)} 0 0 ${colorRef}`)
      if (wb) shadows.push(`inset 0 -${px2rem(wb, ctx.remBase)} 0 0 ${colorRef}`)
      if (wl) shadows.push(`inset ${px2rem(wl, ctx.remBase)} 0 0 0 ${colorRef}`)
      if (wr) shadows.push(`inset -${px2rem(wr, ctx.remBase)} 0 0 0 ${colorRef}`)
      if (shadows.length) styles.boxShadow = shadows.join(', ')
    } else {
      const wPx = sizeToPx(w)
      if (wPx !== undefined && Number.isInteger(wPx)) {
        styles.insetBorder = `${wPx} ${colorStr}`
      } else if (wPx !== undefined) {
        const colorRef = colorStr ? `var(--colors-${String(colorStr).replace(/\./g, '-')})` : '#000'
        styles.boxShadow = `inset 0 0 0 ${px2rem(wPx, ctx.remBase)} ${colorRef}`
      }
    }
  }

  // corner radius (no squircle handling here — defer to a future iteration)
  if (n.cornerRadius) {
    if ('tl' in n.cornerRadius) {
      const r = n.cornerRadius as CornerRadii
      const tl = sizeToProp(r.tl, ctx.remBase)
      const tr = sizeToProp(r.tr, ctx.remBase)
      const br = sizeToProp(r.br, ctx.remBase)
      const bl = sizeToProp(r.bl, ctx.remBase)
      if (tl) styles.borderTopLeftRadius = tl
      if (tr) styles.borderTopRightRadius = tr
      if (br) styles.borderBottomRightRadius = br
      if (bl) styles.borderBottomLeftRadius = bl
    } else {
      const r = sizeToProp(n.cornerRadius, ctx.remBase)
      if (r !== undefined && r !== 0) styles.borderRadius = r
    }
  }

  if (n.clip) styles.overflow = 'hidden'
  if (n.children?.some((c) => c.positioning === Positioning.Absolute)) styles.position = 'relative'

  // pick panda pattern
  const tag = direction === 'row' ? 'Flex' : direction === 'column' ? 'Stack' : 'Box'
  ctx.usedJsxPatterns.add(tag)
  const compact = compactPaddingStyles(styles)
  const attrs = attrsFromObject(compact)
  const open = f.createJsxOpeningElement(f.createIdentifier(tag), undefined, f.createJsxAttributes(attrs))
  const close = f.createJsxClosingElement(f.createIdentifier(tag))
  const childParent: ParentCtx = {
    dir: direction,
    mainSizing: direction === 'row' ? sizingH : direction === 'column' ? sizingV : Sizing.Fixed,
  }
  const children = n.children.map((c) => emitNode(c, ctx, childParent))
  return f.createJsxElement(open, children, close)
}

function lookupTypoByPrefix(liveId: string, map: Record<string, string>): string | undefined {
  if (map[liveId]) return map[liveId]
  for (const k of Object.keys(map)) {
    if (liveId.startsWith(k) || k.startsWith(liveId)) return map[k]
  }
  return undefined
}

function emitText(n: DText, ctx: Ctx, parent: ParentCtx): ast.JsxElement {
  const wrapperName = n.textStyleRef ? lookupTypoByPrefix(n.textStyleRef, ctx.typographyMap) : undefined
  const isHug = n.autoResize === TextAutoResize.Hug
  const parentDir = parent.dir
  const parentHugMain = parent.mainSizing === Sizing.Hug
  const sizingH = n.sizing?.horizontal ?? Sizing.Fixed
  const fillMain = sizingH === Sizing.Fill && parentDir === 'row' && !parentHugMain
  const fillCross = sizingH === Sizing.Fill && parentDir === 'column'
  const collapsedFill = sizingH === Sizing.Fill && parentDir === 'row' && parentHugMain
  const fixedWidth = !isHug && !fillMain && !fillCross && !collapsedFill ? n.width : undefined

  if (wrapperName) {
    ctx.usedTypography.add(wrapperName)
    const props: Record<string, unknown> = {}
    if (fixedWidth !== undefined) props.width = px2rem(fixedWidth, ctx.remBase)
    if (fillMain) { props.flex = 1; props.minWidth = 0 }
    if (fillCross) props.alignSelf = 'stretch'
    const colorVal = colorToProp(n.color)
    if (colorVal) props.color = colorVal
    if (n.textAlign && n.textAlign !== TextAlign.Left && n.textAlign !== TextAlign.Justify) {
      props.textAlign = n.textAlign
    }
    if (n.textDecoration) props.textDecoration = n.textDecoration
    const attrs = attrsFromObject(props)
    const open = f.createJsxOpeningElement(f.createIdentifier(wrapperName), undefined, f.createJsxAttributes(attrs))
    const close = f.createJsxClosingElement(f.createIdentifier(wrapperName))
    const boundKey = n.contentBinding
    if (boundKey) ctx.usedPropBindings.add(boundKey)
    const children: ast.JsxChild[] = boundKey
      ? [propExpression(boundKey)]
      : [n.content.includes('\n')
          ? f.createJsxExpression(undefined, f.createNoSubstitutionTemplateLiteral(n.content, noTokenFlags))
          : f.createJsxText(n.content)]
    return f.createJsxElement(open, children, close)
  }

  // Fallback: panda styled.span
  ctx.usedJsxPatterns.add('styled')
  const styles: Record<string, unknown> = {
    fontSize: sizeToProp(n.fontSize, ctx.remBase),
    lineHeight: sizeToProp(n.lineHeight, ctx.remBase),
  }
  const colorVal = colorToProp(n.color)
  if (colorVal) styles.color = colorVal
  if (n.fontFamily) styles.fontFamily = `"${n.fontFamily}", system-ui, sans-serif`
  if (typeof n.fontWeight === 'number') styles.fontWeight = n.fontWeight
  if (n.textAlign) styles.textAlign = n.textAlign
  if (n.textDecoration) styles.textDecoration = n.textDecoration
  if (fixedWidth !== undefined) styles.width = px2rem(fixedWidth, ctx.remBase)
  if (fillMain) { styles.flex = 1; styles.minWidth = 0 }
  if (fillCross) styles.alignSelf = 'stretch'
  if (isHug) styles.whiteSpace = 'nowrap'
  const tag = () => f.createPropertyAccessExpression(
    f.createIdentifier('styled'), undefined, f.createIdentifier('span'),
  )
  const open = f.createJsxOpeningElement(tag(), undefined, f.createJsxAttributes(attrsFromObject(styles)))
  const close = f.createJsxClosingElement(tag())
  const boundKey = n.contentBinding
  if (boundKey) ctx.usedPropBindings.add(boundKey)
  const children: ast.JsxChild[] = boundKey
    ? [propExpression(boundKey)]
    : n.content.includes('\n')
      ? [f.createJsxExpression(undefined, f.createNoSubstitutionTemplateLiteral(n.content, noTokenFlags))]
      : [f.createJsxText(n.content)]
  return f.createJsxElement(open, children, close)
}

function emitShape(n: DShape, ctx: Ctx, _parent: ParentCtx): ast.JsxElement {
  const w = sizeToPx(n.width) ?? 0
  const h = sizeToPx(n.height) ?? 0
  // Plain SVG sub-elements (`<line>`, `<rect>`, `<ellipse>`) take SVG color
  // values, not panda token strings. Resolve any `{tokenPath}` to the
  // matching CSS custom-property reference so theme switches still work.
  const svgColor = (c: Color | undefined): string | undefined => {
    if (!c) return undefined
    if ('tokenPath' in c) return `var(--colors-${c.tokenPath.replace(/\./g, '-')})`
    return c.color
  }
  const fillVal = svgColor(n.fill) ?? 'none'
  ctx.usedJsxPatterns.add('styled')
  const innerAttrs: Record<string, unknown> = { fill: fillVal }
  if (n.stroke) {
    innerAttrs.stroke = svgColor(n.stroke.paint) ?? '#000'
    innerAttrs['strokeWidth'] = sizeToPx(n.stroke.width) ?? 1
  }

  let inner: ast.JsxChild
  if (n.shape === ShapeKind.Rect) {
    if (n.cornerRadius && !('tl' in n.cornerRadius)) {
      const r = sizeToPx(n.cornerRadius)
      if (r) { innerAttrs.rx = r; innerAttrs.ry = r }
    }
    inner = f.createJsxSelfClosingElement(
      f.createIdentifier('rect'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('width'), f.createJsxExpression(undefined, valueToExpr(w))),
        f.createJsxAttribute(f.createIdentifier('height'), f.createJsxExpression(undefined, valueToExpr(h))),
        ...Object.entries(innerAttrs).map(([k, v]) =>
          f.createJsxAttribute(f.createIdentifier(k), f.createJsxExpression(undefined, valueToExpr(v))),
        ),
      ]),
    )
  } else if (n.shape === ShapeKind.Ellipse) {
    inner = f.createJsxSelfClosingElement(
      f.createIdentifier('ellipse'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('cx'), f.createJsxExpression(undefined, valueToExpr(w / 2))),
        f.createJsxAttribute(f.createIdentifier('cy'), f.createJsxExpression(undefined, valueToExpr(h / 2))),
        f.createJsxAttribute(f.createIdentifier('rx'), f.createJsxExpression(undefined, valueToExpr(w / 2))),
        f.createJsxAttribute(f.createIdentifier('ry'), f.createJsxExpression(undefined, valueToExpr(h / 2))),
        ...Object.entries(innerAttrs).map(([k, v]) =>
          f.createJsxAttribute(f.createIdentifier(k), f.createJsxExpression(undefined, valueToExpr(v))),
        ),
      ]),
    )
  } else if (n.shape === ShapeKind.Line) {
    const horizontal = h === 0 || h < w
    const sw = sizeToPx(n.stroke?.width) ?? 1
    const cap = n.stroke?.cap ?? StrokeCap.Butt
    const capInset = cap === StrokeCap.Butt ? 0 : sw / 2
    const lx = horizontal ? capInset : sw / 2
    const ly = horizontal ? sw / 2 : capInset
    const lx2 = horizontal ? w - capInset : sw / 2
    const ly2 = horizontal ? sw / 2 : h - capInset
    const lineAttrs: ast.JsxAttribute[] = [
      f.createJsxAttribute(f.createIdentifier('x1'), f.createJsxExpression(undefined, valueToExpr(lx))),
      f.createJsxAttribute(f.createIdentifier('y1'), f.createJsxExpression(undefined, valueToExpr(ly))),
      f.createJsxAttribute(f.createIdentifier('x2'), f.createJsxExpression(undefined, valueToExpr(lx2))),
      f.createJsxAttribute(f.createIdentifier('y2'), f.createJsxExpression(undefined, valueToExpr(ly2))),
      ...Object.entries(innerAttrs).map(([k, v]) =>
        f.createJsxAttribute(f.createIdentifier(k), f.createJsxExpression(undefined, valueToExpr(v))),
      ),
    ]
    if (cap !== StrokeCap.Butt) {
      lineAttrs.push(f.createJsxAttribute(f.createIdentifier('strokeLinecap'), stringLiteral(cap)))
    }
    inner = f.createJsxSelfClosingElement(f.createIdentifier('line'), undefined, f.createJsxAttributes(lineAttrs))
  } else {
    // polygon / star — placeholder rect.
    inner = f.createJsxSelfClosingElement(
      f.createIdentifier('rect'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('width'), f.createJsxExpression(undefined, valueToExpr(w))),
        f.createJsxAttribute(f.createIdentifier('height'), f.createJsxExpression(undefined, valueToExpr(h))),
        ...Object.entries(innerAttrs).map(([k, v]) =>
          f.createJsxAttribute(f.createIdentifier(k), f.createJsxExpression(undefined, valueToExpr(v))),
        ),
      ]),
    )
  }

  // viewport inflate for line shapes
  let viewW = w, viewH = h
  if (n.shape === ShapeKind.Line && n.stroke) {
    const sw = sizeToPx(n.stroke.width) ?? 1
    if (h === 0) viewH = sw
    if (w === 0) viewW = sw
  }
  const hStretch = n.sizing?.horizontal === Sizing.Fill
    || (n.positioning === Positioning.Absolute && n.anchor?.horizontal === Anchor.Stretch)
  const vStretch = n.sizing?.vertical === Sizing.Fill
    || (n.positioning === Positioning.Absolute && n.anchor?.vertical === Anchor.Stretch)
  const svgAttrs: ast.JsxAttribute[] = [
    f.createJsxAttribute(f.createIdentifier('viewBox'), stringLiteral(`0 0 ${viewW} ${viewH}`)),
    f.createJsxAttribute(f.createIdentifier('display'), stringLiteral('block')),
    f.createJsxAttribute(f.createIdentifier('flexShrink'), f.createJsxExpression(undefined, valueToExpr(0))),
    f.createJsxAttribute(f.createIdentifier('width'), stringLiteral(hStretch ? '100%' : px2rem(viewW, ctx.remBase))),
    f.createJsxAttribute(f.createIdentifier('height'), stringLiteral(vStretch ? '100%' : px2rem(viewH, ctx.remBase))),
  ]
  if (n.shape === ShapeKind.Line && (hStretch || vStretch)) {
    svgAttrs.push(f.createJsxAttribute(f.createIdentifier('preserveAspectRatio'), stringLiteral('none')))
  }
  if (n.opacity !== undefined) {
    svgAttrs.push(f.createJsxAttribute(f.createIdentifier('opacity'), f.createJsxExpression(undefined, valueToExpr(n.opacity))))
  }
  const tag = () => f.createPropertyAccessExpression(
    f.createIdentifier('styled'), undefined, f.createIdentifier('svg'),
  )
  const open = f.createJsxOpeningElement(tag(), undefined, f.createJsxAttributes(svgAttrs))
  const close = f.createJsxClosingElement(tag())
  return f.createJsxElement(open, [inner], close)
}

function emitVector(n: DVector, ctx: Ctx): ast.JsxSelfClosingElement {
  const w = sizeToPx(n.width) ?? 0
  const h = sizeToPx(n.height) ?? 0
  if (n.svg.startsWith('data:')) {
    return f.createJsxSelfClosingElement(
      f.createIdentifier('img'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('src'), stringLiteral(n.svg)),
        f.createJsxAttribute(f.createIdentifier('alt'), stringLiteral('')),
        styleAttr({ display: 'block', flexShrink: 0, width: px2rem(w, ctx.remBase), height: px2rem(h, ctx.remBase) }),
      ]),
    )
  }
  // Inline raw SVG markup is not parseable by the TS factory — best-effort
  // fallback: a styled.div with a background-image data URL would require
  // base64 work; for now emit a comment-bearing div placeholder.
  return f.createJsxSelfClosingElement(
    f.createIdentifier('div'), undefined,
    f.createJsxAttributes([
      styleAttr({ width: px2rem(w, ctx.remBase), height: px2rem(h, ctx.remBase) }),
      f.createJsxAttribute(f.createIdentifier('dangerouslySetInnerHTML'),
        f.createJsxExpression(undefined, valueToExpr({ __html: n.svg }))),
    ]),
  )
}

function emitImage(n: DImage, ctx: Ctx): ast.JsxSelfClosingElement {
  const w = sizeToPx(n.width) ?? 0
  const h = sizeToPx(n.height) ?? 0
  const styles: Record<string, unknown> = {
    display: 'block', flexShrink: 0,
    width: px2rem(w, ctx.remBase), height: px2rem(h, ctx.remBase),
  }
  if (n.opacity !== undefined) styles.opacity = n.opacity
  if (!n.dataUrl) {
    return f.createJsxSelfClosingElement(
      f.createIdentifier('div'), undefined,
      f.createJsxAttributes([styleAttr(styles)]),
    )
  }
  return f.createJsxSelfClosingElement(
    f.createIdentifier('img'), undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(f.createIdentifier('src'), stringLiteral(n.dataUrl)),
      f.createJsxAttribute(f.createIdentifier('alt'), stringLiteral('')),
      styleAttr(styles),
    ]),
  )
}

function emitInstance(n: DInstance, ctx: Ctx, parent: ParentCtx): ast.JsxChild {
  ctx.usedComponents.add(n.componentName)
  // Elide props that match defaultProps.
  const props = n.defaultProps
    ? Object.fromEntries(Object.entries(n.props).filter(([k, v]) => !deepEq(v, n.defaultProps![k])))
    : n.props
  // Optional binding overlay — DInstance is open-ended, so plugins or upstream
  // compiler may attach `instancePropBindings: Record<propName, ownerKey>`.
  const bindings = (n as Record<string, unknown>).instancePropBindings as Record<string, string> | undefined
  const attrKeys = new Set<string>([...Object.keys(props), ...(bindings ? Object.keys(bindings) : [])])
  const attrs: ast.JsxAttributeLike[] = []
  for (const k of attrKeys) {
    const boundKey = bindings?.[k]
    if (boundKey) {
      ctx.usedPropBindings.add(boundKey)
      attrs.push(f.createJsxAttribute(f.createIdentifier(k), propExpression(boundKey)))
    } else {
      attrs.push(...attrsFromObject({ [k]: props[k] }))
    }
  }
  // Layout overlay — when this instance is a flex child and parent isn't
  // hugging, FIXED axes need flex-shrink: 0; FILL axes get flex/alignSelf.
  const layoutStyles: Record<string, unknown> = {}
  const sizingH = n.sizing?.horizontal
  const sizingV = n.sizing?.vertical
  if (parent.dir !== 'none' && parent.mainSizing !== Sizing.Hug) {
    if (parent.dir === 'row' && sizingH === Sizing.Fixed) layoutStyles.flexShrink = 0
    if (parent.dir === 'column' && sizingV === Sizing.Fixed) layoutStyles.flexShrink = 0
  }
  if (sizingH === Sizing.Fill && parent.dir === 'row' && parent.mainSizing !== Sizing.Hug) {
    layoutStyles.flex = 1; layoutStyles.minWidth = 0
  } else if (sizingH === Sizing.Fill && parent.dir === 'column') {
    layoutStyles.alignSelf = 'stretch'
  }
  if (sizingV === Sizing.Fill && parent.dir === 'column' && parent.mainSizing !== Sizing.Hug) {
    layoutStyles.flex = 1; layoutStyles.minHeight = 0
  } else if (sizingV === Sizing.Fill && parent.dir === 'row') {
    layoutStyles.alignSelf = 'stretch'
  }
  if (n.layoutOverrides) {
    for (const [k, v] of Object.entries(n.layoutOverrides)) {
      if (v) {
        const val = sizeToProp(v as Size, ctx.remBase)
        if (val !== undefined) layoutStyles[k] = val
      }
    }
  }
  if (n.opacity !== undefined) layoutStyles.opacity = n.opacity
  // Don't emit layout keys that the component itself already specifies via props.
  for (const k of Object.keys(n.props)) delete layoutStyles[k]
  if (Object.keys(layoutStyles).length) attrs.push(...attrsFromObject(layoutStyles))

  return f.createJsxSelfClosingElement(
    f.createIdentifier(n.componentName), undefined, f.createJsxAttributes(attrs),
  )
}

function emitUnknown(n: DUnknown, ctx: Ctx): ast.JsxSelfClosingElement {
  const w = sizeToPx(n.width) ?? 0
  const h = sizeToPx(n.height) ?? 0
  if (w === 0 || h === 0) {
    return f.createJsxSelfClosingElement(
      f.createIdentifier('div'), undefined,
      f.createJsxAttributes([styleAttr({ display: 'none' })]),
    )
  }
  return f.createJsxSelfClosingElement(
    f.createIdentifier('div'), undefined,
    f.createJsxAttributes([styleAttr({
      width: px2rem(w, ctx.remBase),
      height: px2rem(h, ctx.remBase),
      background: '#f00',
    })]),
  )
}

// ---------------------------------------------------------------------------
// Plugin EmitContext shim — bridges the legacy CodegenPlugin API to the new
// emitter. The plugin's own `tokenMap` lookup is forwarded as-is.
// ---------------------------------------------------------------------------

function buildPluginCtx(ctx: Ctx) {
  const wrapWithStyle = (jsx: ast.JsxChild, style: Record<string, unknown>): ast.JsxChild => {
    ctx.usedJsxPatterns.add('styled')
    const tag = () => f.createPropertyAccessExpression(
      f.createIdentifier('styled'), undefined, f.createIdentifier('span'),
    )
    const attrs = attrsFromObject(style)
    return f.createJsxElement(
      f.createJsxOpeningElement(tag(), undefined, f.createJsxAttributes(attrs)),
      [jsx],
      f.createJsxClosingElement(tag()),
    )
  }
  const wrapWithCss = (jsx: ast.JsxChild, style: Record<string, unknown>): ast.JsxChild => {
    ctx.usesCss = true
    const callExpr = callExpression(f.createIdentifier('css'), [valueToExpr(style)])
    const open = f.createJsxOpeningElement(
      f.createIdentifier('span'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('className'),
          f.createJsxExpression(undefined, callExpr)),
      ]),
    )
    return f.createJsxElement(open, [jsx], f.createJsxClosingElement(f.createIdentifier('span')))
  }
  return {
    parentDir: 'none' as 'row' | 'column' | 'none',
    tokenMap: ctx.tokenMap,
    resolveTokenPath: (id: string | undefined) => (id ? ctx.tokenMap[id] : undefined),
    wrapWithStyle, wrapWithCss, jsxAttr, styleAttr, appendJsxAttr,
  }
}

// ---------------------------------------------------------------------------
// Wrap helpers — visibility binding + absolute positioning.
// ---------------------------------------------------------------------------

function wrapAbsolute(n: DNode, jsx: ast.JsxChild, ctx: Ctx): ast.JsxChild {
  if (n.positioning !== Positioning.Absolute) return jsx
  const inset = n.inset ?? {}
  let absX = typeof inset.left === 'number' ? inset.left : 0
  let absY = typeof inset.top === 'number' ? inset.top : 0
  // figma reports a LINE node's bbox y/x as the FAR edge of the stroke on the
  // collapsed axis (not the line center). Our `<svg>` viewport gets inflated
  // by strokeWeight on that axis with the stroke drawn from the svg's top
  // edge — without offsetting the absolute wrapper, the rendered line sits
  // strokeWeight px below figma's mark. Pull back by the full stroke width.
  if (n.kind === NodeKind.Shape && (n as DShape).shape === ShapeKind.Line) {
    const sh = n as DShape
    const sw = sizeToPx(sh.stroke?.width) ?? 1
    const w = sizeToPx(sh.width) ?? 0
    const h = sizeToPx(sh.height) ?? 0
    if (h === 0) absY -= sw
    if (w === 0) absX -= sw
  }
  const wrapStyle: Record<string, unknown> = {
    position: 'absolute',
    left: px2rem(absX, ctx.remBase),
    top: px2rem(absY, ctx.remBase),
  }
  if (n.anchor?.horizontal === Anchor.Stretch && typeof inset.right === 'number') {
    wrapStyle.right = px2rem(inset.right, ctx.remBase)
  }
  if (n.anchor?.vertical === Anchor.Stretch && typeof inset.bottom === 'number') {
    wrapStyle.bottom = px2rem(inset.bottom, ctx.remBase)
  }
  ctx.usedJsxPatterns.add('styled')
  const tag = () => f.createPropertyAccessExpression(
    f.createIdentifier('styled'), undefined, f.createIdentifier('span'),
  )
  return f.createJsxElement(
    f.createJsxOpeningElement(tag(), undefined, f.createJsxAttributes(attrsFromObject(wrapStyle))),
    [jsx],
    f.createJsxClosingElement(tag()),
  )
}

function wrapVisibility(n: DNode, jsx: ast.JsxChild, ctx: Ctx, parent: ParentCtx): ast.JsxChild {
  if (!n.visibilityBinding || parent.dir === 'none') return jsx
  ctx.usedPropBindings.add(n.visibilityBinding)
  const cond = f.createBinaryExpression(
    undefined,
    f.createIdentifier(n.visibilityBinding),
    undefined,
    f.createToken(ast.SyntaxKind.ExclamationEqualsEqualsToken),
    keywordExpression(ast.SyntaxKind.FalseKeyword),
  )
  const conditional = f.createConditionalExpression(
    cond,
    f.createToken(ast.SyntaxKind.QuestionToken),
    f.createParenthesizedExpression(jsx as unknown as ast.Expression),
    f.createToken(ast.SyntaxKind.ColonToken),
    keywordExpression(ast.SyntaxKind.NullKeyword),
  )
  return f.createJsxExpression(undefined, conditional)
}

function emitNode(n: DNode, ctx: Ctx, parent: ParentCtx): ast.JsxChild {
  let jsx: ast.JsxChild
  switch (n.kind) {
    case NodeKind.Flex:
    case NodeKind.Stack:
    case NodeKind.Box:
      jsx = emitContainer(n, ctx, parent); break
    case NodeKind.Text:
      jsx = emitText(n, ctx, parent); break
    case NodeKind.Shape:
      jsx = emitShape(n, ctx, parent); break
    case NodeKind.Vector:
      jsx = emitVector(n, ctx); break
    case NodeKind.Image:
      jsx = emitImage(n, ctx); break
    case NodeKind.Instance:
      jsx = emitInstance(n, ctx, parent); break
    case NodeKind.Unknown:
      jsx = emitUnknown(n, ctx); break
  }
  // Plugin chain — bridge the new AST node to the legacy IRNode contract via a
  // best-effort cast. Plugins inspect `kind === 'component'` and `componentName`,
  // both of which we synthesize for INSTANCE nodes below.
  if (ctx.plugins.length) {
    const pctx = buildPluginCtx(ctx)
    pctx.parentDir = parent.dir
    // Build a shim that satisfies what the icon-current-color plugin reads.
    const shim = n.kind === NodeKind.Instance
      ? { ...(n as Record<string, unknown>), kind: 'component', componentName: n.componentName }
      : n
    for (const p of ctx.plugins) {
      if (p.emitWrap) {
        jsx = p.emitWrap(shim as never, jsx, pctx as never)
      }
    }
  }
  jsx = wrapAbsolute(n, jsx, ctx)
  jsx = wrapVisibility(n, jsx, ctx, parent)
  return jsx
}

// ---------------------------------------------------------------------------
// Top-level emit: produce a self-contained .tsx string.
// ---------------------------------------------------------------------------

interface ReactPandaCtxExt {
  /** Optional pre-booted tsgo printer (so the cli can reuse a single
   *  snapshot across components). When omitted, the emitter boots its own. */
  printNode?: (node: ast.Node) => string
  /** Plugins typed as the legacy `CodegenPlugin` shape. */
  plugins?: CodegenPlugin[]
  /** Component file extension override (default `tsx`). */
  fileExtension?: string
  /** Source figma node id (for the file header comment). */
  sourceId?: string
}

function buildSource(root: DNode, ctx: Ctx, printNode: (n: ast.Node) => string, sourceId: string): string {
  const body = emitNode(root, ctx, ROOT_PARENT) as ast.Expression

  // Imports
  const componentImports = [...ctx.usedComponents].sort().map((name) => {
    const meta = ctx.registry.get(name)
    const importPath = meta ? `../../${name}/impl.tsx` : `../../${name}/impl.tsx`
    return f.createImportDeclaration(undefined,
      f.createImportClause(undefined, undefined,
        f.createNamedImports([
          f.createImportSpecifier(false, f.createIdentifier('impl'), f.createIdentifier(name)),
        ])),
      stringLiteral(importPath),
    )
  })
  const typographyImports = ctx.usedTypography.size > 0
    ? [f.createImportDeclaration(undefined,
        f.createImportClause(undefined, undefined,
          f.createNamedImports([...ctx.usedTypography].sort().map((n) =>
            f.createImportSpecifier(false, undefined, f.createIdentifier(n))))),
        stringLiteral('../../typography/index.tsx'))]
    : []
  const cssImport = ctx.usesCss
    ? [f.createImportDeclaration(undefined,
        f.createImportClause(undefined, undefined,
          f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier('css'))])),
        stringLiteral('../../../../styled-system/css'))]
    : []
  const jsxPatternImport = ctx.usedJsxPatterns.size > 0
    ? [f.createImportDeclaration(undefined,
        f.createImportClause(undefined, undefined,
          f.createNamedImports([...ctx.usedJsxPatterns].sort().map((n) =>
            f.createImportSpecifier(false, undefined, f.createIdentifier(n))))),
        stringLiteral('../../../../styled-system/jsx'))]
    : []
  const fcImport = f.createImportDeclaration(undefined,
    f.createImportClause(ast.SyntaxKind.TypeKeyword, undefined,
      f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier('FC'))])),
    stringLiteral('react'),
  )

  // FC signature
  const boundKeys = [...ctx.usedPropBindings].sort()
  const fcType = boundKeys.length === 0
    ? f.createTypeReferenceNode(f.createIdentifier('FC'), undefined)
    : f.createTypeReferenceNode(f.createIdentifier('FC'), [
        f.createTypeReferenceNode(f.createIdentifier('Record'), [
          f.createKeywordTypeNode(ast.SyntaxKind.StringKeyword),
          f.createKeywordTypeNode(ast.SyntaxKind.UnknownKeyword),
        ]),
      ])
  const fnParams = boundKeys.length === 0
    ? []
    : [f.createParameterDeclaration(undefined, undefined, f.createIdentifier('props'), undefined, undefined, undefined)]

  let generatedBody: ast.ConciseBody
  if (boundKeys.length === 0) {
    generatedBody = f.createParenthesizedExpression(body)
  } else {
    let body2 = body
    if (ast.isJsxElement(body2)) {
      const op = body2.openingElement
      const newOpening = f.createJsxOpeningElement(
        op.tagName, op.typeArguments,
        f.createJsxAttributes([
          ...op.attributes.properties,
          f.createJsxSpreadAttribute(f.createIdentifier('rest')),
        ]),
      )
      body2 = f.createJsxElement(newOpening, body2.children, body2.closingElement) as ast.Expression
    }
    const destructure = f.createVariableStatement(undefined,
      f.createVariableDeclarationList([
        f.createVariableDeclaration(
          f.createObjectBindingPattern([
            ...boundKeys.map((k) =>
              f.createBindingElement(undefined, undefined, f.createIdentifier(k), undefined)),
            f.createBindingElement(
              f.createToken(ast.SyntaxKind.DotDotDotToken),
              undefined, f.createIdentifier('rest'), undefined),
          ]),
          undefined, undefined,
          f.createAsExpression(
            f.createIdentifier('props'),
            f.createTypeReferenceNode(f.createIdentifier('Record'), [
              f.createKeywordTypeNode(ast.SyntaxKind.StringKeyword),
              f.createKeywordTypeNode(ast.SyntaxKind.UnknownKeyword),
            ]),
          ),
        ),
      ], nodeFlagsConst),
    )
    generatedBody = f.createBlock(
      [destructure, f.createReturnStatement(f.createParenthesizedExpression(body2))],
      true,
    )
  }
  const generatedFn = f.createVariableStatement(
    [exportModifier()],
    f.createVariableDeclarationList([
      f.createVariableDeclaration(
        f.createIdentifier('Generated'),
        undefined, fcType,
        f.createArrowFunction(undefined, undefined, fnParams, undefined,
          f.createToken(ast.SyntaxKind.EqualsGreaterThanToken),
          generatedBody),
      ),
    ], nodeFlagsConst),
  )
  const implExport = f.createVariableStatement(
    [exportModifier()],
    f.createVariableDeclarationList([
      f.createVariableDeclaration(
        f.createIdentifier('impl'),
        undefined, fcType,
        f.createArrowFunction(undefined, undefined, fnParams, undefined,
          f.createToken(ast.SyntaxKind.EqualsGreaterThanToken),
          f.createJsxSelfClosingElement(
            f.createIdentifier('Generated'),
            undefined,
            f.createJsxAttributes(boundKeys.length === 0 ? [] : [
              f.createJsxSpreadAttribute(f.createIdentifier('props')),
            ]),
          ),
        ),
      ),
    ], nodeFlagsConst),
  )

  const statements: ast.Statement[] = [
    fcImport, ...componentImports, ...typographyImports, ...cssImport, ...jsxPatternImport,
    generatedFn, implExport,
  ]
  const header = `/**\n * AUTO-GENERATED by pixpec react-panda emitter.\n * Source: ${sourceId}\n */\n`
  return header + statements.map(printNode).join('\n') + '\n' + 'export interface GeneratedProps {}\n'
}

export const reactPandaEmitter: Emitter = {
  name: 'react-panda',
  description: 'React + PandaCSS components — Flex/Stack/Box pattern, panda atomic class output.',
  emit(root: DNode, ctx: EmitContext): EmitResult {
    const ext = ctx as EmitContext & ReactPandaCtxExt
    const plugins = (ext.plugins ?? (ctx.plugins as CodegenPlugin[] | undefined) ?? []) as CodegenPlugin[]
    const cgCtx: Ctx = {
      remBase: ctx.remBase ?? 16,
      componentName: ctx.componentName,
      registry: ctx.registry ?? new Map(),
      tokenMap: ctx.designSystem?.tokens ?? {},
      typographyMap: ctx.designSystem?.typography ?? {},
      plugins,
      usedJsxPatterns: new Set(),
      usedTypography: new Set(),
      usedComponents: new Set(),
      usedPropBindings: new Set(),
      usesCss: false,
    }
    const sourceId = ext.sourceId ?? root.sourceId

    let printNode = ext.printNode
    let api: API | undefined
    let source: string
    try {
      if (!printNode) {
        const cwd = process.cwd()
        api = new API({ cwd })
        // tsgo wants a tsconfig path; use the cwd's if present, otherwise
        // pixpec's own tsconfig (we know it exists relative to this file).
        const here = nodePath.dirname(fileURLToPath(import.meta.url))
        const tsconfigCandidates = [
          nodePath.resolve(cwd, 'tsconfig.json'),
          nodePath.resolve(here, '../../../tsconfig.json'),
        ]
        const tsconfig = tsconfigCandidates.find((p) => existsSync(p))
        if (!tsconfig) throw new Error('[react-panda emitter] tsgo: no tsconfig.json found')
        const snap = api.updateSnapshot({ openProject: tsconfig })
        const proj = snap.getProjects()[0]
        if (!proj) throw new Error('[react-panda emitter] tsgo: no project loaded')
        printNode = (node: ast.Node) => proj.emitter.printNode(node)
      }
      source = buildSource(root, cgCtx, printNode, sourceId)
    } finally {
      if (api) api.close()
    }
    return { source, fileExtension: ext.fileExtension ?? 'tsx' }
  },
}
