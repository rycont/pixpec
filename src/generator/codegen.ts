/**
 * IR → React + PandaCSS JSX codegen using TypeScript native-preview AST.
 *
 *   - Type-safe AST construction (@typescript/native-preview/ast/factory)
 *   - Native emitter handles escaping, indentation, JSX text/expression boundaries
 *   - No string concatenation
 *
 * Phase 0 mappings:
 *   IRComponent → <Name {...props} />
 *   IRFrame     → <div style={{...}}>{children}</div>
 *   IRText      → <span style={{...}}>content</span>
 *   IRVector / IRUnknown → placeholder div
 *
 * propsFromFigma() runs in hydrate() pass before codegen.
 */
import * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import { isJsxSelfClosingElement } from '@typescript/native-preview/ast/is'
import { getSvgPath } from 'figma-squircle'
import type { Component } from '../types.ts'
import type { IRNode, IRComponent, IRFrame, IRText, IRVector, IRShape, IRImage, IRUnknown } from './ir.ts'

interface IRComponentRaw extends IRComponent {
  raw: unknown
}

function cleanControlValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  if (Array.isArray(value)) return value.map(cleanControlValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cleanControlValue(v)]),
    )
  }
  return value
}

/** Apply each registered component's propsFromFigma to fill .props. Mutates.
 * propsFromFigma is allowed to return `undefined` for missing-in-figma fields;
 * we drop those keys here so the rendering component naturally falls back to
 * its declared `defaults` at runtime.
 * If the component declares `defaults`, copy it to IR — codegen will elide
 * instance props whose values match the declared defaults. Without defaults
 * declared, NO elision happens (safe fallback for un-migrated components). */
export function hydrate(node: IRNode, components: Component<unknown>[]): IRNode {
  if (node.kind === 'component') {
    const c = node as IRComponentRaw
    const comp = components.find((x) => x.name === c.componentName)
    if (comp?.figma) {
      const raw = comp.figma.propsFromFigma(c.raw as never) as Record<string, unknown>
      c.props = Object.fromEntries(
        Object.entries(raw)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, cleanControlValue(v)]),
      )
    }
    if (comp?.defaults) c.defaultProps = cleanControlValue(comp.defaults) as Record<string, unknown>
    delete (c as Partial<IRComponentRaw>).raw
  }
  if (node.kind === 'frame') for (const ch of node.children) hydrate(ch, components)
  return node
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const noTokenFlags = 0 as ast.TokenFlags
const noNodeFlags = 0 as ast.NodeFlags
const nodeFlagsConst = 2 as ast.NodeFlags
const noType = undefined as unknown as ast.TypeNode

const stringLiteral = (text: string): ast.StringLiteral => f.createStringLiteral(text, noTokenFlags)
const numericLiteral = (value: number): ast.NumericLiteral =>
  f.createNumericLiteral(String(value), noTokenFlags)
const keywordExpression = <T extends ast.KeywordExpressionSyntaxKind>(
  kind: T,
): ast.KeywordExpression<T> => f.createKeywordExpression(kind)
const exportModifier = (): ast.ModifierLike =>
  f.createToken(ast.SyntaxKind.ExportKeyword) as ast.ModifierLike
const propertyAssignment = (
  name: ast.PropertyName,
  initializer: ast.Expression,
): ast.PropertyAssignment => f.createPropertyAssignment(undefined, name, undefined, noType, initializer)
const callExpression = (expression: ast.Expression, args: readonly ast.Expression[]): ast.CallExpression =>
  f.createCallExpression(expression, undefined, undefined, args, noNodeFlags)

function printStringLiteral(text: string): string {
  return JSON.stringify(text)
}

