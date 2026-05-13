/**
 * Raw figma dump shape — what the plugin script returns. Mirrors the
 * fields figma's plugin API exposes per node type, with no classification
 * or resolution. Compiler is the only consumer; it walks this tree and
 * builds the platform-neutral Design AST.
 *
 * All fields are optional so the dumper can stay defensive (skip values it
 * can't read on a particular node type without breaking the whole dump).
 */

export interface RawConstraints {
  horizontal?: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE";
  vertical?: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE";
}

export interface RawSolidPaint {
  type: "SOLID";
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color: { r: number; g: number; b: number };
  boundVariables?: Record<string, { type: "VARIABLE_ALIAS"; id: string }>;
}

export interface RawImagePaint {
  type: "IMAGE";
  visible?: boolean;
  scaleMode?: string;
  imageTransform?: [[number, number, number], [number, number, number]];
  imageHash?: string;
  dataUrl?: string;
}

export type RawPaint =
  | RawSolidPaint
  | RawImagePaint
  | { type: string; visible?: boolean };

export interface RawDropShadowEffect {
  type: "DROP_SHADOW";
  visible?: boolean;
  radius: number;
  offset: { x: number; y: number };
  spread?: number;
  color: { r: number; g: number; b: number; a?: number };
  blendMode?: string;
}

export type RawEffect =
  | RawDropShadowEffect
  | { type: string; visible?: boolean };

export interface RawTextRun {
  characters: string;
  fills?: RawPaint[];
  fontName?: { family: string; style: string };
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: { unit: string; value?: number };
  textDecoration?: string;
  letterSpacing?: { unit: string; value: number };
  textCase?: string;
}

export interface RawOverride {
  id: string;
  overriddenFields: string[];
}

export interface RawComponentProperty {
  type: "BOOLEAN" | "TEXT" | "VARIANT" | "INSTANCE_SWAP";
  value: string | boolean;
  boundVariables?: Record<string, unknown>;
}

export interface RawNode {
  // ---- common to every node ----
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  /** Bounding-box dim (post-rotation if rotation set; figma quirks). */
  width?: number;
  height?: number;
  /** Figma InstanceNode scale factor. Present only when a component instance
   * has been rescaled as a whole instead of directly resizing descendants. */
  scaleFactor?: number;
  /** Position relative to parent. */
  x?: number;
  y?: number;
  /** Rotation in degrees CCW. */
  rotation?: number;
  /** Layer-level opacity (0..1). */
  opacity?: number;
  /** When parent is auto-layout, ABSOLUTE removes child from flex flow. */
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  /** Non-fatal Figma API read failures captured by the dumper. */
  dumpErrors?: Record<string, string>;
  /** Pin/stretch behavior for absolute children. */
  constraints?: RawConstraints;
  /** Owner-component-prop refs that drive this node's properties (e.g.
   *  `{visible: 'Left Icon#2137:0', characters: 'Label#...'}`). */
  componentPropertyReferences?: Record<string, string>;
  /** Variable bindings on per-property style values. */
  boundVariables?: Record<string, unknown>;

  // ---- FRAME / COMPONENT / INSTANCE ----
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
  primaryAxisSizingMode?: "FIXED" | "AUTO";
  counterAxisSizingMode?: "FIXED" | "AUTO";
  layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  layoutGrow?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  itemSpacing?: number;
  counterAxisSpacing?: number;
  counterAxisAlignItems?: "MIN" | "CENTER" | "MAX";
  primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  layoutWrap?: "NO_WRAP" | "WRAP";
  fills?: RawPaint[];
  strokes?: RawPaint[];
  effects?: RawEffect[];
  strokeWeight?: number;
  strokeTopWeight?: number;
  strokeRightWeight?: number;
  strokeBottomWeight?: number;
  strokeLeftWeight?: number;
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
  strokeCap?: "NONE" | "ROUND" | "SQUARE" | string;
  cornerRadius?: number | "mixed";
  topLeftRadius?: number;
  topRightRadius?: number;
  bottomRightRadius?: number;
  bottomLeftRadius?: number;
  cornerSmoothing?: number;
  clipsContent?: boolean;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;

  // ---- INSTANCE only ----
  mainComponent?: {
    id: string;
    key: string;
    name: string;
    /** Containing COMPONENT_SET key, when this is a variant. */
    parentKey?: string;
    parentName?: string;
  };
  componentProperties?: Record<string, RawComponentProperty>;
  overrides?: RawOverride[];
  /** "Expose properties" descendants surfaced as instance props in figma. */
  exposedInstances?: Array<{ id: string; name: string }>;

  // ---- TEXT only ----
  characters?: string;
  fontName?: { family: string; style: string };
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: { unit: string; value?: number };
  paragraphSpacing?: number;
  letterSpacing?: { unit: string; value: number };
  textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textAlignVertical?: "TOP" | "CENTER" | "BOTTOM";
  textAutoResize?: "WIDTH_AND_HEIGHT" | "HEIGHT" | "NONE" | "TRUNCATE";
  textCase?: string;
  textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  textStyleId?: string;
  /** Per-segment styled runs (figma `getStyledTextSegments`). */
  styledTextSegments?: RawTextRun[];

  // ---- VECTOR / BOOLEAN_OPERATION / GROUP ----
  /** Inline SVG source from `exportAsync({format:'SVG_STRING'})`. */
  svg?: string;
  /** Set when SVG export failed (figma sometimes returns empty for
   *  invisible/clipped nodes); fallback emit needed. */
  svgExportFailed?: boolean;
  /** Raw Figma vector path data, used when SVG export fails for a VECTOR. */
  vectorPaths?: Array<{ windingRule?: string; data: string }>;

  // ---- recursion ----
  children?: RawNode[];
}
