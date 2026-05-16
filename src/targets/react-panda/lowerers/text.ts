import * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import type { DText } from '../../../compiler/design-ast.ts'
import { Sizing, TextAutoResize, TextDecoration } from '../../../compiler/design-ast.ts'
import { attrsFromObject, jsxEl, propExpression, stringLiteral, styledTag } from '../ast.ts'
import { colorToProp, isExpressionValue, isLiteralValue } from '../data-lowerer.ts'
import type { LowererCtx as Ctx, LowerResult, ParentCtx } from '../lowerer-types.ts'
import { emptyUses, LocalCtx } from '../lowerer-types.ts'
import {
    axisSizing,
    expressionPropName,
    literalValue,
    numberOrExpressionToProp,
    sizeToProp,
} from '../sizing.ts'
import { fillStyleExpression } from '../styles.ts'

const LINE_BREAK_RE = new RegExp('[\\r\\u2028\\u2029]', 'g')

function normalizeTextLineBreaks(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(LINE_BREAK_RE, '\n')
}

export function emitText(n: DText, ctx: Ctx, parent: ParentCtx): LowerResult {
    const uses = emptyUses()
    const ts = n.textStyle
    const isPlainTsObject =
        ts && !isExpressionValue(ts) && !isLiteralValue(ts) && typeof ts === 'object'
    const textStyleToken =
        typeof ts === 'string'
            ? ts
            : isPlainTsObject && 'base' in ts
              ? (ts as { base: string }).base
              : undefined
    const textStyleLiteral = isLiteralValue(ts) ? ts.value : undefined
    const textStyleOverrides = isPlainTsObject ? ts : undefined
    const isHug = n.autoResize === TextAutoResize.Hug

    const parentHugMain = parent.has(LocalCtx.MainAxisHug)
    const sizingH = axisSizing(n.width) ?? Sizing.Fixed
    const fillMain = sizingH === Sizing.Fill && parent.has(LocalCtx.Flex) && !parentHugMain
    const fillCross = sizingH === Sizing.Fill && parent.has(LocalCtx.Stack)
    const collapsedFill = sizingH === Sizing.Fill && parent.has(LocalCtx.Flex) && parentHugMain
    const fixedWidth = !isHug && !fillMain && !fillCross && !collapsedFill ? n.width : undefined
    const contentLiteral = literalValue<string>(n.content) ?? ''
    const hasExplicitLineBreak = new RegExp('[\\n\\r\\u2028\\u2029]').test(contentLiteral)
    const contentCanContainLineBreaks = expressionPropName(n.content) !== undefined

    uses.usedJsxPatterns.add('styled')
    const styles: Record<string, unknown> = {}
    if (textStyleToken) {
        styles.textStyle = textStyleToken
    } else {
        const style = textStyleLiteral ?? textStyleOverrides
        styles.fontSize = sizeToProp(style?.fontSize, ctx.env.remBase)
        styles.lineHeight = sizeToProp(style?.lineHeight, ctx.env.remBase)
        if (style?.fontFamily) {
            styles.fontFamily = `"${style.fontFamily}", system-ui, sans-serif`
        }
        if (typeof style?.fontWeight === 'number') {
            styles.fontWeight = style.fontWeight
        }
    }
    const colorVal = colorToProp(n.color)
    if (colorVal) {
        styles.color = colorVal
    }
    if (n.textAlign) {
        styles.textAlign = n.textAlign
    }
    const wrapsUnderlineRun =
        n.textDecoration === TextDecoration.Underline && fixedWidth !== undefined
    if (n.textDecoration && !wrapsUnderlineRun) {
        styles.textDecoration =
            n.textDecoration === TextDecoration.Underline ? 'underline' : n.textDecoration
    }
    if (fixedWidth !== undefined) {
        styles.width = numberOrExpressionToProp(fixedWidth, ctx.env.remBase)
    }
    if (fillMain) {
        styles.flex = 1
        styles.minWidth = 0
    }
    if (fillCross) {
        styles.alignSelf = 'stretch'
    }
    if (hasExplicitLineBreak || (contentCanContainLineBreaks && !isHug)) {
        styles.whiteSpace = 'pre-wrap'
    } else if (isHug) {
        styles.whiteSpace = 'nowrap'
    }
    const tag = styledTag('span')
    const attrs = attrsFromObject(styles)
    const textStyleProp = expressionPropName(n.textStyle)
    if (textStyleProp) {
        attrs.push(
            f.createJsxAttribute(f.createIdentifier('textStyle'), propExpression(textStyleProp)),
        )
    }
    const colorProp = expressionPropName(n.color)
    if (colorProp) {
        attrs.push(
            f.createJsxAttribute(f.createIdentifier('style'), fillStyleExpression(colorProp)),
        )
    }
    const contentProp = expressionPropName(n.content)
    const contentPropExpr = contentProp ? propExpression(contentProp) : undefined
    const children: ast.JsxChild[] = contentPropExpr
        ? [contentPropExpr]
        : [f.createJsxExpression(undefined, stringLiteral(normalizeTextLineBreaks(contentLiteral)))]
    const renderedChildren: ast.JsxChild[] = wrapsUnderlineRun
        ? [jsxEl(tag, attrsFromObject({ textDecoration: 'underline' }), children)]
        : children
    return { jsx: jsxEl(tag, attrs, renderedChildren), uses }
}
