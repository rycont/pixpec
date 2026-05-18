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

/** Strip `<dir>/...` prefix and the `.ext`; replace non-identifier chars with `_`. */
function assetStem(filename: string): string {
    const base = filename.split('/').pop() ?? filename
    return base.replace(/\.[^./]+$/, '').replace(/[^A-Za-z0-9]/g, '_')
}
export function sidecarAlias(filename: string): string {
    return `Svg_${assetStem(filename)}`
}
export function sidecarAliasTinted(filename: string): string {
    return `SvgC_${assetStem(filename)}`
}
export function imageAliasFromFilename(filename: string): string {
    return `Img_${assetStem(filename)}`
}

/** Relative path (from `<outputDir>`) of the tinted-variant sidecar file for
 *  the given source node id. Codegen writes the sidecar bytes to this path. */
export function tintedSidecarRelativePath(ctx: Ctx, assetFilename: string): string {
    const filename = `${assetStem(assetFilename)}__c.svg`
    return targetSidecarRelativePath(ctx, filename)
}

function targetSidecarRelativePath(ctx: Ctx, filename: string): string {
    const base = ctx.env.outputDir ? nodePath.basename(ctx.env.outputDir) : ''
    if (base === 'generated' || base === 'breakdown') {
        return `../.pixpec/assets/${filename}`
    }
    return `./.pixpec/assets/${filename}`
}

/** Build a relative import path from `<outputDir>` to the shared asset file.
 *  `filename` is what the compile-side writeAsset returned — typically just a
 *  bare hash filename, but generate.ts prefixes it with `pixpec-assets/` to
 *  match the GPUI runtime convention. Either form is treated as
 *  outputDir-relative and routed straight through (with a leading `./`). */
export function assetImportPathFromOutput(filename: string, ctx: Ctx): string {
    const normalized = filename.split(nodePath.sep).join('/')
    if (normalized.startsWith('./') || normalized.startsWith('../')) {
        return normalized
    }
    if (normalized.includes('/')) {
        return `./${normalized}`
    }
    // Bare filename — resolve against assetsDir if present, otherwise the
    // target-local sidecar dir.
    const outDir = ctx.env.outputDir
    const assetsDir = ctx.env.assetsDir
    if (!outDir || !assetsDir) {
        return targetSidecarRelativePath(ctx, normalized)
    }
    const rel = nodePath.relative(outDir, nodePath.join(assetsDir, normalized))
    const relNormalized = rel.split(nodePath.sep).join('/')
    return relNormalized.startsWith('.') ? relNormalized : `./${relNormalized}`
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
