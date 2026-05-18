import type {
    Color,
    ColorLiteral,
    CornerRadii,
    ExpressionValue,
    GradientPaint,
    ImagePaint,
    Length,
    LengthValue,
    LiteralValue,
    Paint,
    Shadow,
} from '../../compiler/design-ast.ts'

export function px2rem(v: number, base: number): string {
    return `${+(v / base).toFixed(6)}rem`
}

function isObj(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object'
}

export function isLengthLiteral(v: unknown): v is Length {
    return isObj(v) && typeof v.value === 'number' && (v.unit === 'px' || v.unit === '%')
}

export function isCornerRadii(v: unknown): v is CornerRadii {
    return isObj(v) && 'tl' in v
}

export function isPerSideWidth(v: unknown): v is {
    top: LengthValue
    right: LengthValue
    bottom: LengthValue
    left: LengthValue
} {
    return isObj(v) && 'top' in v
}

export function isExpressionValue(v: unknown): v is ExpressionValue {
    return isObj(v) && v.kind === 'expression'
}

export function isLiteralValue<T>(v: unknown): v is LiteralValue<T> {
    return isObj(v) && v.kind === 'literal'
}

export function sizeToPropLiteral(s: Length, remBase: number): string | number {
    if (s.value === 0) {
        return 0
    }
    if (s.unit === '%') {
        // toFixed(6) rounds the 7th digit, which for repeating fractions like
        // 26/192=13.5416666... bumps the value UP to 13.541667 — when chromium
        // multiplies that back by 192 it lands at 26.00000064, one column past
        // figma's exact-integer render. Use 10 digits so the round-trip stays
        // within rasterizer epsilon of the exact value.
        return `${+s.value.toFixed(10)}%`
    }
    return px2rem(s.value, remBase)
}

/** Numeric value for non-css-value calculations such as flex, opacity, and shadow offsets. */
export function sizeToPx(s: LengthValue | undefined): number | undefined {
    if (!s || isExpressionValue(s) || typeof s === 'string') {
        return undefined
    }
    if (isLiteralValue<Length>(s)) {
        return s.value.value
    }
    return undefined
}

export function isColorLiteralObject(v: unknown): v is ColorLiteral {
    if (!isObj(v)) {
        return false
    }
    if (typeof v.r !== 'number') {
        return false
    }
    if (typeof v.g !== 'number') {
        return false
    }
    if (typeof v.b !== 'number') {
        return false
    }
    return v.a === undefined || typeof v.a === 'number'
}

export function colorLiteralToCss(c: ColorLiteral): string {
    if (c.a !== undefined && c.a < 0.999) {
        return `rgba(${c.r},${c.g},${c.b},${+c.a.toFixed(6)})`
    }
    return `#${[c.r, c.g, c.b]
        .map((v) =>
            Math.max(0, Math.min(255, Math.round(v)))
                .toString(16)
                .padStart(2, '0'),
        )
        .join('')}`
}

export function colorToProp(c: Color | undefined): string | undefined {
    if (c && typeof c === 'object' && 'kind' in c) {
        if (c.kind === 'expression') {
            return undefined
        }
        if (c.kind === 'literal') {
            return colorLiteralToCss(c.value)
        }
    }
    if (!c) {
        return undefined
    }
    if (typeof c === 'string') {
        return c
    }
    if (isColorLiteralObject(c)) {
        return colorLiteralToCss(c)
    }
    return undefined
}

export function paintToProp(paint: Paint | undefined): string | undefined {
    if (!paint) {
        return undefined
    }
    if (isExpressionValue(paint)) {
        return undefined
    }
    if (typeof paint === 'string') {
        return paint
    }
    if (isLiteralValue<ColorLiteral | GradientPaint | ImagePaint>(paint)) {
        return paintLiteralToProp(paint.value)
    }
    return undefined
}

export function paintLiteralToProp(
    paint: ColorLiteral | GradientPaint | ImagePaint,
): string | undefined {
    if (isColorLiteralObject(paint)) {
        return colorLiteralToCss(paint)
    }
    if (paint.kind === 'linearGradient') {
        const stops = paint.stops
            .map(
                (stop: { offset: number; color: Color }) =>
                    `${colorToProp(stop.color) ?? 'transparent'} ${+(stop.offset * 100).toFixed(3)}%`,
            )
            .join(', ')
        return `linear-gradient(${paint.angle}deg, ${stops})`
    }
    // Image paints are routed through container/codegen lowerer with sidecar
    // registration — not inlined here. Return undefined so the caller emits
    // the image fill via `backgroundImage: url(<sidecar>)` instead.
    return undefined
}

export function isImagePaintLiteral(
    paint: Paint | undefined,
): paint is { kind: 'literal'; value: ImagePaint } {
    if (!paint || typeof paint === 'string') {
        return false
    }
    if (!isLiteralValue<ColorLiteral | GradientPaint | ImagePaint>(paint)) {
        return false
    }
    const v = paint.value as { kind?: string }
    return v.kind === 'image'
}

export function isGradientPaint(v: unknown): v is GradientPaint {
    return isObj(v) && v.kind === 'linearGradient' && Array.isArray(v.stops)
}

export function colorToCss(c: Color | undefined): string {
    const prop = colorToProp(c)
    if (!prop) {
        return 'transparent'
    }
    if (typeof c === 'string') {
        return `var(--colors-${c.replace(/\./g, '-')})`
    }
    return prop
}

export function cssColorLiteral(value: string): string {
    if (
        value === 'transparent' ||
        value.startsWith('#') ||
        value.startsWith('rgb') ||
        value.includes('gradient(')
    ) {
        return value
    }
    return `var(--colors-${value.replace(/\./g, '-')})`
}

export function cssBackgroundLayer(value: string): string {
    if (value.includes('gradient(')) {
        return value
    }
    return `linear-gradient(${value}, ${value})`
}

export function shadowToCss(shadow: Shadow, remBase: number): string {
    const x = sizeToPx(shadow.x) ?? 0
    const y = sizeToPx(shadow.y) ?? 0
    const blur = sizeToPx(shadow.blur) ?? 0
    const spread = shadow.spread ? (sizeToPx(shadow.spread) ?? 0) : 0
    return [
        px2rem(x, remBase),
        px2rem(y, remBase),
        px2rem(blur, remBase),
        px2rem(spread, remBase),
        colorToCss(shadow.color),
    ].join(' ')
}
