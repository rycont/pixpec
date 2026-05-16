// React + PandaCSS target codegen: Design AST → self-contained .tsx source.

import { existsSync } from 'node:fs'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import { API } from '@typescript/native-preview/sync'
import type { DDataScope, DNode, DShape } from '../../compiler/design-ast.ts'
import { Anchor, NodeKind, ShapeKind } from '../../compiler/design-ast.ts'
import type { CodegenContext, CodegenResult } from '../types.ts'
import {
    exportModifier,
    jsxEl,
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
import { expressionPropName, nodeSourceId } from './sizing.ts'
import { injectSpreadAttr, splitCssPropsDecl, squircleHookMarker } from './styles.ts'

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

function generatedPropsSource(scope: DDataScope, rootPropsTypeName: string): string {
    const fields = Object.entries(scope.data)
        .map(([key, def]) => {
            const type = reactPandaPropType(def.type)
            return `    ${key}?: ${type}`
        })
        .join('\n')
    return `export interface ${propsTypeName(scope)} extends ${rootPropsTypeName} {\n${fields}\n}\n`
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

function wrapAbsolute(n: DNode, jsx: ast.JsxChild, ctx: Ctx): LowerResult {
    const uses = emptyUses()
    if (!n.absolute) {
        return { jsx, uses }
    }
    const inset = n.absolute.inset ?? {}
    let absX = sizeToPx(inset.left) ?? 0
    let absY = sizeToPx(inset.top) ?? 0
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
        if (h === 0) {
            absY -= sw
        }
        if (w === 0) {
            absX -= sw
        }
    }
    if (n.renderBoundsOffset) {
        const offset = n.renderBoundsOffset
        absX += sizeToPx(offset.x) ?? 0
        absY += sizeToPx(offset.y) ?? 0
    }
    const wrapStyle: Record<string, unknown> = {
        position: 'absolute',
        left: px2rem(absX, ctx.env.remBase),
        top: px2rem(absY, ctx.env.remBase),
    }
    if (n.absolute.anchor?.horizontal === Anchor.Stretch && sizeToPx(inset.right) !== undefined) {
        wrapStyle.right = px2rem(sizeToPx(inset.right) ?? 0, ctx.env.remBase)
    }
    if (n.absolute.anchor?.vertical === Anchor.Stretch && sizeToPx(inset.bottom) !== undefined) {
        wrapStyle.bottom = px2rem(sizeToPx(inset.bottom) ?? 0, ctx.env.remBase)
    }
    uses.usedJsxPatterns.add('styled')
    return {
        jsx: jsxEl(styledTag('span'), [styleAttr(wrapStyle)], [jsx]),
        uses,
    }
}

function wrapVisibility(n: DNode, jsx: ast.JsxChild, ctx: Ctx, parent: ParentCtx): LowerResult {
    const uses = emptyUses()
    const visibleProp = expressionPropName(n.visible)
    if (!visibleProp || (!parent.has(LocalCtx.Flex) && !parent.has(LocalCtx.Stack))) {
        return { jsx, uses }
    }
    const cond = f.createBinaryExpression(
        undefined,
        propAccess(visibleProp),
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
    return { jsx: f.createJsxExpression(undefined, conditional), uses }
}

setNodeDispatcher((n, ctx, parent) => emitNode(n, ctx, parent))

function emitNode(n: DNode, ctx: Ctx, parent: ParentCtx): LowerResult {
    if (n.kind === NodeKind.DataScope) {
        return emitNode((n as DDataScope).child, ctx, parent)
    }
    const uses = emptyUses()
    let inner: LowerResult
    switch (n.kind) {
        case NodeKind.Flex:
        case NodeKind.Stack:
        case NodeKind.Box:
            inner = emitContainer(n, ctx, parent)
            break
        case NodeKind.Text:
            inner = emitText(n, ctx, parent)
            break
        case NodeKind.Shape:
            inner = emitShape(n, ctx, parent)
            break
        case NodeKind.Vector:
            inner = emitVector(n, ctx)
            break
        case NodeKind.Image:
            inner = emitImage(n, ctx)
            break
        case NodeKind.Instance:
            inner = emitInstance(n, ctx, parent)
            break
        case NodeKind.Unknown:
            inner = emitUnknown(n, ctx)
            break
    }
    mergeUses(uses, inner.uses)
    const abs = wrapAbsolute(n, inner.jsx, ctx)
    mergeUses(uses, abs.uses)
    const vis = wrapVisibility(n, abs.jsx, ctx, parent)
    mergeUses(uses, vis.uses)
    return { jsx: vis.jsx, uses }
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
    svgSidecars: Map<string, { alias: string; content: string; importPath: string }>
    imageSidecars: Map<string, { content: Uint8Array }>
}

function buildSource(
    root: DNode,
    ctx: Ctx,
    printNode: (n: ast.Node) => string,
    sourceId: string,
    componentName: string,
): BuildResult {
    const scope = ensureDataScope(root, componentName)
    const { jsx: bodyJsx, uses } = emitNode(scope.child, ctx, ROOT_PARENT)
    const body = bodyJsx as ast.Expression
    uses.tintFilterId = `tint_${sourceId.replace(/[^A-Za-z0-9]/g, '_')}`
    uses.usedJsxPatterns.add('splitCssProps')

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
    const svgImports = [...uses.svgSidecars.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, { alias, importPath }]) => defaultImport(alias, importPath))
    const jsxPatternImport = uses.usedJsxPatterns.size
        ? [namedImport([...uses.usedJsxPatterns].sort(), styledSystemPath(ctx, 'jsx'))]
        : []
    const squircleImport = uses.squircleHooks.length
        ? [namedImport(['useSquircleClip'], 'pixpec/targets/react-panda/runtime')]
        : []
    const fcImport = namedImport(['FC'], 'react', { typeOnly: true })
    // FC signature
    const rootPropsTypeName = rootPropsType(scope.child)
    const propsTypeIdent = propsTypeName(scope)
    const rootPropsTypeImport = namedImport([rootPropsTypeName], styledSystemPath(ctx, 'jsx'), {
        typeOnly: true,
    })
    const fcType = f.createTypeReferenceNode(f.createIdentifier('FC'), [
        f.createTypeReferenceNode(f.createIdentifier(propsTypeIdent), undefined),
    ])
    const fnParams = [
        f.createParameterDeclaration(
            undefined,
            undefined,
            f.createIdentifier('props'),
            undefined,
            undefined,
            undefined,
        ),
    ]

    // Spread caller's cssProps LAST so they override baked-in attrs. The
    // root-pattern `direction` is incompatible with Panda's CSS `direction`,
    // so splitCssPropsDecl strips it before spreading.
    const body2 = injectSpreadAttr(body, f.createJsxSpreadAttribute(f.createIdentifier('cssProps')))
    const cssPropsDecl = splitCssPropsDecl()
    const returnExpr: ast.Expression = f.createParenthesizedExpression(body2)
    const generatedBody: ast.ConciseBody = f.createBlock(
        [
            cssPropsDecl,
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
        rootPropsTypeImport,
        ...componentImports,
        ...typographyImports,
        ...cssImport,
        ...jsxPatternImport,
        ...squircleImport,
        ...svgImports,
    ]
    const header = `/**\n * AUTO-GENERATED by pixpec react-panda target.\n * Source: ${sourceId}\n */\n`
    let printed =
        header +
        statements.map(printNode).join('\n') +
        '\n' +
        generatedPropsSource(scope, rootPropsTypeName) +
        printNode(generatedFn) +
        '\n'
    return {
        source: printed,
        svgSidecars: uses.svgSidecars,
        imageSidecars: uses.imageSidecars,
    }
}

export function codegenReactPanda(root: DNode, ctx: CodegenContext): CodegenResult {
    const normalizedRoot = ensureSourceMeta(root)
    const ext = ctx as CodegenContext & ReactPandaCtxExt
    const cgCtx: Ctx = {
        env: {
            remBase: ctx.remBase ?? 16,
            registry: ctx.registry ?? new Map(),
            tokenMap: ctx.designSystem?.tokens ?? {},
            typographyMap: ctx.designSystem?.typography ?? {},
            outputDir: ctx.outputDir,
            rootDir: ctx.rootDir,
            componentsDir: ctx.componentsDir,
            propsFile: ctx.propsFile,
            viewConfig: ctx.viewConfig ?? {},
        },
    }
    const sourceId = ext.sourceId ?? nodeSourceId(normalizedRoot)

    const printNode = ext.printNode ?? getSharedPrintNode(process.cwd())
    const result = buildSource(normalizedRoot, cgCtx, printNode, sourceId, ctx.componentName)
    const sidecars = [
        ...[...result.svgSidecars.entries()].map(([relativePath, { content }]) => ({
            relativePath,
            content,
        })),
        ...[...result.imageSidecars.entries()].map(([relativePath, { content }]) => ({
            relativePath,
            content,
        })),
    ]
    return {
        source: result.source,
        fileExtension: ext.fileExtension ?? 'tsx',
        sidecars,
    }
}
