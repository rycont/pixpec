/**
 * React + PandaCSS target codegen — Design AST → self-contained .tsx source.
 *
 * Mirrors the legacy `src/generator/codegen.ts` output shape (Flex/Stack/Box
 * panda patterns, typography wrappers, styled.svg shapes, conditional
 * visibilityBinding render, FC + Generated/impl exports) but consumes the
 * platform-neutral Design AST (`src/compiler/design-ast.ts`) instead of the
 * legacy IR. The pipeline is: source dump → `compile()` → target `codegen()`.
 *
 * Token resolution: Length/Color values arrive pre-decided as token strings,
 * literal wrappers, or prop expressions. No figma var-id lookup happens here —
 * that work was done upstream by the compiler.
 */

import * as ast from "@typescript/native-preview/ast";
import * as f from "@typescript/native-preview/ast/factory";
import { isJsxSelfClosingElement } from "@typescript/native-preview/ast/is";
import { API } from "@typescript/native-preview/sync";
import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import type { CodegenPlugin } from "../../types.ts";
import type {
  DNode,
  DDataScope,
  DFlex,
  DStack,
  DBox,
  DText,
  DShape,
  DVector,
  DImage,
  DInstance,
  DUnknown,
  AxisSize,
  Length,
  LengthValue,
  Color,
  ColorLiteral,
  GradientPaint,
  Paint,
  CornerRadii,
  Shadow,
  Value,
  ExpressionValue,
  LiteralValue,
  DataScopeEntry,
} from "../../compiler/design-ast.ts";
import {
  NodeKind,
  Sizing,
  Anchor,
  Align,
  Justify,
  TextAutoResize,
  TextDecoration,
  TextAlign,
  ShapeKind,
  StrokeAlign,
  StrokeCap,
  FlowDirection,
} from "../../compiler/design-ast.ts";
import type {
  CodegenContext,
  CodegenResult,
  TargetComponentMeta,
} from "../types.ts";

// ---------------------------------------------------------------------------
// AST factory helpers — same wrappers as the legacy codegen.
// ---------------------------------------------------------------------------

const noTokenFlags = 0 as ast.TokenFlags;
const nodeFlagsConst = 2 as ast.NodeFlags;
const noType = undefined as unknown as ast.TypeNode;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const stringLiteral = (s: string): ast.StringLiteral =>
  f.createStringLiteral(s, noTokenFlags);
const numericLiteral = (v: number): ast.NumericLiteral =>
  f.createNumericLiteral(String(v), noTokenFlags);
const keywordExpression = <T extends ast.KeywordExpressionSyntaxKind>(
  k: T,
): ast.KeywordExpression<T> => f.createKeywordExpression(k);
const exportModifier = (): ast.ModifierLike =>
  f.createToken(ast.SyntaxKind.ExportKeyword) as ast.ModifierLike;
const propertyAssignment = (
  name: ast.PropertyName,
  init: ast.Expression,
): ast.PropertyAssignment =>
  f.createPropertyAssignment(undefined, name, undefined, noType, init);
const callExpression = (
  e: ast.Expression,
  args: readonly ast.Expression[],
): ast.CallExpression =>
  f.createCallExpression(e, undefined, undefined, args, 0 as ast.NodeFlags);

function valueToExpr(v: unknown): ast.Expression {
  if (isExpressionNode(v)) return v;
  if (v === null) return keywordExpression(ast.SyntaxKind.NullKeyword);
  if (v === undefined) return f.createIdentifier("undefined");
  if (typeof v === "boolean")
    return keywordExpression(
      v ? ast.SyntaxKind.TrueKeyword : ast.SyntaxKind.FalseKeyword,
    );
  if (typeof v === "number") return numericLiteral(v);
  if (typeof v === "string") return stringLiteral(v);
  if (Array.isArray(v))
    return f.createArrayLiteralExpression(v.map(valueToExpr));
  if (typeof v === "object") {
    const props = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => {
        const name = IDENT_RE.test(k)
          ? f.createIdentifier(k)
          : stringLiteral(k);
        return propertyAssignment(name, valueToExpr(val));
      },
    );
    return f.createObjectLiteralExpression(props, false);
  }
  return stringLiteral(String(v));
}

function expressionPropName(value: unknown): string | undefined {
  return isExpressionValue(value)
    ? value.name
    : undefined;
}

function literalValue<T>(value: unknown): T | undefined {
  return isLiteralValue<T>(value) ? value.value : undefined;
}

function valuePropExpression<T>(
  value: Value<T> | undefined,
): ast.JsxExpression | undefined {
  const name = expressionPropName(value);
  return name ? propExpression(name) : undefined;
}

// JSX attribute strings don't support `\"` escape — `prop="\"x\""` parses as
// invalid. Strings containing `"` must use expression form `prop={"\"x\""}`
// so the inner quote is a JS string escape, not JSX.
function jsxStringInitializer(v: string): ast.JsxAttributeValue {
  return v.includes('"') || /[^\x00-\x7F]/.test(v)
    ? f.createJsxExpression(undefined, valueToExpr(v))
    : stringLiteral(v);
}
function attrsFromObject(obj: Record<string, unknown>): ast.JsxAttributeLike[] {
  const inline: ast.JsxAttributeLike[] = [];
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(normalizeJsxProps(obj))) {
    if (v === undefined) continue;
    if (IDENT_RE.test(k)) {
      const initializer: ast.JsxAttributeValue = isJsxExpressionValue(v)
        ? v
        : typeof v === "string"
          ? jsxStringInitializer(v)
          : f.createJsxExpression(undefined, valueToExpr(v));
      inline.push(f.createJsxAttribute(f.createIdentifier(k), initializer));
    } else {
      rest[k] = v;
    }
  }
  if (Object.keys(rest).length)
    inline.push(f.createJsxSpreadAttribute(valueToExpr(rest)));
  return inline;
}

function isJsxExpressionValue(value: unknown): value is ast.JsxExpression {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === ast.SyntaxKind.JsxExpression
  );
}

function normalizeJsxProps(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out = compactPaddingStyles(obj);
  if (out.borderRadius !== undefined) {
    out.rounded = out.borderRadius;
    delete out.borderRadius;
  }
  return out;
}

function jsxAttr(name: string, value: unknown): ast.JsxAttribute {
  const initializer: ast.JsxAttributeValue =
    typeof value === "string"
      ? jsxStringInitializer(value)
      : f.createJsxExpression(undefined, valueToExpr(value));
  return f.createJsxAttribute(f.createIdentifier(name), initializer);
}

function styleAttr(style: Record<string, unknown>): ast.JsxAttribute {
  return f.createJsxAttribute(
    f.createIdentifier("style"),
    f.createJsxExpression(undefined, valueToExpr(style)),
  );
}

function appendJsxAttr(
  jsx: ast.JsxChild,
  attr: ast.JsxAttribute,
): ast.JsxChild {
  if (!isJsxSelfClosingElement(jsx)) return jsx;
  return f.updateJsxSelfClosingElement(
    jsx,
    jsx.tagName,
    jsx.typeArguments,
    f.createJsxAttributes([...jsx.attributes.properties, attr]),
  );
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a),
      kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEq(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Length / Paint → panda value.
// ---------------------------------------------------------------------------

const px2rem = (v: number, base: number): string =>
  `${+(v / base).toFixed(6)}rem`;

function isLengthLiteral(value: unknown): value is Length {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { value?: unknown }).value === "number" &&
    (value as { unit?: unknown }).unit === "px"
  );
}

function isCornerRadii(value: unknown): value is CornerRadii {
  return !!value && typeof value === "object" && "tl" in value;
}

function isPerSideWidth(value: unknown): value is {
  top: LengthValue;
  right: LengthValue;
  bottom: LengthValue;
  left: LengthValue;
} {
  return !!value && typeof value === "object" && "top" in value;
}

/** Length → panda atomic-prop value. Tokens emit the dot path; literals
 *  emit a rem string (panda passes through literal CSS values). */
function sizeToProp(
  s: LengthValue | undefined,
  remBase: number,
): string | number | ast.Expression | undefined {
  if (!s) return undefined;
  if (isExpressionValue(s)) return propExpressionNode(s.name);
  if (typeof s === "string") return s;
  if (isLiteralValue<Length>(s)) return sizeToPropLiteral(s.value, remBase);
  if (!isLengthLiteral(s)) return undefined;
  return sizeToPropLiteral(s, remBase);
}

function sizeToPropLiteral(s: Length, remBase: number): string | number {
  if (s.value === 0) return 0;
  return px2rem(s.value, remBase);
}

function isExpressionValue(value: unknown): value is ExpressionValue {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "expression"
  );
}

function isExpressionNode(value: unknown): value is ast.Expression {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { kind?: unknown }).kind === "number"
  );
}

function isLiteralValue<T>(value: unknown): value is LiteralValue<T> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "literal"
  );
}

/** Numeric value (for non-px props like flex, opacity). */
function sizeToPx(s: LengthValue | undefined): number | undefined {
  if (!s || isExpressionValue(s) || typeof s === "string") return undefined;
  if (isLiteralValue<Length>(s)) return s.value.value;
  return undefined;
}

function sizeToPxWithTokens(
  s: LengthValue | undefined,
  tokenValues: Record<string, number>,
): number | undefined {
  if (!s) return undefined;
  if (isExpressionValue(s)) return undefined;
  if (typeof s === "string") return tokenValues[s];
  if (isLiteralValue<Length>(s)) return s.value.value;
  return undefined;
}

function sizeToPropMinusPx(
  s: LengthValue | undefined,
  px: number,
  remBase: number,
): string | number | ast.Expression | undefined {
  if (!px) return sizeToProp(s, remBase);
  const value = sizeToPx(s);
  if (value === undefined) return sizeToProp(s, remBase);
  return sizeToPropLiteral({ value: Math.max(0, value - px), unit: "px" }, remBase);
}

function numberOrExpressionToProp(
  value: LengthValue,
  remBase: number,
): string | number | ast.Expression | undefined {
  return sizeToProp(value, remBase);
}

function axisSizing(axis: AxisSize | undefined): Sizing | undefined {
  if (axis === Sizing.Fill) return Sizing.Fill;
  if (axis === Sizing.Hug) return Sizing.Hug;
  if (axis !== undefined) return Sizing.Fixed;
  return undefined;
}

function isAbsoluteNode(node: DNode): boolean {
  return !!node.absolute;
}

