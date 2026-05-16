import type * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import type { DInstance, LengthValue } from '../../../compiler/design-ast.ts'
import { Anchor, Sizing } from '../../../compiler/design-ast.ts'
import { attrsFromObject, jsxSelf, propExpression, propExpressionWithFallback } from '../ast.ts'
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
import { emptyUses, LocalCtx } from '../lowerer-types.ts'
import { axisSizing, sizeToProp } from '../sizing.ts'

function deepEq(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true
    }
    if (typeof a !== typeof b) {
        return false
    }
    if (a && b && typeof a === 'object') {
        if (Array.isArray(a) !== Array.isArray(b)) {
            return false
        }
        const ka = Object.keys(a)
        const kb = Object.keys(b as object)
        if (ka.length !== kb.length) {
            return false
        }
        return ka.every((k) =>
            deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
        )
    }
    return false
}

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

export function emitInstance(n: DInstance, ctx: Ctx, parent: ParentCtx): LowerResult {
    const uses = emptyUses()
    uses.usedComponents.add(n.componentName)
    // Elide props that match defaultProps.
    const allProps = n.props
    const props = n.defaultProps
        ? Object.fromEntries(
              Object.entries(allProps).filter(([k, v]) => !deepEq(v, n.defaultProps![k])),
          )
        : allProps
    const bindings = (n as Record<string, unknown>).instancePropBindings as
        | Record<string, string>
        | undefined
    const attrKeys = new Set<string>([
        ...Object.keys(props),
        ...(bindings ? Object.keys(bindings) : []),
    ])
    const attrs: ast.JsxAttributeLike[] = []
    for (const k of attrKeys) {
        const boundKey = bindings?.[k]
        if (boundKey) {
            const fallback = allProps[k]
            attrs.push(
                f.createJsxAttribute(
                    f.createIdentifier(k),
                    fallback === undefined
                        ? propExpression(boundKey)
                        : propExpressionWithFallback(boundKey, fallback),
                ),
            )
        } else if (isExpressionValue(props[k])) {
            const propName = props[k].name
            attrs.push(f.createJsxAttribute(f.createIdentifier(k), propExpression(propName)))
        } else {
            attrs.push(
                ...attrsFromObject({
                    [k]: componentPropToTargetValue(props[k], ctx),
                }),
            )
        }
    }
    // Layout overlay — when this instance is a flex child and parent isn't
    // hugging, FIXED axes need flex-shrink: 0; FILL axes get flex/alignSelf.
    const layoutStyles: Record<string, unknown> = {}
    const sizingH = axisSizing(n.width)
    const sizingV = axisSizing(n.height)
    if (
        (parent.has(LocalCtx.Flex) || parent.has(LocalCtx.Stack)) &&
        !parent.has(LocalCtx.MainAxisHug)
    ) {
        if (parent.has(LocalCtx.Flex) && sizingH === Sizing.Fixed) {
            layoutStyles.flexShrink = 0
        }
        if (parent.has(LocalCtx.Stack) && sizingV === Sizing.Fixed) {
            layoutStyles.flexShrink = 0
        }
    }
    const absoluteStretchH = n.absolute?.anchor?.horizontal === Anchor.Stretch
    const absoluteStretchV = n.absolute?.anchor?.vertical === Anchor.Stretch
    const applyInstanceAxis = (
        axis: 'h' | 'v',
        sizing: Sizing | undefined,
        absStretch: boolean,
    ) => {
        const main = axis === 'h' ? LocalCtx.Flex : LocalCtx.Stack
        const cross = axis === 'h' ? LocalCtx.Stack : LocalCtx.Flex
        const sizeKey = axis === 'h' ? 'width' : 'height'
        const minKey = axis === 'h' ? 'minWidth' : 'minHeight'
        if (absStretch) {
            layoutStyles[sizeKey] = '100%'
        } else if (sizing === Sizing.Fill) {
            if (parent.has(main) && !parent.has(LocalCtx.MainAxisHug)) {
                layoutStyles.flex = 1
                layoutStyles[minKey] = 0
            } else if (!parent.has(LocalCtx.Flex) && !parent.has(LocalCtx.Stack)) {
                layoutStyles[sizeKey] = '100%'
            } else if (parent.has(cross)) {
                layoutStyles.alignSelf = 'stretch'
                layoutStyles[sizeKey] = '100%'
            }
        }
    }
    applyInstanceAxis('h', sizingH, absoluteStretchH)
    applyInstanceAxis('v', sizingV, absoluteStretchV)
    if (n.layoutOverrides) {
        for (const [k, v] of Object.entries(n.layoutOverrides)) {
            if (v) {
                const val = sizeToProp(v as LengthValue, ctx.env.remBase)
                if (val !== undefined) {
                    layoutStyles[k] = val
                }
            }
        }
    }
    if (n.opacity !== undefined) {
        layoutStyles.opacity = n.opacity
    }
    // Pass concrete dim down — `<Icon Type={iconType} width="1rem" height="1rem"/>`
    // — when the parent has resized the instance off its master dim.
    if (!absoluteStretchH && sizingH === Sizing.Fixed && n.width) {
        const wv = sizeToProp(n.width, ctx.env.remBase)
        if (wv !== undefined) {
            layoutStyles.width = wv
        }
    }
    if (!absoluteStretchV && sizingV === Sizing.Fixed && n.height) {
        const hv = sizeToProp(n.height, ctx.env.remBase)
        if (hv !== undefined) {
            layoutStyles.height = hv
        }
    }
    // Don't emit layout keys that the component itself already specifies via props.
    for (const k of Object.keys(n.props)) {
        delete layoutStyles[k]
    }
    if (Object.keys(layoutStyles).length) {
        attrs.push(...attrsFromObject(layoutStyles))
    }

    return { jsx: jsxSelf(n.componentName, attrs), uses }
}
