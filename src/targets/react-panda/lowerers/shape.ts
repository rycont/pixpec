import type * as ast from '@typescript/native-preview/ast'
import type { DShape } from '../../../compiler/design-ast.ts'
import { Anchor, ShapeKind, Sizing, StrokeAlign, StrokeCap } from '../../../compiler/design-ast.ts'
import { jsxAttr, jsxEl, jsxExprAttr, jsxSelf, styledTag } from '../ast.ts'
import { isCornerRadii, paintToProp, px2rem, sizeToPx } from '../data-lowerer.ts'
import type { LowererCtx as Ctx, LowerResult, ParentCtx } from '../lowerer-types.ts'
import { emptyUses } from '../lowerer-types.ts'
import { axisSizing } from '../sizing.ts'

export function emitShape(n: DShape, ctx: Ctx, _parent: ParentCtx): LowerResult {
    const uses = emptyUses()
    const w = sizeToPx(n.width) ?? 0
    const h = sizeToPx(n.height) ?? 0
    const fillVal = paintToProp(n.fill) ?? 'none'
    uses.usedJsxPatterns.add('styled')
    const innerAttrs: Record<string, unknown> = { fill: fillVal }
    const strokeWidth = n.stroke ? (sizeToPx(n.stroke.width) ?? 1) : 0
    const strokeInset = n.stroke?.align === StrokeAlign.Inside ? strokeWidth / 2 : 0
    if (n.stroke) {
        innerAttrs.stroke = paintToProp(n.stroke.paint) ?? '#000'
        innerAttrs['strokeWidth'] = strokeWidth
    }

    const innerExtras = (): ast.JsxAttributeLike[] =>
        Object.entries(innerAttrs).map(([k, v]) => jsxExprAttr(k, v))
    let inner: ast.JsxChild
    if (n.shape === ShapeKind.Rect) {
        if (n.cornerRadius && !isCornerRadii(n.cornerRadius)) {
            const r = sizeToPx(n.cornerRadius)
            if (r) {
                innerAttrs.rx = r
                innerAttrs.ry = r
            }
        }
        inner = jsxSelf('rect', [
            ...(strokeInset > 0 ? [jsxAttr('x', strokeInset), jsxAttr('y', strokeInset)] : []),
            jsxAttr('width', Math.max(0, w - strokeInset * 2)),
            jsxAttr('height', Math.max(0, h - strokeInset * 2)),
            ...innerExtras(),
        ])
    } else if (n.shape === ShapeKind.Ellipse) {
        inner = jsxSelf('ellipse', [
            jsxAttr('cx', w / 2),
            jsxAttr('cy', h / 2),
            jsxAttr('rx', Math.max(0, (w - strokeInset * 2) / 2)),
            jsxAttr('ry', Math.max(0, (h - strokeInset * 2) / 2)),
            ...innerExtras(),
        ])
    } else if (n.shape === ShapeKind.Line) {
        const horizontal = h === 0 || h < w
        const sw = sizeToPx(n.stroke?.width) ?? 1
        const cap = n.stroke?.cap ?? StrokeCap.Butt
        const capInset = cap === StrokeCap.Butt ? 0 : sw / 2
        const lx = horizontal ? capInset : sw / 2
        const ly = horizontal ? sw / 2 : capInset
        const lx2 = horizontal ? w - capInset : sw / 2
        const ly2 = horizontal ? sw / 2 : h - capInset
        const lineAttrs: ast.JsxAttributeLike[] = [
            jsxAttr('x1', lx),
            jsxAttr('y1', ly),
            jsxAttr('x2', lx2),
            jsxAttr('y2', ly2),
            ...innerExtras(),
        ]
        if (cap !== StrokeCap.Butt) {
            lineAttrs.push(jsxAttr('strokeLinecap', cap))
        }
        inner = jsxSelf('line', lineAttrs)
    } else {
        // polygon / star — placeholder rect.
        inner = jsxSelf('rect', [jsxAttr('width', w), jsxAttr('height', h), ...innerExtras()])
    }

    // viewport inflate for line shapes
    let viewW = w
    let viewH = h
    if (n.shape === ShapeKind.Line && n.stroke) {
        const sw = sizeToPx(n.stroke.width) ?? 1
        if (h === 0) {
            viewH = sw
        }
        if (w === 0) {
            viewW = sw
        }
    }
    const hStretch =
        axisSizing(n.width) === Sizing.Fill || n.absolute?.anchor?.horizontal === Anchor.Stretch
    const vStretch =
        axisSizing(n.height) === Sizing.Fill || n.absolute?.anchor?.vertical === Anchor.Stretch
    const svgAttrs: ast.JsxAttributeLike[] = [
        jsxAttr('viewBox', `0 0 ${viewW} ${viewH}`),
        jsxAttr('display', 'block'),
        jsxAttr('flexShrink', 0),
        jsxAttr('width', hStretch ? '100%' : px2rem(viewW, ctx.env.remBase)),
        jsxAttr('height', vStretch ? '100%' : px2rem(viewH, ctx.env.remBase)),
    ]
    if (n.shape === ShapeKind.Line && (hStretch || vStretch)) {
        svgAttrs.push(jsxAttr('preserveAspectRatio', 'none'))
    }
    if (n.opacity !== undefined) {
        svgAttrs.push(jsxAttr('opacity', n.opacity))
    }
    return { jsx: jsxEl(styledTag('svg'), svgAttrs, [inner]), uses }
}