function isColorLiteralObject(value: unknown): value is ColorLiteral {
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

function colorLiteralToCss(c: ColorLiteral): string {
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

function colorToProp(c: Color | undefined): string | undefined {
  if (c && typeof c === "object" && "kind" in c) {
    if (c.kind === "expression") return undefined;
    if (c.kind === "literal") return colorLiteralToCss(c.value);
  }
  if (!c) return undefined;
  if (typeof c === "string") return c;
  if (isColorLiteralObject(c)) return colorLiteralToCss(c);
  return undefined;
}

function paintToProp(paint: Paint | undefined): string | undefined {
  if (!paint) return undefined;
  if (isExpressionValue(paint)) return undefined;
  if (typeof paint === "string") return paint;
  if (isLiteralValue<ColorLiteral | GradientPaint>(paint))
    return paintLiteralToProp(paint.value);
  return undefined;
}

function paintLiteralToProp(paint: ColorLiteral | GradientPaint): string | undefined {
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

function isGradientPaint(value: unknown): value is GradientPaint {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "linearGradient" &&
    Array.isArray((value as { stops?: unknown }).stops)
  );
}

function componentPropToTargetValue(value: unknown, ctx: Ctx): unknown {
  if (!isLiteralValue<unknown>(value)) return value;
  const literal = value.value;
  if (isLengthLiteral(literal)) return sizeToPropLiteral(literal, ctx.remBase);
  if (isColorLiteralObject(literal)) return colorLiteralToCss(literal);
  if (isGradientPaint(literal)) return paintLiteralToProp(literal);
  return literal;
}

function colorToCss(c: Color | undefined): string {
  const prop = colorToProp(c);
  if (!prop) return "transparent";
  if (typeof c === "string") {
    return `var(--colors-${prop.replace(/\./g, "-")})`;
  }
  return prop;
}

function cssColorLiteral(value: string): string {
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

function cssBackgroundLayer(value: string): string {
  return value.includes("gradient(")
    ? value
    : `linear-gradient(${value}, ${value})`;
}

function tokenCssVar(tokenPath: string, ctx: Ctx): string {
  const fallback = ctx.tokenColorMap[tokenPath];
  const name = `--colors-${tokenPath.replace(/\./g, "-")}`;
  return fallback ? `var(${name}, ${fallback})` : `var(${name})`;
}

function shadowToCss(shadow: Shadow, remBase: number): string {
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

// ---------------------------------------------------------------------------
// Padding compaction (matches legacy codegen).
// ---------------------------------------------------------------------------

function compactPaddingStyles(
  styles: Record<string, unknown>,
): Record<string, unknown> {
  const top = styles.paddingTop;
  const right = styles.paddingRight;
  const bottom = styles.paddingBottom;
  const left = styles.paddingLeft;
  const out = { ...styles };
  delete out.paddingTop;
  delete out.paddingRight;
  delete out.paddingBottom;
  delete out.paddingLeft;
  if (
    top !== undefined &&
    right !== undefined &&
    bottom !== undefined &&
    left !== undefined &&
    top === right &&
    top === bottom &&
    top === left
  ) {
    out.p = top;
    return out;
  }
  if (left !== undefined && right !== undefined && left === right) {
    out.px = left;
  } else {
    if (left !== undefined) out.pl = left;
    if (right !== undefined) out.pr = right;
  }
  if (top !== undefined && bottom !== undefined && top === bottom) {
    out.py = top;
  } else {
    if (top !== undefined) out.pt = top;
    if (bottom !== undefined) out.pb = bottom;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codegen context.
// ---------------------------------------------------------------------------

interface Ctx {
  remBase: number;
  componentName: string;
  registry: Map<string, TargetComponentMeta>;
  tokenMap: Record<string, string>;
  tokenValueMap: Record<string, number>;
  tokenColorMap: Record<string, string>;
  typographyMap: Record<string, string>;
  plugins: CodegenPlugin[];
  usedJsxPatterns: Set<string>; // Flex / Stack / Box / styled
  usedTypography: Set<string>;
  usedComponents: Set<string>;
  usedPropBindings: Set<string>;
  usesCss: boolean;
  outputDir?: string;
  rootDir?: string;
  componentsDir?: string;
  propsFile?: string;
  viewConfig: NonNullable<CodegenContext["viewConfig"]>;
  repetitionComponents: Array<{
    name: string;
    props: Record<string, unknown[]>;
    jsx: ast.JsxChild;
  }>;
  repetitionMarkers: Map<string, string>;
  repetitionCounter: number;
  /** Target asset sidecars plus the import alias the generated JSX references. */
  svgSidecars: Map<
    string,
    { alias: string; content: string; importPath: string }
  >;
  imageSidecars: Map<string, { content: Uint8Array }>;
  assetUrls: Map<string, string>;
  squircleHooks: Array<{ id: number; radiusPx: number; smoothing: number }>;
  /** When true, the generated FC inlines an SVG filter `<defs>` and the
   *  inner Svg conditionally applies `filter: url(#tint_<id>)` when the
   *  caller passes a `color` CSS prop. Implements the "monochrome tint
   *  override" pattern (e.g. Logo rendered all-gray). */
  usesTinting: boolean;
  /** Stable filter id used inside the FC. Derived from sourceId so it
   *  doesn't collide across mounted components. */
  tintFilterId: string;
}

interface ParentCtx {
  dir: "row" | "column" | "none";
  mainSizing: Sizing;
  isRoot?: boolean;
}

const ROOT_PARENT: ParentCtx = {
  dir: "none",
  mainSizing: Sizing.Fixed,
  isRoot: true,
};

// ---------------------------------------------------------------------------
// Per-node emit functions.
// ---------------------------------------------------------------------------

// Reference props as `props.X` member access (instead of destructuring to a
// local `X`), so figma prop names that collide with imports (e.g. boolean
// toggle prop "Icon" vs the imported `Icon` component) don't shadow each
// other. tsgo's printer panics on factory-built PropertyAccessExpression
// inside JSX, so we emit a marker identifier and rewrite in post-process
// string substitution at the end of buildSource (see PIXPEC_PROP_ regex).
function propExpression(key: string): ast.JsxExpression {
  return f.createJsxExpression(undefined, propExpressionNode(key));
}

function propExpressionNode(key: string): ast.Expression {
  return f.createIdentifier(`PIXPEC_PROP_${key}`);
}

function propExpressionWithFallback(
  key: string,
  fallback: unknown,
): ast.JsxExpression {
  return f.createJsxExpression(
    undefined,
    f.createBinaryExpression(
      undefined,
      f.createIdentifier(`PIXPEC_PROP_${key}`),
      undefined,
      f.createToken(ast.SyntaxKind.QuestionQuestionToken),
      valueToExpr(fallback),
    ),
  );
}

function fillStyleExpression(key: string): ast.JsxExpression {
  return f.createJsxExpression(
    undefined,
    f.createIdentifier(`PIXPEC_FILL_STYLE_${key}`),
  );
}

function fillBackgroundStyleExpression(key: string): ast.JsxExpression {
  return f.createJsxExpression(
    undefined,
    f.createIdentifier(`PIXPEC_FILL_BACKGROUND_STYLE_${key}`),
  );
}

function boxShadowStyleExpression(key: string): ast.JsxExpression {
  return f.createJsxExpression(
    undefined,
    f.createIdentifier(`PIXPEC_BOX_SHADOW_STYLE_${key}`),
  );
}

function boxShadowAppendStyleExpression(
  base: string,
  key: string,
): ast.JsxExpression {
  return f.createJsxExpression(
    undefined,
    f.createIdentifier(
      `PIXPEC_BOX_SHADOW_APPEND_${encodeMarkerString(base)}__${key}`,
    ),
  );
}

function staticBorderPaintStyleExpression(
  background: string,
  paint: string,
  baseShadow?: string,
): ast.JsxExpression {
  const shadowSuffix = baseShadow ? `__${encodeMarkerString(baseShadow)}` : "";
  return f.createJsxExpression(
    undefined,
    f.createIdentifier(
      `PIXPEC_STATIC_BORDER_PAINT_STYLE_${encodeMarkerString(background)}__${encodeMarkerString(paint)}${shadowSuffix}`,
    ),
  );
}

function borderPaintStyleExpression(
  key: string,
  background: string,
  shadowKey?: string,
  baseShadow?: string,
): ast.JsxExpression {
  const shadowSuffix = shadowKey ? `__${shadowKey}` : "";
  const baseSuffix = baseShadow ? `__${encodeMarkerString(baseShadow)}` : "";
  return f.createJsxExpression(
    undefined,
    f.createIdentifier(
      `PIXPEC_BORDER_PAINT_STYLE_${key}__${encodeMarkerString(background)}${shadowSuffix}${baseSuffix}`,
    ),
  );
}

function encodeMarkerString(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function decodeMarkerString(value: string): string {
  return Buffer.from(value, "hex").toString("utf8");
}

function encodeMarkerNumber(value: number): string {
  return String(+value.toFixed(6)).replace(/-/g, "m").replace(/\./g, "p");
}

function squircleHookMarker(
  id: number,
  radiusPx: number,
  smoothing: number,
): ast.Statement {
  return f.createExpressionStatement(
    f.createIdentifier(
      `PIXPEC_SQUIRCLE_HOOK_${id}_${encodeMarkerNumber(radiusPx)}_${encodeMarkerNumber(smoothing)}`,
    ),
  );
}

function squircleRefExpression(id: number): ast.JsxExpression {
  return f.createJsxExpression(
    undefined,
    f.createIdentifier(`PIXPEC_SQUIRCLE_REF_${id}`),
  );
}

function squircleStyleExpression(id: number): ast.JsxExpression {
  return f.createJsxExpression(
    undefined,
    f.createIdentifier(`PIXPEC_SQUIRCLE_STYLE_${id}`),
  );
}

function squircleFillBackgroundStyleExpression(
  key: string,
  id: number,
): ast.JsxExpression {
  return f.createJsxExpression(
    undefined,
    f.createIdentifier(`PIXPEC_SQUIRCLE_FILL_BACKGROUND_STYLE_${key}_${id}`),
  );
}

function textStyleExpression(
  key: string,
  fallback?: string,
): ast.JsxExpression {
  const prop = f.createIdentifier(`PIXPEC_PROP_${key}`);
  const expr = fallback
    ? f.createBinaryExpression(
        undefined,
        prop,
        undefined,
        f.createToken(ast.SyntaxKind.BarBarToken),
        stringLiteral(fallback),
      )
    : prop;
  return f.createJsxExpression(undefined, expr);
}

function emitContainer(
  n: DFlex | DStack | DBox,
  ctx: Ctx,
  parent: ParentCtx,
): ast.JsxElement {
  const parentDir = parent.dir;
  const isRow = n.kind === NodeKind.Flex;
  const isCol = n.kind === NodeKind.Stack;
  const direction: "row" | "column" | "none" = isRow
    ? "row"
    : isCol
      ? "column"
      : "none";
  const styles: Record<string, unknown> = {};
  const cssBorderLayoutInsetPx = insideCssBorderLayoutInsetPx(n);

  if (direction !== "none") {
    const flex = n as DFlex | DStack;
    // align / justify — always emit align (CSS default `stretch` ≠ figma `start`).
    styles.align = flex.align ?? Align.Start;
    const visibleChildren = flex.children.filter((c) => !isAbsoluteNode(c));
    const justify =
      flex.justify === Justify.SpaceBetween && visibleChildren.length === 1
        ? Justify.Center
        : (flex.justify ?? Justify.Start);
    if (justify !== Justify.Start) styles.justify = justify;
    // gap (skip 0 on row to match legacy compactness; keep on column).
    const gap = sizeToProp(flex.gap, ctx.remBase);
    // Tokens are always considered "nonzero gap"; only explicit `0` literals
    // get elided on row containers.
    const gapIsZeroLiteral = sizeToPx(flex.gap) === 0;
    if (!gapIsZeroLiteral || direction === "column") {
      if (gap !== undefined) styles.gap = gap;
    }
    if (flex.wrap) {
      styles.flexWrap = "wrap";
      styles.alignContent = "flex-start";
      const cg = sizeToProp(flex.counterGap, ctx.remBase);
      if (cg !== undefined && cg !== gap) {
        if (direction === "row") styles.rowGap = cg;
        else styles.columnGap = cg;
      }
    }
  }

  // padding
  if (n.padding) {
    const pt = sizeToPropMinusPx(
      n.padding.top,
      cssBorderLayoutInsetPx,
      ctx.remBase,
    );
    const pr = sizeToPropMinusPx(
      n.padding.right,
      cssBorderLayoutInsetPx,
      ctx.remBase,
    );
    const pb = sizeToPropMinusPx(
      n.padding.bottom,
      cssBorderLayoutInsetPx,
      ctx.remBase,
    );
    const pl = sizeToPropMinusPx(
      n.padding.left,
      cssBorderLayoutInsetPx,
      ctx.remBase,
    );
    if (pt !== undefined && pt !== 0) styles.paddingTop = pt;
    if (pr !== undefined && pr !== 0) styles.paddingRight = pr;
    if (pb !== undefined && pb !== 0) styles.paddingBottom = pb;
    if (pl !== undefined && pl !== 0) styles.paddingLeft = pl;
  }

  // sizing
  const sizingH = axisSizing(n.width) ?? Sizing.Fixed;
  const sizingV = axisSizing(n.height) ?? Sizing.Fixed;
  if (sizingH === Sizing.Fill) {
    if (parentDir === "none") styles.width = "100%";
    else if (parentDir === "row" && parent.mainSizing !== Sizing.Hug) {
      styles.flex = 1;
      styles.minWidth = 0;
    } else if (parentDir === "column") {
      styles.alignSelf = "stretch";
    }
  } else if (sizingH === Sizing.Fixed && n.width) {
    const w = sizeToProp(n.width, ctx.remBase);
    if (w !== undefined) styles.width = w;
  }
  if (sizingV === Sizing.Fill) {
    if (parentDir === "none") styles.height = "100%";
    else if (parentDir === "column" && parent.mainSizing !== Sizing.Hug) {
      styles.flex = 1;
      styles.minHeight = 0;
    } else if (parentDir === "row") {
      styles.alignSelf = "stretch";
    }
  } else if (sizingV === Sizing.Fixed && n.height) {
    const h = sizeToProp(n.height, ctx.remBase);
    if (h !== undefined) styles.height = h;
  }
  // FIXED main-axis child of FILL/FIXED parent: don't flex-shrink.
  if (parent.mainSizing !== Sizing.Hug) {
    if (parentDir === "row" && sizingH === Sizing.Fixed) styles.flexShrink = 0;
    if (parentDir === "column" && sizingV === Sizing.Fixed)
      styles.flexShrink = 0;
  }

  // min/max
  if (n.minWidth) styles.minWidth = sizeToProp(n.minWidth, ctx.remBase);
  if (n.maxWidth) styles.maxWidth = sizeToProp(n.maxWidth, ctx.remBase);
  if (n.minHeight) styles.minHeight = sizeToProp(n.minHeight, ctx.remBase);
  if (n.maxHeight) styles.maxHeight = sizeToProp(n.maxHeight, ctx.remBase);

  // background
  if (n.background) {
    const bg = paintToProp(n.background);
    if (bg !== undefined) styles.background = bg;
  }
  if (n.opacity !== undefined) styles.opacity = n.opacity;
  if (
    !parent.isRoot &&
    !isAbsoluteNode(n) &&
    n.renderBoundsOffset &&
    !isRenderBoundsFromAbsoluteChild(n)
  ) {
    const offsetX = sizeToPx(n.renderBoundsOffset.x) ?? 0;
    const offsetY = sizeToPx(n.renderBoundsOffset.y) ?? 0;
    styles.transform = `translate(${px2rem(-offsetX, ctx.remBase)}, ${px2rem(-offsetY, ctx.remBase)})`;
  }

  // border (uniform-only path; per-side via boxShadow inset)
  const borderPaintProp = expressionPropName(
    n.border?.paint as unknown as Value<Color>,
  );
  let staticBorderPaintStyle:
    | { background: string; paint: string; baseShadow?: string }
    | undefined;
  if (n.border) {
    const w = n.border.width;
    const colorStr = paintToProp(n.border.paint);
    const colorRef = colorStr ? cssColorLiteral(colorStr) : "#000";
    const gradientBorder = Boolean(colorStr?.includes("gradient("));
    if (borderPaintProp) {
      const wPx = isPerSideWidth(w) ? undefined : sizeToPx(w);
      if (wPx !== undefined) {
        styles.border = `${px2rem(wPx, ctx.remBase)} solid transparent`;
      }
    } else if (isPerSideWidth(w)) {
      // mixed per-side
      const shadows: string[] = [];
      const wt = sizeToPx(w.top),
        wb = sizeToPx(w.bottom),
        wl = sizeToPx(w.left),
        wr = sizeToPx(w.right);
      if (wt)
        shadows.push(`inset 0 ${px2rem(wt, ctx.remBase)} 0 0 ${colorRef}`);
      if (wb)
        shadows.push(`inset 0 -${px2rem(wb, ctx.remBase)} 0 0 ${colorRef}`);
      if (wl)
        shadows.push(`inset ${px2rem(wl, ctx.remBase)} 0 0 0 ${colorRef}`);
      if (wr)
        shadows.push(`inset -${px2rem(wr, ctx.remBase)} 0 0 0 ${colorRef}`);
      if (shadows.length) styles.boxShadow = shadows.join(", ");
    } else {
      const wPx = sizeToPx(w);
      if (wPx !== undefined && gradientBorder) {
        styles.border = `${px2rem(wPx, ctx.remBase)} solid transparent`;
        staticBorderPaintStyle = {
          background: "transparent",
          paint: colorRef,
        };
      } else if (wPx !== undefined && n.border.align === StrokeAlign.Outside) {
        styles.boxShadow = `0 0 0 ${px2rem(wPx, ctx.remBase)} ${colorRef}`;
      } else if (wPx !== undefined && n.border.align === StrokeAlign.Center) {
        styles.boxShadow = `0 0 0 ${px2rem(wPx / 2, ctx.remBase)} ${colorRef}, inset 0 0 0 ${px2rem(wPx / 2, ctx.remBase)} ${colorRef}`;
      } else if (wPx !== undefined && Number.isInteger(wPx)) {
        styles.insetBorder = `${wPx} ${colorStr}`;
      } else if (wPx !== undefined) {
        styles.boxShadow = `inset 0 0 0 ${px2rem(wPx, ctx.remBase)} ${colorRef}`;
      }
    }
  }
  const shadowProp = expressionPropName(n.shadow as unknown as Value<Shadow>);
  if (!shadowProp && n.shadow) {
    const shadow = shadowToCss(n.shadow, ctx.remBase);
    styles.boxShadow = styles.boxShadow
      ? `${styles.boxShadow}, ${shadow}`
      : shadow;
  }
  if (staticBorderPaintStyle) {
    staticBorderPaintStyle.background =
      typeof styles.background === "string"
        ? cssColorLiteral(styles.background)
        : "transparent";
    if (typeof styles.boxShadow === "string") {
      staticBorderPaintStyle.baseShadow = styles.boxShadow;
      delete styles.boxShadow;
    }
    delete styles.background;
  }

  // corner radius
  if (n.cornerRadius) {
    if (isCornerRadii(n.cornerRadius)) {
      const r = n.cornerRadius as CornerRadii;
      const tl = sizeToProp(r.tl, ctx.remBase);
      const tr = sizeToProp(r.tr, ctx.remBase);
      const br = sizeToProp(r.br, ctx.remBase);
      const bl = sizeToProp(r.bl, ctx.remBase);
      if (tl) styles.borderTopLeftRadius = tl;
      if (tr) styles.borderTopRightRadius = tr;
      if (br) styles.borderBottomRightRadius = br;
      if (bl) styles.borderBottomLeftRadius = bl;
    } else {
      const r = sizeToProp(n.cornerRadius, ctx.remBase);
      if (r !== undefined && r !== 0) styles.borderRadius = r;
    }
  }

  if (n.clip) styles.overflow = "hidden";
  if (n.children?.some((c) => isAbsoluteNode(c)))
    styles.position = "relative";

  // pick panda pattern
  const tag =
    direction === "row" ? "Flex" : direction === "column" ? "Stack" : "Box";
  ctx.usedJsxPatterns.add(tag);
  const compact = compactPaddingStyles(styles);
  const attrs = attrsFromObject(compact);
  const squircleRadius =
    n.cornerSmoothing &&
    n.cornerSmoothing > 0 &&
    n.width &&
    n.height &&
    sizingH === Sizing.Fixed &&
    sizingV === Sizing.Fixed
      ? sizeToPxWithTokens(n.cornerRadius as LengthValue, ctx.tokenValueMap)
      : undefined;
  const squircleHook =
    squircleRadius !== undefined
      ? {
          id: ctx.squircleHooks.length,
          radiusPx: squircleRadius,
          smoothing: n.cornerSmoothing ?? 0,
        }
      : undefined;
  if (squircleHook) {
    ctx.squircleHooks.push(squircleHook);
    attrs.push(
      f.createJsxAttribute(
        f.createIdentifier("ref"),
        squircleRefExpression(squircleHook.id),
      ),
    );
  }
  const backgroundProp = expressionPropName(n.background);
  let styleAttrAdded = false;
  if (staticBorderPaintStyle) {
    attrs.push(
      f.createJsxAttribute(
        f.createIdentifier("style"),
        staticBorderPaintStyleExpression(
          staticBorderPaintStyle.background,
          staticBorderPaintStyle.paint,
          staticBorderPaintStyle.baseShadow,
        ),
      ),
    );
    styleAttrAdded = true;
  } else if (borderPaintProp) {
    ctx.usedPropBindings.add(borderPaintProp);
    const shadowKey = shadowProp;
    if (shadowKey) {
      ctx.usedPropBindings.add(shadowKey);
    }
    const background =
      typeof styles.background === "string" ? styles.background : "transparent";
    const baseShadow =
      typeof styles.boxShadow === "string" ? styles.boxShadow : undefined;
    attrs.push(
      f.createJsxAttribute(
        f.createIdentifier("style"),
        borderPaintStyleExpression(
          borderPaintProp,
          background,
          shadowKey,
          baseShadow,
        ),
      ),
    );
    styleAttrAdded = true;
  } else if (backgroundProp) {
    ctx.usedPropBindings.add(backgroundProp);
    attrs.push(
      f.createJsxAttribute(
        f.createIdentifier("style"),
        squircleHook
          ? squircleFillBackgroundStyleExpression(
              backgroundProp,
              squircleHook.id,
            )
          : fillBackgroundStyleExpression(backgroundProp),
      ),
    );
    styleAttrAdded = true;
  } else if (squircleHook) {
    attrs.push(
      f.createJsxAttribute(
        f.createIdentifier("style"),
        squircleStyleExpression(squircleHook.id),
      ),
    );
    styleAttrAdded = true;
  }
  if (!borderPaintProp && shadowProp) {
    ctx.usedPropBindings.add(shadowProp);
    const baseShadow =
      typeof styles.boxShadow === "string" ? styles.boxShadow : undefined;
    if (baseShadow) delete styles.boxShadow;
    attrs.push(
      f.createJsxAttribute(
        f.createIdentifier("style"),
        baseShadow
          ? boxShadowAppendStyleExpression(baseShadow, shadowProp)
          : boxShadowStyleExpression(shadowProp),
      ),
    );
    styleAttrAdded = true;
  }
  const open = f.createJsxOpeningElement(
    f.createIdentifier(tag),
    undefined,
    f.createJsxAttributes(attrs),
  );
  const close = f.createJsxClosingElement(f.createIdentifier(tag));
  const childParent: ParentCtx = {
    dir: direction,
    mainSizing:
      direction === "row"
        ? sizingH
        : direction === "column"
          ? sizingV
          : Sizing.Fixed,
  };
  const repeated = emitRepetitionChildren(n, ctx, childParent);
  const children =
    repeated ?? n.children.map((c) => emitNode(c, ctx, childParent));
  return f.createJsxElement(open, children, close);
}

function insideCssBorderLayoutInsetPx(n: DFlex | DStack | DBox): number {
  if (!n.border || n.border.align !== StrokeAlign.Inside) return 0;
  const w = n.border.width;
  if (isPerSideWidth(w)) return 0;
  const wPx = sizeToPx(w);
  if (!wPx) return 0;
  const borderPaintProp = expressionPropName(
    n.border.paint as unknown as Value<Color>,
  );
  const colorStr = paintToProp(n.border.paint);
  return borderPaintProp || colorStr?.includes("gradient(") ? wPx : 0;
}

function isRenderBoundsFromAbsoluteChild(n: DFlex | DStack | DBox): boolean {
  return n.children.some((child) => isAbsoluteNode(child));
}

function emitRepetitionChildren(
  n: DFlex | DStack | DBox,
  ctx: Ctx,
  childParent: ParentCtx,
): ast.JsxChild[] | undefined {
  const sourceId = nodeSourceId(n);
  const cfg = ctx.viewConfig[sourceId]?.repetition;
  if (!cfg) return undefined;
  if (n.children.length === 0) {
    throw new Error(
      `pixpec react-panda: repetition container ${sourceId} has no children`,
    );
  }
  const name = cfg.childComponent.name;
  const rows = analyzeRepetitionRows(sourceId, name, n.children);
  const template = applyRepetitionBindings(rows.template, rows.bindings);
  const jsx = emitNode(template, ctx, childParent);
  const marker = `PIXPEC_REPETITION_${ctx.repetitionCounter++}`;
  ctx.repetitionComponents.push({ name, props: rows.valuesByProp, jsx });
  ctx.repetitionMarkers.set(marker, repetitionMapSource(name, rows.records));
  return [f.createJsxExpression(undefined, f.createIdentifier(marker))];
}

interface RepetitionBinding {
  path: number[];
  kind:
    | "textContent"
    | "textFill"
    | "instanceProp"
    | "containerFill"
    | "visibility";
  key?: string;
  propName: string;
}

interface RepetitionRowAlignment {
  nodesByPath: Map<string, DNode>;
  missingPaths: number[][];
}

function analyzeRepetitionRows(
  containerId: string,
  componentName: string,
  rows: DNode[],
): {
  template: DNode;
  bindings: RepetitionBinding[];
  records: Array<Record<string, unknown>>;
  valuesByProp: Record<string, unknown[]>;
} {
  const templateIndex = chooseRepetitionTemplateIndex(rows);
  const template = rows[templateIndex];
  const alignments = rows.map((row, i) => {
    const alignment = alignRepetitionRow(template, row);
    if (alignment.error) {
      throw new Error(
        `pixpec repetition ${containerId}: child ${i + 1} does not match ${componentName} template (${alignment.error})`,
      );
    }
    if (rootMissingPaths(alignment.missingPaths).length > 1) {
      throw new Error(
        `pixpec repetition ${containerId}: child ${i + 1} differs from ${componentName} template by more than one missing node`,
      );
    }
    return alignment;
  });
  const candidates: Array<{ binding: RepetitionBinding; values: unknown[] }> =
    [];
  const seenVisibilityPaths = new Set<string>();
  for (const alignment of alignments) {
    for (const path of rootMissingPaths(alignment.missingPaths)) {
      const key = pathKey(path);
      if (seenVisibilityPaths.has(key)) continue;
      const node = nodeAtPath(template, path);
      if (!node) continue;
      candidates.push({
        binding: {
          path,
          kind: "visibility",
          propName: uniquePropName(
            showPropName(nodeSourceName(node)),
            candidates,
          ),
        },
        values: alignments.map(
          (a) => !a.missingPaths.some((missing) => samePath(missing, path)),
        ),
      });
      seenVisibilityPaths.add(key);
    }
  }
  walkAlignedRows(template, alignments, [], (nodes, path) => {
    if (nodes.some((node) => !node)) return;
    const present = nodes as DNode[];
    const sample = present[0];
    if (sample.kind === NodeKind.Text) {
      const values = present.map((n) => literalValue((n as DText).content));
      if (hasVariation(values)) {
        candidates.push({
          binding: {
            path,
            kind: "textContent",
            propName: uniquePropName(
              propName(nodeSourceName(sample)),
              candidates,
            ),
          },
          values,
        });
      }
      const colors = present.map((n) => colorToProp((n as DText).color));
      if (hasVariation(colors)) {
        candidates.push({
          binding: {
            path,
            kind: "textFill",
            propName: uniquePropName(
              `${propName(nodeSourceName(sample))}Fill`,
              candidates,
            ),
          },
          values: colors,
        });
      }
    } else if (sample.kind === NodeKind.Instance) {
      const keys = new Set<string>();
      for (const node of present) {
        for (const key of Object.keys((node as DInstance).props ?? {}))
          keys.add(key);
      }
      for (const key of [...keys].sort()) {
        const values = present.map((n) => (n as DInstance).props?.[key]);
        if (!hasVariation(values)) continue;
        candidates.push({
          binding: {
            path,
            kind: "instanceProp",
            key,
            propName: uniquePropName(
              nestedPropName(nodeSourceName(sample), key),
              candidates,
            ),
          },
          values,
        });
      }
    } else if (isContainerNode(sample)) {
      const values = present.map((n) =>
        paintToProp((n as DFlex | DStack | DBox).background),
      );
      if (hasVariation(values)) {
        candidates.push({
          binding: {
            path,
            kind: "containerFill",
            propName: uniquePropName(
              `${propName(nodeSourceName(sample))}Fill`,
              candidates,
            ),
          },
          values,
        });
      }
    }
  });
  const records = rows.map((_, i) =>
    Object.fromEntries(
      candidates.map(({ binding, values }) => [binding.propName, values[i]]),
    ),
  );
  const valuesByProp = Object.fromEntries(
    candidates.map(({ binding, values }) => [binding.propName, values]),
  );
  return {
    template,
    bindings: candidates.map((c) => c.binding),
    records,
    valuesByProp,
  };
}

function chooseRepetitionTemplateIndex(rows: DNode[]): number {
  let bestIndex = 0;
  let bestCount = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const count = nodeCount(rows[i]);
    if (count > bestCount) {
      bestIndex = i;
      bestCount = count;
    }
  }
  return bestIndex;
}

function nodeCount(node: DNode): number {
  return (
    1 + nodeChildren(node).reduce((sum, child) => sum + nodeCount(child), 0)
  );
}

function alignRepetitionRow(
  template: DNode,
  row: DNode,
): RepetitionRowAlignment & { error?: string } {
  const nodesByPath = new Map<string, DNode>();
  const missingPaths: number[][] = [];
  const error = alignNode(template, row, [], nodesByPath, missingPaths);
  return { nodesByPath, missingPaths, error };
}

function alignNode(
  template: DNode,
  row: DNode | undefined,
  path: number[],
  nodesByPath: Map<string, DNode>,
  missingPaths: number[][],
): string | undefined {
  if (!row) {
    missingPaths.push(path);
    return undefined;
  }
  const mismatch = compatibleNodeMismatch(template, row, pathLabel(path));
  if (mismatch) return mismatch;
  nodesByPath.set(pathKey(path), row);
  const templateChildren = nodeChildren(template);
  const rowChildren = nodeChildren(row);
  let rowIndex = 0;
  for (let i = 0; i < templateChildren.length; i += 1) {
    const templateChild = templateChildren[i];
    const rowChild = rowChildren[rowIndex];
    if (
      rowChild &&
      !compatibleNodeMismatch(templateChild, rowChild, pathLabel([...path, i]))
    ) {
      const error = alignNode(
        templateChild,
        rowChild,
        [...path, i],
        nodesByPath,
        missingPaths,
      );
      if (error) return error;
      rowIndex += 1;
    } else {
      missingPaths.push([...path, i]);
    }
  }
  if (rowIndex < rowChildren.length) {
    return `${pathLabel(path)}: extra child ${rowIndex + 1} of ${rowChildren.length}`;
  }
  return undefined;
}

function compatibleNodeMismatch(
  a: DNode,
  b: DNode,
  path: string,
): string | undefined {
  if (a.kind !== b.kind) return `${path}: kind ${a.kind} != ${b.kind}`;
  if (
    a.kind === NodeKind.Instance &&
    (a as DInstance).componentName !== (b as DInstance).componentName
  ) {
    return `${path}: instance ${(a as DInstance).componentName} != ${(b as DInstance).componentName}`;
  }
  if (
    a.kind === NodeKind.Shape &&
    (a as DShape).shape !== (b as DShape).shape
  ) {
    return `${path}: shape ${(a as DShape).shape} != ${(b as DShape).shape}`;
  }
  const ad = containerDirection(a);
  const bd = containerDirection(b);
  if (ad !== bd) return `${path}: direction ${ad} != ${bd}`;
  return undefined;
}

function walkAlignedRows(
  template: DNode,
  alignments: RepetitionRowAlignment[],
  path: number[],
  visit: (nodes: Array<DNode | undefined>, path: number[]) => void,
): void {
  visit(
    alignments.map((alignment) => alignment.nodesByPath.get(pathKey(path))),
    path,
  );
  const children = nodeChildren(template);
  for (let i = 0; i < children.length; i += 1) {
    walkAlignedRows(children[i], alignments, [...path, i], visit);
  }
}

function rootMissingPaths(paths: number[][]): number[][] {
  const roots: number[][] = [];
  for (const path of paths) {
    if (!roots.some((root) => isDescendantPath(root, path))) roots.push(path);
  }
  return roots;
}

function isDescendantPath(parent: number[], child: number[]): boolean {
  return (
    child.length > parent.length &&
    parent.every((value, i) => child[i] === value)
  );
}

function samePath(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, i) => b[i] === value);
}

function pathKey(path: number[]): string {
  return path.join(".");
}

function pathLabel(path: number[]): string {
  return path.length ? `root.${path.join(".")}` : "root";
}

function showPropName(name: string): string {
  const base = propName(name);
  const pascal = base ? `${base[0].toUpperCase()}${base.slice(1)}` : "Node";
  return `show${pascal}`;
}

function nodeChildren(n: DNode): DNode[] {
  return isContainerNode(n) ? n.children : [];
}

function isContainerNode(n: DNode): n is DFlex | DStack | DBox {
  return (
    n.kind === NodeKind.Flex ||
    n.kind === NodeKind.Stack ||
    n.kind === NodeKind.Box
  );
}

function containerDirection(n: DNode): "row" | "column" | "none" {
  return n.kind === NodeKind.Flex
    ? "row"
    : n.kind === NodeKind.Stack
      ? "column"
      : n.kind === NodeKind.Box
        ? "none"
        : "none";
}

function hasVariation(values: unknown[]): boolean {
  const first = stableValue(values[0]);
  return values.some((v) => stableValue(v) !== first);
}

function stableValue(value: unknown): string {
  return JSON.stringify(value);
}

function uniquePropName(
  base: string,
  candidates: Array<{ binding: RepetitionBinding }>,
): string {
  const used = new Set(candidates.map((c) => c.binding.propName));
  let name = IDENT_RE.test(base) ? base : propName(base);
  let i = 2;
  while (used.has(name)) name = `${base}${i++}`;
  return name;
}

function propName(name: string): string {
  const stripped = name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/#[^#]*$/, "")
    .trim();
  const parts = stripped.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return "prop";
  const joined = parts.join("");
  return joined === "style" ? "styleVariant" : joined;
}

function nestedPropName(layerName: string, key: string): string {
  const layer = propName(layerName);
  const prop = propName(key);
  return `${layer ? layer[0].toLowerCase() + layer.slice(1) : "item"}${prop}`;
}

function applyRepetitionBindings(
  root: DNode,
  bindings: RepetitionBinding[],
): DNode {
  const clone = cloneNode(root);
  for (const binding of bindings) {
    const node = nodeAtPath(clone, binding.path);
    if (!node) continue;
    if (binding.kind === "textContent" && node.kind === NodeKind.Text) {
      (node as DText).content = {
        kind: "expression",
        type: "prop",
        name: binding.propName,
      };
    } else if (binding.kind === "textFill" && node.kind === NodeKind.Text) {
      (node as DText).color = {
        kind: "expression",
        type: "prop",
        name: binding.propName,
      };
    } else if (
      binding.kind === "instanceProp" &&
      node.kind === NodeKind.Instance &&
      binding.key
    ) {
      const inst = node as DInstance;
      inst.instancePropBindings = {
        ...(inst.instancePropBindings ?? {}),
        [binding.key]: binding.propName,
      };
    } else if (binding.kind === "containerFill" && isContainerNode(node)) {
      node.background = {
        kind: "expression",
        type: "prop",
        name: binding.propName,
      };
    } else if (binding.kind === "visibility") {
      node.visible = {
        kind: "expression",
        type: "prop",
        name: binding.propName,
      };
    }
  }
  return clone;
}

function cloneNode<T extends DNode>(node: T): T {
  return structuredClone(node);
}

function nodeAtPath(root: DNode, path: number[]): DNode | undefined {
  let node: DNode | undefined = root;
  for (const index of path) {
    if (!node || !isContainerNode(node)) return undefined;
    node = node.children[index];
  }
  return node;
}

function repetitionMapSource(
  componentName: string,
  records: Array<Record<string, unknown>>,
): string {
  return `{${JSON.stringify(records, null, 4)}.map((item, index) => <${componentName} key={index} {...item} />)}`;
}

function localComponentSource(
  component: {
    name: string;
    props: Record<string, unknown[]>;
    jsx: ast.JsxChild;
  },
  printNode: (n: ast.Node) => string,
): string {
  const propsType = `${component.name}Props`;
  const fields = Object.entries(component.props)
    .map(([name, values]) => `    ${name}: ${unionType(values)}`)
    .join("\n");
  const body = printNode(component.jsx as unknown as ast.Node);
  return `interface ${propsType} {\n${fields}\n}\n\nconst ${component.name}: FC<${propsType}> = (props) => {\n    return (${body})\n}\n`;
}

function dataScopeData(root: DNode): Record<string, DataScopeEntry> {
  return root.kind === NodeKind.DataScope ? root.data : {};
}

function generatedPropsSource(
  root: DNode,
  rootPropsTypeName: string,
  _usedPropKeys: string[],
): string {
  const data = dataScopeData(root);
  const fields = Object.entries(data)
    .map(([key, def]) => {
      const type = reactPandaPropType(def.type);
      return `    ${key}?: ${type}`;
    })
    .join("\n");
  return `export interface GeneratedProps extends ${rootPropsTypeName} {\n${fields}\n}\n`;
}

function reactPandaPropType(type: string | undefined): string {
  if (type === "boolean") return "boolean";
  if (type === "number") return "number";
  if (type === "length") return "string | number";
  if (
    type === "string" ||
    type === "color" ||
    type === "paint" ||
    type === "textStyle" ||
    type === "shadow"
  ) {
    return "string";
  }
  if (type?.startsWith("component:")) return "unknown";
  return "unknown";
}

function unionType(values: unknown[]): string {
  const unique = [
    ...new Set(
      values
        .map((v) => JSON.stringify(v))
        .filter((v): v is string => v !== undefined),
    ),
  ];
  if (unique.length === 0) return "unknown";
  if (unique.every((v) => typeof JSON.parse(v) === "boolean")) return "boolean";
  if (
    unique.every((v) => {
      const parsed = JSON.parse(v) as unknown;
      return (
        typeof parsed === "string" ||
        typeof parsed === "boolean" ||
        typeof parsed === "number" ||
        parsed === null
      );
    })
  ) {
    return unique.join(" | ");
  }
  return "unknown";
}

function lookupTypoByPrefix(
  liveId: string,
  map: Record<string, string>,
): string | undefined {
  if (map[liveId]) return map[liveId];
  for (const k of Object.keys(map)) {
    if (liveId.startsWith(k) || k.startsWith(liveId)) return map[k];
  }
  return undefined;
}

function emitText(n: DText, ctx: Ctx, parent: ParentCtx): ast.JsxElement {
  const textStyleToken =
    typeof n.textStyle === "string" ? n.textStyle :
    !isExpressionValue(n.textStyle) && !isLiteralValue(n.textStyle) && "base" in n.textStyle
      ? n.textStyle.base
      : undefined;
  const textStyleLiteral = isLiteralValue(n.textStyle) ? n.textStyle.value : undefined;
  const textStyleOverrides =
    !isExpressionValue(n.textStyle) && !isLiteralValue(n.textStyle) && typeof n.textStyle === "object"
      ? n.textStyle
      : undefined;
  const isHug = n.autoResize === TextAutoResize.Hug;
  const parentDir = parent.dir;
  const parentHugMain = parent.mainSizing === Sizing.Hug;
  const sizingH = axisSizing(n.width) ?? Sizing.Fixed;
  const fillMain =
    sizingH === Sizing.Fill && parentDir === "row" && !parentHugMain;
  const fillCross = sizingH === Sizing.Fill && parentDir === "column";
  const collapsedFill =
    sizingH === Sizing.Fill && parentDir === "row" && parentHugMain;
  const fixedWidth =
    !isHug && !fillMain && !fillCross && !collapsedFill ? n.width : undefined;
  const contentLiteral = literalValue<string>(n.content) ?? "";
  const hasExplicitLineBreak = /[\n\r\u2028\u2029]/.test(contentLiteral);
  const contentCanContainLineBreaks =
    expressionPropName(n.content) !== undefined;

  ctx.usedJsxPatterns.add("styled");
  const styles: Record<string, unknown> = {};
  if (textStyleToken) {
    styles.textStyle = textStyleToken;
  } else {
    const style = textStyleLiteral ?? textStyleOverrides;
    styles.fontSize = sizeToProp(style?.fontSize, ctx.remBase);
    styles.lineHeight = sizeToProp(style?.lineHeight, ctx.remBase);
    if (style?.fontFamily)
      styles.fontFamily = `"${style.fontFamily}", system-ui, sans-serif`;
    if (typeof style?.fontWeight === "number") styles.fontWeight = style.fontWeight;
  }
  const colorVal = colorToProp(n.color);
  if (colorVal) styles.color = colorVal;
  if (n.textAlign) styles.textAlign = n.textAlign;
  const wrapsUnderlineRun =
    n.textDecoration === TextDecoration.Underline && fixedWidth !== undefined;
  if (n.textDecoration && !wrapsUnderlineRun) {
    if (n.textDecoration === TextDecoration.Underline) {
      styles.textDecoration = "underline";
    } else {
      styles.textDecoration = n.textDecoration;
    }
  }
  if (fixedWidth !== undefined)
    styles.width = numberOrExpressionToProp(fixedWidth, ctx.remBase);
  if (fillMain) {
    styles.flex = 1;
    styles.minWidth = 0;
  }
  if (fillCross) styles.alignSelf = "stretch";
  if (hasExplicitLineBreak || (contentCanContainLineBreaks && !isHug))
    styles.whiteSpace = "pre-wrap";
  else if (isHug) styles.whiteSpace = "nowrap";
  const tag = () =>
    f.createPropertyAccessExpression(
      f.createIdentifier("styled"),
      undefined,
      f.createIdentifier("span"),
      0 as ast.NodeFlags,
    );
  const attrs = attrsFromObject(styles);
  const textStyleProp = expressionPropName(n.textStyle);
  if (textStyleProp) {
    ctx.usedPropBindings.add(textStyleProp);
    attrs.push(
      f.createJsxAttribute(
        f.createIdentifier("textStyle"),
        propExpression(textStyleProp),
      ),
    );
  }
  const colorProp = expressionPropName(n.color);
  if (colorProp) {
    ctx.usedPropBindings.add(colorProp);
    attrs.push(
      f.createJsxAttribute(
        f.createIdentifier("style"),
        fillStyleExpression(colorProp),
      ),
    );
  }
  const contentProp = expressionPropName(n.content);
  if (contentProp) ctx.usedPropBindings.add(contentProp);
  const contentPropExpr = contentProp ? propExpression(contentProp) : undefined;
  const children: ast.JsxChild[] = contentPropExpr
    ? [contentPropExpr]
    : [
        f.createJsxExpression(
          undefined,
          stringLiteral(normalizeTextLineBreaks(contentLiteral)),
        ),
      ];
  const renderedChildren: ast.JsxChild[] = wrapsUnderlineRun
    ? [
        f.createJsxElement(
          f.createJsxOpeningElement(
            tag(),
            undefined,
            f.createJsxAttributes(
              attrsFromObject({ textDecoration: "underline" }),
            ),
          ),
          children,
          f.createJsxClosingElement(tag()),
        ),
      ]
    : children;
  const open = f.createJsxOpeningElement(
    tag(),
    undefined,
    f.createJsxAttributes(attrs),
  );
  const close = f.createJsxClosingElement(tag());
  return f.createJsxElement(open, renderedChildren, close);
}

function normalizeTextLineBreaks(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[\r\u2028\u2029]/g, "\n");
}

function emitShape(n: DShape, ctx: Ctx, _parent: ParentCtx): ast.JsxElement {
  const w = sizeToPx(n.width) ?? 0;
  const h = sizeToPx(n.height) ?? 0;
  const svgColor = (c: Color | undefined): string | undefined => {
    const prop = colorToProp(c);
    if (!prop) return undefined;
    return typeof c === "string" ? tokenCssVar(c, ctx) : prop;
  };
  const fillVal = paintToProp(n.fill) ?? "none";
  ctx.usedJsxPatterns.add("styled");
  const innerAttrs: Record<string, unknown> = { fill: fillVal };
  const strokeWidth = n.stroke ? (sizeToPx(n.stroke.width) ?? 1) : 0;
  const strokeInset =
    n.stroke?.align === StrokeAlign.Inside ? strokeWidth / 2 : 0;
  if (n.stroke) {
    innerAttrs.stroke = paintToProp(n.stroke.paint) ?? "#000";
    innerAttrs["strokeWidth"] = strokeWidth;
  }

  let inner: ast.JsxChild;
  if (n.shape === ShapeKind.Rect) {
    if (n.cornerRadius && !isCornerRadii(n.cornerRadius)) {
      const r = sizeToPx(n.cornerRadius);
      if (r) {
        innerAttrs.rx = r;
        innerAttrs.ry = r;
      }
    }
    inner = f.createJsxSelfClosingElement(
      f.createIdentifier("rect"),
      undefined,
      f.createJsxAttributes([
        ...(strokeInset > 0
          ? [
              f.createJsxAttribute(
                f.createIdentifier("x"),
                f.createJsxExpression(undefined, valueToExpr(strokeInset)),
              ),
              f.createJsxAttribute(
                f.createIdentifier("y"),
                f.createJsxExpression(undefined, valueToExpr(strokeInset)),
              ),
            ]
          : []),
        f.createJsxAttribute(
          f.createIdentifier("width"),
          f.createJsxExpression(
            undefined,
            valueToExpr(Math.max(0, w - strokeInset * 2)),
          ),
        ),
        f.createJsxAttribute(
          f.createIdentifier("height"),
          f.createJsxExpression(
            undefined,
            valueToExpr(Math.max(0, h - strokeInset * 2)),
          ),
        ),
        ...Object.entries(innerAttrs).map(([k, v]) =>
          f.createJsxAttribute(
            f.createIdentifier(k),
            f.createJsxExpression(undefined, valueToExpr(v)),
          ),
        ),
      ]),
    );
  } else if (n.shape === ShapeKind.Ellipse) {
    inner = f.createJsxSelfClosingElement(
      f.createIdentifier("ellipse"),
      undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(
          f.createIdentifier("cx"),
          f.createJsxExpression(undefined, valueToExpr(w / 2)),
        ),
        f.createJsxAttribute(
          f.createIdentifier("cy"),
          f.createJsxExpression(undefined, valueToExpr(h / 2)),
        ),
        f.createJsxAttribute(
          f.createIdentifier("rx"),
          f.createJsxExpression(
            undefined,
            valueToExpr(Math.max(0, (w - strokeInset * 2) / 2)),
          ),
        ),
        f.createJsxAttribute(
          f.createIdentifier("ry"),
          f.createJsxExpression(
            undefined,
            valueToExpr(Math.max(0, (h - strokeInset * 2) / 2)),
          ),
        ),
        ...Object.entries(innerAttrs).map(([k, v]) =>
          f.createJsxAttribute(
            f.createIdentifier(k),
            f.createJsxExpression(undefined, valueToExpr(v)),
          ),
        ),
      ]),
    );
  } else if (n.shape === ShapeKind.Line) {
    const horizontal = h === 0 || h < w;
    const sw = sizeToPx(n.stroke?.width) ?? 1;
    const cap = n.stroke?.cap ?? StrokeCap.Butt;
    const capInset = cap === StrokeCap.Butt ? 0 : sw / 2;
    const lx = horizontal ? capInset : sw / 2;
    const ly = horizontal ? sw / 2 : capInset;
    const lx2 = horizontal ? w - capInset : sw / 2;
    const ly2 = horizontal ? sw / 2 : h - capInset;
    const lineAttrs: ast.JsxAttribute[] = [
      f.createJsxAttribute(
        f.createIdentifier("x1"),
        f.createJsxExpression(undefined, valueToExpr(lx)),
      ),
      f.createJsxAttribute(
        f.createIdentifier("y1"),
        f.createJsxExpression(undefined, valueToExpr(ly)),
      ),
      f.createJsxAttribute(
        f.createIdentifier("x2"),
        f.createJsxExpression(undefined, valueToExpr(lx2)),
      ),
      f.createJsxAttribute(
        f.createIdentifier("y2"),
        f.createJsxExpression(undefined, valueToExpr(ly2)),
      ),
      ...Object.entries(innerAttrs).map(([k, v]) =>
        f.createJsxAttribute(
          f.createIdentifier(k),
          f.createJsxExpression(undefined, valueToExpr(v)),
        ),
      ),
    ];
    if (cap !== StrokeCap.Butt) {
      lineAttrs.push(
        f.createJsxAttribute(
          f.createIdentifier("strokeLinecap"),
          stringLiteral(cap),
        ),
      );
    }
    inner = f.createJsxSelfClosingElement(
      f.createIdentifier("line"),
      undefined,
      f.createJsxAttributes(lineAttrs),
    );
  } else {
    // polygon / star — placeholder rect.
    inner = f.createJsxSelfClosingElement(
      f.createIdentifier("rect"),
      undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(
          f.createIdentifier("width"),
          f.createJsxExpression(undefined, valueToExpr(w)),
        ),
        f.createJsxAttribute(
          f.createIdentifier("height"),
          f.createJsxExpression(undefined, valueToExpr(h)),
        ),
        ...Object.entries(innerAttrs).map(([k, v]) =>
          f.createJsxAttribute(
            f.createIdentifier(k),
            f.createJsxExpression(undefined, valueToExpr(v)),
          ),
        ),
      ]),
    );
  }

  // viewport inflate for line shapes
  let viewW = w,
    viewH = h;
  if (n.shape === ShapeKind.Line && n.stroke) {
    const sw = sizeToPx(n.stroke.width) ?? 1;
    if (h === 0) viewH = sw;
    if (w === 0) viewW = sw;
  }
  const hStretch =
    axisSizing(n.width) === Sizing.Fill ||
    n.absolute?.anchor?.horizontal === Anchor.Stretch;
  const vStretch =
    axisSizing(n.height) === Sizing.Fill ||
    n.absolute?.anchor?.vertical === Anchor.Stretch;
  const svgAttrs: ast.JsxAttribute[] = [
    f.createJsxAttribute(
      f.createIdentifier("viewBox"),
      stringLiteral(`0 0 ${viewW} ${viewH}`),
    ),
    f.createJsxAttribute(f.createIdentifier("display"), stringLiteral("block")),
    f.createJsxAttribute(
      f.createIdentifier("flexShrink"),
      f.createJsxExpression(undefined, valueToExpr(0)),
    ),
    f.createJsxAttribute(
      f.createIdentifier("width"),
      stringLiteral(hStretch ? "100%" : px2rem(viewW, ctx.remBase)),
    ),
    f.createJsxAttribute(
      f.createIdentifier("height"),
      stringLiteral(vStretch ? "100%" : px2rem(viewH, ctx.remBase)),
    ),
  ];
  if (n.shape === ShapeKind.Line && (hStretch || vStretch)) {
    svgAttrs.push(
      f.createJsxAttribute(
        f.createIdentifier("preserveAspectRatio"),
        stringLiteral("none"),
      ),
    );
  }
  if (n.opacity !== undefined) {
    svgAttrs.push(
      f.createJsxAttribute(
        f.createIdentifier("opacity"),
        f.createJsxExpression(undefined, valueToExpr(n.opacity)),
      ),
    );
  }
  const tag = () =>
    f.createPropertyAccessExpression(
      f.createIdentifier("styled"),
      undefined,
      f.createIdentifier("svg"),
      0 as ast.NodeFlags,
    );
  const open = f.createJsxOpeningElement(
    tag(),
    undefined,
    f.createJsxAttributes(svgAttrs),
  );
  const close = f.createJsxClosingElement(tag());
  return f.createJsxElement(open, [inner], close);
}

