import * as ast from '@typescript/native-preview/ast'
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
import * as f from '@typescript/native-preview/ast/factory'
import { attrsFromObject, compactPaddingStyles, jsxAttr, jsxEl, propAccess, propertyAssignment } from '../ast.ts'
import { templateString } from '../styles.ts'
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
import { assetImportPathFromOutput, imageAliasFromFilename } from '../assets.ts'
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
let dispatch: (n: DNode, ctx: Ctx, parent: ParentCtx) => Promise<LowerResult> = async () => {
    throw new Error('emitNode dispatcher not registered')
}
export function setNodeDispatcher(fn: typeof dispatch) {
    dispatch = fn
}

export async function emitContainer(n: DFlex | DStack | DBox, ctx: Ctx, parent: ParentCtx): Promise<LowerResult> {
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
    let imageBgIdent: ast.Identifier | undefined
    if (n.background) {
        if (isImagePaintLiteral(n.background) && n.background.value.asset) {
            const filename = n.background.value.asset
            const alias = imageAliasFromFilename(filename)
            uses.defaultImports.set(alias, assetImportPathFromOutput(filename, ctx))
            imageBgIdent = f.createIdentifier(alias)
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
    let promotedInsetBorderAttr: ast.JsxAttributeLike | undefined
    if (n.border) {
        const w = n.border.width
        const colorStr = paintToProp(n.border.paint)
        const colorRef = colorStr ? cssColorLiteral(colorStr) : '#000'
        const gradientBorder = Boolean(colorStr?.includes('gradient('))
        const widthPropName = !isPerSideWidth(w) ? expressionPropName(w) : undefined
        if (borderPaintProp) {
            const wPx = isPerSideWidth(w) ? undefined : sizeToPx(w)
            if (wPx !== undefined) {
                styles.border = `${px2rem(wPx, ctx.env.remBase)} solid transparent`
            }
        } else if (widthPropName && colorStr && !colorStr.includes('gradient(')) {
            // Promoted width — emit inline `style={{ boxShadow: `inset 0 0 0
            // ${props.X} ${color}` }}` so cssgen doesn't need to pre-emit a
            // class for every (width, color) combination.
            const head = n.border.align === StrokeAlign.Outside
                ? '0 0 0 '
                : 'inset 0 0 0 '
            const tail = ` ${colorRef}`
            const template = f.createTemplateExpression(
                f.createTemplateHead(head, head, undefined),
                [
                    f.createTemplateSpan(
                        propAccess(widthPropName),
                        f.createTemplateTail(tail, tail, undefined),
                    ),
                ],
            )
            promotedInsetBorderAttr = f.createJsxAttribute(
                f.createIdentifier('style'),
                f.createJsxExpression(
                    undefined,
                    f.createObjectLiteralExpression([
                        f.createPropertyAssignment(
                            undefined,
                            f.createIdentifier('boxShadow'),
                            undefined,
                            undefined,
                            template,
                        ),
                    ], false),
                ),
            )
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
    // Apply flip from figma transform matrix as CSS scaleX/Y(-1). HTML
    // cascade composes nested flips the same way figma's cumulative does.
    // Emit as inline `style={{ transform: ... }}` rather than Panda's
    // `transform` JSX prop — Panda statically extracts CSS at build time, so
    // runtime template-literal values would produce a hash class with no
    // matching rule. inline style hits the browser parser directly.
    const flipExpr = flipTransformExpr(n.flip)
    let flipStyleAttr: ast.JsxAttribute | undefined
    if (flipExpr !== undefined) {
        flipStyleAttr = f.createJsxAttribute(
            f.createIdentifier('style'),
            f.createJsxExpression(
                undefined,
                f.createObjectLiteralExpression(
                    [
                        propertyAssignment(
                            f.createIdentifier('transform'),
                            typeof flipExpr === 'string'
                                ? f.createStringLiteral(flipExpr)
                                : flipExpr,
                        ),
                    ],
                    false,
                ),
            ),
        )
    }

    // pick panda pattern
    const tag = direction === 'row' ? 'Flex' : direction === 'column' ? 'Stack' : 'Box'
    uses.usedJsxPatterns.add(tag)
    const compact = compactPaddingStyles(styles)
    // Panda's token-aware shorthand for the `background` CSS prop is `bg`.
    // Emitting `background=` skips the token utility in some Panda configs;
    // `bg=` always resolves design tokens (e.g. "line.divider" → bg_line.divider).
    if (compact && typeof compact === 'object' && 'background' in compact && !('bg' in compact)) {
        (compact as Record<string, unknown>).bg = (compact as Record<string, unknown>).background
        delete (compact as Record<string, unknown>).background
    }
    const attrs = attrsFromObject(compact)
    if (promotedInsetBorderAttr) attrs.push(promotedInsetBorderAttr)
    if (flipStyleAttr) attrs.push(flipStyleAttr)
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
                    f.createIdentifier('bg'),
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
    if (imageBgIdent) {
        // Background image URL must go through inline `style={...}` — Panda's
        // `bgImage` utility is not token-aware for dynamic URLs. backgroundSize
        // /Position/Repeat stay as Panda style props.
        const urlTemplate = f.createTemplateExpression(
            f.createTemplateHead('url(', 'url(', undefined),
            [
                f.createTemplateSpan(
                    imageBgIdent,
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
            ],
            false,
        )
        pushStyle(f.createJsxExpression(undefined, styleObj))
        attrs.push(
            jsxAttr('bgSize', 'cover'),
            jsxAttr('bgPosition', 'center'),
            jsxAttr('bgRepeat', 'no-repeat'),
        )
    }
    const childParent: ParentCtx =
        direction === 'row'
            ? flexCtx({ mainAxisHug: sizingH === Sizing.Hug })
            : direction === 'column'
              ? stackCtx({ mainAxisHug: sizingV === Sizing.Hug })
              : boxCtx()
    const childResults = await Promise.all(
        n.children.map((c) => dispatch(c, ctx, childParent)),
    )
    const children = childResults.map((r) => {
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

// Build the inline-style `transform` value for a figma flip. Returns:
//   undefined  — both axes are positive (no transform)
//   string     — literal flip only (e.g. "scaleX(-1)")
//   AST expr   — at least one axis is a prop expression; emits a template
//                literal like `${props.X ? 'scaleX(-1)' : ''} ${props.Y ?
//                'scaleY(-1)' : ''}` so each usage applies its own per-axis
//                flip at runtime.
function flipTransformExpr(
    flip: { x: unknown; y: unknown } | undefined,
): string | ast.Expression | undefined {
    if (!flip) return undefined
    const xExpr = expressionPropName(flip.x)
    const yExpr = expressionPropName(flip.y)
    const xLit = flip.x === true
    const yLit = flip.y === true
    const xPiece = !!flip.x
    const yPiece = !!flip.y
    if (!xPiece && !yPiece) return undefined
    // Pure literal path: just emit the CSS string.
    if (!xExpr && !yExpr) {
        const parts: string[] = []
        if (xLit) parts.push('scaleX(-1)')
        if (yLit) parts.push('scaleY(-1)')
        return parts.length ? parts.join(' ') : undefined
    }
    // Expression-driven: build `${flipX ? 'scaleX(-1)' : ''} ${flipY ?
    // 'scaleY(-1)' : ''}` using JS conditional expressions.
    const conditionalPart = (prop: unknown, css: string): ast.Expression => {
        if (prop === true) return f.createStringLiteral(css)
        const name = expressionPropName(prop)
        if (!name) return f.createStringLiteral('')
        return f.createConditionalExpression(
            propAccess(name),
            f.createToken(ast.SyntaxKind.QuestionToken),
            f.createStringLiteral(css),
            f.createToken(ast.SyntaxKind.ColonToken),
            f.createStringLiteral(''),
        )
    }
    return templateString(['', ' ', ''], [
        conditionalPart(flip.x, 'scaleX(-1)'),
        conditionalPart(flip.y, 'scaleY(-1)'),
    ])
}
