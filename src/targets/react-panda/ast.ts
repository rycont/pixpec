// AST factory helpers: primitives + JSX builders + value/prop expression builders.
// Knows nothing about Figma IR or codegen semantics — pure TypeScript AST construction.

import * as ast from '@typescript/native-preview/ast'
import * as f from '@typescript/native-preview/ast/factory'

export const noTokenFlags = 0 as ast.TokenFlags
export const nodeFlagsConst = 2 as ast.NodeFlags
export const noType = undefined as unknown as ast.TypeNode
export const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export function stringLiteral(s: string): ast.StringLiteral {
    return f.createStringLiteral(s, noTokenFlags)
}

export function numericLiteral(v: number): ast.NumericLiteral {
    return f.createNumericLiteral(String(v), noTokenFlags)
}

export function keywordExpression<T extends ast.KeywordExpressionSyntaxKind>(
    k: T,
): ast.KeywordExpression<T> {
    return f.createKeywordExpression(k)
}

export function exportModifier(): ast.ModifierLike {
    return f.createToken(ast.SyntaxKind.ExportKeyword) as ast.ModifierLike
}

export function propertyAssignment(
    name: ast.PropertyName,
    init: ast.Expression,
): ast.PropertyAssignment {
    return f.createPropertyAssignment(undefined, name, undefined, noType, init)
}

export function callExpression(
    e: ast.Expression,
    args: readonly ast.Expression[],
): ast.CallExpression {
    return f.createCallExpression(e, undefined, undefined, args, 0 as ast.NodeFlags)
}

export function isExpressionNode(value: unknown): value is ast.Expression {
    return (
        !!value &&
        typeof value === 'object' &&
        typeof (value as { kind?: unknown }).kind === 'number'
    )
}

export function isJsxExpressionValue(value: unknown): value is ast.JsxExpression {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as { kind?: unknown }).kind === ast.SyntaxKind.JsxExpression
    )
}

export function valueToExpr(v: unknown): ast.Expression {
    if (isExpressionNode(v)) {
        return v
    }
    if (v === null) {
        return keywordExpression(ast.SyntaxKind.NullKeyword)
    }
    if (v === undefined) {
        return f.createIdentifier('undefined')
    }
    if (typeof v === 'boolean') {
        return keywordExpression(v ? ast.SyntaxKind.TrueKeyword : ast.SyntaxKind.FalseKeyword)
    }
    if (typeof v === 'number') {
        return numericLiteral(v)
    }
    if (typeof v === 'string') {
        return stringLiteral(v)
    }
    if (Array.isArray(v)) {
        return f.createArrayLiteralExpression(v.map(valueToExpr))
    }
    if (typeof v === 'object') {
        const props = Object.entries(v as Record<string, unknown>).map(([k, val]) => {
            const name = IDENT_RE.test(k) ? f.createIdentifier(k) : stringLiteral(k)
            return propertyAssignment(name, valueToExpr(val))
        })
        return f.createObjectLiteralExpression(props, false)
    }
    return stringLiteral(String(v))
}

// `props.X` — kept as PropertyAccess (not destructured to a local) so figma
// prop names that collide with imports don't shadow each other.
export function propAccess(key: string): ast.Expression {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
        return f.createElementAccessExpression(
            f.createIdentifier('props'),
            undefined,
            stringLiteral(key),
            0 as ast.NodeFlags,
        )
    }
    return f.createPropertyAccessExpression(
        f.createIdentifier('props'),
        undefined,
        f.createIdentifier(key),
        0 as ast.NodeFlags,
    )
}

export function propExpression(key: string): ast.JsxExpression {
    return f.createJsxExpression(undefined, propAccess(key))
}

export function propExpressionWithFallback(key: string, fallback: unknown): ast.JsxExpression {
    return f.createJsxExpression(
        undefined,
        f.createBinaryExpression(
            undefined,
            propAccess(key),
            undefined,
            f.createToken(ast.SyntaxKind.QuestionQuestionToken),
            valueToExpr(fallback),
        ),
    )
}

// JSX builders ---------------------------------------------------------------

export type TagFactory = string | (() => ast.JsxTagNameExpression)