function emitVector(n: DVector, ctx: Ctx): ast.JsxChild {
  const rawW = sizeToPx(n.width) ?? 0;
  const rawH = sizeToPx(n.height) ?? 0;
  const svgSize = n.svg.startsWith("data:") ? undefined : svgRootSize(n.svg);
  const w = svgSize?.width ?? rawW;
  const h = svgSize?.height ?? rawH;
  if (n.svg.startsWith("data:")) {
    ctx.usedJsxPatterns.add("styled");
    const tag = () =>
      f.createPropertyAccessExpression(
        f.createIdentifier("styled"),
        undefined,
        f.createIdentifier("img"),
        0 as ast.NodeFlags,
      );
    return f.createJsxSelfClosingElement(
      tag(),
      undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier("src"), stringLiteral(n.svg)),
        f.createJsxAttribute(f.createIdentifier("alt"), stringLiteral("")),
        jsxAttr("flexShrink", 0),
        jsxAttr("width", px2rem(w, ctx.remBase)),
        jsxAttr("height", px2rem(h, ctx.remBase)),
        styleAttr({
          display: "block",
        }),
      ]),
    );
  }
  // Wrap the svgr-imported component in an inline-sized element. Breakdown
  // generated files are not part of Panda's static extraction set, so
  // arbitrary width/height must not depend on generated utility classes.
  const sourceId = nodeSourceId(n);
  const sidecarKey = assetSidecarPath(ctx, sidecarFilename(sourceId));
  const alias = sidecarAlias(sourceId);
  const normalizedSvg = n.svg;
  if (!ctx.svgSidecars.has(sidecarKey)) {
    ctx.svgSidecars.set(sidecarKey, {
      alias,
      content: ringifyStrokeCircles(normalizedSvg),
      importPath: assetImportPath(sidecarKey, "?react"),
    });
  }
  const fillProp = expressionPropName(n.fill);
  if (fillProp) {
    ctx.usedPropBindings.add(fillProp);
  }
  // preserveAspectRatio="none" matches figma's behaviour: a resized
  // instance stretches the master svg anisotropically to fill the box,
  // rather than svgr's default "xMidYMid meet" letterbox. When the vector
  // fill is declared as a prop expression, a second currentColor sidecar
  // lets that specific prop drive the SVG fill without relying on unrelated
  // target style conventions.
  const tintedKey = assetSidecarPath(ctx, sidecarFilenameTinted(sourceId));
  const tintedAlias = sidecarAliasTinted(sourceId);
  if (!ctx.svgSidecars.has(tintedKey)) {
    ctx.svgSidecars.set(tintedKey, {
      alias: tintedAlias,
      content: makeCurrentColorSvg(ringifyStrokeCircles(normalizedSvg)),
      importPath: assetImportPath(tintedKey, "?react"),
    });
  }
  ctx.usesTinting = true;
  const innerSvg = f.createJsxSelfClosingElement(
    f.createIdentifier("PIXPEC_TINT_SWAP"),
    undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(
        f.createIdentifier("normal"),
        f.createJsxExpression(undefined, f.createIdentifier(alias)),
      ),
      f.createJsxAttribute(
        f.createIdentifier("tinted"),
        f.createJsxExpression(undefined, f.createIdentifier(tintedAlias)),
      ),
      f.createJsxAttribute(
        f.createIdentifier("fillProp"),
        stringLiteral(fillProp ?? ""),
      ),
    ]),
  );
  ctx.usedJsxPatterns.add("styled");
  const tag = () =>
    f.createPropertyAccessExpression(
      f.createIdentifier("styled"),
      undefined,
      f.createIdentifier("span"),
      0 as ast.NodeFlags,
    );
  const open = f.createJsxOpeningElement(
    tag(),
    undefined,
    f.createJsxAttributes([
      jsxAttr("flexShrink", 0),
      jsxAttr("width", px2rem(w, ctx.remBase)),
      jsxAttr("height", px2rem(h, ctx.remBase)),
      styleAttr({
        display: "block",
      }),
    ]),
  );
  return f.createJsxElement(open, [innerSvg], f.createJsxClosingElement(tag()));
}

