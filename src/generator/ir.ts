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
export type IRNode = IRComponent | IRFrame | IRText | IRVector | IRUnknown

export interface IRBase {
  /** Figma node id, e.g., "47:1234". */
  figmaId: string
  /** Figma node name (for codegen comments / debugging). */
  figmaName: string
}

/** Recognized as a registered component (defineComponent.figma binding). */
export interface IRComponent extends IRBase {
  kind: 'component'
  /** Matches a Component.name from defineComponent. */
  componentName: string
  /** Props produced by Component.figma.fromInstance(raw). */
  props: Record<string, unknown>
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
  }
  width?: number
  height?: number
  background?: string  // hex or rgba; codegen maps to panda token if matches
  borderRadius?: number
  children: IRNode[]
}

export interface IRText extends IRBase {
  kind: 'text'
  content: string
  fontSize: number
  fontWeight: number
  lineHeight: number
  /** Resolved CSS color (hex or rgba). Codegen maps to panda token. */
  color: string
  textAlign?: 'left' | 'center' | 'right' | 'justify'
  /** Figma textStyle binding (S:hash,index format). If matches a registered
   * typography wrapper, codegen emits <Wrapper>content</Wrapper> instead of
   * a styled span. */
  textStyleId?: string
}

export interface IRVector extends IRBase {
  kind: 'vector'
  /** Path d-attribute (or URL if exported as image). */
  d?: string
  fills: string[]
  width: number
  height: number
}

/** Walker couldn't classify; codegen falls back to fixed-size placeholder. */
export interface IRUnknown extends IRBase {
  kind: 'unknown'
  type: string
  width: number
  height: number
}
