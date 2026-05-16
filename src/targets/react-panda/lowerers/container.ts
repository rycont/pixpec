import type * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import type {
    Color,
    CornerRadii,
    DBox,
    DFlex,
    DNode,
    DStack,
    LengthValue,
    Shadow,
    Value,
} from '../../../compiler/design-ast.ts'
import { Align, Justify, NodeKind, Sizing, StrokeAlign } from '../../../compiler/design-ast.ts'
import { attrsFromObject, compactPaddingStyles, jsxEl, propAccess } from '../ast.ts'
import {
    cssColorLiteral,
    isCornerRadii,
    isImagePaintLiteral,
    isPerSideWidth,
    paintToProp,
    px2rem,
    shadowToCss,
    sizeToPx,
} from '../data-lowerer.ts'
import { imagePaintUrlMarker } from '../assets.ts'
import type { LowererCtx as Ctx, LowerResult, ParentCtx } from '../lowerer-types.ts'
import { boxCtx, emptyUses, flexCtx, LocalCtx, mergeUses, stackCtx } from '../lowerer-types.ts'
import {
    axisSizing,
    expressionPropName,
    isAbsoluteNode,
    nodeSourceId,
    sizeToProp,
    sizeToPropMinusPx,
} from '../sizing.ts'
import {
    borderPaintStyleExpression,
    boxShadowAppendStyleExpression,
    boxShadowStyleExpression,
    sanitizeKey,
    squircleFillBackgroundStyleExpression,
    squircleRefExpression,
    squircleStyleExpression,
    staticBorderPaintStyleExpression,
} from '../styles.ts'

// Reference to the dispatcher — set by codegen.ts to avoid circular import.
let dispatch: (n: DNode, ctx: Ctx, parent: ParentCtx) => LowerResult = () => {
    throw new Error('emitNode dispatcher not registered')
}
export function setNodeDispatcher(fn: typeof dispatch) {
    dispatch = fn
}