function printTemplateLiteral(text: string): string {
  return `\`${text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``
}

function printIdentifier(node: ast.Identifier): string {
  return node.text
}

function printPropertyName(node: ast.PropertyName): string {
  return node.kind === ast.SyntaxKind.Identifier
    ? printIdentifier(node as ast.Identifier)
    : printStringLiteral((node as ast.StringLiteral).text)
}

function printExpr(node: ast.Expression): string {
  switch (node.kind) {
    case ast.SyntaxKind.Identifier:
      return printIdentifier(node as ast.Identifier)
    case ast.SyntaxKind.StringLiteral:
      return printStringLiteral((node as ast.StringLiteral).text)
    case ast.SyntaxKind.NumericLiteral:
      return (node as ast.NumericLiteral).text
    case ast.SyntaxKind.TrueKeyword:
      return 'true'
    case ast.SyntaxKind.FalseKeyword:
      return 'false'
    case ast.SyntaxKind.NullKeyword:
      return 'null'
    case ast.SyntaxKind.ArrayLiteralExpression:
      return `[${[...(node as ast.ArrayLiteralExpression).elements].map(printExpr).join(', ')}]`
    case ast.SyntaxKind.ObjectLiteralExpression:
      return `{ ${[...(node as ast.ObjectLiteralExpression).properties].map((p) => {
        if (p.kind !== ast.SyntaxKind.PropertyAssignment) {
          throw new Error(`[pixpec generate] unsupported object property kind: ${p.kind}`)
        }
        const prop = p as ast.PropertyAssignment
        return `${printPropertyName(prop.name)}: ${printExpr(prop.initializer)}`
      }).join(', ')} }`
    case ast.SyntaxKind.CallExpression: {
      const call = node as ast.CallExpression
      return `${printExpr(call.expression)}(${[...call.arguments].map(printExpr).join(', ')})`
    }
    case ast.SyntaxKind.ParenthesizedExpression:
      return `(${printExpr((node as ast.ParenthesizedExpression).expression)})`
    case ast.SyntaxKind.ArrowFunction:
      return printArrowFunction(node as ast.ArrowFunction)
    case ast.SyntaxKind.NoSubstitutionTemplateLiteral:
      return printTemplateLiteral((node as ast.NoSubstitutionTemplateLiteral).text)
    case ast.SyntaxKind.JsxSelfClosingElement:
    case ast.SyntaxKind.JsxElement:
      return printJsx(node as ast.JsxChild)
    case ast.SyntaxKind.PropertyAccessExpression: {
      // ts-go stores child nodes in node._data (factory.generated.js:1757);
      // typed `.expression`/`.name` getters from ast.d.ts aren't materialized
      // on factory-created nodes.
      const data = (node as unknown as { _data: { expression: ast.Expression; name: ast.Identifier } })._data
      return `${printExpr(data.expression)}.${printIdentifier(data.name)}`
    }
    default:
      throw new Error(`[pixpec generate] unsupported expression kind: ${node.kind}`)
  }
}

function printJsxTagName(node: ast.JsxTagNameExpression): string {
  return node.kind === ast.SyntaxKind.Identifier
    ? printIdentifier(node as ast.Identifier)
    : printExpr(node as ast.Expression)
}

function printJsxAttr(attr: ast.JsxAttributeLike): string {
  if (attr.kind === ast.SyntaxKind.JsxSpreadAttribute) {
    return `{...${printExpr((attr as ast.JsxSpreadAttribute).expression)}}`
  }
  const a = attr as ast.JsxAttribute
  const name = a.name.kind === ast.SyntaxKind.Identifier
    ? printIdentifier(a.name as ast.Identifier)
    : `${printIdentifier((a.name as ast.JsxNamespacedName).namespace)}:${printIdentifier((a.name as ast.JsxNamespacedName).name)}`
  if (!a.initializer) return name
  if (a.initializer.kind === ast.SyntaxKind.StringLiteral) {
    return `${name}=${printStringLiteral((a.initializer as ast.StringLiteral).text)}`
  }
  return `${name}={${printExpr((a.initializer as ast.JsxExpression).expression!)}}`
}

function printJsxAttrs(attrs: ast.JsxAttributes): string {
  const printed = [...attrs.properties].map(printJsxAttr)
  return printed.length ? ` ${printed.join(' ')}` : ''
}

function printJsxText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/{/g, '&#123;')
}

function printJsx(node: ast.JsxChild): string {
  switch (node.kind) {
    case ast.SyntaxKind.JsxText:
      return printJsxText((node as ast.JsxText).text)
    case ast.SyntaxKind.JsxExpression: {
      const expr = (node as ast.JsxExpression).expression
      return `{${expr ? printExpr(expr) : ''}}`
    }
    case ast.SyntaxKind.JsxSelfClosingElement: {
      const el = node as ast.JsxSelfClosingElement
      return `<${printJsxTagName(el.tagName)}${printJsxAttrs(el.attributes)} />`
    }
    case ast.SyntaxKind.JsxElement: {
      const el = node as ast.JsxElement
      const tag = printJsxTagName(el.openingElement.tagName)
      const attrs = printJsxAttrs(el.openingElement.attributes)
      return `<${tag}${attrs}>${[...el.children].map(printJsx).join('')}</${tag}>`
    }
    default:
      throw new Error(`[pixpec generate] unsupported JSX kind: ${node.kind}`)
  }
}

function printImportDeclaration(node: ast.ImportDeclaration): string {
  const clause = node.importClause
  const moduleSpecifier = printExpr(node.moduleSpecifier as ast.Expression)
  if (!clause?.namedBindings || clause.namedBindings.kind !== ast.SyntaxKind.NamedImports) {
    return `import ${moduleSpecifier};`
  }
  const typePrefix = clause.phaseModifier === ast.SyntaxKind.TypeKeyword ? ' type' : ''
  const imports = [...(clause.namedBindings as ast.NamedImports).elements]
    .map((s) => s.propertyName ? `${printIdentifier(s.propertyName as ast.Identifier)} as ${printIdentifier(s.name)}` : printIdentifier(s.name))
    .join(', ')
  return `import${typePrefix} { ${imports} } from ${moduleSpecifier};`
}

function printVariableStatement(node: ast.VariableStatement): string {
  const exported = node.modifiers?.some((m) => m.kind === ast.SyntaxKind.ExportKeyword) ? 'export ' : ''
  const declarations = [...node.declarationList.declarations].map((d) => {
    const type = d.type ? `: ${printTypeNode(d.type)}` : ''
    const init = d.initializer ? ` = ${printExpr(d.initializer)}` : ''
    return `${printIdentifier(d.name as ast.Identifier)}${type}${init}`
  })
  return `${exported}const ${declarations.join(', ')};`
}

function printTypeNode(node: ast.TypeNode): string {
  if (node.kind === ast.SyntaxKind.TypeReference) {
    const typeRef = node as ast.TypeReferenceNode
    return printPropertyName(typeRef.typeName as ast.PropertyName)
  }
  throw new Error(`[pixpec generate] unsupported type node kind: ${node.kind}`)
}

function printArrowFunction(node: ast.ArrowFunction): string {
  return `() => ${printExpr(node.body as ast.Expression)}`
}

function printStatement(node: ast.Statement): string {
  if (node.kind === ast.SyntaxKind.ImportDeclaration) return printImportDeclaration(node as ast.ImportDeclaration)
  if (node.kind === ast.SyntaxKind.VariableStatement) return printVariableStatement(node as ast.VariableStatement)
  throw new Error(`[pixpec generate] unsupported statement kind: ${node.kind}`)
}

function printSourceFile(sourceFile: ast.SourceFile): string {
  return [...sourceFile.statements].map(printStatement).join('\n') + '\n'
}

/** JS value → ts AST expression. Handles primitives, arrays, plain objects. */
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

/** Build JSX attributes; identifier-safe keys go inline, rest go via spread.
 * String values render as `prop="value"` (no curly braces) — matches the
 * idiomatic JSX style. Other types (number, boolean, object) use `{...}`. */
function attrsFromObject(obj: Record<string, unknown>): ast.JsxAttributeLike[] {
  const inline: ast.JsxAttributeLike[] = []
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (IDENT_RE.test(k)) {
      const initializer: ast.JsxAttributeValue = typeof v === 'string'
        ? stringLiteral(v)
        : f.createJsxExpression(undefined, valueToExpr(v))
      inline.push(f.createJsxAttribute(f.createIdentifier(k), initializer))
    } else {
      rest[k] = v
    }
  }
  if (Object.keys(rest).length) {
    inline.push(f.createJsxSpreadAttribute(valueToExpr(rest)))
  }
  return inline
}

/** Deep-equal for primitives + plain JSON-shaped objects/arrays. */
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

function componentLayoutStyles(n: IRComponent, parent: ParentCtx, ctx: CodegenCtx): Record<string, unknown> {
  if (parent.dir === 'none') {
    // Root case: still emit explicit width/height when designer resized the
    // instance off its master dim (e.g. IconButton Small=28 stretched to 32
    // inside Input). Skip when no resize — recipe handles default.
    const ws: Record<string, unknown> = {}
    if (n.sizingH === 'fixed' && typeof n.width === 'number' && typeof n.mainWidth === 'number' && n.width !== n.mainWidth) {
      ws.width = px2remPanda(n.width, ctx.remBase)
    }
    if (n.sizingV === 'fixed' && typeof n.height === 'number' && typeof n.mainHeight === 'number' && n.height !== n.mainHeight) {
      ws.height = px2remPanda(n.height, ctx.remBase)
    }
    return ws
  }
  const ws: Record<string, unknown> = {}
  // Registered components own their root layout by default. Codegen only
  // expresses axes where the instance differs from the main component root.
  // HUG resolved-size changes from text/prop overrides are intentionally
  // ignored; the component implementation should produce those naturally.
  const changedH = n.sizingH !== undefined && (
    (n.mainSizingH !== undefined && n.sizingH !== n.mainSizingH) ||
    (n.sizingH === 'fixed' && typeof n.width === 'number' && typeof n.mainWidth === 'number' && n.width !== n.mainWidth)
  )
  const changedV = n.sizingV !== undefined && (
    (n.mainSizingV !== undefined && n.sizingV !== n.mainSizingV) ||
    (n.sizingV === 'fixed' && typeof n.height === 'number' && typeof n.mainHeight === 'number' && n.height !== n.mainHeight)
  )
  if (changedH) {
    if (n.sizingH === 'fixed' && typeof n.width === 'number') {
      ws.width = n.width
    } else if (n.sizingH === 'fill') {
      if (parent.dir === 'row' && parent.mainSizing !== 'hug') {
        ws.flex = 1
        ws.minWidth = 0
      } else if (parent.dir === 'column') {
        ws.alignSelf = 'stretch'
        ws.minWidth = 0
      }
    }
  }
  if (changedV) {
    if (n.sizingV === 'fixed' && typeof n.height === 'number') {
      ws.height = n.height
    } else if (n.sizingV === 'fill') {
      if (parent.dir === 'column' && parent.mainSizing !== 'hug') {
        ws.flex = 1
        ws.minHeight = 0
      } else if (parent.dir === 'row') {
        ws.alignSelf = 'stretch'
        ws.minHeight = 0
      }
    }
  }
  // FIXED main-axis child of FILL/FIXED parent: prevent flex-shrink from
  // collapsing the child below its explicit dim. HUG parent never shrinks
  // its children, so wrap is unnecessary there. Emitted as a Panda style
  // prop directly on the component (DS components must forward style/
  // className to their root — AGENTS.md: 1 figma node = 1 JSX element).
  if (parent.mainSizing !== 'hug') {
    if (parent.dir === 'row' && n.sizingH === 'fixed') ws.flexShrink = 0
    if (parent.dir === 'column' && n.sizingV === 'fixed') ws.flexShrink = 0
  }
  return ws
}

function emitComponent(n: IRComponent, ctx: CodegenCtx, parent: ParentCtx = { dir: 'none', mainSizing: 'fixed' }): ast.JsxChild {
  // Elide props that match the component-set's default — figma's
  // `componentPropertyDefinitions[name].defaultValue` semantically equals
  // "what you'd get if you didn't override it." Cuts visual noise on
  // generated JSX without losing fidelity.
  const props = n.defaultProps
    ? Object.fromEntries(Object.entries(n.props).filter(([k, v]) => !deepEq(v, n.defaultProps![k])))
    : n.props
  const attrs = attrsFromObject(props)
  // When this component is a direct child of an autolayout frame, put Figma's
  // flex item sizing on the component itself as Panda style props. Registered
  // DS components are expected to split/forward Panda style props to their
  // root element. This removes the old "safe span" wrapper for FIXED/FILL/HUG
  // cases.
  const layoutStyles = n.rotation === undefined ? componentLayoutStyles(n, parent, ctx) : {}
  for (const k of Object.keys(n.props)) delete layoutStyles[k]
  if ('width' in n.props) delete layoutStyles.minWidth
  if ('height' in n.props) delete layoutStyles.minHeight
  if (n.opacity !== undefined) layoutStyles.opacity = n.opacity
  if (Object.keys(layoutStyles).length) attrs.push(...attrsFromObject(pandaize(layoutStyles, ctx.remBase)))
  const inner = f.createJsxSelfClosingElement(
    f.createIdentifier(n.componentName),
    undefined,
    f.createJsxAttributes(attrs),
  )
  let wrapped: ast.JsxChild = inner
  // figma rotation (counterclockwise degrees) → CSS rotate (clockwise positive).
  // Wrap with inline-flex div so rotate doesn't affect parent layout.
  if (n.rotation !== undefined) {
    // The rotation wrap holds the PRE-rotation box (figma `.width`×`.height`).
    // Outer layout-wrap reserves the post-rotation axis-aligned bbox; the
    // rotation here just paints the inner box at that visual orientation.
    //
    // transform-origin defaults to 50%/50%, which puts the rotated visual off
    // the layout slot when w ≠ h. Use top-left origin (0 0) and a translate
    // to bring the post-rotation bbox back to (0,0) of the slot:
    //   corners → rotate → minX, minY → translate(-minX, -minY)
    // This places the rotated visual flush with the layout-wrap span's box,
    // matching figma's render of rotated children inside autolayout.
    const css = (-n.rotation) * Math.PI / 180  // CSS rotate is clockwise; figma counterclockwise

    const w0 = typeof n.width === 'number' ? n.width : 0
    const h0 = typeof n.height === 'number' ? n.height : 0
    const cos = Math.cos(css), sin = Math.sin(css)
    const corners: [number, number][] = [[0, 0], [w0, 0], [w0, h0], [0, h0]]
    const rotated = corners.map(([x, y]): [number, number] => [x * cos - y * sin, x * sin + y * cos])
    const minX = Math.min(...rotated.map((p) => p[0]))
    const minY = Math.min(...rotated.map((p) => p[1]))
    // Thin rotated shape (post-rotation w ≤ 1 css) at sub-pixel x in flex
    // → Skia HTML rasterizer snaps to integer raw px. Empirically translate
    // half a css px LESS than the geometric `-minX` puts the rendered ink at
    // figma's sub-pixel position (verified via SnapGridProbe + Gen_3707_4081
    // divider). Geometric: translate(1, 0) → snap to css 63. Adjusted:
    // translate(0.5, 0) → ink at css 62.5 = match figma. The trick works only
    // for thin shapes; thicker rotated shapes don't snap.
    const atRoot = parent.dir === 'none'
    const tx = -minX
    // Use CSS individual transform properties (translate, rotate) which
    // Panda exposes as utilities — `transform` is multi-token and trips
    // Panda's atomic class generator. Composition order per CSS spec for
    // individual properties: rotate first, then translate (matches the
    // legacy `transform: translate(...) rotate(...)` right-to-left order).
    const pandaProps: Record<string, unknown> = atRoot
      // boxWrapper centers content; absolute pin defeats centering so
      // transform-origin:0,0 lines up with screenshot clip's top-left.
      ? { position: 'absolute', top: 0, left: 0 }
      : { display: 'inline-flex', alignSelf: 'flex-start', flexShrink: 0, verticalAlign: 'top' }
    pandaProps.transformOrigin = '0 0'
    pandaProps.translate = `${px2remPanda(tx, ctx.remBase)} ${px2remPanda(-minY, ctx.remBase)}`
    pandaProps.rotate = `${-n.rotation}deg`
    if (typeof n.width === 'number') pandaProps.width = px2remPanda(n.width, ctx.remBase)
    if (typeof n.height === 'number') pandaProps.height = px2remPanda(n.height, ctx.remBase)
    const extraAttrs = attrsFromObject(pandaize(pandaProps, ctx.remBase))
    return f.updateJsxSelfClosingElement(
      inner as ast.JsxSelfClosingElement,
      (inner as ast.JsxSelfClosingElement).tagName,
      (inner as ast.JsxSelfClosingElement).typeArguments,
      f.createJsxAttributes([
        ...(inner as ast.JsxSelfClosingElement).attributes.properties,
        ...extraAttrs,
      ]),
    )
  }
  return wrapped
}

function emitFrame(n: IRFrame, ctx: CodegenCtx, parent: ParentCtx = { dir: 'none', mainSizing: 'fixed' }): ast.JsxElement {
  const parentDir = parent.dir
  const flexDir = n.layout.direction === 'none' ? null : n.layout.direction
  const styles: Record<string, unknown> = {}
  // CSS values that bypass Panda atomic extraction (e.g. mixed-stroke
  // boxShadow with var() refs — Panda extract drops the class). Emitted as
  // a separate `style={{...}}` JSX attribute alongside the Panda atomic props.
  const inlineStyle: Record<string, unknown> = {}
  // FILL semantics depend on parent main-axis: same axis → flex:1; cross axis → alignSelf:stretch.
  // BUT if parent's main-axis is HUG, "fill" along that axis is meaningless in figma
  // (HUG sizes to content), so collapse to HUG behaviour (no flex:1) — matches figma render.
  const fillStyle = (axis: 'h' | 'v'): 'main' | 'cross' | null => {
    if (parentDir === 'none') return null
    const parentMainIsH = parentDir === 'row'
    const isMain = (axis === 'h' && parentMainIsH) || (axis === 'v' && !parentMainIsH)
    if (isMain && parent.mainSizing === 'hug') return null
    return isMain ? 'main' : 'cross'
  }
  // Auto-layout containers map to panda's Flex (row) / Stack (column) / Box.
  // Each pattern's intrinsic default matches its name — Flex defaults to
  // flex-direction:row, Stack defaults to column. Skip emitting `direction`
  // when it matches the pattern's default.
  // Token-aware emission: when a styled property is bound to a figma variable,
  // emit the panda token path (e.g. 'spacing.200', 'background.standard.primary')
  // instead of raw px/hex. Resolves via ctx.tokenMap (figma var id → panda path).
  const tids = n.tokenIds || {}
  if (flexDir) {
    // direction omitted: Flex pattern defaults to row, Stack to column —
    // and we always pair (row→Flex, column→Stack), so the prop is redundant.
    // Always emit align — CSS flex default for align-items is `stretch`
    // (NOT `start`), so omitting figma's `start` would leak `stretch` onto
    // children that would otherwise be intrinsic-sized.
    styles.align = n.layout.alignItems
    // figma SPACE_BETWEEN with a single child renders as "center" (figma
    // distributes equal space on both sides). CSS flex `space-between` with
    // a single child collapses to `start`, so it would shift the child
    // left by (frameW - childW)/2 vs figma. Substitute when only 1 child.
    const visibleChildren = n.children.filter((c) => !c.absolute)
    const justify =
      n.layout.justifyContent === 'space-between' && visibleChildren.length === 1
        ? 'center'
        : n.layout.justifyContent
    if (justify !== 'start') styles.justify = justify
    // Stack pattern may carry a default gap, so preserve column gap=0. Flex
    // row has no default gap, so omit zero for terser generated JSX.
    // For SPACE_BETWEEN: figma's `itemSpacing` is documented but only used
    // when items would otherwise overlap; the actual rendered gap = remaining
    // space distributed evenly. CSS `gap` is a HARD MIN — emitting it forces
    // items to keep that gap, overriding space-between's distribution. Skip
    // the gap emit so the browser's space-between distributes freely.
    if ((n.layout.gap !== 0 || n.layout.direction === 'column')
        && n.layout.justifyContent !== 'space-between') {
      styles.gap = resolveValue(n.layout.gap, tids.gap, ctx.tokenMap, `${n.figmaId}.gap`, ctx.tokenValueMap)
    }
    // figma layoutWrap=WRAP → flex-wrap:wrap. counterAxisSpacing maps to
    // rowGap (horizontal flow) or columnGap (vertical flow). The single
    // `gap` property emitted above sets BOTH axes; override the wrap-axis
    // gap when figma specifies a different counter-gap.
    if (n.layout.wrap) {
      styles.flexWrap = 'wrap'
      const cg = n.layout.counterGap
      if (typeof cg === 'number' && cg !== n.layout.gap) {
        if (n.layout.direction === 'row') styles.rowGap = cg
        else if (n.layout.direction === 'column') styles.columnGap = cg
      }
    }
  }
  // figma allows degenerate frames where padding-sum > FIXED size on an
  // axis (e.g. h=4 with padTop=10 padBottom=10). Figma clips and renders at
  // the FIXED size; CSS clamps box dim up to padding-sum and can't be
  // overridden by box-sizing/max-height/overflow. Drop padding on the
  // offending axis when it would be degenerate. Logged for diagnostics.
  const dropV = n.layout.sizingV === 'fixed' && typeof n.height === 'number'
    && (n.layout.paddingTop + n.layout.paddingBottom > n.height)
  const dropH = n.layout.sizingH === 'fixed' && typeof n.width === 'number'
    && (n.layout.paddingLeft + n.layout.paddingRight > n.width)
  if (n.layout.paddingTop && !dropV) styles.paddingTop = resolveValue(n.layout.paddingTop, tids.paddingTop, ctx.tokenMap, `${n.figmaId}.paddingTop`, ctx.tokenValueMap)
  if (n.layout.paddingRight && !dropH) styles.paddingRight = resolveValue(n.layout.paddingRight, tids.paddingRight, ctx.tokenMap, `${n.figmaId}.paddingRight`, ctx.tokenValueMap)
  if (n.layout.paddingBottom && !dropV) styles.paddingBottom = resolveValue(n.layout.paddingBottom, tids.paddingBottom, ctx.tokenMap, `${n.figmaId}.paddingBottom`, ctx.tokenValueMap)
  if (n.layout.paddingLeft && !dropH) styles.paddingLeft = resolveValue(n.layout.paddingLeft, tids.paddingLeft, ctx.tokenMap, `${n.figmaId}.paddingLeft`, ctx.tokenValueMap)
  // FIXED → explicit figma resolved width/height (CSS default stretch != figma).
  // FILL → flex:1 (main) or alignSelf:stretch (cross). HUG → omit (intrinsic).
  // At root (parent.dir === 'none') there is no real auto-layout parent, so
  // represent FILL as filling the rendered boundary instead of assuming the
  // verify harness's inline-flex wrapper.
  if (n.layout.sizingH === 'fill') {
    if (parentDir === 'none') {
      styles.width = '100%'
    } else {
      const r = fillStyle('h')
      // `minWidth: 0` lets flex children shrink below their intrinsic min-content
      // (figma's autolayout doesn't enforce min-content, but CSS flexbox defaults
      // to `min-width: auto` which can push children to overflow their parent).
      if (r === 'main') { styles.flex = 1; styles.minWidth = 0 }
      else if (r === 'cross') { styles.alignSelf = 'stretch'; styles.minWidth = 0 }
    }
  } else if (n.layout.sizingH === 'fixed' && n.width !== undefined) {
    styles.width = resolveValue(n.width, tids.width, ctx.tokenMap, `${n.figmaId}.width`, ctx.tokenValueMap)
    // figma's FIXED sizing means "this dim is the truth" even if padding +
    // children would normally push the flex container larger. CSS flex
    // items get `min-width: auto` by default (= intrinsic min-content) which
    // can override an explicit width — but only when this element IS a flex
    // item (i.e., the parent is a flex container). Skip the override at the
    // root (no parent) or in non-flex parents.
    if (parentDir !== 'none') styles.minWidth = 0
  }
  if (n.layout.sizingV === 'fill') {
    if (parentDir === 'none') {
      styles.height = '100%'
    } else {
      const r = fillStyle('v')
      if (r === 'main') { styles.flex = 1; styles.minHeight = 0 }
      else if (r === 'cross') { styles.alignSelf = 'stretch'; styles.minHeight = 0 }
    }
  } else if (n.layout.sizingV === 'fixed' && n.height !== undefined) {
    styles.height = resolveValue(n.height, tids.height, ctx.tokenMap, `${n.figmaId}.height`, ctx.tokenValueMap)
    if (parentDir !== 'none') styles.minHeight = 0
  }
  // figma's FIXED-on-main-axis means "do not shrink to fit container," but
  // CSS flex items default to flex-shrink:1 and can shrink below their
  // explicit dim when the container's content area is smaller. Force
  // flex-shrink:0 on FIXED main-axis frame children so they overflow like figma.
  if (parentDir === 'row' && n.layout.sizingH === 'fixed') styles.flexShrink = 0
  if (parentDir === 'column' && n.layout.sizingV === 'fixed') styles.flexShrink = 0
  if (n.background) styles.background = resolveValue(n.background, tids.background, ctx.tokenMap, `${n.figmaId}.background`, ctx.tokenValueMap)
  if (n.opacity !== undefined) styles.opacity = n.opacity
  // Min/max constraints from figma. Emitted even with HUG sizing so a
  // HUG row with minHeight=48 stays 48px tall when content is shorter.
  if (n.minWidth !== undefined) styles.minWidth = n.minWidth
  if (n.maxWidth !== undefined) styles.maxWidth = n.maxWidth
  if (n.minHeight !== undefined) styles.minHeight = n.minHeight
  if (n.maxHeight !== undefined) styles.maxHeight = n.maxHeight
  // figma cornerSmoothing > 0 → render the rounded shape via clip-path with
  // figma-squircle's path. CSS `border-radius` is a circular arc; figma uses
  // a G2-continuous (smoothed) corner that fades into the side gradually.
  // For fixed-dim frames we can bake the path string at codegen time.
  //
  // CSS `clip-path: path(...)` uses px coordinates — when verify-mode scales
  // the box via html font-size, the px-coord path no longer covers the full
  // scaled box. Emit a per-frame SVG <clipPath clipPathUnits="objectBoundingBox">
  // whose path is normalized to 0..1, then reference via clip-path: url(#id).
  // SVG clipPath auto-scales to the box dim regardless of html font-size.
  let squirclePath: string | undefined
  let squircleClipId: string | undefined
  if (n.borderRadius && n.cornerSmoothing && n.cornerSmoothing > 0
      && typeof n.width === 'number' && typeof n.height === 'number') {
    requireTokenPath(tids.borderRadius, ctx.tokenMap, `${n.figmaId}.borderRadius`)
    squirclePath = getSvgPath({
      width: n.width, height: n.height,
      cornerRadius: n.borderRadius, cornerSmoothing: n.cornerSmoothing,
    }).replace(/\n/g, ' ').trim()
    squircleClipId = `pxp-clip-${n.figmaId.replace(/[^A-Za-z0-9]/g, '_')}`
    styles.clipPath = `url(#${squircleClipId})`
  } else if (n.borderRadius) {
    styles.borderRadius = resolveValue(n.borderRadius, tids.borderRadius, ctx.tokenMap, `${n.figmaId}.borderRadius`, ctx.tokenValueMap)
  } else if (
    (n.borderRadiusTopLeft || n.borderRadiusTopRight ||
     n.borderRadiusBottomRight || n.borderRadiusBottomLeft)
  ) {
    // Per-corner radii (figma's mixed cornerRadius). Squircle smoothing on
    // mixed corners isn't supported here — figma-squircle's path needs a
    // single radius. Falls back to plain CSS per-corner border-radius.
    if (n.borderRadiusTopLeft) styles.borderTopLeftRadius = n.borderRadiusTopLeft
    if (n.borderRadiusTopRight) styles.borderTopRightRadius = n.borderRadiusTopRight
    if (n.borderRadiusBottomRight) styles.borderBottomRightRadius = n.borderRadiusBottomRight
    if (n.borderRadiusBottomLeft) styles.borderBottomLeftRadius = n.borderRadiusBottomLeft
  }
  // Stroke. Two cases:
  //   - non-squircle: use `inset boxShadow` (matches figma INSIDE alignment,
  //     no layout perturbation since `border` would expand the box).
  //   - squircle: clip-path cuts the inset shadow at the squircle edge, so
  //     corners lose their stroke pixels. Render an absolute SVG overlay
  //     with the same path stroked at 2× weight; clip-path clips the outer
  //     half, leaving exactly `strokeWeight` px of stroke inside the squircle.
  let strokeOverlay: ast.JsxChild | undefined
  if (n.strokeColor && n.strokeWeight) {
    requireTokenPath(tids.strokeWeight, ctx.tokenMap, `${n.figmaId}.strokeWeight`)
    const strokeTokenPath = requireTokenPath(tids.strokeColor, ctx.tokenMap, `${n.figmaId}.strokeColor`)
    const strokeColor = strokeTokenPath ? `{colors.${strokeTokenPath}}` : n.strokeColor
    const strokeAttrColor = strokeTokenPath ? colorTokenVar(strokeTokenPath) : n.strokeColor
    if (squirclePath) {
      styles.position = 'relative'
      ctx.usedJsxPatterns.add('styled')
      const tag = () => f.createPropertyAccessExpression(
        f.createIdentifier('styled'), undefined, f.createIdentifier('svg'),
      )
      strokeOverlay = f.createJsxElement(
        f.createJsxOpeningElement(tag(), undefined,
          f.createJsxAttributes([
            f.createJsxAttribute(f.createIdentifier('viewBox'),
              stringLiteral(`0 0 ${n.width} ${n.height}`)),
            f.createJsxAttribute(f.createIdentifier('preserveAspectRatio'),
              stringLiteral('none')),
            f.createJsxAttribute(f.createIdentifier('position'), stringLiteral('absolute')),
            f.createJsxAttribute(f.createIdentifier('inset'), f.createJsxExpression(undefined, valueToExpr(0))),
            f.createJsxAttribute(f.createIdentifier('width'), stringLiteral('100%')),
            f.createJsxAttribute(f.createIdentifier('height'), stringLiteral('100%')),
            f.createJsxAttribute(f.createIdentifier('pointerEvents'), stringLiteral('none')),
          ])),
        [f.createJsxSelfClosingElement(f.createIdentifier('path'), undefined,
          f.createJsxAttributes([
            f.createJsxAttribute(f.createIdentifier('d'), stringLiteral(squirclePath)),
            f.createJsxAttribute(f.createIdentifier('fill'), stringLiteral('none')),
            f.createJsxAttribute(f.createIdentifier('stroke'), stringLiteral(strokeAttrColor)),
            f.createJsxAttribute(f.createIdentifier('strokeWidth'),
              f.createJsxExpression(undefined, valueToExpr(n.strokeWeight * 2))),
          ]))],
        f.createJsxClosingElement(tag()),
      )
    } else {
      // Per-side weights (figma individualStrokeWeights → strokeWeight=mixed).
      // Emit borderTop/Right/Bottom/Left individually instead of insetBorder
      // (which is uniform 4-side). CSS border adds outside the box; figma
      // strokeAlign INSIDE adds inside. To keep layout dim stable, use
      // boxShadow inset chained per side.
      const hasMixed = n.strokeTopWeight !== undefined
      if (hasMixed) {
        // Panda's atomic generator doesn't reliably extract boxShadow values
        // with multiple commas+parens (each variant per-side combo creates a
        // unique class — too dynamic to pre-extract). CSS var() reference is
        // native, so an inline style entry is the most robust path.
        // Use rem (not px) so verify-mode supersample (htmlFs=128 → 8× rem
        // scale) renders the stroke at the figma design dim. Raw px would
        // render 1 device px = 0.125 design px → invisible hairline.
        const colorRef = strokeTokenPath ? colorTokenVar(strokeTokenPath) : n.strokeColor
        const w2r = (w: number) => px2rem(w, ctx.remBase)
        const shadows: string[] = []
        if (n.strokeTopWeight) shadows.push(`inset 0 ${w2r(n.strokeTopWeight)} 0 0 ${colorRef}`)
        if (n.strokeBottomWeight) shadows.push(`inset 0 -${w2r(n.strokeBottomWeight)} 0 0 ${colorRef}`)
        if (n.strokeLeftWeight) shadows.push(`inset ${w2r(n.strokeLeftWeight)} 0 0 0 ${colorRef}`)
        if (n.strokeRightWeight) shadows.push(`inset -${w2r(n.strokeRightWeight)} 0 0 0 ${colorRef}`)
        if (shadows.length) inlineStyle.boxShadow = shadows.join(', ')
      } else if (Number.isInteger(n.strokeWeight)) {
        styles.insetBorder = `${n.strokeWeight} ${strokeTokenPath ?? n.strokeColor}`
      } else {
        // Fractional uniform stroke (scaled-instance — figma 28→32 yields
        // 1.14px stroke). Panda's insetBorder atomic extraction is flaky
        // for non-integer values across panda postcss cache states. Use
        // inline boxShadow with var() so the rule is always applied.
        const colorRef = strokeTokenPath ? colorTokenVar(strokeTokenPath) : n.strokeColor
        inlineStyle.boxShadow = `inset 0 0 0 ${px2rem(n.strokeWeight, ctx.remBase)} ${colorRef}`
      }
    }
  }
  if (n.clipsContent) styles.overflow = 'hidden'
  if (n.children?.some((c) => c.absolute)) styles.position = 'relative'

  // Pick the panda pattern: Flex (row) / Stack (column) / Box (no flex).
  // pattern's component name is tracked so we can emit the import.
  const tag =
    flexDir === 'row' ? 'Flex' :
    flexDir === 'column' ? 'Stack' :
    'Box'
  ctx.usedJsxPatterns.add(tag)
  const compactStyles = compactPaddingStyles(styles)
  const attrs = Object.keys(compactStyles).length
    ? attrsFromObject(pandaize(compactStyles, ctx.remBase))
    : []
  if (Object.keys(inlineStyle).length) {
    attrs.push(f.createJsxAttribute(
      f.createIdentifier('style'),
      f.createJsxExpression(undefined, valueToExpr(inlineStyle)),
    ))
  }
  const open = f.createJsxOpeningElement(
    f.createIdentifier(tag), undefined, f.createJsxAttributes(attrs),
  )
  const close = f.createJsxClosingElement(f.createIdentifier(tag))
  // Build child parent ctx — main-axis sizing for this frame.
  const mainSizing: 'fixed' | 'hug' | 'fill' = n.layout.direction === 'row' ? n.layout.sizingH
    : n.layout.direction === 'column' ? n.layout.sizingV : 'fixed'
  const childParent: ParentCtx = { dir: n.layout.direction, mainSizing }
  const children = n.children.map((c) => emitNode(c, ctx, childParent))
  if (strokeOverlay) children.push(strokeOverlay)
  // Inject SVG <defs><clipPath> for squircle (objectBoundingBox so it scales
  // with the box dim regardless of html font-size).
  if (squircleClipId && squirclePath && typeof n.width === 'number' && typeof n.height === 'number') {
    const clipDef = f.createJsxElement(
      f.createJsxOpeningElement(f.createIdentifier('svg'), undefined,
        f.createJsxAttributes([
          f.createJsxAttribute(f.createIdentifier('width'), stringLiteral('0')),
          f.createJsxAttribute(f.createIdentifier('height'), stringLiteral('0')),
          f.createJsxAttribute(f.createIdentifier('style'),
            f.createJsxExpression(undefined, valueToExpr({ position: 'absolute' }))),
          f.createJsxAttribute(f.createIdentifier('aria-hidden'), stringLiteral('true')),
        ])),
      [f.createJsxElement(
        f.createJsxOpeningElement(f.createIdentifier('defs'), undefined, f.createJsxAttributes([])),
        [f.createJsxElement(
          f.createJsxOpeningElement(f.createIdentifier('clipPath'), undefined,
            f.createJsxAttributes([
              f.createJsxAttribute(f.createIdentifier('id'), stringLiteral(squircleClipId)),
              f.createJsxAttribute(f.createIdentifier('clipPathUnits'), stringLiteral('objectBoundingBox')),
            ])),
          [f.createJsxSelfClosingElement(f.createIdentifier('path'), undefined,
            f.createJsxAttributes([
              f.createJsxAttribute(f.createIdentifier('d'), stringLiteral(squirclePath)),
              f.createJsxAttribute(f.createIdentifier('transform'),
                stringLiteral(`scale(${(1 / n.width).toFixed(8)} ${(1 / n.height).toFixed(8)})`)),
            ]))],
          f.createJsxClosingElement(f.createIdentifier('clipPath')),
        )],
        f.createJsxClosingElement(f.createIdentifier('defs')),
      )],
      f.createJsxClosingElement(f.createIdentifier('svg')),
    )
    children.push(clipDef)
  }
  let jsx: ast.JsxElement = f.createJsxElement(open, children, close)
  // figma rotation on FRAME — wrap in inline-block with transform.
  // Same approach as emitComponent rotation handling: pre-rotation box
  // + transform + translate to compensate origin shift.
  if (typeof n.rotation === 'number' && Math.abs(n.rotation) >= 0.01
      && typeof n.width === 'number' && typeof n.height === 'number') {
    const css = (-n.rotation) * Math.PI / 180
    const w0 = n.width, h0 = n.height
    const cos = Math.cos(css), sn = Math.sin(css)
    const corners: [number, number][] = [[0, 0], [w0, 0], [w0, h0], [0, h0]]
    const rotated = corners.map(([x, y]): [number, number] => [x * cos - y * sn, x * sn + y * cos])
    const minX = Math.min(...rotated.map((p) => p[0]))
    const minY = Math.min(...rotated.map((p) => p[1]))
    const maxX = Math.max(...rotated.map((p) => p[0]))
    const maxY = Math.max(...rotated.map((p) => p[1]))
    const rotW = maxX - minX
    const rotH = maxY - minY
    // Outer wrapper: post-rotation axis-aligned bbox dim. Inner rotation
    // origin (0,0) translated by (-minX,-minY) so painted bbox lines up
    // with wrapper's (0,0).
    const rotateStyle: Record<string, unknown> = {
      display: 'inline-block',
      verticalAlign: 'top',
      width: px2rem(rotW, ctx.remBase),
      height: px2rem(rotH, ctx.remBase),
    }
    const innerStyle: Record<string, unknown> = {
      transformOrigin: '0 0',
      transform: `translate(${px2rem(-minX, ctx.remBase)}, ${px2rem(-minY, ctx.remBase)}) rotate(${-n.rotation}deg)`,
    }
    // Apply transform to existing jsx by wrapping in another div (or merging).
    // Simpler: wrap jsx with inner-transform div, then outer-bbox div.
    const innerOpen = f.createJsxOpeningElement(
      f.createIdentifier('div'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('style'),
          f.createJsxExpression(undefined, valueToExpr(innerStyle))),
      ]),
    )
    const innerClose = f.createJsxClosingElement(f.createIdentifier('div'))
    const innerJsx = f.createJsxElement(innerOpen, [jsx], innerClose)
    const rotOpen = f.createJsxOpeningElement(
      f.createIdentifier('div'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('style'),
          f.createJsxExpression(undefined, valueToExpr(rotateStyle))),
      ]),
    )
    const rotClose = f.createJsxClosingElement(f.createIdentifier('div'))
    jsx = f.createJsxElement(rotOpen, [innerJsx], rotClose)
  }
  return jsx
}