function svgRootSize(
  svg: string,
): { width: number; height: number } | undefined {
  const root = svg.match(/<svg\b([^>]*)>/i)?.[1];
  if (!root) return undefined;
  const read = (name: string) => {
    const raw = root.match(new RegExp(`\\s${name}="([^"]+)"`, "i"))?.[1];
    if (!raw) return undefined;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const width = read("width");
  const height = read("height");
  if (width && height) return { width, height };
  const viewBox = root
    .match(/\sviewBox="([^"]+)"/i)?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    const [, , w, h] = viewBox;
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return undefined;
}

function sidecarFilename(sourceId: string): string {
  return `svg__${sourceId.replace(/[^A-Za-z0-9]/g, "_")}.svg`;
}
function sidecarFilenameTinted(sourceId: string): string {
  return `svg__${sourceId.replace(/[^A-Za-z0-9]/g, "_")}__c.svg`;
}
function sidecarAlias(sourceId: string): string {
  return `Svg_${sourceId.replace(/[^A-Za-z0-9]/g, "_")}`;
}
function sidecarAliasTinted(sourceId: string): string {
  return `SvgC_${sourceId.replace(/[^A-Za-z0-9]/g, "_")}`;
}
function assetSidecarPath(ctx: Ctx, filename: string): string {
  const base = ctx.outputDir ? nodePath.basename(ctx.outputDir) : "";
  if (base === "generated" || base === "breakdown")
    return `../.pixpec/assets/${filename}`;
  return `.pixpec/assets/${filename}`;
}
function assetImportPath(relativePath: string, suffix = ""): string {
  const rel = relativePath.replace(/\\/g, "/");
  return `${rel.startsWith("./") || rel.startsWith("../") ? rel : `./${rel}`}${suffix}`;
}
function imageFilename(sourceId: string, mime: string): string | undefined {
  const ext = extensionForImageMime(mime);
  if (!ext) return undefined;
  return `image__${sourceId.replace(/[^A-Za-z0-9]/g, "_")}.${ext}`;
}
function extensionForImageMime(mime: string): string | undefined {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return undefined;
  }
}
function imageAssetUrlMarker(n: DImage, ctx: Ctx): string | undefined {
  if (!n.dataUrl) return undefined;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(n.dataUrl);
  if (!match) return undefined;
  const mime = match[1] ?? "";
  const filename = imageFilename(nodeSourceId(n), mime);
  if (!filename) return undefined;
  const relativePath = assetSidecarPath(ctx, filename);
  if (!ctx.imageSidecars.has(relativePath)) {
    ctx.imageSidecars.set(relativePath, {
      content: Buffer.from(match[2] ?? "", "base64"),
    });
  }
  const marker = `PIXPEC_ASSET_URL_${ctx.assetUrls.size}`;
  ctx.assetUrls.set(marker, assetImportPath(relativePath));
  return marker;
}
/** Replace every literal fill color in an SVG string with `currentColor`,
 *  so the rendered svg picks up the host element's CSS color. Strokes
 *  (used in Logo for outline circles) get the same treatment. Empty fills
 *  (`fill="none"`) and presentation-attribute defaults are left alone. */