export function emitContainer(n: DFlex | DStack | DBox, ctx: Ctx, parent: ParentCtx): LowerResult {
    const uses = emptyUses()

    const direction: 'row' | 'column' | 'none' =
        n.kind === NodeKind.Flex ? 'row' : n.kind === NodeKind.Stack ? 'column' : 'none'
    const styles: Record<string, unknown> = {}
    const cssBorderLayoutInsetPx = insideCssBorderLayoutInsetPx(n)

    if (direction !== 'none') {
        const flex = n as DFlex | DStack
        // Always emit align — CSS default `stretch` ≠ figma `start`.
        styles.align = flex.align ?? Align.Start
        const visibleChildren = flex.children.filter((c) => !isAbsoluteNode(c))
        const justify =
            flex.justify === Justify.SpaceBetween && visibleChildren.length === 1
                ? Justify.Center
                : (flex.justify ?? Justify.Start)
        if (justify !== Justify.Start) {
            styles.justify = justify
        }
        // Skip gap=0 on row (token gaps are always nonzero); keep on column.
        const gap = sizeToProp(flex.gap, ctx.env.remBase)
        const gapIsZeroLiteral = sizeToPx(flex.gap) === 0
        if ((!gapIsZeroLiteral || direction === 'column') && gap !== undefined) {
            styles.gap = gap
        }
        if (flex.wrap) {
            styles.flexWrap = 'wrap'
            styles.alignContent = 'flex-start'
            const cg = sizeToProp(flex.counterGap, ctx.env.remBase)
            if (cg !== undefined && cg !== gap) {
                styles[direction === 'row' ? 'rowGap' : 'columnGap'] = cg
            }
        }
    }

    // padding — figma renders no visible padding for empty autolayout frames
    // (padding only affects child layout). Skip emission when no children.
    const hasChildren = 'children' in n && Array.isArray(n.children) && n.children.length > 0
    if (n.padding && hasChildren) {
        const pad = (side: keyof typeof n.padding, key: string) => {
            const v = sizeToPropMinusPx(n.padding![side], cssBorderLayoutInsetPx, ctx.env.remBase)
            if (v !== undefined && v !== 0) {
                styles[key] = v
            }
        }
        pad('top', 'paddingTop')
        pad('right', 'paddingRight')
        pad('bottom', 'paddingBottom')
        pad('left', 'paddingLeft')
    }

    // sizing
    const sizingH = axisSizing(n.width) ?? Sizing.Fixed
    const sizingV = axisSizing(n.height) ?? Sizing.Fixed
    const applyAxis = (axis: 'h' | 'v', sizing: Sizing, dim: typeof n.width | typeof n.height) => {
        const main = axis === 'h' ? LocalCtx.Flex : LocalCtx.Stack
        const cross = axis === 'h' ? LocalCtx.Stack : LocalCtx.Flex
        const sizeKey = axis === 'h' ? 'width' : 'height'
        const minKey = axis === 'h' ? 'minWidth' : 'minHeight'
        if (sizing === Sizing.Fill) {
            if (!parent.has(LocalCtx.Flex) && !parent.has(LocalCtx.Stack)) {
                styles[sizeKey] = '100%'
            } else if (parent.has(main) && !parent.has(LocalCtx.MainAxisHug)) {
                styles.flex = 1
                styles[minKey] = 0
            } else if (parent.has(cross)) {
                styles.alignSelf = 'stretch'
            }
        } else if (sizing === Sizing.Fixed && dim) {
            const v = sizeToProp(dim, ctx.env.remBase)
            if (v !== undefined) {
                styles[sizeKey] = v
            }
        }
    }
    applyAxis('h', sizingH, n.width)
    applyAxis('v', sizingV, n.height)
    // FIXED main-axis child of FILL/FIXED parent: don't flex-shrink.
    if (!parent.has(LocalCtx.MainAxisHug)) {
        if (parent.has(LocalCtx.Flex) && sizingH === Sizing.Fixed) {
            styles.flexShrink = 0
        }
        if (parent.has(LocalCtx.Stack) && sizingV === Sizing.Fixed) {
            styles.flexShrink = 0
        }
    }

    // min/max
    if (n.minWidth) {
        styles.minWidth = sizeToProp(n.minWidth, ctx.env.remBase)
    }
    if (n.maxWidth) {
        styles.maxWidth = sizeToProp(n.maxWidth, ctx.env.remBase)
    }
    if (n.minHeight) {
        styles.minHeight = sizeToProp(n.minHeight, ctx.env.remBase)
    }
    if (n.maxHeight) {
        styles.maxHeight = sizeToProp(n.maxHeight, ctx.env.remBase)
    }

    // background + opacity + render-bounds offset
    let imageBgExpr: ast.Expression | undefined
    if (n.background) {
        if (isImagePaintLiteral(n.background)) {
            imageBgExpr = imagePaintUrlMarker(
                n.background.value,
                nodeSourceId(n),
                ctx,
                uses,
            )
        } else {
            const bg = paintToProp(n.background)
            if (bg !== undefined) {
                styles.background = bg
            }
        }
    }
    if (n.opacity !== undefined) {
        styles.opacity = n.opacity
    }
    if (
        !parent.has(LocalCtx.Root) &&
        !isAbsoluteNode(n) &&
        n.renderBoundsOffset &&
        !isRenderBoundsFromAbsoluteChild(n)
    ) {
        const offsetX = sizeToPx(n.renderBoundsOffset.x) ?? 0
        const offsetY = sizeToPx(n.renderBoundsOffset.y) ?? 0
        styles.transform = `translate(${px2rem(-offsetX, ctx.env.remBase)}, ${px2rem(-offsetY, ctx.env.remBase)})`
    }

    // border (uniform-only path; per-side via boxShadow inset)
    const borderPaintProp = expressionPropName(n.border?.paint as unknown as Value<Color>)
    let staticBorderPaintStyle:
        | { background: string; paint: string; baseShadow?: string }
        | undefined
    if (n.border) {
        const w = n.border.width
        const colorStr = paintToProp(n.border.paint)
        const colorRef = colorStr ? cssColorLiteral(colorStr) : '#000'
        const gradientBorder = Boolean(colorStr?.includes('gradient('))
        if (borderPaintProp) {
            const wPx = isPerSideWidth(w) ? undefined : sizeToPx(w)
            if (wPx !== undefined) {
                styles.border = `${px2rem(wPx, ctx.env.remBase)} solid transparent`
            }
        } else if (isPerSideWidth(w)) {
            // Per-side widths via inset box-shadow.
            const remB = ctx.env.remBase
            const shadows: string[] = []
            const wt = sizeToPx(w.top)
            const wb = sizeToPx(w.bottom)
            const wl = sizeToPx(w.left)
            const wr = sizeToPx(w.right)
            if (wt) {
                shadows.push(`inset 0 ${px2rem(wt, remB)} 0 0 ${colorRef}`)
            }
            if (wb) {
                shadows.push(`inset 0 -${px2rem(wb, remB)} 0 0 ${colorRef}`)
            }
            if (wl) {
                shadows.push(`inset ${px2rem(wl, remB)} 0 0 0 ${colorRef}`)
            }
            if (wr) {
                shadows.push(`inset -${px2rem(wr, remB)} 0 0 0 ${colorRef}`)
            }
            if (shadows.length) {
                styles.boxShadow = shadows.join(', ')
            }
        } else {
            const wPx = sizeToPx(w)
            if (wPx !== undefined && gradientBorder) {
                styles.border = `${px2rem(wPx, ctx.env.remBase)} solid transparent`
                staticBorderPaintStyle = {
                    background: 'transparent',
                    paint: colorRef,
                }
            } else if (wPx !== undefined && n.border.align === StrokeAlign.Outside) {
                styles.boxShadow = `0 0 0 ${px2rem(wPx, ctx.env.remBase)} ${colorRef}`
            } else if (wPx !== undefined && n.border.align === StrokeAlign.Center) {
                styles.boxShadow = `0 0 0 ${px2rem(wPx / 2, ctx.env.remBase)} ${colorRef}, inset 0 0 0 ${px2rem(wPx / 2, ctx.env.remBase)} ${colorRef}`
            } else if (wPx !== undefined && Number.isInteger(wPx)) {
                styles.insetBorder = `${wPx} ${colorStr}`
            } else if (wPx !== undefined) {
                styles.boxShadow = `inset 0 0 0 ${px2rem(wPx, ctx.env.remBase)} ${colorRef}`
            }
        }
    }
    const shadowProp = expressionPropName(n.shadow as unknown as Value<Shadow>)
    if (!shadowProp && n.shadow) {
        const shadow = shadowToCss(n.shadow, ctx.env.remBase)
        styles.boxShadow = styles.boxShadow ? `${styles.boxShadow}, ${shadow}` : shadow
    }
    if (staticBorderPaintStyle) {
        staticBorderPaintStyle.background =
            typeof styles.background === 'string'
                ? cssColorLiteral(styles.background)
                : 'transparent'
        if (typeof styles.boxShadow === 'string') {
            staticBorderPaintStyle.baseShadow = styles.boxShadow
            delete styles.boxShadow
        }
        delete styles.background
    }

    // corner radius
    if (n.cornerRadius) {
        if (isCornerRadii(n.cornerRadius)) {
            const r = n.cornerRadius as CornerRadii
            for (const [from, to] of [
                ['tl', 'borderTopLeftRadius'],
                ['tr', 'borderTopRightRadius'],
                ['br', 'borderBottomRightRadius'],
                ['bl', 'borderBottomLeftRadius'],
            ] as const) {
                const v = sizeToProp(r[from], ctx.env.remBase)
                if (v) {
                    styles[to] = v
                }
            }
        } else {
            const r = sizeToProp(n.cornerRadius, ctx.env.remBase)
            if (r !== undefined && r !== 0) {
                styles.borderRadius = r
            }
        }
    }

    if (n.clip) {
        styles.overflow = 'hidden'
    }
    if (n.children?.some((c) => isAbsoluteNode(c))) {
        styles.position = 'relative'
    }

    // pick panda pattern
    const tag = direction === 'row' ? 'Flex' : direction === 'column' ? 'Stack' : 'Box'
    uses.usedJsxPatterns.add(tag)
    const compact = compactPaddingStyles(styles)
    const attrs = attrsFromObject(compact)
    const squircleRadius =
        n.cornerSmoothing &&
        n.cornerSmoothing > 0 &&
        n.width &&
        n.height &&
        sizingH === Sizing.Fixed &&
        sizingV === Sizing.Fixed
            ? sizeToPx(n.cornerRadius as LengthValue)
            : undefined
    const squircleHook =
        squircleRadius !== undefined
            ? {
                  key: sanitizeKey(nodeSourceId(n)),
                  radiusPx: squircleRadius,
                  smoothing: n.cornerSmoothing ?? 0,
              }
            : undefined
    if (squircleHook) {
        uses.squircleHooks.push(squircleHook)
        attrs.push(
            f.createJsxAttribute(
                f.createIdentifier('ref'),
                squircleRefExpression(squircleHook.key),
            ),
        )
    }
    const backgroundProp = expressionPropName(n.background)
    const pushStyle = (expr: ast.JsxExpression) =>
        attrs.push(f.createJsxAttribute(f.createIdentifier('style'), expr))
    if (staticBorderPaintStyle) {
        pushStyle(
            staticBorderPaintStyleExpression(
                staticBorderPaintStyle.background,
                staticBorderPaintStyle.paint,
                staticBorderPaintStyle.baseShadow,
            ),
        )
    } else if (borderPaintProp) {
        const background = typeof styles.background === 'string' ? styles.background : 'transparent'
        const baseShadow = typeof styles.boxShadow === 'string' ? styles.boxShadow : undefined
        pushStyle(borderPaintStyleExpression(borderPaintProp, background, shadowProp, baseShadow))
    } else if (backgroundProp) {
        if (squircleHook) {
            pushStyle(squircleFillBackgroundStyleExpression(backgroundProp, squircleHook.key))
        } else {
            // Use Panda's JSX prop (token-aware) instead of style={…} so
            // design-token strings (e.g. "components.fill.standard.primary")
            // resolve to CSS variables instead of getting written as raw
            // (invalid) color strings.
            attrs.push(
                f.createJsxAttribute(
                    f.createIdentifier('background'),
                    f.createJsxExpression(undefined, propAccess(backgroundProp)),
                ),
            )
        }
    } else if (squircleHook) {
        pushStyle(squircleStyleExpression(squircleHook.key))
    }
    if (!borderPaintProp && shadowProp) {
        const baseShadow = typeof styles.boxShadow === 'string' ? styles.boxShadow : undefined
        if (baseShadow) {
            delete styles.boxShadow
        }
        pushStyle(
            baseShadow
                ? boxShadowAppendStyleExpression(baseShadow, shadowProp)
                : boxShadowStyleExpression(shadowProp),
        )
    }
    if (imageBgExpr) {
        const urlTemplate = f.createTemplateExpression(
            f.createTemplateHead('url(', 'url(', undefined),
            [
                f.createTemplateSpan(
                    imageBgExpr,
                    f.createTemplateTail(')', ')', undefined),
                ),
            ],
        )
        const styleObj = f.createObjectLiteralExpression(
            [
                f.createPropertyAssignment(
                    undefined,
                    f.createIdentifier('backgroundImage'),
                    undefined,
                    undefined,
                    urlTemplate,
                ),
                f.createPropertyAssignment(
                    undefined,
                    f.createIdentifier('backgroundSize'),
                    undefined,
                    undefined,
                    f.createStringLiteral('cover', false),
                ),
                f.createPropertyAssignment(
                    undefined,
                    f.createIdentifier('backgroundPosition'),
                    undefined,
                    undefined,
                    f.createStringLiteral('center', false),
                ),
                f.createPropertyAssignment(
                    undefined,
                    f.createIdentifier('backgroundRepeat'),
                    undefined,
                    undefined,
                    f.createStringLiteral('no-repeat', false),
                ),
            ],
            false,
        )
        pushStyle(f.createJsxExpression(undefined, styleObj))
    }
    const childParent: ParentCtx =
        direction === 'row'
            ? flexCtx({ mainAxisHug: sizingH === Sizing.Hug })
            : direction === 'column'
              ? stackCtx({ mainAxisHug: sizingV === Sizing.Hug })
              : boxCtx()
    const children = n.children.map((c) => {
        const r = dispatch(c, ctx, childParent)
        mergeUses(uses, r.uses)
        return r.jsx
    })
    return { jsx: jsxEl(tag, attrs, children), uses }
}

function insideCssBorderLayoutInsetPx(n: DFlex | DStack | DBox): number {
    if (!n.border || n.border.align !== StrokeAlign.Inside) {
        return 0
    }
    const w = n.border.width
    if (isPerSideWidth(w)) {
        return 0
    }
    const wPx = sizeToPx(w)
    if (!wPx) {
        return 0
    }
    const borderPaintProp = expressionPropName(n.border.paint as unknown as Value<Color>)
    const colorStr = paintToProp(n.border.paint)
    return borderPaintProp || colorStr?.includes('gradient(') ? wPx : 0
}

function isRenderBoundsFromAbsoluteChild(n: DFlex | DStack | DBox): boolean {
    return n.children.some((child) => isAbsoluteNode(child))
}
