/**
 * Design AST — platform-neutral intermediate representation.
 *
 * The compiler builds this from a raw figma dump. Emitters consume it and
 * lower it to a target framework's source code (React + PandaCSS today;
 * Slint, Flutter, etc. are pluggable). Nothing in this file is figma- or
 * React-specific — only generic UI-tree concepts. The `sourceId`/`sourceName`
 * fields are opaque trace-back tags so a downstream emitter or debugger can
 * link an AST node back to wherever it came from.
 */

export type DNode =
  | DDataScope
  | DFlex
  | DStack
  | DBox
  | DText
  | DShape
  | DVector
  | DImage
  | DInstance
  | DUnknown;

export type TokenRef = string;

export type LiteralValue<T = unknown> = {
  kind: "literal";
  value: T;
};

export type ExpressionValue = { kind: "expression"; type: "prop"; name: string };

export type ScalarValue<T> = TokenRef | LiteralValue<T> | ExpressionValue;

export type AggregateValue<T extends object> =
  | TokenRef
  | LiteralValue<T>
  | ({ base: TokenRef } & Partial<T>)
  | ExpressionValue;

export type Value<T> = ScalarValue<T>;

export interface DataScopeEntry {
  type: string;
  default?: unknown;
}

/** Sizing semantic shared with auto-layout systems. */
export enum Sizing {
  Fixed = "fixed",
  Hug = "hug",
  Fill = "fill",
}

export type AxisSize = LengthValue | Sizing.Hug | Sizing.Fill;

/** Anchor for absolutely-positioned children — controls how the child is
 *  pinned/stretched relative to its positioned ancestor. */
export enum Anchor {
  Start = "start",
  Center = "center",
  End = "end",
  Stretch = "stretch",
  Scale = "scale",
}

/** Cross-axis alignment for auto-layout containers. */
export enum Align {
  Start = "start",
  Center = "center",
  End = "end",
}

/** Main-axis distribution for auto-layout containers. */
export enum Justify {
  Start = "start",
  Center = "center",
  End = "end",
  SpaceBetween = "space-between",
}

/** Position relative to parent — 'flow' (laid out by parent flex/stack)
 *  or 'absolute' (overlay positioned by inset/anchor). */
export enum Positioning {
  Flow = "flow",
  Absolute = "absolute",
}

/** Auto-resize mode for text nodes. */
export enum TextAutoResize {
  Hug = "hug",
  FixedWidth = "fixed-width",
  FixedBoth = "fixed-both",
  Truncate = "truncate",
}

/** Text decoration. */
export enum TextDecoration {
  Underline = "underline",
  LineThrough = "line-through",
}

/** Shape primitive kind. */
export enum ShapeKind {
  Rect = "rect",
  Ellipse = "ellipse",
  Polygon = "polygon",
  Star = "star",
  Line = "line",
}

/** Stroke end-cap style. */
export enum StrokeCap {
  Butt = "butt",
  Round = "round",
  Square = "square",
}

/** Stroke placement relative to the shape's geometry. */
export enum StrokeAlign {
  Inside = "inside",
  Outside = "outside",
  Center = "center",
}

/** Text horizontal alignment. */
export enum TextAlign {
  Left = "left",
  Center = "center",
  Right = "right",
  Justify = "justify",
}

/** Direction of an auto-layout container. */
export enum FlowDirection {
  Row = "row",
  Column = "column",
}

/** Discriminator for the Design AST node union. */
export enum NodeKind {
  DataScope = "dataScope",
  Flex = "flex",
  Stack = "stack",
  Box = "box",
  Text = "text",
  Shape = "shape",
  Vector = "vector",
  Image = "image",
  Instance = "instance",
  Unknown = "unknown",
}

/** Non-rendering data boundary. Emitters must not create a GUI layer for this
 * node; it scopes prop expressions into its child and emits the child directly. */
export interface DDataScope extends DNodeBase {
  kind: NodeKind.DataScope;
  componentName: string;
  data: Record<string, DataScopeEntry>;
  child: DNode;
}

export interface Length {
  value: number;
  unit: "px";
}

export type LengthValue = ScalarValue<Length>;

export type ColorLiteral = {
  r: number;
  g: number;
  b: number;
  a?: number;
};

export type Color = ScalarValue<ColorLiteral>;

export type GradientPaint = {
  kind: "linearGradient";
  angle: number;
  stops: Array<{ offset: number; color: Color }>;
};

export type Paint = ScalarValue<ColorLiteral | GradientPaint>;

export interface Padding {
  top: LengthValue;
  right: LengthValue;
  bottom: LengthValue;
  left: LengthValue;
}

export interface CornerRadii {
  tl: LengthValue;
  tr: LengthValue;
  br: LengthValue;
  bl: LengthValue;
}

export interface Border {
  paint: Paint;
  width: LengthValue | { top: LengthValue; right: LengthValue; bottom: LengthValue; left: LengthValue };
  align?: StrokeAlign;
}

export interface Shadow {
  x: LengthValue;
  y: LengthValue;
  blur: LengthValue;
  spread?: LengthValue;
  color: Color;
}

export interface AbsoluteLayout {
  inset?: { left?: LengthValue; top?: LengthValue; right?: LengthValue; bottom?: LengthValue };
  anchor?: { horizontal?: Anchor; vertical?: Anchor };
}

export type TextStyleName = TokenRef | ExpressionValue;

export interface TextStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: LengthValue;
  lineHeight?: LengthValue;
  paragraphSpacing?: LengthValue;
}