function makeCurrentColorSvg(svg: string): string {
  // Match #RRGGBB[AA] hex AND any non-`none` color value (e.g. `white`,
  // `rgb(...)`, named colors). figma's white-variant Logo uses `fill="white"`
  // which is real paint — must convert to currentColor too. Skip `fill="none"`
  // (intentional no-paint).
  const colorRe = /(fill|stroke)="(?!none\b|currentColor\b)([^"]+)"/g;
  return svg
    .split(/(<mask\b[\s\S]*?<\/mask>)/g)
    .map((part) =>
      part.startsWith("<mask")
        ? part
        : part.replace(colorRe, (_m, attr) => `${attr}="currentColor"`),
    )
    .join("");
}

function normalizeFigmaAngularGradients(svg: string): string {
  const gradients: string[] = [];
  const out = svg.replace(
    /<g clip-path="url\(#([^"]+)_clip_path\)" data-figma-skip-parse="true"><g transform="[^"]*"><foreignObject\b[\s\S]*?<\/foreignObject><\/g><\/g><rect\b([^>]*?)\sdata-figma-gradient-fill="([^"]+)"([^>]*)\/>/g,
    (
      match,
      clipBase: string,
      before: string,
      rawJson: string,
      after: string,
    ) => {
      const parsed = parseFigmaGradient(rawJson);
      if (!parsed) return match;
      const id = `${clipBase}_linear_pixpec`;
      gradients.push(figmaGradientDef(id, parsed));
      return `<rect${before} ${after} fill="url(#${id})"/>`;
    },
  );
  if (gradients.length === 0) return out;
  if (out.includes("</defs>"))
    return out.replace("</defs>", `${gradients.join("")}</defs>`);
  return out.replace("</svg>", `<defs>${gradients.join("")}</defs></svg>`);
}

