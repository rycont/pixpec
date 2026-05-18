// Style expression emitters: produce JSX-embeddable expressions for `style={...}`
// attributes, runtime hook declarations, and SVG conditional rendering.

import * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'
import {
    callExpression,
    jsxAttr,
    jsxEl,
    jsxSelf,
    nodeFlagsConst,
    noTokenFlags,
    numericLiteral,
    propAccess,
    propertyAssignment,
    stringLiteral,
    styleAttr,
    styledTag,
} from './ast.ts'
import { cssBackgroundLayer } from './data-lowerer.ts'

const QUESTION = f.createToken(ast.SyntaxKind.QuestionToken)
const COLON = f.createToken(ast.SyntaxKind.ColonToken)
const NULLISH = f.createToken(ast.SyntaxKind.QuestionQuestionToken)

export function sanitizeKey(s: string): string {
    return s.replace(/[^A-Za-z0-9]/g, '_')
}

export function templateString(parts: string[], exprs: ast.Expression[]): ast.TemplateExpression {
    const head = parts[0]
    const spans = exprs.map((e, i) => {
        const text = parts[i + 1]
        const isLast = i === exprs.length - 1
        const literal = isLast
            ? f.createTemplateTail(text, text, noTokenFlags)
            : f.createTemplateMiddle(text, text, noTokenFlags)
        return f.createTemplateSpan(e, literal)
    })
    return f.createTemplateExpression(f.createTemplateHead(head, head, noTokenFlags), spans)
}

// `{ <styleKey>: props.<propKey> }`
function singlePropStyle(styleKey: string, propKey: string): ast.JsxExpression {
    return f.createJsxExpression(
        undefined,
        f.createObjectLiteralExpression(
            [propertyAssignment(f.createIdentifier(styleKey), propAccess(propKey))],
            false,
        ),
    )
}

export function fillStyleExpression(key: string): ast.JsxExpression {
    return singlePropStyle('color', key)
}

export function fillBackgroundStyleExpression(key: string): ast.JsxExpression {
    return singlePropStyle('background', key)
}

export function boxShadowStyleExpression(key: string): ast.JsxExpression {
    return singlePropStyle('boxShadow', key)
}

// `{ boxShadow: props.<key> ? `<base>, ${props.<key>}` : "<base>" }`
export function boxShadowAppendStyleExpression(base: string, key: string): ast.JsxExpression {
    const cond = f.createConditionalExpression(
        propAccess(key),
        QUESTION,
        templateString([`${base}, `, ''], [propAccess(key)]),
        COLON,
        stringLiteral(base),
    )
    return f.createJsxExpression(
        undefined,
        f.createObjectLiteralExpression(
            [propertyAssignment(f.createIdentifier('boxShadow'), cond)],
            false,
        ),
    )
}

// `{ background: "<bg> padding-box, <paint> border-box", boxShadow?: "<shadow>" }`
export function staticBorderPaintStyleExpression(
    background: string,
    paint: string,
    baseShadow?: string,
): ast.JsxExpression {
    const bg = cssBackgroundLayer(background)
    const pt = cssBackgroundLayer(paint)
    const props: ast.ObjectLiteralElementLike[] = [
        propertyAssignment(
            f.createIdentifier('background'),
            stringLiteral(`${bg} padding-box, ${pt} border-box`),
        ),
    ]
    if (baseShadow) {
        props.push(propertyAssignment(f.createIdentifier('boxShadow'), stringLiteral(baseShadow)))
    }
    return f.createJsxExpression(undefined, f.createObjectLiteralExpression(props, false))
}

