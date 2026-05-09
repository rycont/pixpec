/**
 * Intermediate Representation between figma node tree and target framework
 * (React + PandaCSS for now).
 *
 * Walker emits IR. Codegen consumes IR.
 *
 * Each IR node carries the original figma node id so iterative refinement
 * can locate "this node rendered with too much dE — try a different pattern"
 * back to its source.
 */
export type IRNode = IRComponent | IRFrame | IRText | IRVector | IRShape | IRImage | IRUnknown

/**
 * Opaque visual atom — emitted for figma node types we can't reliably
 * recreate as DOM/CSS (GROUP, complex VECTOR, BOOLEAN_OPERATION). Captured
 * as inline SVG via figma.exportAsync({format:'SVG'}) at generate time.
 * Vector-quality (DPR-independent), keeps semantic <path>/<g> structure.
 */
export interface IRImage extends IRBase {
  kind: 'image'
  width: number
  height: number
  /** data URL `data:image/svg+xml;base64,...` from figma's SVG export.
   * Resolved by runGenerate after walk; emitted as `<img src=...>`. */
  dataUrl?: string
  /** Sibling sizing inside parent flex. */
  sizingH?: 'fixed' | 'hug' | 'fill'
  sizingV?: 'fixed' | 'hug' | 'fill'
}

export interface IRBase {
  /** Figma node id, e.g., "47:1234". */
  figmaId: string
  /** Figma node name (for codegen comments / debugging). */
  figmaName: string
  /** layoutPositioning=ABSOLUTE: render with position:absolute, removed from flex flow. */
  absolute?: boolean
  absX?: number
  absY?: number
  /** Node-level "Layer opacity" (figma slider). Captured only when < 1. */
  opacity?: number
}

/** Recognized as a registered component (defineComponent.figma binding). */
export interface IRComponent extends IRBase {
  kind: 'component'
  /** Matches a Component.name from defineComponent. */
  componentName: string
  /** Props produced by Component.figma.propsFromFigma(raw). */
  props: Record<string, unknown>
  /** prop-key → owning-component prop key. When set, codegen emits the
   * matching attr as `{props.<ownerKey>}` instead of the literal value
   * — turning the per-variant tree into a parametric Generated FC. */
  boundProps?: Record<string, string>
  /** Default-equivalent props (also via propsFromFigma) — for codegen to elide
   * redundant prop emission. Source: figma COMPONENT_SET.componentPropertyDefinitions. */
  defaultProps?: Record<string, unknown>
  /** figma `rotation` in degrees (counterclockwise). codegen emits CSS transform. */
  rotation?: number
  /** Sibling sizing — used by codegen to add flex-shrink:0 / flex:1 / alignSelf
   * when the instance sits in a flex parent (figma FIXED/FILL semantics that
   * differ from CSS flex defaults). */
  sizingH?: 'fixed' | 'hug' | 'fill'
  sizingV?: 'fixed' | 'hug' | 'fill'
  /** Main component root sizing/dim. Used to distinguish real instance
   * layout overrides from HUG resolved-size changes caused by props/text. */
  mainSizingH?: 'fixed' | 'hug' | 'fill'
  mainSizingV?: 'fixed' | 'hug' | 'fill'
  mainWidth?: number
  mainHeight?: number
  width?: number
  height?: number
  /** Layout-property overrides on the instance — figma lets designers tweak
   * padding/gap on an instance without detaching. Walker captures only the
   * keys whose value differs from the master; codegen forwards each as a
   * style prop on the registered component invocation. The DS component
   * impl is expected to accept the prop on its root element. */
  layoutOverride?: {
    paddingTop?: number
    paddingRight?: number
    paddingBottom?: number
    paddingLeft?: number
    gap?: number
  }
  /** IR children — populated by walker for snapshot purposes (passed as
   * second arg to `propsFromFigma`). Codegen ignores these (the registered
   * component impl owns its render); they exist only so DS authors can
   * extract data the flat `raw` shape can't cover (e.g. labels from N
   * nested Tab_Item instances). */
  children?: IRNode[]
  /** Open extension slot — plugin walkExtend hooks attach DS-specific data
   * here (e.g. `effectiveFill` for icons that use currentColor). Plugins
   * read these in their emitWrap to decide whether to wrap the instance. */
  [pluginField: string]: unknown
}