function parseFigmaGradient(raw: string):
  | Array<{
      color: { r: number; g: number; b: number; a: number };
      position: number;
    }>
  | undefined {
  try {
    const parsed = JSON.parse(
      raw
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, "&"),
    ) as {
      stops?: Array<{
        color?: { r?: number; g?: number; b?: number; a?: number };
        position?: number;
      }>;
    };
    const stops = parsed.stops
      ?.map((stop) => {
        const c = stop.color;
        if (!c) return undefined;
        return {
          color: { r: c.r ?? 0, g: c.g ?? 0, b: c.b ?? 0, a: c.a ?? 1 },
          position: stop.position ?? 0,
        };
      })
      .filter(
        (
          stop,
        ): stop is {
          color: { r: number; g: number; b: number; a: number };
          position: number;
        } => !!stop,
      );
    return stops && stops.length >= 2 ? stops : undefined;
  } catch {
    return undefined;
  }
}

function figmaGradientDef(
  id: string,
  stops: Array<{
    color: { r: number; g: number; b: number; a: number };
    position: number;
  }>,
): string {
  const stopTags = stops
    .map((stop) => {
      const c = stop.color;
      const r = Math.round(Math.max(0, Math.min(1, c.r)) * 255);
      const g = Math.round(Math.max(0, Math.min(1, c.g)) * 255);
      const b = Math.round(Math.max(0, Math.min(1, c.b)) * 255);
      const offset = `${Math.max(0, Math.min(100, stop.position * 100))}%`;
      return `<stop offset="${offset}" stop-color="rgb(${r},${g},${b})" stop-opacity="${c.a}"/>`;
    })
    .join("");
  return `<linearGradient id="${id}" x1="20" y1="96" x2="100" y2="16" gradientUnits="userSpaceOnUse">${stopTags}</linearGradient>`;
}

function normalizeFigmaDropShadowFilters(svg: string): string {
  const filters = new Map<string, string>();
  const withoutDefs = svg.replace(
    /<filter id="([^"]+)"[^>]*>[\s\S]*?<feOffset(?:\s+dx="([^"]+)")?\s+dy="([^"]+)"\/>\s*<feGaussianBlur stdDeviation="([^"]+)"\/>[\s\S]*?<feColorMatrix type="matrix" values="([^"]+)"\/>[\s\S]*?<\/filter>/g,
    (
      match,
      id: string,
      dxRaw: string | undefined,
      dyRaw: string,
      blurRaw: string,
      matrix: string,
    ) => {
      const values = matrix.trim().split(/\s+/).map(Number);
      if (values.length < 20) return match;
      const r = Math.round(Math.max(0, Math.min(1, values[4] ?? 0)) * 255);
      const g = Math.round(Math.max(0, Math.min(1, values[9] ?? 0)) * 255);
      const b = Math.round(Math.max(0, Math.min(1, values[14] ?? 0)) * 255);
      const a = Math.max(0, Math.min(1, values[18] ?? 1));
      const dx = Number(dxRaw ?? 0);
      const dy = Number(dyRaw);
      const blur = Number(blurRaw) * 2;
      if (![dx, dy, blur].every(Number.isFinite)) return match;
      filters.set(
        id,
        `filter:drop-shadow(${dx}px ${dy}px ${blur}px rgba(${r},${g},${b},${a}))`,
      );
      return "";
    },
  );
  if (filters.size === 0) return svg;
  return withoutDefs.replace(
    /<g filter="url\(#([^)]+)\)">/g,
    (match, id: string) => {
      const style = filters.get(id);
      return style ? `<g style="${style}">` : match;
    },
  );
}

// Convert `<circle stroke=... stroke-width=W>` (no real fill) to a filled
// ring path. Stroke geometry scales with viewBox under preserveAspectRatio
// ="none", so anisotropic stretch produces a ring with direction-dependent
// thickness — figma renders the source ELLIPSE node directly with uniform
// stroke. Encoding the ring as fill (outer arc + inner arc, even-odd)
// converts stroke geometry into proper fill that stretches as a true
// elliptical ring, matching figma's render.
function ringifyStrokeCircles(svg: string): string {
  return svg.replace(/<circle\b([^/>]*?)\/>/g, (m, attrs: string) => {
    const get = (k: string) =>
      attrs.match(new RegExp(`\\s${k}="([^"]+)"`))?.[1];
    const cx = parseFloat(get("cx") ?? "0");
    const cy = parseFloat(get("cy") ?? "0");
    const r = parseFloat(get("r") ?? "0");
    const sw = parseFloat(get("stroke-width") ?? "0");
    const stroke = get("stroke");
    const fill = get("fill");
    // Only ringify when stroke is the actual paint (no fill or fill="none")
    // and stroke-width is meaningful. Pure-fill circles stay as-is.
    if (!stroke || sw <= 0) return m;
    if (fill && fill !== "none") return m;
    const ro = r + sw / 2;
    const ri = r - sw / 2;
    if (ri <= 0) return m;
    // even-odd: outer arc (CW) + inner arc (CCW). Two semicircle arcs per
    // ring; sweep flag toggled to switch direction.
    const ring =
      `M${cx - ro} ${cy}a${ro} ${ro} 0 1 0 ${2 * ro} 0a${ro} ${ro} 0 1 0 ${-2 * ro} 0Z` +
      `M${cx - ri} ${cy}a${ri} ${ri} 0 1 1 ${2 * ri} 0a${ri} ${ri} 0 1 1 ${-2 * ri} 0Z`;
    return `<path fill-rule="evenodd" fill="${stroke}" d="${ring}"/>`;
  });
}

function emitImage(n: DImage, ctx: Ctx): ast.JsxSelfClosingElement {
  const w = sizeToPx(n.width) ?? 0;
  const h = sizeToPx(n.height) ?? 0;
  const styles: Record<string, unknown> = {
    display: "block",
    flexShrink: 0,
    width: px2rem(w, ctx.remBase),
    height: px2rem(h, ctx.remBase),
  };
  if (n.opacity !== undefined) styles.opacity = n.opacity;
  const srcMarker = imageAssetUrlMarker(n, ctx);
  if (!srcMarker) {
    return f.createJsxSelfClosingElement(
      f.createIdentifier("div"),
      undefined,
      f.createJsxAttributes([styleAttr(styles)]),
    );
  }
  ctx.usedJsxPatterns.add("styled");
  const tag = () =>
    f.createPropertyAccessExpression(
      f.createIdentifier("styled"),
      undefined,
      f.createIdentifier("img"),
      0 as ast.NodeFlags,
    );
  return f.createJsxSelfClosingElement(
    tag(),
    undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(
        f.createIdentifier("src"),
        f.createJsxExpression(undefined, f.createIdentifier(srcMarker)),
      ),
      f.createJsxAttribute(f.createIdentifier("alt"), stringLiteral("")),
      styleAttr(styles),
    ]),
  );
}

function emitInstance(n: DInstance, ctx: Ctx, parent: ParentCtx): ast.JsxChild {
  ctx.usedComponents.add(n.componentName);
  // Elide props that match defaultProps.
  const allProps = n.props;
  const props = n.defaultProps
    ? Object.fromEntries(
        Object.entries(allProps).filter(
          ([k, v]) => !deepEq(v, n.defaultProps![k]),
        ),
      )
    : allProps;
  // Optional binding overlay — DInstance is open-ended, so plugins or upstream
  // compiler may attach `instancePropBindings: Record<propName, ownerKey>`.
  const bindings = (n as Record<string, unknown>).instancePropBindings as
    | Record<string, string>
    | undefined;
  const attrKeys = new Set<string>([
    ...Object.keys(props),
    ...(bindings ? Object.keys(bindings) : []),
  ]);
  const attrs: ast.JsxAttributeLike[] = [];
  for (const k of attrKeys) {
    const boundKey = bindings?.[k];
    if (boundKey) {
      ctx.usedPropBindings.add(boundKey);
      const fallback = allProps[k];
      attrs.push(
        f.createJsxAttribute(
          f.createIdentifier(k),
          fallback === undefined
            ? propExpression(boundKey)
            : propExpressionWithFallback(boundKey, fallback),
        ),
      );
    } else if (isExpressionValue(props[k])) {
      const propName = props[k].name;
      ctx.usedPropBindings.add(propName);
      attrs.push(
        f.createJsxAttribute(f.createIdentifier(k), propExpression(propName)),
      );
    } else {
      attrs.push(...attrsFromObject({ [k]: componentPropToTargetValue(props[k], ctx) }));
    }
  }
  // Layout overlay — when this instance is a flex child and parent isn't
  // hugging, FIXED axes need flex-shrink: 0; FILL axes get flex/alignSelf.
  const layoutStyles: Record<string, unknown> = {};
  const sizingH = axisSizing(n.width);
  const sizingV = axisSizing(n.height);
  if (parent.dir !== "none" && parent.mainSizing !== Sizing.Hug) {
    if (parent.dir === "row" && sizingH === Sizing.Fixed)
      layoutStyles.flexShrink = 0;
    if (parent.dir === "column" && sizingV === Sizing.Fixed)
      layoutStyles.flexShrink = 0;
  }
  const absoluteStretchH =
    n.absolute?.anchor?.horizontal === Anchor.Stretch;
  const absoluteStretchV =
    n.absolute?.anchor?.vertical === Anchor.Stretch;
  if (absoluteStretchH) {
    layoutStyles.width = "100%";
  } else if (
    sizingH === Sizing.Fill &&
    parent.dir === "row" &&
    parent.mainSizing !== Sizing.Hug
  ) {
    layoutStyles.flex = 1;
    layoutStyles.minWidth = 0;
  } else if (sizingH === Sizing.Fill && parent.dir === "none") {
    layoutStyles.width = "100%";
  } else if (sizingH === Sizing.Fill && parent.dir === "column") {
    layoutStyles.alignSelf = "stretch";
    layoutStyles.width = "100%";
  }
  if (absoluteStretchV) {
    layoutStyles.height = "100%";
  } else if (
    sizingV === Sizing.Fill &&
    parent.dir === "column" &&
    parent.mainSizing !== Sizing.Hug
  ) {
    layoutStyles.flex = 1;
    layoutStyles.minHeight = 0;
  } else if (sizingV === Sizing.Fill && parent.dir === "none") {
    layoutStyles.height = "100%";
  } else if (sizingV === Sizing.Fill && parent.dir === "row") {
    layoutStyles.alignSelf = "stretch";
    layoutStyles.height = "100%";
  }
  if (n.layoutOverrides) {
    for (const [k, v] of Object.entries(n.layoutOverrides)) {
      if (v) {
        const val = sizeToProp(v as LengthValue, ctx.remBase);
        if (val !== undefined) layoutStyles[k] = val;
      }
    }
  }
  if (n.opacity !== undefined) layoutStyles.opacity = n.opacity;
  // Pass concrete dim down — `<Icon Type={iconType} width="1rem" height="1rem"/>`
  // — when the parent (e.g. a Badge variant) has resized the instance off its
  // master dim. Without this, Icon falls back to its master 1.5rem and the
  // Badge slot mismatch makes the icon overflow / render at the wrong scale.
  if (!absoluteStretchH && sizingH === Sizing.Fixed && n.width) {
    const wv = sizeToProp(n.width, ctx.remBase);
    if (wv !== undefined) layoutStyles.width = wv;
  }
  if (!absoluteStretchV && sizingV === Sizing.Fixed && n.height) {
    const hv = sizeToProp(n.height, ctx.remBase);
    if (hv !== undefined) layoutStyles.height = hv;
  }
  // Don't emit layout keys that the component itself already specifies via props.
  for (const k of Object.keys(n.props)) delete layoutStyles[k];
  if (Object.keys(layoutStyles).length)
    attrs.push(...attrsFromObject(layoutStyles));

  return f.createJsxSelfClosingElement(
    f.createIdentifier(n.componentName),
    undefined,
    f.createJsxAttributes(attrs),
  );
}