// `{ background: `<bg> padding-box, ${gradient-aware paint} border-box`, boxShadow?: ... }`
export function borderPaintStyleExpression(
    key: string,
    background: string,
    shadowKey: string | undefined,
    baseShadow: string | undefined,
): ast.JsxExpression {
    const bg = cssBackgroundLayer(background)
    const propOrTransparent = f.createBinaryExpression(
        undefined,
        propAccess(key),
        undefined,
        NULLISH,
        stringLiteral('transparent'),
    )
    const isGradient = callExpression(
        f.createPropertyAccessExpression(
            callExpression(f.createIdentifier('String'), [propOrTransparent]),
            undefined,
            f.createIdentifier('includes'),
            0 as ast.NodeFlags,
        ),
        [stringLiteral('gradient(')],
    )
    const paintLayer = f.createConditionalExpression(
        isGradient,
        QUESTION,
        propAccess(key),
        COLON,
        templateString(['linear-gradient(', ', ', ')'], [propOrTransparent, propOrTransparent]),
    )
    const props: ast.ObjectLiteralElementLike[] = [
        propertyAssignment(
            f.createIdentifier('background'),
            templateString([`${bg} padding-box, `, ' border-box'], [paintLayer]),
        ),
    ]
    const shadow = borderShadowExpr(shadowKey, baseShadow)
    if (shadow) {
        props.push(propertyAssignment(f.createIdentifier('boxShadow'), shadow))
    }
    return f.createJsxExpression(undefined, f.createObjectLiteralExpression(props, false))
}

function borderShadowExpr(
    shadowKey: string | undefined,
    baseShadow: string | undefined,
): ast.Expression | undefined {
    if (shadowKey && baseShadow) {
        return f.createConditionalExpression(
            propAccess(shadowKey),
            QUESTION,
            templateString([`${baseShadow}, `, ''], [propAccess(shadowKey)]),
            COLON,
            stringLiteral(baseShadow),
        )
    }
    if (shadowKey) {
        return propAccess(shadowKey)
    }
    if (baseShadow) {
        return stringLiteral(baseShadow)
    }
    return undefined
}

// `<Svg .../>` when no fill prop; `{props.X ? <SvgTinted .../> : <Svg .../>}` otherwise.
export function tintSwapJsx(
    normal: string,
    tinted: string,
    fillProp: string | undefined,
    extraAttrs: ast.JsxAttributeLike[] = [],
): ast.JsxChild {
    const baseStyle = { display: 'block' }
    const svgAttrs = (extra?: ast.JsxAttributeLike): ast.JsxAttributeLike[] => {
        const a: ast.JsxAttributeLike[] = [
            jsxAttr('preserveAspectRatio', 'none'),
            jsxAttr('shapeRendering', 'crispEdges'),
            ...extraAttrs,
        ]
        if (extra) {
            a.push(extra)
        }
        return a
    }
    const normalSvg = jsxSelf(normal, svgAttrs(styleAttr(baseStyle)))
    if (!fillProp) {
        return normalSvg
    }
    // Wrap tinted SVG in a `<styled.span color={props.X}>` so Panda's JSX prop
    // pipeline resolves whatever the value is: design-token paths get
    // converted to their CSS variable, raw hex/rgb get matched to a staticCss-
    // pre-emitted utility class. `display: contents` keeps the wrapper out of
    // the box model. init.ts's collectStaticTokens registers every observed
    // value under the `color` property so Panda's cssgen emits the matching
    // classes — without that registration, raw values produce hash classes
    // with no rule and the SVG paints its inherited (black) color.
    const tintedSvg = jsxSelf(tinted, svgAttrs(styleAttr(baseStyle)))
    const tintedWrap = jsxEl(
        styledTag('span'),
        [jsxAttr('color', propAccess(fillProp)), styleAttr({ display: 'contents' })],
        [tintedSvg],
    )
    return f.createJsxExpression(
        undefined,
        f.createConditionalExpression(
            propAccess(fillProp),
            QUESTION,
            tintedWrap as unknown as ast.Expression,
            COLON,
            normalSvg as unknown as ast.Expression,
        ),
    )
}