function emitText(n: IRText, ctx: CodegenCtx, parent: ParentCtx = { dir: 'none', mainSizing: 'fixed' }): ast.JsxElement {
  const parentDir = parent.dir
  // If textStyleId matches a registered typography wrapper, use it.
  // The wrapper handles fontSize/lineHeight/weight/y-shift internally.
  // Live textStyleId format: "S:<hash>,<nodeSuffix>"; binding keys end in
  // ",", so binding key is a prefix of the live id.
  const wrapperName = n.textStyleId ? lookupTypoByPrefix(n.textStyleId, ctx.typographyMap) : undefined
  // Only constrain width when figma forces wrap; HUG = omit so intrinsic governs.
  // figma HUG text doesn't wrap (overflows parent if needed). Mirror that semantically.
  const isHug = n.autoResize === 'hug'
  // figma `paragraphSpacing`: distance between paragraphs (split by `\n`).
  // For typography-wrapper path, the wrapper itself reads paragraphSpacing
  // from `tokens/panda-tokens.ts` and emits per-paragraph blocks — we just
  // pass the raw string. For the fallback (raw <span>) path, codegen handles
  // the split here using `n.paragraphSpacing` from the IR.
  const paragraphs = n.content.split('\n')
  const needsParagraphBlocks = paragraphs.length > 1 && n.paragraphSpacing > 0
  // sizingH=FILL on text (autolayout sibling growing to fill row) → flex:1 (main axis) or
  // alignSelf:stretch (cross axis); explicit width breaks wrap behavior so omit it.
  // figma FILL on main axis is meaningless if parent is HUG (parent sizes to content,
  // so child has no space to grow into). Collapse to HUG so text uses intrinsic width.
  const parentHugMain = parent.mainSizing === 'hug'
  const fillMain = n.sizingH === 'fill' && parentDir === 'row' && !parentHugMain
  // Cross-axis FILL is independent of parent main sizing — even if parent
  // HUGs vertically (column flex main axis), the horizontal cross size is
  // determined by the widest child, and `alignSelf: stretch` on this text
  // makes it match that width. Without this, parent's `align="center"`
  // (figma counterAxisAlignItems=CENTER) would center the intrinsic-width
  // text instead of stretching it edge-to-edge.
  const fillCross = n.sizingH === 'fill' && parentDir === 'column'
  // Main-axis FILL is meaningless when parent is HUG main (no space to grow);
  // collapse to intrinsic.
  const collapsedFill = n.sizingH === 'fill' && parentDir === 'row' && parentHugMain
  const fixedWidth = !isHug && !fillMain && !fillCross && !collapsedFill ? n.width : undefined
  if (wrapperName) {
    ctx.usedTypography.add(wrapperName)
    const attrs: ast.JsxAttributeLike[] = []
    const wrapperProps: Record<string, unknown> = {}
    const inlineStyles: Record<string, unknown> = {}
    if (fixedWidth !== undefined) wrapperProps.width = fixedWidth
    if (fillMain) { wrapperProps.flex = 1; wrapperProps.minWidth = 0 }
    if (fillCross) wrapperProps.alignSelf = 'stretch'
    // figma HUG: width = intrinsic max-content, parent overflows. CSS equivalent:
    // whiteSpace:nowrap (don't soft-wrap) + flex-shrink:0 (don't shrink below natural).
    // figma HUG: width = intrinsic max-content. `nowrap` prevents soft-wrap;
    // explicit `<br/>` (see textChildren) still creates the figma-authored
    // hard breaks regardless of nowrap.
    if (isHug) wrapperProps.whiteSpace = 'nowrap'
    // Typography wrappers extend HTMLStyledProps<'span'>, so panda style props
    // (color, bg, etc.) pass through `splitCssProps` and merge into className
    // via css(). Prefer the bound token path (resolves to var(--colors-...))
    // — falls back to raw hex/rgba when no figma variable is bound.
    const colorTokenPath = requireTokenPath(n.tokenIds?.color, ctx.tokenMap, `${n.figmaId}.color`)
    if (colorTokenPath) {
      wrapperProps.color = colorTokenPath
    } else if (n.color) {
      inlineStyles.color = n.color
    }
    // figma fontName — emit verbatim (family + style). family is e.g.
    // "Wanted Sans Variable" or "goorm Sans Code"; style is the
    // designer-authored string (any text — "Bold", "400", "Regular").
    // The DS layer (typography wrapper / Text impl) maps style to CSS
    // font-weight/font-style if needed; pixpec stays format-agnostic.
    if (n.fontFamily) {
      inlineStyles.fontFamily = `"${n.fontFamily}", system-ui, sans-serif`
    }
    if (n.fontStyle) wrapperProps.fontStyle = n.fontStyle
    // figma's HUG width = ceil(advance) creates 0..1 css slack. textAlignHorizontal
    // distributes that slack: LEFT→right, CENTER→half each side, RIGHT→left. Chromium
    // default text-align: start (= LEFT) leaves slack on the right, mismatching figma's
    // CENTER/RIGHT placement by slack/2 or slack css. Mirror figma's choice when not LEFT.
    // JUSTIFIED on single-line falls back to start in CSS, matching figma's behavior.
    if (n.textAlign && n.textAlign !== 'left' && n.textAlign !== 'justify') {
      wrapperProps.textAlign = n.textAlign
    }
    if (n.textDecoration) wrapperProps.textDecoration =
      n.textDecoration === 'UNDERLINE' ? 'underline'
      : n.textDecoration === 'STRIKETHROUGH' ? 'line-through'
      : n.textDecoration.toLowerCase()
    attrs.push(...attrsFromObject(pandaize(wrapperProps, ctx.remBase)))
    if (Object.keys(inlineStyles).length) {
      attrs.push(f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(inlineStyles))))
    }
    const open = f.createJsxOpeningElement(
      f.createIdentifier(wrapperName), undefined, f.createJsxAttributes(attrs),
    )
    const close = f.createJsxClosingElement(f.createIdentifier(wrapperName))
    // Pass raw string (with `\n`) to typography wrapper; wrapper handles
    // paragraph splitting itself per design-system metadata. Use a template
    // literal so non-ASCII characters (Korean, emoji, etc.) survive the TS
    // printer's default \uXXXX escape behavior.
    const child: ast.JsxChild = n.content.includes('\n')
      ? f.createJsxExpression(undefined, f.createNoSubstitutionTemplateLiteral(n.content, noTokenFlags))
      : f.createJsxText(n.content)
    return f.createJsxElement(open, [child], close)
  }
  // Fallback: styled span (when textStyleId missing or unknown).
  const styles: Record<string, unknown> = {
    fontSize: resolveValue(n.fontSize, n.tokenIds?.fontSize, ctx.tokenMap, `${n.figmaId}.fontSize`, ctx.tokenValueMap),
    lineHeight: resolveValue(n.lineHeight, n.tokenIds?.lineHeight, ctx.tokenMap, `${n.figmaId}.lineHeight`, ctx.tokenValueMap),
    color: resolveValue(n.color, n.tokenIds?.color, ctx.tokenMap, `${n.figmaId}.color`, ctx.tokenValueMap),
  }
  if (n.fontFamily) styles.fontFamily = `"${n.fontFamily}", system-ui, sans-serif`
  if (n.fontStyle) styles.fontStyle = n.fontStyle
  if (n.textAlign) styles.textAlign = n.textAlign
  // figma → CSS text-decoration: UNDERLINE → underline, STRIKETHROUGH →
  // line-through. Fallthrough on unknown values keeps the figma string.
  if (n.textDecoration) styles.textDecoration =
    n.textDecoration === 'UNDERLINE' ? 'underline'
    : n.textDecoration === 'STRIKETHROUGH' ? 'line-through'
    : n.textDecoration.toLowerCase()
  if (fixedWidth !== undefined) styles.width = fixedWidth
  if (fillMain) { styles.flex = 1; styles.minWidth = 0 }
  if (fillCross) styles.alignSelf = 'stretch'
  if (isHug) styles.whiteSpace = 'nowrap'
  const open = f.createJsxOpeningElement(
    f.createIdentifier('span'), undefined,
    f.createJsxAttributes([cssAttr(styles, ctx)]),
  )
  const close = f.createJsxClosingElement(f.createIdentifier('span'))
  return f.createJsxElement(open, paragraphChildren(n.content, n.paragraphSpacing, ctx.remBase), close)
}

