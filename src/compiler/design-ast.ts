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

export type LiteralValue<T> =
  | { kind: "literal"; source: "raw"; value: T }
  | { kind: "literal"; source: "token"; path: string };

export type ExpressionValue = { kind: "expression"; type: "prop"; name: string };

export type Value<T> = LiteralValue<T> | ExpressionValue;

/** Sizing semantic shared with auto-layout systems. */
export enum Sizing {
  Fixed = "fixed",
  Hug = "hug",
  Fill = "fill",
}

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

export interface DataScopeBinding {
  prop: string;
  sourceId: string;
  field: string;
}

/** Non-rendering data boundary. Emitters must not create a GUI layer for this
 * node; it scopes prop expressions into its child and emits the child directly. */
export interface DDataScope extends DNodeBase {
  kind: NodeKind.DataScope;
  bindings: DataScopeBinding[];
  child: DNode;
}

/**
 * Size value — either a literal number with a unit (figma's design-px today;
 * future emitters may extend the unit set) or a design-token reference.
 *
 * Compiler picks `tokenPath` when the property is bound to a figma variable
 * AND the resolved intrinsic value matches the node's effective value.
 * Anything else (no binding, or scaled instance whose value drifted off the
 * token's intrinsic) falls back to the raw literal — that way emitters
 * always render the figma-authoritative pixel result.
 */
export type Size = { value: number; unit: "px" } | { tokenPath: string };

/**
 * Color value — same dichotomy as `Size`. Tokens carry color names like
 * `content.standard.primary`; literals carry resolved hex/rgba.
 */
export type Color =
  | { color: string; opacity?: number }
  | { tokenPath: string; opacity?: number };

export interface Padding {
  top: Size;
  right: Size;
  bottom: Size;
  left: Size;
}

export interface CornerRadii {
  tl: Size;
  tr: Size;
  br: Size;
  bl: Size;
}

export interface Border {
  paint: Color;
  width: Size | { top: Size; right: Size; bottom: Size; left: Size };
  align?: StrokeAlign;
}

export interface Shadow {
  x: Size;
  y: Size;
  blur: Size;
  spread?: Size;
  color: Color;
}

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
  /** Positioning mode against the parent. */
  positioning?: Positioning;
  /** Distance from the positioned ancestor's edges, in design units.
   *  Only meaningful when positioning === 'absolute'. */
  inset?: { left?: number; top?: number; right?: number; bottom?: number };
  /** Per-axis anchoring when positioning='absolute'. 'stretch' = pin both
   *  edges (the underline-spans-tab-width pattern). */
  anchor?: { horizontal?: Anchor; vertical?: Anchor };
  /** Sibling sizing inside the parent container. */
  sizing?: { horizontal?: Sizing; vertical?: Sizing };
  /** Offset from the node's design box to Figma's exported render bounds. */
  renderBoundsOffset?: { x: number; y: number };
  /** Node visibility. When expression-valued, an owner component prop gates
   * this node without a parallel binding field. */
  visible?: Value<boolean>;
}

/** Container with explicit auto-layout — children laid out left-to-right
 *  with optional cross-axis alignment, gap, padding, etc. */
export interface DFlex extends DNodeBase {
  kind: NodeKind.Flex;
  direction: FlowDirection.Row;
  width?: Size;
  height?: Size;
  minWidth?: Size;
  maxWidth?: Size;
  minHeight?: Size;
  maxHeight?: Size;
  padding?: Padding;
  gap?: Size;
  /** Gap between wrapped lines, when `wrap` is true. */
  counterGap?: Size;
  align?: Align;
  justify?: Justify;
  wrap?: boolean;
  background?: Value<Color>;
  border?: Border;
  shadow?: Shadow;
  cornerRadius?: Size | CornerRadii;
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
  fontSize?: Size;
  lineHeight?: Size;
  textDecoration?: TextDecoration;
}

/** Text node. */
export interface DText extends DNodeBase {
  kind: NodeKind.Text;
  content: Value<string>;
  fontFamily?: string;
  /** CSS-style numeric weight (100..900). */
  fontWeight?: number;
  fontSize: Size;
  lineHeight: Size;
  /** Gap between paragraphs (newline-separated runs). */
  paragraphSpacing?: Size;
  color: Value<Color>;
  textDecoration?: TextDecoration;
  textAlign?: TextAlign;
  /** Reference to an upstream typography style (e.g. figma textStyleId).
   *  Emitter may map this to a typography component wrapper. */
  textStyleRef?: Value<string>;
  /** Required when text needs to wrap. */
  width: number;
  autoResize: TextAutoResize;
  runs?: DTextRun[];
}

/** Geometric primitive. */
export interface DShape extends DNodeBase {
  kind: NodeKind.Shape;
  shape: ShapeKind;
  width: Size;
  height: Size;
  fill?: Color;
  stroke?: {
    paint: Color;
    width: Size;
    align?: StrokeAlign;
    /** End-cap shape on open paths (lines, vectors). */
    cap?: StrokeCap;
  };
  cornerRadius?: Size | CornerRadii;
}

/** Inline vector (path or raw SVG). Resolved upstream from a vector source. */
export interface DVector extends DNodeBase {
  kind: NodeKind.Vector;
  width: Size;
  height: Size;
  /** The vector paint source. When prop-bound, the emitter must drive the
   *  vector from that declared prop, not from target-specific style
   *  conventions such as CSS `color`. */
  fill?: Value<Color>;
  /** Inline SVG (raw `<svg>` content) or `data:image/svg+xml;base64,...` URL. */
  svg: string;
}

/** Raster image embedded as a vector asset (e.g. exported figma group SVG). */
export interface DImage extends DNodeBase {
  kind: NodeKind.Image;
  width: Size;
  height: Size;
  /** `data:image/svg+xml;base64,...` URL. */
  dataUrl?: string;
  /** Figma-rendered PNG for bitmap image-fill nodes when scale/crop semantics
   *  need exact source-renderer output. */
  renderedDataUrl?: string;
  imageScaleMode?: string;
  imageTransform?: [[number, number, number], [number, number, number]];
}

/** Reference to a registered design-system component. Emitter resolves the
 *  `componentName` to its target source (import + JSX call for React, etc.). */
export interface DInstance extends DNodeBase {
  kind: NodeKind.Instance;
  componentName: string;
  props: Record<string, unknown>;
  /** Defaults so the emitter can elide redundant prop emissions on call sites. */
  defaultProps?: Record<string, unknown>;
  /** Per-instance layout overrides (vs. master). */
  layoutOverrides?: {
    paddingTop?: Size;
    paddingRight?: Size;
    paddingBottom?: Size;
    paddingLeft?: Size;
    gap?: Size;
  };
  width?: Size;
  height?: Size;
  /** Per-instance-property bindings — { figmaPropKey: ownerPropKey }. The
   *  emitter passes these through as JSX attributes (e.g. `Type={iconType}`)
   *  so the parametric Generated FC swaps in the owner-component prop
   *  instead of the master literal value. */
  instancePropBindings?: Record<string, string>;
  /** Open extension slot for emitter plugins to attach their own data. */
  [extension: string]: unknown;
}

/** Fallback for nodes the compiler couldn't classify. Emitter chooses a
 *  reasonable placeholder. */
export interface DUnknown extends DNodeBase {
  kind: NodeKind.Unknown;
  sourceType?: string;
  hidden?: boolean;
  width: Size;
  height: Size;
}