function emitUnknown(n: DUnknown, ctx: Ctx): ast.JsxSelfClosingElement {
  const w = sizeToPx(n.width) ?? 0;
  const h = sizeToPx(n.height) ?? 0;
  ctx.usedJsxPatterns.add("styled");
  const tag = () =>
    f.createPropertyAccessExpression(
      f.createIdentifier("styled"),
      undefined,
      f.createIdentifier("div"),
      0 as ast.NodeFlags,
    );
  if (n.hidden) {
    return f.createJsxSelfClosingElement(
      tag(),
      undefined,
      f.createJsxAttributes([
        styleAttr({
          width: px2rem(w, ctx.remBase),
          height: px2rem(h, ctx.remBase),
          opacity: 0,
        }),
      ]),
    );
  }
  if (w === 0 || h === 0) {
    return f.createJsxSelfClosingElement(
      tag(),
      undefined,
      f.createJsxAttributes([styleAttr({ display: "none" })]),
    );
  }
  return f.createJsxSelfClosingElement(
    tag(),
    undefined,
    f.createJsxAttributes([
      styleAttr({
        width: px2rem(w, ctx.remBase),
        height: px2rem(h, ctx.remBase),
        background: "#f00",
      }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Plugin context shim — bridges the CodegenPlugin API to the target codegen.
// The plugin's own `tokenMap` lookup is forwarded as-is.
// ---------------------------------------------------------------------------

function buildPluginCtx(ctx: Ctx) {
  const wrapWithStyle = (
    jsx: ast.JsxChild,
    style: Record<string, unknown>,
  ): ast.JsxChild => {
    ctx.usedJsxPatterns.add("styled");
    const tag = () =>
      f.createPropertyAccessExpression(
        f.createIdentifier("styled"),
        undefined,
        f.createIdentifier("span"),
        0 as ast.NodeFlags,
      );
    const attrs = attrsFromObject(style);
    return f.createJsxElement(
      f.createJsxOpeningElement(tag(), undefined, f.createJsxAttributes(attrs)),
      [jsx],
      f.createJsxClosingElement(tag()),
    );
  };
  const wrapWithCss = (
    jsx: ast.JsxChild,
    style: Record<string, unknown>,
  ): ast.JsxChild => {
    ctx.usesCss = true;
    const callExpr = callExpression(f.createIdentifier("css"), [
      valueToExpr(style),
    ]);
    const open = f.createJsxOpeningElement(
      f.createIdentifier("span"),
      undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(
          f.createIdentifier("className"),
          f.createJsxExpression(undefined, callExpr),
        ),
      ]),
    );
    return f.createJsxElement(
      open,
      [jsx],
      f.createJsxClosingElement(f.createIdentifier("span")),
    );
  };
  return {
    parentDir: "none" as "row" | "column" | "none",
    tokenMap: ctx.tokenMap,
    resolveTokenPath: (id: string | undefined) =>
      id ? ctx.tokenMap[id] : undefined,
    wrapWithStyle,
    wrapWithCss,
    jsxAttr,
    styleAttr,
    appendJsxAttr,
  };
}

// ---------------------------------------------------------------------------
// Wrap helpers — visibility binding + absolute positioning.
// ---------------------------------------------------------------------------

function wrapAbsolute(n: DNode, jsx: ast.JsxChild, ctx: Ctx): ast.JsxChild {
  if (!n.absolute) return jsx;
  const inset = n.absolute.inset ?? {};
  let absX = sizeToPx(inset.left) ?? 0;
  let absY = sizeToPx(inset.top) ?? 0;
  // figma reports a LINE node's bbox y/x as the FAR edge of the stroke on the
  // collapsed axis (not the line center). Our `<svg>` viewport gets inflated
  // by strokeWeight on that axis with the stroke drawn from the svg's top
  // edge — without offsetting the absolute wrapper, the rendered line sits
  // strokeWeight px below figma's mark. Pull back by the full stroke width.
  if (n.kind === NodeKind.Shape && (n as DShape).shape === ShapeKind.Line) {
    const sh = n as DShape;
    const sw = sizeToPx(sh.stroke?.width) ?? 1;
    const w = sizeToPx(sh.width) ?? 0;
    const h = sizeToPx(sh.height) ?? 0;
    if (h === 0) absY -= sw;
    if (w === 0) absX -= sw;
  }
  if (n.renderBoundsOffset) {
    const offset = n.renderBoundsOffset;
    absX += sizeToPx(offset.x) ?? 0;
    absY += sizeToPx(offset.y) ?? 0;
  }
  const wrapStyle: Record<string, unknown> = {
    position: "absolute",
    left: px2rem(absX, ctx.remBase),
    top: px2rem(absY, ctx.remBase),
  };
  if (
    n.absolute.anchor?.horizontal === Anchor.Stretch &&
    sizeToPx(inset.right) !== undefined
  ) {
    wrapStyle.right = px2rem(sizeToPx(inset.right) ?? 0, ctx.remBase);
  }
  if (
    n.absolute.anchor?.vertical === Anchor.Stretch &&
    sizeToPx(inset.bottom) !== undefined
  ) {
    wrapStyle.bottom = px2rem(sizeToPx(inset.bottom) ?? 0, ctx.remBase);
  }
  ctx.usedJsxPatterns.add("styled");
  const tag = () =>
    f.createPropertyAccessExpression(
      f.createIdentifier("styled"),
      undefined,
      f.createIdentifier("span"),
      0 as ast.NodeFlags,
    );
  return f.createJsxElement(
    f.createJsxOpeningElement(
      tag(),
      undefined,
      f.createJsxAttributes([styleAttr(wrapStyle)]),
    ),
    [jsx],
    f.createJsxClosingElement(tag()),
  );
}

function wrapVisibility(
  n: DNode,
  jsx: ast.JsxChild,
  ctx: Ctx,
  parent: ParentCtx,
): ast.JsxChild {
  const visibleProp = expressionPropName(n.visible);
  if (!visibleProp || parent.dir === "none") return jsx;
  ctx.usedPropBindings.add(visibleProp);
  // Same `PIXPEC_PROP_<key>` marker as propExpression — post-process rewrites
  // to `(props as ...)["<key>"]` so we don't shadow component imports when
  // the visibility prop key collides with one (e.g. boolean `Icon` toggle).
  const cond = f.createBinaryExpression(
    undefined,
    f.createIdentifier(`PIXPEC_PROP_${visibleProp}`),
    undefined,
    f.createToken(ast.SyntaxKind.ExclamationEqualsEqualsToken),
    keywordExpression(ast.SyntaxKind.FalseKeyword),
  );
  const conditional = f.createConditionalExpression(
    cond,
    f.createToken(ast.SyntaxKind.QuestionToken),
    f.createParenthesizedExpression(jsx as unknown as ast.Expression),
    f.createToken(ast.SyntaxKind.ColonToken),
    keywordExpression(ast.SyntaxKind.NullKeyword),
  );
  return f.createJsxExpression(undefined, conditional);
}

function emitNode(n: DNode, ctx: Ctx, parent: ParentCtx): ast.JsxChild {
  if (n.kind === NodeKind.DataScope) {
    return emitNode((n as DDataScope).child, ctx, parent);
  }
  let jsx: ast.JsxChild;
  switch (n.kind) {
    case NodeKind.Flex:
    case NodeKind.Stack:
    case NodeKind.Box:
      jsx = emitContainer(n, ctx, parent);
      break;
    case NodeKind.Text:
      jsx = emitText(n, ctx, parent);
      break;
    case NodeKind.Shape:
      jsx = emitShape(n, ctx, parent);
      break;
    case NodeKind.Vector:
      jsx = emitVector(n, ctx);
      break;
    case NodeKind.Image:
      jsx = emitImage(n, ctx);
      break;
    case NodeKind.Instance:
      jsx = emitInstance(n, ctx, parent);
      break;
    case NodeKind.Unknown:
      jsx = emitUnknown(n, ctx);
      break;
  }
  // Plugin chain — plugins receive the Design AST node directly.
  if (ctx.plugins.length) {
    const pctx = buildPluginCtx(ctx);
    pctx.parentDir = parent.dir;
    for (const p of ctx.plugins) {
      if (p.emitWrap) {
        jsx = p.emitWrap(n, jsx, pctx as never);
      }
    }
  }
  jsx = wrapAbsolute(n, jsx, ctx);
  jsx = wrapVisibility(n, jsx, ctx, parent);
  return jsx;
}

// ---------------------------------------------------------------------------
// Top-level emit: produce a self-contained .tsx string.
// ---------------------------------------------------------------------------

interface ReactPandaCtxExt {
  /** Optional pre-booted tsgo printer (so the cli can reuse a single
   *  snapshot across components). When omitted, the emitter boots its own. */
  printNode?: (node: ast.Node) => string;
  /** Plugins typed as the legacy `CodegenPlugin` shape. */
  plugins?: CodegenPlugin[];
  /** Component file extension override (default `tsx`). */
  fileExtension?: string;
  /** Source figma node id (for the file header comment). */
  sourceId?: string;
}

interface SharedPrinter {
  api: API;
  printNode: (node: ast.Node) => string;
}

const sharedPrinters = new Map<string, SharedPrinter>();

function getSharedPrintNode(cwd: string): (node: ast.Node) => string {
  const cached = sharedPrinters.get(cwd);
  if (cached) return cached.printNode;

  const api = new API({ cwd });
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const tsconfigCandidates = [
    nodePath.resolve(cwd, "tsconfig.json"),
    nodePath.resolve(here, "../../../tsconfig.json"),
  ];
  const tsconfig = tsconfigCandidates.find((p) => existsSync(p));
  if (!tsconfig)
    throw new Error("[react-panda target] tsgo: no tsconfig.json found");
  const snap = api.updateSnapshot({ openProject: tsconfig });
  const proj = snap.getProjects()[0];
  if (!proj) throw new Error("[react-panda target] tsgo: no project loaded");
  const printNode = (node: ast.Node) => proj.emitter.printNode(node);
  sharedPrinters.set(cwd, { api, printNode });
  return printNode;
}

function rootPropsType(root: DNode): string {
  switch (root.kind) {
    case NodeKind.DataScope:
      return rootPropsType((root as DDataScope).child);
    case NodeKind.Flex:
      return "FlexProps";
    case NodeKind.Stack:
      return "StackProps";
    default:
      return "BoxProps";
  }
}

function relativeImport(
  fromDir: string | undefined,
  toPath: string,
  fallback: string,
): string {
  if (!fromDir) return fallback;
  let rel = nodePath.relative(fromDir, toPath).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function nodeSourceId(n: DNode): string {
  if (n.kind === NodeKind.DataScope)
    return nodeSourceId((n as DDataScope).child);
  return n.sourceId ?? "node";
}

function nodeSourceName(n: DNode): string {
  if (n.kind === NodeKind.DataScope)
    return nodeSourceName((n as DDataScope).child);
  return n.sourceName ?? n.kind;
}

function ensureSourceMeta(root: DNode): DNode {
  const visit = (node: DNode, path: number[]) => {
    if (node.kind === NodeKind.DataScope) {
      visit((node as DDataScope).child, path);
      return;
    }
    node.sourceId ??= path.length === 0 ? "root" : `n${path.join("_")}`;
    node.sourceName ??= node.kind;
    if (isContainerNode(node)) {
      node.children.forEach((child, index) => visit(child, [...path, index]));
    }
  };
  visit(root, []);
  return root;
}

function buildSource(
  root: DNode,
  ctx: Ctx,
  printNode: (n: ast.Node) => string,
  sourceId: string,
): string {
  ctx.tintFilterId = `tint_${sourceId.replace(/[^A-Za-z0-9]/g, "_")}`;
  const body = emitNode(root, ctx, ROOT_PARENT) as ast.Expression;
  ctx.usedJsxPatterns.add("splitCssProps");

  // Imports
  const componentImports = [...ctx.usedComponents].sort().map((name) => {
    const meta = ctx.registry.get(name);
    const componentName = meta?.componentName ?? name;
    const componentFile = nodePath.resolve(
      ctx.componentsDir ?? "",
      componentName,
      "impl",
      "react-panda",
      "index.tsx",
    );
    const importPath = relativeImport(
      ctx.outputDir,
      componentFile,
      `../../${componentName}/impl/react-panda/index.tsx`,
    );
    return f.createImportDeclaration(
      undefined,
      f.createImportClause(
        undefined,
        undefined,
        f.createNamedImports([
          f.createImportSpecifier(
            false,
            f.createIdentifier("impl"),
            f.createIdentifier(name),
          ),
        ]),
      ),
      stringLiteral(importPath),
    );
  });
  const typographyImports =
    ctx.usedTypography.size > 0
      ? [
          f.createImportDeclaration(
            undefined,
            f.createImportClause(
              undefined,
              undefined,
              f.createNamedImports(
                [...ctx.usedTypography]
                  .sort()
                  .map((n) =>
                    f.createImportSpecifier(
                      false,
                      undefined,
                      f.createIdentifier(n),
                    ),
                  ),
              ),
            ),
            stringLiteral(
              relativeImport(
                ctx.outputDir,
                nodePath.resolve(
                  ctx.componentsDir ?? "",
                  "typography/index.tsx",
                ),
                "../../typography/index.tsx",
              ),
            ),
          ),
        ]
      : [];
  const cssImport = ctx.usesCss
    ? [
        f.createImportDeclaration(
          undefined,
          f.createImportClause(
            undefined,
            undefined,
            f.createNamedImports([
              f.createImportSpecifier(
                false,
                undefined,
                f.createIdentifier("css"),
              ),
            ]),
          ),
          stringLiteral(
            relativeImport(
              ctx.outputDir,
              nodePath.resolve(ctx.rootDir ?? "", "styled-system/css"),
              "../../../../styled-system/css",
            ),
          ),
        ),
      ]
    : [];
  const svgImports = [...ctx.svgSidecars.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { alias, importPath }]) =>
      f.createImportDeclaration(
        undefined,
        f.createImportClause(undefined, f.createIdentifier(alias), undefined),
        stringLiteral(importPath),
      ),
    );
  const jsxPatternImport =
    ctx.usedJsxPatterns.size > 0
      ? [
          f.createImportDeclaration(
            undefined,
            f.createImportClause(
              undefined,
              undefined,
              f.createNamedImports(
                [...ctx.usedJsxPatterns]
                  .sort()
                  .map((n) =>
                    f.createImportSpecifier(
                      false,
                      undefined,
                      f.createIdentifier(n),
                    ),
                  ),
              ),
            ),
            stringLiteral(
              relativeImport(
                ctx.outputDir,
                nodePath.resolve(ctx.rootDir ?? "", "styled-system/jsx"),
                "../../../../styled-system/jsx",
              ),
            ),
          ),
        ]
      : [];
  const squircleImport =
    ctx.squircleHooks.length > 0
      ? [
          f.createImportDeclaration(
            undefined,
            f.createImportClause(
              undefined,
              undefined,
              f.createNamedImports([
                f.createImportSpecifier(
                  false,
                  undefined,
                  f.createIdentifier("useSquircleClip"),
                ),
              ]),
            ),
            stringLiteral("pixpec/targets/react-panda/runtime"),
          ),
        ]
      : [];
  const fcImport = f.createImportDeclaration(
    undefined,
    f.createImportClause(
      ast.SyntaxKind.TypeKeyword,
      undefined,
      f.createNamedImports([
        f.createImportSpecifier(false, undefined, f.createIdentifier("FC")),
      ]),
    ),
    stringLiteral("react"),
  );
  // FC signature
  const rootPropsTypeName = rootPropsType(root);
  const rootPropsTypeImport = f.createImportDeclaration(
    undefined,
    f.createImportClause(
      ast.SyntaxKind.TypeKeyword,
      undefined,
      f.createNamedImports([
        f.createImportSpecifier(
          false,
          undefined,
          f.createIdentifier(rootPropsTypeName),
        ),
      ]),
    ),
    stringLiteral(
      relativeImport(
        ctx.outputDir,
        nodePath.resolve(ctx.rootDir ?? "", "styled-system/jsx"),
        "../../../../styled-system/jsx",
      ),
    ),
  );
  const fcType = f.createTypeReferenceNode(f.createIdentifier("FC"), [
    f.createTypeReferenceNode(f.createIdentifier("GeneratedProps"), undefined),
  ]);
  const fnParams = [
    f.createParameterDeclaration(
      undefined,
      undefined,
      f.createIdentifier("props"),
      undefined,
      undefined,
      undefined,
    ),
  ];

  // Body shape:
  //   const [{ direction: _cssDirection, ...cssProps }] = splitCssProps<RootProps>(props)
  //   return (<root {...cssProps} ...inlineAttrs/>)
  // The root prop type is instantiated per generated variant, so a Flex
  // root receives FlexProps, Stack receives StackProps, and so on.
  // Panda's raw CSS `direction` prop is incompatible with the Flex/Stack
  // pattern `direction` prop, so the CSS one is intentionally dropped before
  // spreading into a pattern component.
  // Caller-supplied Panda CSS props override the master-default attrs
  // baked into the JSX (width, padding, etc.), so spread them LAST.
  let body2 = body;
  if (ast.isJsxElement(body2)) {
    const op = body2.openingElement;
    const newOpening = f.createJsxOpeningElement(
      op.tagName,
      op.typeArguments,
      f.createJsxAttributes([
        ...op.attributes.properties,
        f.createJsxSpreadAttribute(f.createIdentifier("cssProps")),
      ]),
    );
    body2 = f.createJsxElement(
      newOpening,
      body2.children,
      body2.closingElement,
    ) as ast.Expression;
  } else if (ast.isJsxSelfClosingElement(body2)) {
    body2 = f.createJsxSelfClosingElement(
      body2.tagName,
      body2.typeArguments,
      f.createJsxAttributes([
        ...body2.attributes.properties,
        f.createJsxSpreadAttribute(f.createIdentifier("cssProps")),
      ]),
    ) as ast.Expression;
  }
  const boundKeys = [...ctx.usedPropBindings].sort();
  const cssPropsDecl = f.createExpressionStatement(
    f.createIdentifier("PIXPEC_CSS_PROPS_DECL"),
  );
  // When a folded SVG inside `body2` enables tinting, wrap the return in
  // a fragment that includes the shared `<filter id="tint_X">` defs alongside
  // the body. The fragment is `<><svg style=hidden>...defs...</svg>{body}</>`.
  let returnExpr: ast.Expression = f.createParenthesizedExpression(body2);
  // (filter <defs> wrapper deferred — tsgo printer panics; will inject via
  // post-process string replacement below.)
  const generatedBody: ast.ConciseBody = f.createBlock(
    [
      cssPropsDecl,
      ...ctx.squircleHooks.map((h) =>
        squircleHookMarker(h.id, h.radiusPx, h.smoothing),
      ),
      f.createReturnStatement(returnExpr),
    ],
    true,
  );
  const generatedFn = f.createVariableStatement(
    [exportModifier()],
    f.createVariableDeclarationList(
      [
        f.createVariableDeclaration(
          f.createIdentifier("Generated"),
          undefined,
          fcType,
          f.createArrowFunction(
            undefined,
            undefined,
            fnParams,
            undefined,
            f.createToken(ast.SyntaxKind.EqualsGreaterThanToken),
            generatedBody,
          ),
        ),
      ],
      nodeFlagsConst,
    ),
  );
  const statements: ast.Statement[] = [
    fcImport,
    rootPropsTypeImport,
    ...componentImports,
    ...typographyImports,
    ...cssImport,
    ...jsxPatternImport,
    ...squircleImport,
    ...svgImports,
  ];
  const localComponents = ctx.repetitionComponents
    .map((component) => localComponentSource(component, printNode))
    .join("\n");
  const header = `/**\n * AUTO-GENERATED by pixpec react-panda target.\n * Source: ${sourceId}\n */\n`;
  let printed =
    header +
    statements.map(printNode).join("\n") +
    (localComponents ? `\n${localComponents}\n` : "\n") +
    generatedPropsSource(root, rootPropsTypeName, boundKeys) +
    printNode(generatedFn) +
    "\n";
  printed = printed.replace(
    "PIXPEC_CSS_PROPS_DECL;",
    `const [{ direction: _cssDirection, ...cssProps }] = splitCssProps(props)`,
  );
  // Rewrite `PIXPEC_PROP_<key>` marker identifiers into `props.<key>` member
  // access. tsgo's printer panics on factory-built PropertyAccess inside JSX,
  // so propExpression() emits a marker and we resolve here. All marker keys
  // are valid JS identifiers (figma variant prop names + camelCase nested
  // slots), so `.<key>` form is safe and matches the typed BadgeProps shape.
  printed = printed.replace(
    /PIXPEC_PROP_([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (_m, key) => `props.${key}`,
  );
  printed = printed.replace(
    /PIXPEC_FILL_STYLE_([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (_m, key) => `{ color: props.${key} }`,
  );
  printed = printed.replace(
    /PIXPEC_FILL_BACKGROUND_STYLE_([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (_m, key) => `{ background: props.${key} }`,
  );
  printed = printed.replace(
    /PIXPEC_BOX_SHADOW_STYLE_([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (_m, key) => `{ boxShadow: props.${key} }`,
  );
  printed = printed.replace(
    /PIXPEC_BOX_SHADOW_APPEND_([0-9a-f]+)__([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (_m, base, key) => {
      const decoded = decodeMarkerString(base);
      return `{ boxShadow: props.${key} ? \`${decoded}, \${props.${key}}\` : ${JSON.stringify(decoded)} }`;
    },
  );
  printed = printed.replace(
    /PIXPEC_STATIC_BORDER_PAINT_STYLE_([0-9a-f]+)__([0-9a-f]+)(?:__([0-9a-f]+))?/g,
    (_m, encodedBackground, encodedPaint, encodedBaseShadow) => {
      const background = cssBackgroundLayer(
        decodeMarkerString(encodedBackground),
      );
      const paint = cssBackgroundLayer(decodeMarkerString(encodedPaint));
      const baseShadow = encodedBaseShadow
        ? decodeMarkerString(encodedBaseShadow)
        : undefined;
      const entries = [
        `background: ${JSON.stringify(`${background} padding-box, ${paint} border-box`)}`,
      ];
      if (baseShadow) entries.push(`boxShadow: ${JSON.stringify(baseShadow)}`);
      return `{ ${entries.join(", ")} }`;
    },
  );
  printed = printed.replace(
    /PIXPEC_BORDER_PAINT_STYLE_([A-Za-z_$][A-Za-z0-9_$]*)__([0-9a-f]+)(?:__([A-Za-z_$][A-Za-z0-9_$]*))?(?:__([0-9a-f]+))?/g,
    (_m, borderKey, encodedBackground, shadowKey, encodedBaseShadow) => {
      const background = cssBackgroundLayer(
        decodeMarkerString(encodedBackground),
      );
      const cssBackground = background.replace(/[`$]/g, "\\$&");
      const baseShadow = encodedBaseShadow
        ? decodeMarkerString(encodedBaseShadow)
        : undefined;
      const entries = [
        `background: \`${cssBackground} padding-box, \${String(props.${borderKey} ?? 'transparent').includes('gradient(') ? props.${borderKey} : \`linear-gradient(\${props.${borderKey} ?? 'transparent'}, \${props.${borderKey} ?? 'transparent'})\`} border-box\``,
      ];
      if (shadowKey && baseShadow) {
        entries.push(
          `boxShadow: props.${shadowKey} ? \`${baseShadow}, \${props.${shadowKey}}\` : ${JSON.stringify(baseShadow)}`,
        );
      } else if (shadowKey) {
        entries.push(`boxShadow: props.${shadowKey}`);
      } else if (baseShadow) {
        entries.push(`boxShadow: ${JSON.stringify(baseShadow)}`);
      }
      return `{ ${entries.join(", ")} }`;
    },
  );
  const decodeMarkerNumber = (value: string) =>
    Number(value.replace(/m/g, "-").replace(/p/g, "."));
  printed = printed.replace(
    /PIXPEC_SQUIRCLE_HOOK_(\d+)_([A-Za-z0-9]+)_([A-Za-z0-9]+);/g,
    (_m, id, radiusMarker, smoothingMarker) => {
      const radius = decodeMarkerNumber(radiusMarker);
      const smoothing = decodeMarkerNumber(smoothingMarker);
      return `const [squircleRef${id}, squircleClipPath${id}] = useSquircleClip<HTMLDivElement>(${radius}, ${smoothing})`;
    },
  );
  printed = printed.replace(
    /PIXPEC_SQUIRCLE_REF_(\d+)/g,
    (_m, id) => `squircleRef${id}`,
  );
  printed = printed.replace(
    /PIXPEC_SQUIRCLE_STYLE_(\d+)/g,
    (_m, id) => `{ clipPath: squircleClipPath${id} }`,
  );
  printed = printed.replace(
    /PIXPEC_SQUIRCLE_FILL_BACKGROUND_STYLE_([A-Za-z_$][A-Za-z0-9_$]*)_(\d+)/g,
    (_m, key, id) =>
      `{ clipPath: squircleClipPath${id}, background: props.${key} }`,
  );
  for (const [marker, importPath] of ctx.assetUrls) {
    printed = printed.replaceAll(
      marker,
      `new URL('${importPath}', import.meta.url).href`,
    );
  }
  for (const [marker, source] of ctx.repetitionMarkers) {
    printed = printed.replaceAll(marker, source);
  }
  if (ctx.usesTinting) {
    // Rewrite the `<PIXPEC_TINT_SWAP .../>` marker into a real
    // conditional. Two `?react` imports are already in scope; the tinted
    // variant has every literal fill swapped to `currentColor`.
    printed = printed.replace(
      /<PIXPEC_TINT_SWAP\s+normal=\{(\w+)\}\s+tinted=\{(\w+)\}(?:\s+fillProp="([^"]*)")?\s*\/>/g,
      (_m, normal, tinted, fillProp) => {
        if (fillProp) {
          const prop = `props.${fillProp}`;
          const propTintedStyle = `style={{ display: "block", width: "100%", height: "100%", color: ${prop} }}`;
          return (
            `{${prop} ` +
            `? <${tinted} preserveAspectRatio="none" shapeRendering="geometricPrecision" ${propTintedStyle}/> ` +
            `: <${normal} preserveAspectRatio="none" shapeRendering="geometricPrecision" style={{ display: "block", width: "100%", height: "100%" }}/>}`
          );
        }
        return `<${normal} preserveAspectRatio="none" shapeRendering="geometricPrecision" style={{ display: "block", width: "100%", height: "100%" }}/>`;
      },
    );
  }
  return printed;
}

export function codegenReactPanda(
  root: DNode,
  ctx: CodegenContext,
): CodegenResult {
  const normalizedRoot = ensureSourceMeta(root);
  const ext = ctx as CodegenContext & ReactPandaCtxExt;
  const plugins = (ext.plugins ??
    (ctx.plugins as CodegenPlugin[] | undefined) ??
    []) as CodegenPlugin[];
  const cgCtx: Ctx = {
    remBase: ctx.remBase ?? 16,
    componentName: ctx.componentName,
    registry: ctx.registry ?? new Map(),
    tokenMap: ctx.designSystem?.tokens ?? {},
    tokenValueMap: ctx.designSystem?.tokenValues ?? {},
    tokenColorMap: ctx.designSystem?.tokenColors ?? {},
    typographyMap: ctx.designSystem?.typography ?? {},
    plugins,
    usedJsxPatterns: new Set(),
    usedTypography: new Set(),
    usedComponents: new Set(),
    usedPropBindings: new Set(),
    usesCss: false,
    outputDir: ctx.outputDir,
    rootDir: ctx.rootDir,
    componentsDir: ctx.componentsDir,
    propsFile: ctx.propsFile,
    viewConfig: ctx.viewConfig ?? {},
    repetitionComponents: [],
    repetitionMarkers: new Map(),
    repetitionCounter: 0,
    svgSidecars: new Map(),
    imageSidecars: new Map(),
    assetUrls: new Map(),
    squircleHooks: [],
    usesTinting: false,
    tintFilterId: "",
  };
  const sourceId = ext.sourceId ?? nodeSourceId(normalizedRoot);

  const printNode = ext.printNode ?? getSharedPrintNode(process.cwd());
  const source = buildSource(normalizedRoot, cgCtx, printNode, sourceId);
  const sidecars = [
    ...[...cgCtx.svgSidecars.entries()].map(([relativePath, { content }]) => ({
      relativePath,
      content,
    })),
    ...[...cgCtx.imageSidecars.entries()].map(
      ([relativePath, { content }]) => ({
        relativePath,
        content,
      }),
    ),
  ];
  return { source, fileExtension: ext.fileExtension ?? "tsx", sidecars };
}