/** Multi-paragraph block split with `marginBottom: paragraphSpacing` between
 * paragraphs (no spacing on last). Single-paragraph content returns plain text. */
function paragraphChildren(content: string, paragraphSpacing: number, remBase: number): ast.JsxChild[] {
  const paragraphs = content.split('\n')
  if (paragraphs.length <= 1 || paragraphSpacing <= 0) return textChildren(content)
  return paragraphs.map((p, i) => {
    const isLast = i === paragraphs.length - 1
    const styles: Record<string, unknown> = {
      display: 'block',
      whiteSpace: 'inherit',
      ...(isLast ? {} : { marginBottom: px2rem(paragraphSpacing, remBase) }),
    }
    const open = f.createJsxOpeningElement(
      f.createIdentifier('span'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('style'),
          f.createJsxExpression(undefined, valueToExpr(styles))),
      ]),
    )
    return f.createJsxElement(open, [f.createJsxText(p)],
      f.createJsxClosingElement(f.createIdentifier('span')))
  })
}

/**
 * Convert figma `characters` to JSX children. Hard breaks (\n) become explicit
 * `<br/>` so they survive HTML whitespace collapsing regardless of the
 * surrounding white-space CSS — relying on `pre`/`pre-line` is fragile inside
 * `inline-block + width: max-content(...)`.
 */
