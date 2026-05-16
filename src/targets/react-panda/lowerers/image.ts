import type { DImage } from '../../../compiler/design-ast.ts'
import { imageAssetUrlMarker } from '../assets.ts'
import { jsxAttr, jsxExprAttr, jsxSelf, styleAttr, styledTag } from '../ast.ts'
import { px2rem, sizeToPx } from '../data-lowerer.ts'
import type { LowererCtx as Ctx, LowerResult } from '../lowerer-types.ts'
import { emptyUses } from '../lowerer-types.ts'

export function emitImage(n: DImage, ctx: Ctx): LowerResult {
    const uses = emptyUses()
    const w = sizeToPx(n.width) ?? 0
    const h = sizeToPx(n.height) ?? 0
    const styles: Record<string, unknown> = {
        display: 'block',
        flexShrink: 0,
        width: px2rem(w, ctx.env.remBase),
        height: px2rem(h, ctx.env.remBase),
    }
    if (n.opacity !== undefined) {
        styles.opacity = n.opacity
    }
    const srcExpr = imageAssetUrlMarker(n, ctx, uses)
    if (!srcExpr) {
        return { jsx: jsxSelf('div', [styleAttr(styles)]), uses }
    }
    uses.usedJsxPatterns.add('styled')
    return {
        jsx: jsxSelf(styledTag('img'), [
            jsxExprAttr('src', srcExpr),
            jsxAttr('alt', ''),
            styleAttr(styles),
        ]),
        uses,
    }
}
