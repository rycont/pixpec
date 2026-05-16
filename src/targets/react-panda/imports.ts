// Import statement builders.

import * as nodePath from 'node:path'
import * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import { stringLiteral } from './ast.ts'
import type { LowererCtx as Ctx } from './lowerer-types.ts'

export function namedImport(
    names: string[],
    from: string,
    opts: { typeOnly?: boolean; rename?: Record<string, string> } = {},
): ast.ImportDeclaration {
    const specs = names.map((name) => {
        const aliasFrom = opts.rename?.[name]
        return f.createImportSpecifier(
            false,
            aliasFrom ? f.createIdentifier(aliasFrom) : undefined,
            f.createIdentifier(name),
        )
    })
    return f.createImportDeclaration(
        undefined,
        f.createImportClause(
            opts.typeOnly ? ast.SyntaxKind.TypeKeyword : undefined,
            undefined,
            f.createNamedImports(specs),
        ),
        stringLiteral(from),
    )
}

export function defaultImport(name: string, from: string): ast.ImportDeclaration {
    return f.createImportDeclaration(
        undefined,
        f.createImportClause(undefined, f.createIdentifier(name), undefined),
        stringLiteral(from),
    )
}

export function relativeImport(
    fromDir: string | undefined,
    toPath: string,
    fallback: string,
): string {
    if (!fromDir) {
        return fallback
    }
    let rel = nodePath.relative(fromDir, toPath).replace(/\\/g, '/')
    if (!rel.startsWith('.')) {
        rel = `./${rel}`
    }
    return rel
}

export function styledSystemPath(ctx: Ctx, sub: 'css' | 'jsx'): string {
    return relativeImport(
        ctx.env.outputDir,
        nodePath.resolve(ctx.env.rootDir ?? '', `styled-system/${sub}`),
        `../../../../styled-system/${sub}`,
    )
}