function textChildren(content: string): ast.JsxChild[] {
  if (!content.includes('\n')) return [f.createJsxText(content)]
  const out: ast.JsxChild[] = []
  const parts = content.split('\n')
  parts.forEach((p, i) => {
    if (p) out.push(f.createJsxText(p))
    if (i < parts.length - 1) {
      out.push(f.createJsxSelfClosingElement(
        f.createIdentifier('br'), undefined, f.createJsxAttributes([]),
      ))
    }
  })
  return out
}

function emitVector(n: IRVector): ast.JsxSelfClosingElement {
  const styles = { width: n.width, height: n.height, background: n.fills[0] ?? '#ccc' }
  return f.createJsxSelfClosingElement(
    f.createIdentifier('div'), undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(styles))),
    ]),
  )
}

/**
 * Emit a figma shape primitive as inline SVG. SVG preserves sub-pixel
 * rasterization (HTML <div> snaps left-edge to integer css px in chromium —
 * see SnapGridProbe). For shapes inside flex layouts that may end up at
 * sub-pixel x positions (odd parity), this is the only way to match figma.
 *
 * Layout: outer <svg> takes flex slot of width×height; <rect>/<ellipse>/etc
 * are at (0,0) within. Rotation handled via SVG transform attribute (figma
 * CCW deg ↔ SVG rotate CW negative).
 */
