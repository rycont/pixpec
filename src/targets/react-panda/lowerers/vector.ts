import type { DVector } from '../../../compiler/design-ast.ts'
import {
    assetImportPath,
    assetSidecarPath,
    sidecarAlias,
    sidecarAliasTinted,
    sidecarFilename,
    sidecarFilenameTinted,
} from '../assets.ts'
import { jsxAttr, jsxEl, jsxSelf, styleAttr, styledTag } from '../ast.ts'
import { px2rem, sizeToPx } from '../data-lowerer.ts'
import type { LowererCtx as Ctx, LowerResult } from '../lowerer-types.ts'
import { emptyUses } from '../lowerer-types.ts'
import { expressionPropName, nodeSourceId } from '../sizing.ts'
import { tintSwapJsx } from '../styles.ts'

export function emitVector(n: DVector, ctx: Ctx): LowerResult {
    const uses = emptyUses()
    const rawW = sizeToPx(n.width) ?? 0
    const rawH = sizeToPx(n.height) ?? 0
    const svgSize = n.svg.startsWith('data:') ? undefined : svgRootSize(n.svg)
    const w = svgSize?.width ?? rawW
    const h = svgSize?.height ?? rawH
    if (n.svg.startsWith('data:')) {
        uses.usedJsxPatterns.add('styled')
        return {
            jsx: jsxSelf(styledTag('img'), [
                jsxAttr('src', n.svg),
                jsxAttr('alt', ''),
                jsxAttr('flexShrink', 0),
                jsxAttr('width', px2rem(w, ctx.env.remBase)),
                jsxAttr('height', px2rem(h, ctx.env.remBase)),
                styleAttr({ display: 'block' }),
            ]),
            uses,
        }
    }
    // Wrap the svgr-imported component in an inline-sized box. Breakdown
    // outputs aren't in Panda's static extraction set, so width/height can't
    // rely on generated utility classes.
    const sourceId = nodeSourceId(n)
    const sidecarKey = assetSidecarPath(ctx, sidecarFilename(sourceId))
    const alias = sidecarAlias(sourceId)
    const normalizedSvg = n.svg
    if (!uses.svgSidecars.has(sidecarKey)) {
        uses.svgSidecars.set(sidecarKey, {
            alias,
            content: ringifyStrokeCircles(normalizedSvg),
            importPath: assetImportPath(sidecarKey, '?react'),
        })
    }
    const fillProp = expressionPropName(n.fill)
    // Second `currentColor` sidecar lets a prop-driven fill swap colors via
    // inline `color: props.X`. Matches figma's anisotropic stretch under
    // preserveAspectRatio="none".
    const tintedKey = assetSidecarPath(ctx, sidecarFilenameTinted(sourceId))
    const tintedAlias = sidecarAliasTinted(sourceId)
    if (!uses.svgSidecars.has(tintedKey)) {
        uses.svgSidecars.set(tintedKey, {
            alias: tintedAlias,
            content: makeCurrentColorSvg(ringifyStrokeCircles(normalizedSvg)),
            importPath: assetImportPath(tintedKey, '?react'),
        })
    }
    uses.usesTinting = true
    const innerSvg = tintSwapJsx(alias, tintedAlias, fillProp)
    uses.usedJsxPatterns.add('styled')
    return {
        jsx: jsxEl(
            styledTag('span'),
            [
                jsxAttr('flexShrink', 0),
                jsxAttr('width', px2rem(w, ctx.env.remBase)),
                jsxAttr('height', px2rem(h, ctx.env.remBase)),
                styleAttr({ display: 'block' }),
            ],
            [innerSvg],
        ),
        uses,
    }
}

function svgRootSize(svg: string): { width: number; height: number } | undefined {
    const root = svg.match(/<svg\b([^>]*)>/i)?.[1]
    if (!root) {
        return undefined
    }
    const read = (name: string) => {
        const raw = root.match(new RegExp(`\\s${name}="([^"]+)"`, 'i'))?.[1]
        if (!raw) {
            return undefined
        }
        const n = Number.parseFloat(raw)
        return Number.isFinite(n) && n > 0 ? n : undefined
    }
    const width = read('width')
    const height = read('height')
    if (width && height) {
        return { width, height }
    }
    const viewBox = root
        .match(/\sviewBox="([^"]+)"/i)?.[1]
        ?.trim()
        .split(/\s+/)
        .map(Number)
    if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
        const [, , w, h] = viewBox
        if (w > 0 && h > 0) {
            return { width: w, height: h }
        }
    }
    return undefined
}

/** Replace every literal fill color in an SVG string with `currentColor` so
 *  the host element's CSS color drives the rendered svg. Skips `fill="none"`. */
function makeCurrentColorSvg(svg: string): string {
    const colorRe = /(fill|stroke)="(?!none\b|currentColor\b)([^"]+)"/g
    return svg
        .split(/(<mask\b[\s\S]*?<\/mask>)/g)
        .map((part) =>
            part.startsWith('<mask')
                ? part
                : part.replace(colorRe, (_m, attr) => `${attr}="currentColor"`),
        )
        .join('')
}

// `<circle stroke=… stroke-width=W>` → filled ring path. Stroke geometry scales
// with viewBox under preserveAspectRatio="none", so anisotropic stretch
// produces direction-dependent thickness. Encoding as fill (outer arc + inner
// arc, even-odd) preserves figma's uniform-stroke render.
function ringifyStrokeCircles(svg: string): string {
    return svg.replace(/<circle\b([^/>]*?)\/>/g, (m, attrs: string) => {
        const get = (k: string) => attrs.match(new RegExp(`\\s${k}="([^"]+)"`))?.[1]
        const cx = parseFloat(get('cx') ?? '0')
        const cy = parseFloat(get('cy') ?? '0')
        const r = parseFloat(get('r') ?? '0')
        const sw = parseFloat(get('stroke-width') ?? '0')
        const stroke = get('stroke')
        const fill = get('fill')
        if (!stroke || sw <= 0) {
            return m
        }
        if (fill && fill !== 'none') {
            return m
        }
        const ro = r + sw / 2
        const ri = r - sw / 2
        if (ri <= 0) {
            return m
        }
        const ring =
            `M${cx - ro} ${cy}a${ro} ${ro} 0 1 0 ${2 * ro} 0a${ro} ${ro} 0 1 0 ${-2 * ro} 0Z` +
            `M${cx - ri} ${cy}a${ri} ${ri} 0 1 1 ${2 * ri} 0a${ri} ${ri} 0 1 1 ${-2 * ri} 0Z`
        return `<path fill-rule="evenodd" fill="${stroke}" d="${ring}"/>`
    })
}