// `const [squircleRef<KEY>, squircleClipPath<KEY>] = useSquircleClip<HTMLDivElement>(R, S)`
export function squircleHookMarker(
    key: string,
    radiusPx: number,
    smoothing: number,
): ast.Statement {
    const bind = (name: string) =>
        f.createBindingElement(undefined, undefined, f.createIdentifier(name), undefined)
    return f.createVariableStatement(
        undefined,
        f.createVariableDeclarationList(
            [
                f.createVariableDeclaration(
                    f.createArrayBindingPattern([
                        bind(`squircleRef${key}`),
                        bind(`squircleClipPath${key}`),
                    ]),
                    undefined,
                    undefined,
                    f.createCallExpression(
                        f.createIdentifier('useSquircleClip'),
                        undefined,
                        [
                            f.createTypeReferenceNode(
                                f.createIdentifier('HTMLDivElement'),
                                undefined,
                            ),
                        ],
                        [numericLiteral(radiusPx), numericLiteral(smoothing)],
                        0 as ast.NodeFlags,
                    ),
                ),
            ],
            nodeFlagsConst,
        ),
    )
}

export function squircleRefExpression(key: string): ast.JsxExpression {
    return f.createJsxExpression(undefined, f.createIdentifier(`squircleRef${key}`))
}

export function squircleStyleExpression(key: string): ast.JsxExpression {
    return f.createJsxExpression(
        undefined,
        f.createObjectLiteralExpression(
            [
                propertyAssignment(
                    f.createIdentifier('clipPath'),
                    f.createIdentifier(`squircleClipPath${key}`),
                ),
            ],
            false,
        ),
    )
}

export function squircleFillBackgroundStyleExpression(
    fillKey: string,
    hookKey: string,
): ast.JsxExpression {
    return f.createJsxExpression(
        undefined,
        f.createObjectLiteralExpression(
            [
                propertyAssignment(
                    f.createIdentifier('clipPath'),
                    f.createIdentifier(`squircleClipPath${hookKey}`),
                ),
                propertyAssignment(f.createIdentifier('background'), propAccess(fillKey)),
            ],
            false,
        ),
    )
}

// Re-emit the root JSX element with an additional `{...cssProps}` spread attr.
export function injectSpreadAttr(
    jsx: ast.Expression,
    spread: ast.JsxSpreadAttribute,
): ast.Expression {
    if (ast.isJsxElement(jsx)) {
        const op = jsx.openingElement
        return f.createJsxElement(
            f.createJsxOpeningElement(
                op.tagName,
                op.typeArguments,
                f.createJsxAttributes([...op.attributes.properties, spread]),
            ),
            jsx.children,
            jsx.closingElement,
        ) as ast.Expression
    }
    if (ast.isJsxSelfClosingElement(jsx)) {
        return f.createJsxSelfClosingElement(
            jsx.tagName,
            jsx.typeArguments,
            f.createJsxAttributes([...jsx.attributes.properties, spread]),
        ) as ast.Expression
    }
    return jsx
}

// `const [{ direction: _cssDirection, ...cssProps }] = splitCssProps(props)`
export function splitCssPropsDecl(): ast.Statement {
    const dotDotDot = f.createToken(ast.SyntaxKind.DotDotDotToken)
    const objPattern = f.createObjectBindingPattern([
        f.createBindingElement(
            undefined,
            f.createIdentifier('direction'),
            f.createIdentifier('_cssDirection'),
            undefined,
        ),
        f.createBindingElement(dotDotDot, undefined, f.createIdentifier('cssProps'), undefined),
    ])
    const arrPattern = f.createArrayBindingPattern([
        f.createBindingElement(undefined, undefined, objPattern, undefined),
    ])
    return f.createVariableStatement(
        undefined,
        f.createVariableDeclarationList(
            [
                f.createVariableDeclaration(
                    arrPattern,
                    undefined,
                    undefined,
                    callExpression(f.createIdentifier('splitCssProps'), [
                        f.createIdentifier('props'),
                    ]),
                ),
            ],
            nodeFlagsConst,
        ),
    )
}