function emitShape(n: IRShape, ctx: CodegenCtx, parent: ParentCtx = { dir: 'none', mainSizing: 'fixed' }): ast.JsxElement {
  const { width: w, height: h } = n
  requireTokenPath(n.fillTokenId, ctx.tokenMap, `${n.figmaId}.fill`)
  // SVG `fill=` is a raw attribute — panda token paths like
  // `content.standard.secondary` would not resolve. Use the raw hex/rgba.
  const fill = n.fill ?? 'none'
  // Use panda's `styled.svg` so width/height/display/flexShrink become
  // atomic CSS classes (rem-based, scale with verify-mode supersample
  // htmlFs=128). viewBox stays as a raw SVG attr — viewBox→box scaling
  // renders inner cx/cy/rx/ry at the scaled size automatically.
  ctx.usedJsxPatterns.add('styled')
  // Compute child element attrs based on shape kind
  let inner: ast.JsxChild
  // Always emit fill attr — SVG default fill is BLACK when omitted, so a
  // figma shape with no fill (designer-intentional spacer) would render
  // as a black blob. fill="none" preserves layout slot with zero ink.
  const innerAttrs: Record<string, unknown> = { fill }
  if (n.strokeColor) {
    innerAttrs.stroke = n.strokeColor
    innerAttrs['strokeWidth'] = n.strokeWeight ?? 1
  }
  // figma rotation: rotate around shape center (figma rotates around top-left
  // of pre-rotation bounding box, but with absoluteBoundingBox already
  // post-rotation in IR, we render at (0,0) and rotate within the box).
  if (n.rotation && Math.abs(n.rotation) > 0.01) {
    innerAttrs.transform = `rotate(${-n.rotation} ${w / 2} ${h / 2})`
  }
  if (n.shape === 'rect') {
    const tl = n.borderRadiusTopLeft ?? 0
    const tr = n.borderRadiusTopRight ?? 0
    const br = n.borderRadiusBottomRight ?? 0
    const bl = n.borderRadiusBottomLeft ?? 0
    const hasPerCorner = (tl || tr || br || bl) && !n.borderRadius
    if (hasPerCorner) {
      // Per-corner radii — SVG <rect> only supports uniform rx/ry, so emit a
      // <path> with explicit corner arcs. Path traces top→right→bottom→left,
      // each corner using `A r r 0 0 1 x y` for a clockwise quarter-circle.
      const d = [
        `M${tl},0`,
        `L${w - tr},0`,
        tr ? `A${tr},${tr} 0 0 1 ${w},${tr}` : '',
        `L${w},${h - br}`,
        br ? `A${br},${br} 0 0 1 ${w - br},${h}` : '',
        `L${bl},${h}`,
        bl ? `A${bl},${bl} 0 0 1 0,${h - bl}` : '',
        `L0,${tl}`,
        tl ? `A${tl},${tl} 0 0 1 ${tl},0` : '',
        'Z',
      ].filter(Boolean).join(' ')
      innerAttrs.d = d
      inner = f.createJsxSelfClosingElement(
        f.createIdentifier('path'), undefined,
        f.createJsxAttributes(
          Object.entries(innerAttrs).map(([k, v]) =>
            f.createJsxAttribute(
              f.createIdentifier(k),
              typeof v === 'string' ? stringLiteral(v)
                : f.createJsxExpression(undefined, valueToExpr(v)),
            ),
          ),
        ),
      )
    } else {
    if (n.borderRadius) { innerAttrs.rx = n.borderRadius; innerAttrs.ry = n.borderRadius }
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
  } else if (n.shape === 'ellipse') {
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
  } else {
    // polygon/star/line — fallback to filled rect (will be a coarse approx)
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
  // factory signature: (expression, questionDotToken, name, flags) — pass
  // undefined for questionDotToken or `name` lands in the wrong slot.
  const styledSvg = () => f.createPropertyAccessExpression(
    f.createIdentifier('styled'), undefined, f.createIdentifier('svg'),
  )
  const svgAttrs: ast.JsxAttribute[] = [
    f.createJsxAttribute(f.createIdentifier('viewBox'), stringLiteral(`0 0 ${w} ${h}`)),
    f.createJsxAttribute(f.createIdentifier('display'), stringLiteral('block')),
    f.createJsxAttribute(f.createIdentifier('flexShrink'), f.createJsxExpression(undefined, valueToExpr(0))),
    f.createJsxAttribute(f.createIdentifier('width'), stringLiteral(px2remPanda(w, ctx.remBase))),
    f.createJsxAttribute(f.createIdentifier('height'), stringLiteral(px2remPanda(h, ctx.remBase))),
  ]
  if (n.opacity !== undefined) svgAttrs.push(
    f.createJsxAttribute(f.createIdentifier('opacity'), f.createJsxExpression(undefined, valueToExpr(n.opacity))),
  )
  const open = f.createJsxOpeningElement(styledSvg(), undefined, f.createJsxAttributes(svgAttrs))
  const close = f.createJsxClosingElement(styledSvg())
  return f.createJsxElement(open, [inner], close)
}

/** Inline figma vector export (GROUP/VECTOR/BOOLEAN_OPERATION) as an
 * <img src="data:image/svg+xml;base64,...">. SVG keeps vector fidelity at
 * any DPR; the data URL embedding keeps the generated component
 * self-contained (no external asset dir to ship). */
function emitImage(n: IRImage, ctx: CodegenCtx): ast.JsxSelfClosingElement {
  // HTML <img> width/height attrs are raw px and bypass the verify-mode
  // 8x html font-size supersample. Use rem-based style.width/height instead
  // so the img scales with the rest of the codegen output.
  const styles: Record<string, unknown> = {
    display: 'block', flexShrink: 0,
    width: px2rem(n.width, ctx.remBase),
    height: px2rem(n.height, ctx.remBase),
  }
  if (n.opacity !== undefined) styles.opacity = n.opacity
  // No SVG dataUrl (figma export failed — typically empty/invisible Icon
  // instance). Emit a div placeholder so layout slot is preserved without
  // triggering the React "empty src" warning + duplicate page download.
  if (!n.dataUrl) {
    return f.createJsxSelfClosingElement(
      f.createIdentifier('div'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('style'),
          f.createJsxExpression(undefined, valueToExpr(styles))),
      ]),
    )
  }
  return f.createJsxSelfClosingElement(
    f.createIdentifier('img'), undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(f.createIdentifier('src'),
        stringLiteral(n.dataUrl)),
      f.createJsxAttribute(f.createIdentifier('alt'), stringLiteral('')),
      f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(styles))),
    ]),
  )
}