export function styledTag(name: string): () => ast.JsxTagNameExpression {
    return () =>
        f.createPropertyAccessExpression(
            f.createIdentifier('styled'),
            undefined,
            f.createIdentifier(name),
            0 as ast.NodeFlags,
        ) as ast.JsxTagNameExpression
}

function tagNode(t: TagFactory): ast.JsxTagNameExpression {
    return typeof t === 'string' ? f.createIdentifier(t) : t()
}

export function jsxEl(
    tag: TagFactory,
    attrs: readonly ast.JsxAttributeLike[],
    children: readonly ast.JsxChild[],
): ast.JsxElement {
    return f.createJsxElement(
        f.createJsxOpeningElement(tagNode(tag), undefined, f.createJsxAttributes(attrs)),
        children,
        f.createJsxClosingElement(tagNode(tag)),
    )
}

export function jsxSelf(
    tag: TagFactory,
    attrs: readonly ast.JsxAttributeLike[],
): ast.JsxSelfClosingElement {
    return f.createJsxSelfClosingElement(tagNode(tag), undefined, f.createJsxAttributes(attrs))
}

// JSX attribute strings don't support `\"` escape — strings containing `"`
// must use expression form `prop={"\"x\""}`.
export function jsxStringInitializer(v: string): ast.JsxAttributeValue {
    if (v.includes('"') || /[^\x00-\x7F]/.test(v)) {
        return f.createJsxExpression(undefined, valueToExpr(v))
    }
    return stringLiteral(v)
}

export function jsxAttr(name: string, value: unknown): ast.JsxAttribute {
    const initializer: ast.JsxAttributeValue =
        typeof value === 'string'
            ? jsxStringInitializer(value)
            : f.createJsxExpression(undefined, valueToExpr(value))
    return f.createJsxAttribute(f.createIdentifier(name), initializer)
}

// Always emits `name={expr}` form, even for string values. Used in SVG
// attribute emission where the legacy output unconditionally wrapped strings.
export function jsxExprAttr(name: string, value: unknown): ast.JsxAttribute {
    return f.createJsxAttribute(
        f.createIdentifier(name),
        f.createJsxExpression(undefined, valueToExpr(value)),
    )
}

export function styleAttr(style: Record<string, unknown>): ast.JsxAttribute {
    return f.createJsxAttribute(
        f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(style)),
    )
}

function normalizeJsxProps(obj: Record<string, unknown>): Record<string, unknown> {
    const out = compactPaddingStyles(obj)
    if (out.borderRadius !== undefined) {
        out.rounded = out.borderRadius
        delete out.borderRadius
    }
    return out
}

export function attrsFromObject(obj: Record<string, unknown>): ast.JsxAttributeLike[] {
    const inline: ast.JsxAttributeLike[] = []
    const rest: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(normalizeJsxProps(obj))) {
        if (v === undefined) {
            continue
        }
        if (IDENT_RE.test(k)) {
            const initializer: ast.JsxAttributeValue = isJsxExpressionValue(v)
                ? v
                : typeof v === 'string'
                  ? jsxStringInitializer(v)
                  : f.createJsxExpression(undefined, valueToExpr(v))
            inline.push(f.createJsxAttribute(f.createIdentifier(k), initializer))
        } else {
            rest[k] = v
        }
    }
    if (Object.keys(rest).length) {
        inline.push(f.createJsxSpreadAttribute(valueToExpr(rest)))
    }
    return inline
}

// Collapses paddingTop/Right/Bottom/Left into Panda shorthand (p/px/py/pl/pr/pt/pb).
export function compactPaddingStyles(styles: Record<string, unknown>): Record<string, unknown> {
    const { paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l, ...out } = styles
    const all = [t, r, b, l]
    if (all.every((v) => v !== undefined) && all.every((v) => v === t)) {
        return { ...out, p: t }
    }
    if (l !== undefined && r !== undefined && l === r) {
        out.px = l
    } else {
        if (l !== undefined) {
            out.pl = l
        }
        if (r !== undefined) {
            out.pr = r
        }
    }
    if (t !== undefined && b !== undefined && t === b) {
        out.py = t
    } else {
        if (t !== undefined) {
            out.pt = t
        }
        if (b !== undefined) {
            out.pb = b
        }
    }
    return out
}