export type TextStyleValue = AggregateValue<TextStyle>;

/** Shared base — every AST node may carry source trace metadata, optional
 *  opacity/rotation, and may be positioned in absolute (overlay) mode. */
export interface DNodeBase {
  /** Source-tree identifier (figma node id today). Diagnostic only. */
  sourceId?: string;
  /** Source-tree node name (figma layer name). Diagnostic only. */
  sourceName?: string;
  /** Layer-level opacity. Captured only when < 1. */
  opacity?: number;
  /** Rotation in degrees CCW. */
  rotation?: number;
  /** Absolute positioning metadata. Omitted for ordinary flow children. */
  absolute?: AbsoluteLayout;
  /** Offset from the node's design box to the exported render bounds. */
  renderBoundsOffset?: { x: LengthValue; y: LengthValue };
  /** Node visibility. When expression-valued, an owner component prop gates
   * this node without a parallel binding field. */
  visible?: Value<boolean>;
}

/** Container with explicit auto-layout — children laid out left-to-right
 *  with optional cross-axis alignment, gap, padding, etc. */
export interface DFlex extends DNodeBase {
  kind: NodeKind.Flex;
  direction: FlowDirection.Row;
  width?: AxisSize;
  height?: AxisSize;
  minWidth?: LengthValue;
  maxWidth?: LengthValue;
  minHeight?: LengthValue;
  maxHeight?: LengthValue;
  padding?: Padding;
  gap?: LengthValue;
  /** Gap between wrapped lines, when `wrap` is true. */
  counterGap?: LengthValue;
  align?: Align;
  justify?: Justify;
  wrap?: boolean;
  background?: Paint;
  border?: Border;
  shadow?: Shadow;
  cornerRadius?: LengthValue | CornerRadii;
  /** Squircle corner curvature (0..1). >0 means non-CSS corner — emitter
   *  must use a path/clip-path approximation. */
  cornerSmoothing?: number;
  /** Clip overflowing children. */
  clip?: boolean;
  children: DNode[];
}

/** Same as DFlex but column direction. */
export interface DStack extends Omit<DFlex, "kind" | "direction"> {
  kind: NodeKind.Stack;
  direction: FlowDirection.Column;
}

/** Container with NO auto-layout — children position themselves (typically
 *  via `positioning: 'absolute'`). */
export interface DBox extends Omit<
  DFlex,
  "kind" | "direction" | "gap" | "align" | "justify" | "counterGap" | "wrap"
> {
  kind: NodeKind.Box;
}

/** Per-character styled segment within a DText. Each field is undefined
 *  when the segment matches the node-level value (no override). */
export interface DTextRun {
  text: string;
  color?: Color;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: LengthValue;
  lineHeight?: LengthValue;
  textDecoration?: TextDecoration;
}

/** Text node. */
export interface DText extends DNodeBase {
  kind: NodeKind.Text;
  content: Value<string>;
  textStyle: TextStyleValue;
  color: Color;
  textDecoration?: TextDecoration;
  textAlign?: TextAlign;
  /** Required when text needs to wrap. */
  width: AxisSize;
  autoResize: TextAutoResize;
  runs?: DTextRun[];
}

/** Geometric primitive. */
export interface DShape extends DNodeBase {
  kind: NodeKind.Shape;
  shape: ShapeKind;
  width: LengthValue;
  height: LengthValue;
  fill?: Paint;
  stroke?: {
    paint: Paint;
    width: LengthValue;
    align?: StrokeAlign;
    /** End-cap shape on open paths (lines, vectors). */
    cap?: StrokeCap;
  };
  cornerRadius?: LengthValue | CornerRadii;
}

/** Inline vector (path or raw SVG). Resolved upstream from a vector source. */
export interface DVector extends DNodeBase {
  kind: NodeKind.Vector;
  width: LengthValue;
  height: LengthValue;
  /** The vector paint source. When prop-bound, the emitter must drive the
   *  vector from that declared prop, not from target-specific style
   *  conventions such as CSS `color`. */
  fill?: Paint;
  /** Inline SVG (raw `<svg>` content) or `data:image/svg+xml;base64,...` URL. */
  svg: string;
}

/** Raster image embedded as a vector asset (e.g. exported figma group SVG). */
export interface DImage extends DNodeBase {
  kind: NodeKind.Image;
  width: LengthValue;
  height: LengthValue;
  /** `data:image/svg+xml;base64,...` URL. */
  dataUrl?: string;
  /** Figma-rendered PNG for bitmap image-fill nodes when scale/crop semantics
   *  need exact source-renderer output. */
  renderedDataUrl?: string;
  imageScaleMode?: string;
  imageTransform?: [[number, number, number], [number, number, number]];
}

/** Reference to a registered design-system component. Emitter resolves the
 *  `componentName` to its target source (import + JSX call for React, etc.).
 *  All instance-level overrides (including layout: width/height/padding/gap,
 *  and forwarded prop refs via expression values) flow through `props`. */
export interface DInstance extends DNodeBase {
  kind: NodeKind.Instance;
  componentName: string;
  props: Record<string, unknown>;
}

/** Fallback for nodes the compiler couldn't classify. Emitter chooses a
 *  reasonable placeholder. */
export interface DUnknown extends DNodeBase {
  kind: NodeKind.Unknown;
  sourceType?: string;
  hidden?: boolean;
  width: LengthValue;
  height: LengthValue;
}