function emitUnknown(n: IRUnknown): ast.JsxSelfClosingElement {
  // Zero-area unknowns (lines, hover-state placeholders) shouldn't perturb flex layout.
  if (n.width === 0 || n.height === 0) {
    return f.createJsxSelfClosingElement(
      f.createIdentifier('div'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('style'),
          f.createJsxExpression(undefined, valueToExpr({ display: 'none' }))),
      ]),
    )
  }
  const styles = { width: n.width, height: n.height, background: '#f00' }
  return f.createJsxSelfClosingElement(
    f.createIdentifier('div'), undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(styles))),
    ]),
  )
}

interface CodegenCtx {
  typographyMap: Record<string, string>
  usedTypography: Set<string>
  /** Set when any emitted style is wrapped in `css({...})` — adds the panda
   * import to the generated file. */
  usesCss: boolean
  /** Panda jsx patterns referenced (Flex, Stack, Box). One import per use. */
  usedJsxPatterns: Set<string>
  /** figma variable id → panda token path (e.g. "background.standard.primary"). */
  tokenMap: Record<string, string>
  /** figma variable id → numeric value (FLOAT vars only). Used to detect
   * scaled-instance values that diverge from the bound token's intrinsic
   * value (e.g. master radius=6 with token radius/200, instance scaled
   * 32/28 → cornerRadius=6.857). When raw ≠ token value, emit raw. */
  tokenValueMap: Record<string, number>
  /** REM base in CSS px. From pixpec.toml `remBase` (default 16). All emitted
   * numeric figma-px values become `(value/remBase)rem`. */
  remBase: number
  /** DS-specific codegen extensions (Icon currentColor, etc.). Each plugin's
   * `emitWrap` runs after the default JSX is built per node. */
  plugins: import('../types.ts').CodegenPlugin[]
}

/** Wrap a JSX child in a `<span style={...}>`. Exposed to plugins via EmitContext. */
function wrapWithStyle(jsx: ast.JsxChild, style: Record<string, unknown>, ctx: CodegenCtx): ast.JsxChild {
  // styled.span with atomic Panda props — each style entry becomes a CSS
  // class statically extractable by panda postcss. The `style={{}}` inline
  // form would bypass Panda's class system and force inline declarations.
  ctx.usedJsxPatterns.add('styled')
  const tag = () => f.createPropertyAccessExpression(
    f.createIdentifier('styled'), undefined, f.createIdentifier('span'),
  )
  const attrs = attrsFromObject(pandaize(style, ctx.remBase))
  return f.createJsxElement(
    f.createJsxOpeningElement(tag(), undefined, f.createJsxAttributes(attrs)),
    [jsx],
    f.createJsxClosingElement(tag()),
  )
}

/** Wrap a JSX child in a `<span className={css({...})}>`. Token-aware. */
function wrapWithCss(jsx: ast.JsxChild, style: Record<string, unknown>, ctx: CodegenCtx): ast.JsxChild {
  const open = f.createJsxOpeningElement(
    f.createIdentifier('span'), undefined,
    f.createJsxAttributes([cssAttr(style, ctx)]),
  )
  return f.createJsxElement(open, [jsx],
    f.createJsxClosingElement(f.createIdentifier('span')))
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
    jsx,
    jsx.tagName,
    jsx.typeArguments,
    f.createJsxAttributes([...jsx.attributes.properties, attr]),
  )
}

function resolveTokenPath(tokenId: string | undefined, tokenMap: Record<string, string>): string | undefined {
  if (!tokenId) return undefined
  if (tokenMap[tokenId]) return tokenMap[tokenId]
  const key = /^VariableID:([^/]+)\//.exec(tokenId)?.[1]
  if (key && tokenMap[key]) return tokenMap[key]
  const localId = /^VariableID:[^/]+\/(.+)$/.exec(tokenId)?.[1]
  if (localId && tokenMap[`VariableID:${localId}`]) return tokenMap[`VariableID:${localId}`]
  return undefined
}

function requireTokenPath(tokenId: string | undefined, tokenMap: Record<string, string>, label: string): string | undefined {
  if (!tokenId) return undefined
  const tokenPath = resolveTokenPath(tokenId, tokenMap)
  if (!tokenPath) {
    throw new Error(`[pixpec generate] unresolved design token for ${label}: ${tokenId}`)
  }
  return tokenPath
}

function colorTokenVar(tokenPath: string): string {
  return `var(--colors-${tokenPath.replace(/\./g, '-')})`
}

/** Token-or-px helper: when a figma variable id is bound, emit the panda
 * token path. Otherwise emit `<n>px` (or pass-through string). */
function resolveValue(rawValue: number | string | undefined, tokenId: string | undefined, tokenMap: Record<string, string>, label: string, tokenValueMap?: Record<string, number>): string | number | undefined {
  const tokenPath = requireTokenPath(tokenId, tokenMap, label)
  if (tokenPath) {
    // Scaled instance: figma inherits the master's variable binding through
    // a corner-drag, but the rendered numeric value diverges from the
    // variable's intrinsic value. Compare and emit raw on mismatch — the
    // variable name is no longer truthful for this node.
    if (typeof rawValue === 'number' && tokenId && tokenValueMap && tokenId in tokenValueMap) {
      const tokVal = tokenValueMap[tokenId]
      if (Math.abs(rawValue - tokVal) > 0.01) return rawValue
    }
    return tokenPath
  }
  return rawValue
}

/** figma px → rem string. base from pixpec.toml `remBase` (default 16,
 * matches CSS default html font-size). Emitting rem (not px) lets verify-mode
 * harness scale the html font-size to supersample text layout — chrom's Skia
 * glyph advance is dpr-dependent at small font sizes (14px @ dpr=8 measures
 * ~1.36c smaller than dpr=2), so capturing at dpr=2 with 4× rem-base produces
 * a 56px effective render that downsamples cleanly to figma scale=8 and
 * preserves dpr=2 advance precision. Production at default html font-size:
 * 1rem = 16px, unaffected.
 */
const px2rem = (v: number, base: number): string =>
  `${+(v / base).toFixed(6)}rem`

/** Panda atomic class names cap at 3-decimal precision in our setup —
 * `bdr_0.4286rem` (4dp) doesn't extract a CSS rule while `bdr_0.429rem`
 * (3dp) does. Use this when emitting Panda style props (atomic class).
 * Inline `style={{...}}` callers should keep `px2rem` (full precision). */
const px2remPanda = (v: number, base: number): string =>
  `${+(v / base).toFixed(3)}rem`

/**
 * Numeric → 'rem' string for properties that panda interprets as token
 * references when given a bare number (spacing/sizing/radius/border). Other
 * properties (flex, opacity, fontWeight) pass through.
 */
const PX_PROPS = new Set([
  'gap', 'rowGap', 'columnGap',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingInline', 'paddingBlock',
  'p', 'pt', 'pr', 'pb', 'pl', 'px', 'py',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginInline', 'marginBlock',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'top', 'right', 'bottom', 'left', 'inset',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'borderWidth', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontSize', 'lineHeight',
])

