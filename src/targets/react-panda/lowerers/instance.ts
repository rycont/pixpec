import type * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import type { DInstance } from '../../../compiler/design-ast.ts'
import { attrsFromObject, jsxSelf, propExpression } from '../ast.ts'
import {
    colorLiteralToCss,
    isColorLiteralObject,
    isExpressionValue,
    isGradientPaint,
    isLengthLiteral,
    isLiteralValue,
    paintLiteralToProp,
    sizeToPropLiteral,
} from '../data-lowerer.ts'
import type { LowererCtx as Ctx, LowerResult, ParentCtx } from '../lowerer-types.ts'
import { emptyUses } from '../lowerer-types.ts'

function componentPropToTargetValue(value: unknown, ctx: Ctx): unknown {
    if (!isLiteralValue<unknown>(value)) {
        return value
    }
    const literal = value.value
    if (isLengthLiteral(literal)) {
        return sizeToPropLiteral(literal, ctx.env.remBase)
    }
    if (isColorLiteralObject(literal)) {
        return colorLiteralToCss(literal)
    }
    if (isGradientPaint(literal)) {
        return paintLiteralToProp(literal)
    }
    return literal
}

export async function emitInstance(n: DInstance, ctx: Ctx, _parent: ParentCtx): Promise<LowerResult> {
    const uses = emptyUses()
    uses.usedComponents.add(n.componentName)
    const attrs: ast.JsxAttributeLike[] = []
    for (const [k, v] of Object.entries(n.props)) {
        if (isExpressionValue(v)) {
            attrs.push(f.createJsxAttribute(f.createIdentifier(k), propExpression(v.name)))
        } else {
            attrs.push(...attrsFromObject({ [k]: componentPropToTargetValue(v, ctx) }))
        }
    }
    if (n.opacity !== undefined) {
        attrs.push(...attrsFromObject({ opacity: n.opacity }))
    }
    return { jsx: jsxSelf(n.componentName, attrs), uses }
}
