/**
 * IR → React + PandaCSS JSX codegen using TypeScript factory + printer.
 *
 *   - Type-safe AST construction (ts.factory.*)
 *   - Printer handles escaping, indentation, JSX text/expression boundaries
 *   - No string concatenation
 *
 * Phase 0 mappings:
 *   IRComponent → <Name {...props} />
 *   IRFrame     → <div style={{...}}>{children}</div>
 *   IRText      → <span style={{...}}>content</span>
 *   IRVector / IRUnknown → placeholder div
 *
 * fromInstance() runs in hydrate() pass before codegen.
 */
import * as ts from 'typescript'
import type { Component } from '../types.ts'
import type { IRNode, IRComponent, IRFrame, IRText, IRVector, IRUnknown } from './ir.ts'

const f = ts.factory

interface IRComponentRaw extends IRComponent {
  raw: unknown
}

/** Apply each registered component's fromInstance to fill .props. Mutates. */
export function hydrate(node: IRNode, components: Component<unknown>[]): IRNode {
  if (node.kind === 'component') {
    const c = node as IRComponentRaw
    const comp = components.find((x) => x.name === c.componentName)
    if (comp?.figma) c.props = comp.figma.fromInstance(c.raw as never) as Record<string, unknown>
    delete (c as Partial<IRComponentRaw>).raw
  }
  if (node.kind === 'frame') for (const ch of node.children) hydrate(ch, components)
  return node
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** JS value → ts AST expression. Handles primitives, arrays, plain objects. */
function valueToExpr(v: unknown): ts.Expression {
  if (v === null) return f.createNull()
  if (v === undefined) return f.createIdentifier('undefined')
  if (typeof v === 'boolean') return v ? f.createTrue() : f.createFalse()
  if (typeof v === 'number') return f.createNumericLiteral(v)
  if (typeof v === 'string') return f.createStringLiteral(v)
  if (Array.isArray(v)) return f.createArrayLiteralExpression(v.map(valueToExpr))
  if (typeof v === 'object') {
    const props = Object.entries(v as Record<string, unknown>).map(([k, val]) => {
      const name = IDENT_RE.test(k) ? f.createIdentifier(k) : f.createStringLiteral(k)
      return f.createPropertyAssignment(name, valueToExpr(val))
    })
    return f.createObjectLiteralExpression(props, false)
  }
  return f.createStringLiteral(String(v))
}

/** Build JSX attributes; identifier-safe keys go inline, rest go via spread. */
function attrsFromObject(obj: Record<string, unknown>): ts.JsxAttributeLike[] {
  const inline: ts.JsxAttribute[] = []
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (IDENT_RE.test(k)) {
      inline.push(f.createJsxAttribute(
        f.createIdentifier(k),
        f.createJsxExpression(undefined, valueToExpr(v)),
      ))
    } else {
      rest[k] = v
    }
  }
  if (Object.keys(rest).length) {
    inline.push(f.createJsxSpreadAttribute(valueToExpr(rest)) as ts.JsxAttributeLike as ts.JsxAttribute)
  }
  return inline
}

function emitComponent(n: IRComponent): ts.JsxSelfClosingElement {
  return f.createJsxSelfClosingElement(
    f.createIdentifier(n.componentName),
    undefined,
    f.createJsxAttributes(attrsFromObject(n.props)),
  )
}

function emitFrame(n: IRFrame, ctx: CodegenCtx): ts.JsxElement {
  const flexDir = n.layout.direction === 'none' ? null : n.layout.direction
  const styles: Record<string, unknown> = {}
  if (flexDir) {
    styles.display = 'flex'
    styles.flexDirection = flexDir
    if (n.layout.alignItems !== 'start') styles.alignItems = n.layout.alignItems
    if (n.layout.justifyContent !== 'start') styles.justifyContent = n.layout.justifyContent
    if (n.layout.gap) styles.gap = n.layout.gap
  }
  if (n.layout.paddingTop) styles.paddingTop = n.layout.paddingTop
  if (n.layout.paddingRight) styles.paddingRight = n.layout.paddingRight
  if (n.layout.paddingBottom) styles.paddingBottom = n.layout.paddingBottom
  if (n.layout.paddingLeft) styles.paddingLeft = n.layout.paddingLeft
  if (n.width !== undefined) styles.width = n.width
  if (n.height !== undefined) styles.height = n.height
  if (n.background) styles.background = n.background
  if (n.borderRadius) styles.borderRadius = n.borderRadius

  const styleAttr = Object.keys(styles).length
    ? [f.createJsxAttribute(f.createIdentifier('style'), f.createJsxExpression(undefined, valueToExpr(styles)))]
    : []
  const open = f.createJsxOpeningElement(
    f.createIdentifier('div'), undefined, f.createJsxAttributes(styleAttr),
  )
  const close = f.createJsxClosingElement(f.createIdentifier('div'))
  const children = n.children.map((c) => emitNode(c, ctx))
  return f.createJsxElement(open, children, close)
}

