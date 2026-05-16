// Asset/sidecar path helpers for SVG vectors and raster images.
//
// Compile writes inline assets (image fills, SVG bytes) once to a shared
// directory passed in via `ctx.env.assetsDir`. The lowerer here builds the
// per-output relative import path. Target-specific derived assets (e.g. the
// tinted `currentColor` SVG sidecar used by vector tinting) are still written
// alongside the generated source under `<outputDir>/.pixpec/assets/`.

import * as nodePath from 'node:path'
import * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import { stringLiteral } from './ast.ts'
import type { LowererCtx as Ctx } from './lowerer-types.ts'
import { sanitizeKey } from './styles.ts'

export function sidecarAlias(id: string): string {
    return `Svg_${sanitizeKey(id)}`
}
export function sidecarAliasTinted(id: string): string {
    return `SvgC_${sanitizeKey(id)}`
}

/** Relative path (from `<outputDir>`) of the tinted-variant sidecar file for
 *  the given source node id. Codegen writes the sidecar bytes to this path. */
export function tintedSidecarRelativePath(ctx: Ctx, sourceId: string): string {
    const filename = `svg__${sanitizeKey(sourceId)}__c.svg`
    return targetSidecarRelativePath(ctx, filename)
}

function targetSidecarRelativePath(ctx: Ctx, filename: string): string {
    const base = ctx.env.outputDir ? nodePath.basename(ctx.env.outputDir) : ''
    if (base === 'generated' || base === 'breakdown') {
        return `../.pixpec/assets/${filename}`
    }
    return `.pixpec/assets/${filename}`
}

/** Build a relative import path from `<outputDir>` to the shared asset file. */
export function assetImportPathFromOutput(filename: string, ctx: Ctx): string {
    const outDir = ctx.env.outputDir
    const assetsDir = ctx.env.assetsDir
    if (!outDir || !assetsDir) {
        // Without context, fall back to a target-local sidecar path.
        return targetSidecarRelativePath(ctx, filename)
    }
    const rel = nodePath.relative(outDir, nodePath.join(assetsDir, filename))
    const normalized = rel.split(nodePath.sep).join('/')
    return normalized.startsWith('.') ? normalized : `./${normalized}`
}

/** `new URL('<importPath>', import.meta.url).href` — the canonical way to
 *  reference an asset alongside the generated source file in modern bundlers. */
export function assetImportExpression(filename: string, ctx: Ctx): ast.Expression {
    const importPath = assetImportPathFromOutput(filename, ctx)
    const importMetaUrl = f.createPropertyAccessExpression(
        f.createMetaProperty(ast.SyntaxKind.ImportKeyword, f.createIdentifier('meta')),
        undefined,
        f.createIdentifier('url'),
        0 as ast.NodeFlags,
    )
    const newUrl = f.createNewExpression(f.createIdentifier('URL'), undefined, [
        stringLiteral(importPath),
        importMetaUrl,
    ])
    return f.createPropertyAccessExpression(
        newUrl,
        undefined,
        f.createIdentifier('href'),
        0 as ast.NodeFlags,
    )
}
