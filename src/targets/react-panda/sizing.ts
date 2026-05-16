// Length/sizing/value helpers — IR Value/LengthValue → panda prop or AST expression.

import type * as ast from '@typescript/native-preview/ast'
import type {
    AxisSize,
    DDataScope,
    DNode,
    ExpressionValue,
    Length,
    LengthValue,
    LiteralValue,
} from '../../compiler/design-ast.ts'
import { NodeKind, Sizing } from '../../compiler/design-ast.ts'
import { propAccess } from './ast.ts'
import {
    isExpressionValue,
    isLengthLiteral,
    isLiteralValue,
    sizeToPropLiteral,
    sizeToPx,
} from './data-lowerer.ts'

export function expressionPropName(value: unknown): string | undefined {
    return isExpressionValue(value) ? (value as ExpressionValue).name : undefined
}

export function literalValue<T>(value: unknown): T | undefined {
    return isLiteralValue<T>(value) ? (value as LiteralValue<T>).value : undefined
}

export function sizeToProp(
    s: LengthValue | undefined,
    remBase: number,
): string | number | ast.Expression | undefined {
    if (!s) {
        return undefined
    }
    if (isExpressionValue(s)) {
        return propAccess((s as ExpressionValue).name)
    }
    if (typeof s === 'string') {
        return s
    }
    if (isLiteralValue<Length>(s)) {
        return sizeToPropLiteral((s as LiteralValue<Length>).value, remBase)
    }
    if (!isLengthLiteral(s)) {
        return undefined
    }
    return sizeToPropLiteral(s, remBase)
}

export function sizeToPropMinusPx(
    s: LengthValue | undefined,
    px: number,
    remBase: number,
): string | number | ast.Expression | undefined {
    if (!px) {
        return sizeToProp(s, remBase)
    }
    const value = sizeToPx(s)
    if (value === undefined) {
        return sizeToProp(s, remBase)
    }
    return sizeToPropLiteral({ value: Math.max(0, value - px), unit: 'px' }, remBase)
}

export function numberOrExpressionToProp(
    value: LengthValue,
    remBase: number,
): string | number | ast.Expression | undefined {
    return sizeToProp(value, remBase)
}

export function axisSizing(axis: AxisSize | undefined): Sizing | undefined {
    if (axis === Sizing.Fill) {
        return Sizing.Fill
    }
    if (axis === Sizing.Hug) {
        return Sizing.Hug
    }
    if (axis !== undefined) {
        return Sizing.Fixed
    }
    return undefined
}

export function isAbsoluteNode(node: DNode): boolean {
    return !!node.absolute
}

export function nodeSourceId(n: DNode): string {
    if (n.kind === NodeKind.DataScope) {
        return nodeSourceId((n as DDataScope).child)
    }
    return n.sourceId ?? 'node'
}