/** Generic frame — flex container with autolayout, bg, padding, etc. */
export interface IRFrame extends IRBase {
  kind: 'frame'
  layout: {
    direction: 'row' | 'column' | 'none'
    paddingTop: number
    paddingRight: number
    paddingBottom: number
    paddingLeft: number
    gap: number
    alignItems: 'start' | 'center' | 'end'
    justifyContent: 'start' | 'center' | 'end' | 'space-between'
    /** figma layoutSizingHorizontal: FIXED|HUG|FILL → width treatment */
    sizingH: 'fixed' | 'hug' | 'fill'
    sizingV: 'fixed' | 'hug' | 'fill'
    /** figma layoutWrap=WRAP — children wrap onto multiple rows/cols. */
    wrap?: boolean
    /** figma counterAxisSpacing — gap between wrapped lines (when wrap). */
    counterGap?: number
  }
  width?: number
  height?: number
  /** Min/max constraints set on the figma frame. Captured even when the
   * frame is HUG-sized so CSS layout matches figma's actual rendered dim
   * (e.g. a HUG row with minHeight=48 stays 48 tall even when text is
   * shorter — without this CSS HUG would shrink to text dim). */
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  background?: string  // hex or rgba; codegen maps to panda token if matches
  /** First SOLID stroke color (hex/rgba) — figma frames often have 1px
   * border for visual separation. Codegen emits as inset boxShadow to keep
   * the border inside the frame's dim (CSS `border` adds to layout). */
  strokeColor?: string
  strokeWeight?: number
  /** Per-side stroke weights when figma's `strokeWeight === figma.mixed`
   * (individualStrokeWeights set). Codegen emits borderTop/Right/Bottom/Left
   * instead of a 4-side insetBorder. Undefined when stroke is uniform. */
  strokeTopWeight?: number
  strokeRightWeight?: number
  strokeBottomWeight?: number
  strokeLeftWeight?: number
  /** Uniform corner radius. Mutually exclusive with the per-corner fields:
   * the walker emits ONE form depending on whether figma reports a single
   * number or `figma.mixed` for cornerRadius. */
  borderRadius?: number
  borderRadiusTopLeft?: number
  borderRadiusTopRight?: number
  borderRadiusBottomRight?: number
  borderRadiusBottomLeft?: number
  /** figma cornerSmoothing (0..1). >0 means squircle (G2-continuous corner) — codegen
   * must emit clip-path with figma-squircle path instead of CSS border-radius. */
  cornerSmoothing?: number
  /** figma boundVariables — variable id per styled property. Codegen uses
   * `figma-tokens.json` to resolve id → variable name → panda token path. */
  tokenIds?: {
    background?: string
    gap?: string
    paddingTop?: string; paddingRight?: string; paddingBottom?: string; paddingLeft?: string
    width?: string; height?: string
    borderRadius?: string
    strokeColor?: string
    strokeWeight?: string
  }
  /** Panda token paths resolved directly from live Figma variable names. */
  tokenPaths?: {
    background?: string
    gap?: string
    paddingTop?: string; paddingRight?: string; paddingBottom?: string; paddingLeft?: string
    width?: string; height?: string
    borderRadius?: string
    strokeColor?: string
    strokeWeight?: string
  }
  /** figma clipsContent → overflow:hidden; off-bounds children get clipped (e.g., 126x0 separator). */
  clipsContent?: boolean
  /** figma rotation (CCW degrees). Codegen wraps in rotated transform. */
  rotation?: number
  children: IRNode[]
}

/** A styled segment within a TEXT node. Set on `IRText.runs` when figma's
 * `getStyledTextSegments` returns multiple ranges. Each field is undef
 * when the segment matches the node-level value (no override). */
export interface TextRun {
  text: string
  color?: string
  colorTokenId?: string
  fontFamily?: string
  /** Numeric CSS font-weight resolved by figma (100..900). */
  fontWeight?: number
  fontSize?: number
  lineHeight?: number
  textDecoration?: string
}