function emitText(n: IRText, ctx: CodegenCtx): ts.JsxElement {
  // If textStyleId matches a registered typography wrapper, use it.
  // The wrapper handles fontSize/lineHeight/weight/y-shift internally.
  // Live textStyleId format: "S:<hash>,<nodeSuffix>"; binding keys end in
  // ",", so binding key is a prefix of the live id.
  const wrapperName = n.textStyleId ? lookupTypoByPrefix(n.textStyleId, ctx.typographyMap) : undefined
  if (wrapperName) {
    ctx.usedTypography.add(wrapperName)
    const open = f.createJsxOpeningElement(
      f.createIdentifier(wrapperName), undefined, f.createJsxAttributes([]),
    )
    const close = f.createJsxClosingElement(f.createIdentifier(wrapperName))
    return f.createJsxElement(open, [f.createJsxText(n.content)], close)
  }
  // Fallback: styled span (when textStyleId missing or unknown).
  const styles: Record<string, unknown> = {
    fontSize: n.fontSize,
    lineHeight: `${n.lineHeight}px`,
    fontWeight: n.fontWeight,
    color: n.color,
  }
  if (n.textAlign) styles.textAlign = n.textAlign
  const open = f.createJsxOpeningElement(
    f.createIdentifier('span'), undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(styles))),
    ]),
  )
  const close = f.createJsxClosingElement(f.createIdentifier('span'))
  return f.createJsxElement(open, [f.createJsxText(n.content)], close)
}

function emitVector(n: IRVector): ts.JsxSelfClosingElement {
  const styles = { width: n.width, height: n.height, background: n.fills[0] ?? '#ccc' }
  return f.createJsxSelfClosingElement(
    f.createIdentifier('div'), undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(styles))),
    ]),
  )
}

function emitUnknown(n: IRUnknown): ts.JsxSelfClosingElement {
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
}

function lookupTypoByPrefix(liveId: string, map: Record<string, string>): string | undefined {
  // Direct match first.
  if (map[liveId]) return map[liveId]
  for (const key of Object.keys(map)) {
    if (liveId.startsWith(key)) return map[key]
  }
  return undefined
}

function emitNode(n: IRNode, ctx: CodegenCtx): ts.JsxChild {
  switch (n.kind) {
    case 'component': return emitComponent(n)
    case 'frame': return emitFrame(n, ctx)
    case 'text': return emitText(n, ctx)
    case 'vector': return emitVector(n)
    case 'unknown': return emitUnknown(n)
  }
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
): string {
  hydrate(root, components)
  const usedComponents = new Set<string>()
  collectComponents(root, usedComponents)
  const ctx: CodegenCtx = { typographyMap, usedTypography: new Set() }

  const componentImports = [...usedComponents].sort().map((n) =>
    f.createImportDeclaration(undefined,
      f.createImportClause(false, undefined,
        f.createNamedImports([
          f.createImportSpecifier(false, f.createIdentifier('impl'), f.createIdentifier(n)),
        ])),
      f.createStringLiteral(`../${n}/impl.tsx`),
    ),
  )
  // Pre-emit body so usedTypography is populated.
  const body = emitNode(root, ctx) as ts.Expression
  const typographyImports = ctx.usedTypography.size > 0
    ? [f.createImportDeclaration(undefined,
        f.createImportClause(false, undefined,
          f.createNamedImports([...ctx.usedTypography].sort().map((n) =>
            f.createImportSpecifier(false, undefined, f.createIdentifier(n))))),
        f.createStringLiteral('../typography/index.tsx'))]
    : []
  const importStatements = [...componentImports, ...typographyImports]
  const fcImport = f.createImportDeclaration(undefined,
    f.createImportClause(true, undefined,
      f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier('FC'))])),
    f.createStringLiteral('react'),
  )
  const generatedFn = f.createVariableStatement(
    [f.createModifier(ts.SyntaxKind.ExportKeyword)],
    f.createVariableDeclarationList([
      f.createVariableDeclaration(
        f.createIdentifier('Generated'),
        undefined,
        f.createTypeReferenceNode('FC'),
        f.createArrowFunction(undefined, undefined, [], undefined,
          f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
          f.createParenthesizedExpression(body),
        ),
      ),
    ], ts.NodeFlags.Const),
  )
  const implExport = f.createVariableStatement(
    [f.createModifier(ts.SyntaxKind.ExportKeyword)],
    f.createVariableDeclarationList([
      f.createVariableDeclaration(
        f.createIdentifier('impl'),
        undefined,
        f.createTypeReferenceNode('FC'),
        f.createArrowFunction(undefined, undefined, [], undefined,
          f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
          f.createJsxSelfClosingElement(f.createIdentifier('Generated'), undefined, f.createJsxAttributes([])),
        ),
      ),
    ], ts.NodeFlags.Const),
  )
  const sourceFile = f.createSourceFile(
    [fcImport, ...importStatements, generatedFn, implExport],
    f.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  )
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
  return printer.printFile(sourceFile)
}
