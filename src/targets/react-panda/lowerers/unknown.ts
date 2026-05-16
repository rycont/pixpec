import type { DUnknown } from '../../../compiler/design-ast.ts'
import { jsxSelf, styleAttr, styledTag } from '../ast.ts'
import { px2rem, sizeToPx } from '../data-lowerer.ts'
import type { LowererCtx as Ctx, LowerResult } from '../lowerer-types.ts'
import { emptyUses } from '../lowerer-types.ts'

export function emitUnknown(n: DUnknown, ctx: Ctx): LowerResult {
    const uses = emptyUses()
    const w = sizeToPx(n.width) ?? 0
    const h = sizeToPx(n.height) ?? 0
    uses.usedJsxPatterns.add('styled')
    const tag = styledTag('div')
    const wpx = px2rem(w, ctx.env.remBase)
    const hpx = px2rem(h, ctx.env.remBase)
    let style: Record<string, unknown>
    if (n.hidden) {
        style = { width: wpx, height: hpx, opacity: 0 }
    } else if (w === 0 || h === 0) {
        style = { display: 'none' }
    } else {
        style = { width: wpx, height: hpx, background: '#f00' }
    }
    return { jsx: jsxSelf(tag, [styleAttr(style)]), uses }
}