function compactPaddingStyles(styles: Record<string, unknown>): Record<string, unknown> {
  const top = styles.paddingTop
  const right = styles.paddingRight
  const bottom = styles.paddingBottom
  const left = styles.paddingLeft
  const out = { ...styles }
  delete out.paddingTop
  delete out.paddingRight
  delete out.paddingBottom
  delete out.paddingLeft

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

function pandaize(styles: Record<string, unknown>, remBase: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(styles)) {
    // Use 3dp rem for Panda atomic emit — Panda's class-name extractor
    // tops out at 3 decimals (`bdr_0.429rem` extracts; `bdr_0.4286rem`
    // doesn't). For 4+dp we emit raw value via inline `style` instead.
    out[k] = typeof v === 'number' && PX_PROPS.has(k) ? px2remPanda(v, remBase) : v
  }
  return out
}

/** Build `className={css({...})}` JSX attribute (panda CSS). */
function cssAttr(styles: Record<string, unknown>, ctx: CodegenCtx): ast.JsxAttribute {
  ctx.usesCss = true
  const obj = pandaize(styles, ctx.remBase)
  const call = callExpression(f.createIdentifier('css'), [valueToExpr(obj)])
  return f.createJsxAttribute(
    f.createIdentifier('className'),
    f.createJsxExpression(undefined, call),
  )
}

function lookupTypoByPrefix(liveId: string, map: Record<string, string>): string | undefined {
  // Direct match first.
  if (map[liveId]) return map[liveId]
  for (const key of Object.keys(map)) {
    if (liveId.startsWith(key)) return map[key]
  }
  return undefined
}

interface ParentCtx {
  dir: 'row' | 'column' | 'none'
  /** Parent main-axis sizing — when 'hug', child FILL on main axis collapses to HUG (no flex:1) */
  mainSizing: 'fixed' | 'hug' | 'fill'
}

function emitNode(n: IRNode, ctx: CodegenCtx, parent: ParentCtx = { dir: 'none', mainSizing: 'fixed' }): ast.JsxChild {
  let jsx: ast.JsxChild
  switch (n.kind) {
    case 'component': jsx = emitComponent(n, ctx, parent); break
    case 'frame': jsx = emitFrame(n, ctx, parent); break
    case 'text': jsx = emitText(n, ctx, parent); break
    case 'vector': jsx = emitVector(n); break
    case 'shape': jsx = emitShape(n, ctx, parent); break
    case 'image': jsx = emitImage(n, ctx); break
    case 'unknown': jsx = emitUnknown(n); break
  }
  // Plugin emitWrap chain — DS-specific wrapping (e.g. Icon currentColor).
  // Runs BEFORE layout wrap so plugin spans sit between the component and
  // its outer layout span.
  if (ctx.plugins.length) {
    const ectx = {
      parentDir: parent.dir,
      tokenMap: ctx.tokenMap,
      resolveTokenPath: (tokenId: string | undefined) => requireTokenPath(tokenId, ctx.tokenMap, 'plugin token'),
      wrapWithStyle: (child: ast.JsxChild, style: Record<string, unknown>) => wrapWithStyle(child, style, ctx),
      wrapWithCss: (child: ast.JsxChild, style: Record<string, unknown>) => wrapWithCss(child, style, ctx),
      jsxAttr,
      styleAttr,
      appendJsxAttr,
    }
    for (const p of ctx.plugins) {
      if (p.emitWrap) jsx = p.emitWrap(n, jsx, ectx)
    }
  }
  // Rotation-aware layout wrap — CSS transform does not affect flex layout, so
  // rotated component instances still need an outer bbox reservation. Only
  // FIXED axes receive explicit width/height; HUG remains intrinsic and FILL
  // remains a flex/stretch constraint.
  if (n.kind === 'component' && parent.dir !== 'none' && n.rotation !== undefined) {
    const ws: Record<string, unknown> = {}
    const fixedH = n.sizingH === 'fixed'
    const fixedV = n.sizingV === 'fixed'
    if (fixedH && fixedV) ws.flexShrink = 0
    const w = n.width, h = n.height
    let rotW = w, rotH = h
    if (Math.abs(n.rotation) > 0.01 && typeof w === 'number' && typeof h === 'number') {
      const r = (n.rotation * Math.PI) / 180
      const cs = Math.abs(Math.cos(r)), sn = Math.abs(Math.sin(r))
      rotW = w * cs + h * sn
      rotH = w * sn + h * cs
      // Math.cos(π/2) = 6.12e-17 (not exactly 0) → for 90° rotation, w*cs leaks
      // a 1.0000000000000016 instead of 1. Such sub-femto-pixel values become
      // sub-pixel layout positions in chromium and shift downstream items.
      // Round near-integer values to integer (within 1e-9 = nano-pixel).
      const snap = (v: number) => Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v
      rotW = snap(rotW)
      rotH = snap(rotH)
    }
    if (fixedH && typeof rotW === 'number') ws.width = px2remPanda(rotW, ctx.remBase)
    if (fixedV && typeof rotH === 'number') ws.height = px2remPanda(rotH, ctx.remBase)
    jsx = wrapWithStyle(jsx, { ...ws, display: 'inline-block' }, ctx)
  }
  // (no shrink-wrap span — AGENTS.md: 1 figma node = 1 JSX element. The
  // flex-shrink:0 prop is emitted as a Panda style prop directly on the
  // component element by emitComponent's componentLayoutStyles below.)
  // figma layoutPositioning=ABSOLUTE → child overlays parent at (x,y).
  // Wrap with position:absolute + left/top so the child sits outside flex
  // flow but still in DOM. Parent gets position:relative emitted in emitFrame.
  if (n.absolute) {
    jsx = wrapWithStyle(jsx, {
      position: 'absolute',
      left: typeof n.absX === 'number' ? px2remPanda(n.absX, ctx.remBase) : '0rem',
      top: typeof n.absY === 'number' ? px2remPanda(n.absY, ctx.remBase) : '0rem',
    }, ctx)
  }
  return jsx
}

function collectComponents(node: IRNode, set: Set<string>): void {
  if (node.kind === 'component') set.add(node.componentName)
  if (node.kind === 'frame') for (const c of node.children) collectComponents(c, set)
}

/** Generate self-contained tsx file source. */
export function generate(
  root: IRNode,
  components: Component<unknown>[],
  typographyMap: Record<string, string> = {},
  tokenMap: Record<string, string> = {},
  plugins: import('../types.ts').CodegenPlugin[] = [],
  remBase: number = 16,
  tokenValueMap: Record<string, number> = {},
): string {
  hydrate(root, components)
  const usedComponents = new Set<string>()
  collectComponents(root, usedComponents)
  const ctx: CodegenCtx = {
    typographyMap, usedTypography: new Set(),
    usesCss: false, usedJsxPatterns: new Set(),
    tokenMap,
    tokenValueMap,
    remBase,
    plugins,
  }

  const componentImports = [...usedComponents].sort().map((n) =>
    f.createImportDeclaration(undefined,
      f.createImportClause(undefined, undefined,
        f.createNamedImports([
          f.createImportSpecifier(false, f.createIdentifier('impl'), f.createIdentifier(n)),
        ])),
      stringLiteral(`../${n}/impl.tsx`),
    ),
  )
  // Pre-emit body so usedTypography is populated.
  const body = emitNode(root, ctx) as ast.Expression
  const typographyImports = ctx.usedTypography.size > 0
    ? [f.createImportDeclaration(undefined,
        f.createImportClause(undefined, undefined,
          f.createNamedImports([...ctx.usedTypography].sort().map((n) =>
            f.createImportSpecifier(false, undefined, f.createIdentifier(n))))),
        stringLiteral('../typography/index.tsx'))]
    : []
  const cssImport = ctx.usesCss
    ? [f.createImportDeclaration(undefined,
        f.createImportClause(undefined, undefined,
          f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier('css'))])),
        stringLiteral('../../../styled-system/css'))]
    : []
  const jsxPatternImport = ctx.usedJsxPatterns.size > 0
    ? [f.createImportDeclaration(undefined,
        f.createImportClause(undefined, undefined,
          f.createNamedImports([...ctx.usedJsxPatterns].sort().map((n) =>
            f.createImportSpecifier(false, undefined, f.createIdentifier(n))))),
        stringLiteral('../../../styled-system/jsx'))]
    : []
  const importStatements = [...componentImports, ...typographyImports, ...cssImport, ...jsxPatternImport]
  const fcImport = f.createImportDeclaration(undefined,
    f.createImportClause(ast.SyntaxKind.TypeKeyword, undefined,
      f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier('FC'))])),
    stringLiteral('react'),
  )
  const generatedFn = f.createVariableStatement(
    [exportModifier()],
    f.createVariableDeclarationList([
      f.createVariableDeclaration(
        f.createIdentifier('Generated'),
        undefined,
        f.createTypeReferenceNode(f.createIdentifier('FC')),
        f.createArrowFunction(undefined, undefined, [], undefined,
          f.createToken(ast.SyntaxKind.EqualsGreaterThanToken),
          f.createParenthesizedExpression(body),
        ),
      ),
    ], nodeFlagsConst),
  )
  const implExport = f.createVariableStatement(
    [exportModifier()],
    f.createVariableDeclarationList([
      f.createVariableDeclaration(
        f.createIdentifier('impl'),
        undefined,
        f.createTypeReferenceNode(f.createIdentifier('FC')),
        f.createArrowFunction(undefined, undefined, [], undefined,
          f.createToken(ast.SyntaxKind.EqualsGreaterThanToken),
          f.createJsxSelfClosingElement(f.createIdentifier('Generated'), undefined, f.createJsxAttributes([])),
        ),
      ),
    ], nodeFlagsConst),
  )
  const sourceFile = f.createSourceFile(
    [fcImport, ...importStatements, generatedFn, implExport],
    f.createToken(ast.SyntaxKind.EndOfFile),
    '',
    '/__pixpec_generated.tsx' as ast.Path,
    '/__pixpec_generated.tsx' as ast.Path,
  )
  return printSourceFile(sourceFile)
}
