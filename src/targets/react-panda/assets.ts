// Asset/sidecar path helpers for SVG vectors and raster images.

import * as nodePath from 'node:path'
import * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import type { DImage } from '../../compiler/design-ast.ts'
import { stringLiteral } from './ast.ts'
import type { LowererCtx as Ctx, Uses } from './lowerer-types.ts'
import { nodeSourceId } from './sizing.ts'
import { sanitizeKey } from './styles.ts'

export function sidecarFilename(id: string): string {
    return `svg__${sanitizeKey(id)}.svg`
}
export function sidecarFilenameTinted(id: string): string {
    return `svg__${sanitizeKey(id)}__c.svg`
}
export function sidecarAlias(id: string): string {
    return `Svg_${sanitizeKey(id)}`
}
export function sidecarAliasTinted(id: string): string {
    return `SvgC_${sanitizeKey(id)}`
}

export function assetSidecarPath(ctx: Ctx, filename: string): string {
    const base = ctx.env.outputDir ? nodePath.basename(ctx.env.outputDir) : ''
    if (base === 'generated' || base === 'breakdown') {
        return `../.pixpec/assets/${filename}`
    }
    return `.pixpec/assets/${filename}`
}

export function assetImportPath(relativePath: string, suffix = ''): string {
    const rel = relativePath.replace(/\\/g, '/')
    return `${rel.startsWith('./') || rel.startsWith('../') ? rel : `./${rel}`}${suffix}`
}

const IMAGE_MIME_EXT: Record<string, string | undefined> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}

function imageFilename(sourceId: string, mime: string): string | undefined {
    const ext = IMAGE_MIME_EXT[mime.toLowerCase()]
    if (!ext) {
        return undefined
    }
    return `image__${sourceId.replace(/[^A-Za-z0-9]/g, '_')}.${ext}`
}

export function imageAssetUrlMarker(n: DImage, ctx: Ctx, uses: Uses): ast.Expression | undefined {
    if (!n.dataUrl) {
        return undefined
    }
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(n.dataUrl)
    if (!match) {
        return undefined
    }
    const mime = match[1] ?? ''
    const filename = imageFilename(nodeSourceId(n), mime)
    if (!filename) {
        return undefined
    }
    const relativePath = assetSidecarPath(ctx, filename)
    if (!uses.imageSidecars.has(relativePath)) {
        uses.imageSidecars.set(relativePath, {
            content: Buffer.from(match[2] ?? '', 'base64'),
        })
    }
    return assetUrlExpression(assetImportPath(relativePath))
}

// `new URL('<path>', import.meta.url).href`
export function assetUrlExpression(importPath: string): ast.Expression {
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
