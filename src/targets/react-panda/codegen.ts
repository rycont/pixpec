// React + PandaCSS target codegen: Design AST → self-contained .tsx source.

import { existsSync } from 'node:fs'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import { API } from '@typescript/native-preview/sync'
import type { DDataScope, DNode, DShape } from '../../compiler/design-ast.ts'
import { NodeKind, ShapeKind } from '../../compiler/design-ast.ts'
import type { CodegenContext, CodegenResult } from '../types.ts'
import {
    callExpression,
    exportModifier,
    jsxEl,
    jsxAttr,
    keywordExpression,
    nodeFlagsConst,
    propAccess,
    styleAttr,
    styledTag,
} from './ast.ts'
import { px2rem, sizeToPx } from './data-lowerer.ts'
import { defaultImport, namedImport, relativeImport, styledSystemPath } from './imports.ts'
import type { LowererCtx as Ctx, LowerResult, ParentCtx } from './lowerer-types.ts'
import { emptyUses, LocalCtx, mergeUses, ROOT_PARENT } from './lowerer-types.ts'
import { emitContainer, setNodeDispatcher } from './lowerers/container.ts'
import { emitImage } from './lowerers/image.ts'
import { emitInstance } from './lowerers/instance.ts'
import { emitShape } from './lowerers/shape.ts'
import { emitText } from './lowerers/text.ts'
import { emitUnknown } from './lowerers/unknown.ts'
import { emitVector } from './lowerers/vector.ts'
import { expressionPropName, literalValue, nodeSourceId, sizeToProp } from './sizing.ts'
import { squircleHookMarker } from './styles.ts'

// View-level codegen (breakdown) hands us a raw root without a DataScope
// wrapper; wrap it on the fly using ctx.componentName as the identifier.
function ensureDataScope(root: DNode, fallbackName: string): DDataScope {
    if (root.kind === NodeKind.DataScope) {
        return root as DDataScope
    }
    return {
        kind: NodeKind.DataScope,
        componentName: fallbackName || 'Generated',
        data: {},
        child: root,
    } as DDataScope
}

function propsTypeName(scope: DDataScope): string {
    return `${scope.componentName}Props`
}

function generatedPropsSource(scope: DDataScope, _rootPropsTypeName: string): string {
    // All promoted/exposed fields are emitted as REQUIRED here. The component
    // accepts `Partial<XProps>` externally and merges with module-level
    // DEFAULTS, so inside the function body every prop is guaranteed defined.
    const fields = Object.entries(scope.data)
        .map(([key, def]) => {
            const type = reactPandaPropType(def.type)
            return `    ${propsKey(key)}: ${type}`
        })
        .join('\n')
    return `export interface ${propsTypeName(scope)} {\n${fields}\n}\n`
}

function generatedDefaultsSource(scope: DDataScope): string {
    const lines = Object.entries(scope.data)
        .map(([key, def]) => `    ${propsKey(key)}: ${defaultLiteral(def)},`)
        .join('\n')
    return `const DEFAULTS: ${propsTypeName(scope)} = {\n${lines}\n}\n`
}

