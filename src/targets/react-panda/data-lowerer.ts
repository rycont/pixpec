import type {
  Color,
  ColorLiteral,
  CornerRadii,
  GradientPaint,
  Length,
  LengthValue,
  LiteralValue,
  Paint,
  Shadow,
  ExpressionValue,
} from "../../compiler/design-ast.ts";

export const px2rem = (v: number, base: number): string =>
  `${+(v / base).toFixed(6)}rem`;

export function isLengthLiteral(value: unknown): value is Length {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { value?: unknown }).value === "number" &&
    (value as { unit?: unknown }).unit === "px"
  );
}

export function isCornerRadii(value: unknown): value is CornerRadii {
  return !!value && typeof value === "object" && "tl" in value;
}

export function isPerSideWidth(value: unknown): value is {
  top: LengthValue;
  right: LengthValue;
  bottom: LengthValue;
  left: LengthValue;
} {
  return !!value && typeof value === "object" && "top" in value;
}

export function sizeToPropLiteral(s: Length, remBase: number): string | number {
  if (s.value === 0) return 0;
  return px2rem(s.value, remBase);
}

export function isExpressionValue(value: unknown): value is ExpressionValue {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "expression"
  );
}

export function isLiteralValue<T>(value: unknown): value is LiteralValue<T> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "literal"
  );
}

/** Numeric value for non-css-value calculations such as flex, opacity, and shadow offsets. */
export function sizeToPx(s: LengthValue | undefined): number | undefined {
  if (!s || isExpressionValue(s) || typeof s === "string") return undefined;
  if (isLiteralValue<Length>(s)) return s.value.value;
  return undefined;
}

export function sizeToPxWithTokens(
  s: LengthValue | undefined,
  tokenValues: Record<string, number>,
): number | undefined {
  if (!s) return undefined;
  if (isExpressionValue(s)) return undefined;
  if (typeof s === "string") return tokenValues[s];
  if (isLiteralValue<Length>(s)) return s.value.value;
  return undefined;
}

export function isColorLiteralObject(value: unknown): value is ColorLiteral {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { r?: unknown }).r === "number" &&
    typeof (value as { g?: unknown }).g === "number" &&
    typeof (value as { b?: unknown }).b === "number" &&
    ((value as { a?: unknown }).a === undefined ||
      typeof (value as { a?: unknown }).a === "number")
  );
}

export function colorLiteralToCss(c: ColorLiteral): string {
  if (c.a !== undefined && c.a < 0.999) {
    return `rgba(${c.r},${c.g},${c.b},${+c.a.toFixed(6)})`;
  }
  return `#${[c.r, c.g, c.b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function colorToProp(c: Color | undefined): string | undefined {
  if (c && typeof c === "object" && "kind" in c) {
    if (c.kind === "expression") return undefined;
    if (c.kind === "literal") return colorLiteralToCss(c.value);
  }
  if (!c) return undefined;
  if (typeof c === "string") return c;
  if (isColorLiteralObject(c)) return colorLiteralToCss(c);
  return undefined;
}

export function paintToProp(paint: Paint | undefined): string | undefined {
  if (!paint) return undefined;
  if (isExpressionValue(paint)) return undefined;
  if (typeof paint === "string") return paint;
  if (isLiteralValue<ColorLiteral | GradientPaint>(paint))
    return paintLiteralToProp(paint.value);
  return undefined;
}

export function paintLiteralToProp(
  paint: ColorLiteral | GradientPaint,
): string | undefined {
  if (isColorLiteralObject(paint)) return colorLiteralToCss(paint);
  if (paint.kind === "linearGradient") {
    const stops = paint.stops
      .map(
        (stop: { offset: number; color: Color }) =>
          `${colorToProp(stop.color) ?? "transparent"} ${+(
            stop.offset * 100
          ).toFixed(3)}%`,
      )
      .join(", ");
    return `linear-gradient(${paint.angle}deg, ${stops})`;
  }
  return undefined;
}

export function isGradientPaint(value: unknown): value is GradientPaint {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "linearGradient" &&
    Array.isArray((value as { stops?: unknown }).stops)
  );
}

export function colorToCss(c: Color | undefined): string {
  const prop = colorToProp(c);
  if (!prop) return "transparent";
  if (typeof c === "string") {
    return `var(--colors-${c.replace(/\./g, "-")})`;
  }
  return prop;
}

export function cssColorLiteral(value: string): string {
  if (
    value === "transparent" ||
    value.startsWith("#") ||
    value.startsWith("rgb") ||
    value.includes("gradient(")
  ) {
    return value;
  }
  return `var(--colors-${value.replace(/\./g, "-")})`;
}

export function cssBackgroundLayer(value: string): string {
  return value.includes("gradient(")
    ? value
    : `linear-gradient(${value}, ${value})`;
}

export function shadowToCss(shadow: Shadow, remBase: number): string {
  const x = sizeToPx(shadow.x) ?? 0;
  const y = sizeToPx(shadow.y) ?? 0;
  const blur = sizeToPx(shadow.blur) ?? 0;
  const spread = shadow.spread ? (sizeToPx(shadow.spread) ?? 0) : 0;
  return [
    px2rem(x, remBase),
    px2rem(y, remBase),
    px2rem(blur, remBase),
    px2rem(spread, remBase),
    colorToCss(shadow.color),
  ].join(" ");
}