export interface IRText extends IRBase {
  kind: 'text'
  content: string
  /** When set, codegen emits `{props.<boundProp>}` instead of the literal
   * `content` — turns a per-variant text node into a parametric prop ref. */
  boundProp?: string
  fontSize: number
  /** figma `fontName.family` — designer-authored string (e.g.
   * "Wanted Sans Variable", "goorm Sans Code"). Emitted verbatim. */
  fontFamily?: string
  /** figma-resolved CSS font-weight (100..900). */
  fontWeight?: number
  lineHeight: number
  /** figma `paragraphSpacing` (PIXELS). Inserted between paragraphs (split by
   * `\n` in `content`). Soft-wrapped lines do NOT receive this gap; only hard
   * breaks. CSS has no native equivalent — codegen emits per-paragraph block
   * spans with `marginBottom`. */
  paragraphSpacing: number
  /** Resolved CSS color (hex or rgba). Codegen maps to panda token. */
  color: string
  /** figma textDecoration ('UNDERLINE' | 'STRIKETHROUGH'). Codegen maps
   * to CSS text-decoration. Undefined when figma reports 'NONE'. */
  textDecoration?: string
  /** Per-character styled runs from figma `getStyledTextSegments`. Set only
   * when text has mixed fills/fonts/sizes across ranges (otherwise the
   * node-level fontFamily/color/etc apply uniformly and `runs` is undef). */
  runs?: TextRun[]
  /** figma boundVariables — variable id per styled property. Codegen uses
   * `figma-tokens.json` to resolve id → panda token path. */
  tokenIds?: {
    color?: string
    lineHeight?: string
    paragraphSpacing?: string
    fontSize?: string
  }
  /** Panda token paths resolved directly from live Figma variable names. */
  tokenPaths?: {
    color?: string
    lineHeight?: string
    paragraphSpacing?: string
    fontSize?: string
  }
  textAlign?: 'left' | 'center' | 'right' | 'justify'
  /** Figma textStyle binding (S:hash,index format). If matches a registered
   * typography wrapper, codegen emits <Wrapper>content</Wrapper> instead of
   * a styled span. */
  textStyleId?: string
  /** Fields where the node's effective value diverges from textStyleId's
   * definition (figma plugin API has no explicit "is-overridden" flag, so
   * walker resolves the textStyle and diffs each field). Codegen MUST emit
   * the explicit value for any present field — typography wrapper alone
   * would render the textStyle's value, missing the override. */
  textStyleOverrides?: {
    fontName?: { family: string; style: string }
    fontSize?: number
    lineHeight?: { unit: string; value?: number }
    paragraphSpacing?: number
    textCase?: string
    textDecoration?: string
    letterSpacing?: { unit: string; value: number }
  }
  /** figma textAutoResize: WIDTH_AND_HEIGHT(HUG)|HEIGHT(FIXED-w wrap)|NONE(FIXED-wxh) */
  autoResize: 'hug' | 'fixed-width' | 'fixed-both' | 'truncate'
  /** Figma resolved width — only used when autoResize forces wrap (fixed-width/-both/truncate) */
  width: number
  /** Sibling sizing — FILL text in row flex should be flex:1, not width:N */
  sizingH: 'fixed' | 'hug' | 'fill'
  sizingV: 'fixed' | 'hug' | 'fill'
}

export interface IRVector extends IRBase {
  kind: 'vector'
  /** Path d-attribute (or URL if exported as image). */
  d?: string
  fills: string[]
  width: number
  height: number
}

/**
 * Geometric shape primitives — figma RECTANGLE / ELLIPSE / POLYGON / STAR / LINE.
 * No children allowed in figma. Codegen emits as SVG to preserve sub-pixel
 * rasterization (HTML <div> snaps left-edge to integer css px in chromium;
 * SVG path rendering preserves sub-pixel position, matching figma).
 */
export interface IRShape extends IRBase {
  kind: 'shape'
  shape: 'rect' | 'ellipse' | 'polygon' | 'star' | 'line'
  width: number
  height: number
  fill?: string
  fillTokenId?: string
  strokeColor?: string
  strokeWeight?: number
  /** Figma `strokeCap` ('NONE' | 'ROUND' | 'SQUARE' | ARROW_*) — only
   * meaningful for open paths (lines, vectors). ROUND adds a half-circle
   * at each endpoint (radius = strokeWeight/2), so it shifts the visible
   * ink envelope past the geometric endpoints by ~strokeWeight/2 pixels.
   * Codegen maps this to svg `stroke-linecap`. Without it the chromium
   * render uses default `butt` and diverges by exactly that margin from
   * figma's rasterized line endpoints. */
  strokeCap?: 'butt' | 'round' | 'square'
  borderRadius?: number
  borderRadiusTopLeft?: number
  borderRadiusTopRight?: number
  borderRadiusBottomRight?: number
  borderRadiusBottomLeft?: number
  /** figma rotation in degrees CCW. */
  rotation?: number
  /** Sibling sizing inside parent flex. */
  sizingH?: 'fixed' | 'hug' | 'fill'
  sizingV?: 'fixed' | 'hug' | 'fill'
}

/** Walker couldn't classify; codegen falls back to fixed-size placeholder. */
export interface IRUnknown extends IRBase {
  kind: 'unknown'
  type: string
  width: number
  height: number
}