function propsKey(name: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function defaultLiteral(def: { type?: string; default?: unknown }): string {
    const d = def.default
    if (d === undefined || d === null) return 'undefined as never'
    if (typeof d === 'string') return JSON.stringify(d)
    if (typeof d === 'number' || typeof d === 'boolean') return String(d)
    if (typeof d === 'object') {
        const rec = d as Record<string, unknown>
        if (rec.kind === 'literal') {
            const v = rec.value
            if (typeof v === 'string') return JSON.stringify(v)
            if (typeof v === 'number' || typeof v === 'boolean') return String(v)
            if (v && typeof v === 'object') {
                const vr = v as Record<string, unknown>
                if ('unit' in vr && 'value' in vr) {
                    const num = Number(vr.value)
                    if (vr.unit === 'px') return JSON.stringify(`${+(num / 16).toFixed(6)}rem`)
                    return JSON.stringify(`${num}${vr.unit}`)
                }
                if ('r' in vr && 'g' in vr && 'b' in vr) {
                    const a = 'a' in vr ? Number(vr.a) : 1
                    return JSON.stringify(
                        a < 1
                            ? `rgba(${vr.r}, ${vr.g}, ${vr.b}, ${a})`
                            : `rgb(${vr.r}, ${vr.g}, ${vr.b})`,
                    )
                }
            }
        }
    }
    return JSON.stringify(d)
}

function reactPandaPropType(type: string | undefined): string {
    if (type === 'boolean') {
        return 'boolean'
    }
    if (type === 'number') {
        return 'number'
    }
    if (type === 'length') {
        return 'string | number'
    }
    if (
        type === 'string' ||
        type === 'color' ||
        type === 'paint' ||
        type === 'textStyle' ||
        type === 'shadow'
    ) {
        return 'string'
    }
    if (type?.startsWith('component:')) {
        return 'unknown'
    }
    return 'unknown'
}

function isPlainPxLiteral(v: unknown): boolean {
    if (!v || typeof v !== 'object') return false
    const rec = v as Record<string, unknown>
    if (rec.kind !== 'literal' || !rec.value || typeof rec.value !== 'object') return false
    return (rec.value as { unit?: string }).unit === 'px'
}

function wrapAbsolute(n: DNode, jsx: ast.JsxChild, ctx: Ctx): LowerResult {
    const uses = emptyUses()
    if (!n.absolute) {
        return { jsx, uses }
    }
    const wrapStyle: Record<string, unknown> = { position: 'absolute' }
    // Figma reports a LINE node's bbox y/x as the FAR edge of the stroke on the
    // collapsed axis. Apply a small px tweak before emitting the inset.
    let xOffset = 0
    let yOffset = 0
    if (n.kind === NodeKind.Shape && (n as DShape).shape === ShapeKind.Line) {
        const sh = n as DShape
        const sw = sizeToPx(sh.stroke?.width) ?? 1
        const w = sizeToPx(sh.width) ?? 0
        const h = sizeToPx(sh.height) ?? 0
        if (h === 0) yOffset -= sw
        if (w === 0) xOffset -= sw
    }
    if (n.renderBoundsOffset) {
        xOffset += sizeToPx(n.renderBoundsOffset.x) ?? 0
        yOffset += sizeToPx(n.renderBoundsOffset.y) ?? 0
    }
    applyAxisPosition(wrapStyle, n.absolute.horizontal, 'left', 'right', xOffset, ctx)
    applyAxisPosition(wrapStyle, n.absolute.vertical, 'top', 'bottom', yOffset, ctx)
    uses.usedJsxPatterns.add('styled')
    return {
        jsx: jsxEl(styledTag('span'), [styleAttr(wrapStyle)], [jsx]),
        uses,
    }
}

function applyAxisPosition(
    style: Record<string, unknown>,
    axis: import('../../compiler/design-ast.ts').AxisPosition | undefined,
    startKey: 'left' | 'top',
    endKey: 'right' | 'bottom',
    pxOffset: number,
    ctx: Ctx,
): void {
    if (!axis) return
    if (axis.kind === 'center') {
        // `left:50%; transform:translate(-50% + delta)` — center anchor moves
        // the child to the parent's midpoint, then offsets by delta. When BOTH
        // axes are center, both calls land here; append (don't overwrite)
        // `style.transform` so the second axis doesn't drop the first one's
        // translate.
        style[startKey] = '50%'
        const deltaProp = sizeToProp(axis.delta, ctx.env.remBase)
        const translatePct = startKey === 'left' ? 'translateX(-50%)' : 'translateY(-50%)'
        const translateAxis = startKey === 'left' ? 'translateX' : 'translateY'
        const zeroDelta =
            isPlainPxLiteral(axis.delta) &&
            typeof (axis.delta as { value: { value: number } }).value.value === 'number' &&
            (axis.delta as { value: { value: number } }).value.value === 0
        const piece = zeroDelta
            ? translatePct
            : typeof deltaProp === 'string' || typeof deltaProp === 'number'
              ? `${translatePct} ${translateAxis}(${deltaProp})`
              : undefined
        if (piece) {
            const prev = typeof style.transform === 'string' ? style.transform : undefined
            style.transform = prev ? `${prev} ${piece}` : piece
        }
        return
    }
    const startProp = sizeToProp(axis.start, ctx.env.remBase)
    const endProp = sizeToProp(axis.end, ctx.env.remBase)
    if (startProp !== undefined) {
        const isPx = isPlainPxLiteral(axis.start)
        if (isPx && pxOffset !== 0) {
            style[startKey] = px2rem((sizeToPx(axis.start) ?? 0) + pxOffset, ctx.env.remBase)
        } else {
            style[startKey] = startProp
        }
    } else if (pxOffset !== 0) {
        style[startKey] = px2rem(pxOffset, ctx.env.remBase)
    }
    if (endProp !== undefined) {
        style[endKey] = endProp
    }
}

function wrapHidden(n: DNode, jsx: ast.JsxChild, ctx: Ctx, parent: ParentCtx): LowerResult {
    const uses = emptyUses()
    const hiddenLiteral = literalValue<boolean>(n.hidden)
    if (hiddenLiteral === true) {
        return { jsx: f.createJsxExpression(undefined, keywordExpression(ast.SyntaxKind.NullKeyword)), uses }
    }
    const hiddenProp = expressionPropName(n.hidden)
    if (!hiddenProp) {
        return { jsx, uses }
    }
    const cond = f.createBinaryExpression(
        undefined,
        propAccess(hiddenProp),
        undefined,
        f.createToken(ast.SyntaxKind.ExclamationEqualsEqualsToken),
        keywordExpression(ast.SyntaxKind.FalseKeyword),
    )
    const optional = f.createConditionalExpression(
        cond,
        f.createToken(ast.SyntaxKind.QuestionToken),
        jsxChildExpression(jsx),
        f.createToken(ast.SyntaxKind.ColonToken),
        keywordExpression(ast.SyntaxKind.NullKeyword),
    )
    return { jsx: f.createJsxExpression(undefined, optional), uses }
}

function jsxChildExpression(jsx: ast.JsxChild): ast.Expression {
    const expr = ast.isJsxExpression(jsx) ? jsx.expression : jsx
    if (expr && ast.isExpression(expr)) return expr
    return jsxEl(styledTag('span'), [], [jsx])
}

setNodeDispatcher((n, ctx, parent) => emitNode(n, ctx, parent))

async function emitNode(n: DNode, ctx: Ctx, parent: ParentCtx): Promise<LowerResult> {
    if (n.kind === NodeKind.DataScope) {
        return emitNode((n as DDataScope).child, ctx, parent)
    }
    const uses = emptyUses()
    let inner: LowerResult
    switch (n.kind) {
        case NodeKind.Flex:
        case NodeKind.Stack:
        case NodeKind.Box:
            inner = await emitContainer(n, ctx, parent)
            break
        case NodeKind.Text:
            inner = await emitText(n, ctx, parent)
            break
        case NodeKind.Shape:
            inner = await emitShape(n, ctx, parent)
            break
        case NodeKind.Vector:
            inner = await emitVector(n, ctx)
            break
        case NodeKind.Image:
            inner = await emitImage(n, ctx)
            break
        case NodeKind.Instance:
            inner = await emitInstance(n, ctx, parent)
            break
        case NodeKind.Unknown:
            inner = await emitUnknown(n, ctx)
            break
    }
    mergeUses(uses, inner.uses)
    const abs = wrapAbsolute(n, inner.jsx, ctx)
    mergeUses(uses, abs.uses)
    const hidden = wrapHidden(n, abs.jsx, ctx, parent)
    mergeUses(uses, hidden.uses)
    return { jsx: hidden.jsx, uses }
}

// Top-level emit: produce a self-contained .tsx string.

interface ReactPandaCtxExt {
    /** Optional pre-booted tsgo printer (so the cli can reuse a single
     *  snapshot across components). When omitted, the emitter boots its own. */
    printNode?: (node: ast.Node) => string
    /** Component file extension override (default `tsx`). */
    fileExtension?: string
    /** Source figma node id (for the file header comment). */
    sourceId?: string
}

interface SharedPrinter {
    api: API
    printNode: (node: ast.Node) => string
}

const sharedPrinters = new Map<string, SharedPrinter>()

function getSharedPrintNode(cwd: string): (node: ast.Node) => string {
    const cached = sharedPrinters.get(cwd)
    if (cached) {
        return cached.printNode
    }

    const api = new API({ cwd })
    const here = nodePath.dirname(fileURLToPath(import.meta.url))
    const tsconfigCandidates = [
        nodePath.resolve(cwd, 'tsconfig.json'),
        nodePath.resolve(here, '../../../tsconfig.json'),
    ]
    const tsconfig = tsconfigCandidates.find((p) => existsSync(p))
    if (!tsconfig) {
        throw new Error('[react-panda target] tsgo: no tsconfig.json found')
    }
    const snap = api.updateSnapshot({ openProject: tsconfig })
    const proj = snap.getProjects()[0]
    if (!proj) {
        throw new Error('[react-panda target] tsgo: no project loaded')
    }
    const printNode = (node: ast.Node) => proj.emitter.printNode(node)
    sharedPrinters.set(cwd, { api, printNode })
    return printNode
}

function rootPropsType(root: DNode): string {
    switch (root.kind) {
        case NodeKind.Flex:
            return 'FlexProps'
        case NodeKind.Stack:
            return 'StackProps'
        default:
            return 'BoxProps'
    }
}

function ensureSourceMeta(root: DNode): DNode {
    const visit = (node: DNode, path: number[]) => {
        if (node.kind === NodeKind.DataScope) {
            visit((node as DDataScope).child, path)
            return
        }
        node.sourceId ??= path.length === 0 ? 'root' : `n${path.join('_')}`
        node.sourceName ??= node.kind
        if (
            node.kind === NodeKind.Flex ||
            node.kind === NodeKind.Stack ||
            node.kind === NodeKind.Box
        ) {
            node.children.forEach((child, index) => visit(child, [...path, index]))
        }
    }
    visit(root, [])
    return root
}

interface BuildResult {
    source: string
    sidecarFiles: Map<string, string | Uint8Array>
}

async function buildSource(
    root: DNode,
    ctx: Ctx,
    printNode: (n: ast.Node) => string,
    sourceId: string,
    componentName: string,
): Promise<BuildResult> {
    const scope = ensureDataScope(root, componentName)
    const { jsx: bodyJsx, uses } = await emitNode(scope.child, ctx, ROOT_PARENT)
    const body = bodyJsx as ast.Expression
    uses.tintFilterId = `tint_${sourceId.replace(/[^A-Za-z0-9]/g, '_')}`

    // Imports
    const componentImports = [...uses.usedComponents].sort().map((name) => {
        const meta = ctx.env.registry.get(name)
        const componentName = meta?.componentName ?? name
        const componentFile = nodePath.resolve(
            ctx.env.componentsDir ?? '',
            componentName,
            'impl',
            'react-panda',
            'index.tsx',
        )
        const importPath = relativeImport(
            ctx.env.outputDir,
            componentFile,
            `../../${componentName}/impl/react-panda/index.tsx`,
        )
        return namedImport([name], importPath, { rename: { [name]: 'impl' } })
    })
    const typographyImports = uses.usedTypography.size
        ? [
              namedImport(
                  [...uses.usedTypography].sort(),
                  relativeImport(
                      ctx.env.outputDir,
                      nodePath.resolve(ctx.env.componentsDir ?? '', 'typography/index.tsx'),
                      '../../typography/index.tsx',
                  ),
              ),
          ]
        : []
    const cssImport = uses.usesCss ? [namedImport(['css'], styledSystemPath(ctx, 'css'))] : []
    const assetImports = [...uses.defaultImports.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([alias, importPath]) => defaultImport(alias, importPath))
    const jsxPatternImport = uses.usedJsxPatterns.size
        ? [namedImport([...uses.usedJsxPatterns].sort(), styledSystemPath(ctx, 'jsx'))]
        : []
    const hasProps = Object.keys(scope.data).length > 0
    const runtimeImports = [
        ...(hasProps ? ['mergeProps'] : []),
        ...(uses.squircleHooks.length ? ['useSquircleClip'] : []),
    ]
    const squircleImport = runtimeImports.length
        ? [namedImport(runtimeImports, 'pixpec/targets/react-panda/runtime')]
        : []
    const fcImport = namedImport(['FC'], 'react', { typeOnly: true })
    // FC signature
    const propsTypeIdent = propsTypeName(scope)
    const fcType = hasProps
        ? f.createTypeReferenceNode(f.createIdentifier('FC'), [
              f.createTypeReferenceNode(f.createIdentifier('Partial'), [
                  f.createTypeReferenceNode(f.createIdentifier(propsTypeIdent), undefined),
              ]),
          ])
        : f.createTypeReferenceNode(f.createIdentifier('FC'), [])
    const fnParams = hasProps
        ? [
              f.createParameterDeclaration(
                  undefined,
                  undefined,
                  f.createIdentifier('rawProps'),
                  undefined,
                  undefined,
                  undefined,
              ),
          ]
        : []

    // Merge caller's partial props with module-level DEFAULTS so the body sees
    // every field as defined.
    const mergePropsStmt = f.createVariableStatement(
        undefined,
        f.createVariableDeclarationList(
            [
                f.createVariableDeclaration(
                    f.createIdentifier('props'),
                    undefined,
                    undefined,
                    callExpression(f.createIdentifier('mergeProps'), [
                        f.createIdentifier('DEFAULTS'),
                        f.createIdentifier('rawProps'),
                    ]),
                ),
            ],
            nodeFlagsConst,
        ),
    )

    const returnExpr: ast.Expression = f.createParenthesizedExpression(body)
    const generatedBody: ast.ConciseBody = f.createBlock(
        [
            ...(hasProps ? [mergePropsStmt] : []),
            ...uses.squircleHooks.map((h) => squircleHookMarker(h.key, h.radiusPx, h.smoothing)),
            f.createReturnStatement(returnExpr),
        ],
        true,
    )
    const generatedFn = f.createVariableStatement(
        [exportModifier()],
        f.createVariableDeclarationList(
            [
                f.createVariableDeclaration(
                    f.createIdentifier(scope.componentName),
                    undefined,
                    fcType,
                    f.createArrowFunction(
                        undefined,
                        undefined,
                        fnParams,
                        undefined,
                        f.createToken(ast.SyntaxKind.EqualsGreaterThanToken),
                        generatedBody,
                    ),
                ),
            ],
            nodeFlagsConst,
        ),
    )
    const statements: ast.Statement[] = [
        fcImport,
        ...componentImports,
        ...typographyImports,
        ...cssImport,
        ...jsxPatternImport,
        ...squircleImport,
        ...assetImports,
    ]
    const header = `/**\n * AUTO-GENERATED by pixpec react-panda target.\n * Source: ${sourceId}\n */\n`
    let printed =
        header +
        statements.map(printNode).join('\n') +
        '\n' +
        (hasProps ? generatedPropsSource(scope, '') + generatedDefaultsSource(scope) : '') +
        printNode(generatedFn) +
        '\n'
    return {
        source: printed,
        sidecarFiles: uses.sidecarFiles,
    }
}

export async function codegenReactPanda(
    root: DNode,
    ctx: CodegenContext,
): Promise<CodegenResult> {
    const normalizedRoot = ensureSourceMeta(root)
    const ext = ctx as CodegenContext & ReactPandaCtxExt
    const cgCtx: Ctx = {
        env: {
            remBase: ctx.remBase ?? 16,
            registry: ctx.registry ?? new Map(),
            tokenMap: ctx.designSystem?.tokens ?? {},
            tokenValues: ctx.designSystem?.tokenValues ?? {},
            typographyMap: ctx.designSystem?.typography ?? {},
            outputDir: ctx.outputDir,
            rootDir: ctx.rootDir,
            componentsDir: ctx.componentsDir,
            propsFile: ctx.propsFile,
            assetsDir: ctx.assetsDir,
            viewConfig: ctx.viewConfig ?? {},
        },
    }
    const sourceId = ext.sourceId ?? nodeSourceId(normalizedRoot)

    const printNode = ext.printNode ?? getSharedPrintNode(process.cwd())
    const result = await buildSource(normalizedRoot, cgCtx, printNode, sourceId, ctx.componentName)
    const sidecars = [...result.sidecarFiles.entries()].map(([relativePath, content]) => ({
        relativePath,
        content,
    }))
    return {
        source: result.source,
        fileExtension: ext.fileExtension ?? 'tsx',
        sidecars,
    }
}
