/**
 * Branded numeric type for CIEDE2000 ΔE values. The `__dE00` brand makes
 * `DE00` and `number` non-interchangeable at the type level — author can't
 * accidentally return a raw number from a noise function or compare a
 * dE_lab/dE_hsb scalar against a dE00 threshold.
 *
 *   const t = dE00(15.5)              // OK
 *   const t: DE00 = 15.5              // type error
 *   noise: () => 15.5                 // type error (must return DE00)
 *   noise: () => dE00(15.5)           // OK
 *
 * Runtime: zero overhead — `dE00(x)` is just an identity cast. The brand is
 * compile-time only.
 */
declare const dE00Brand: unique symbol
export type DE00 = number & { readonly [dE00Brand]: never }

/** Constructor — narrows a raw number into a branded DE00. */
export function dE00(x: number): DE00 {
  return x as DE00
}

/**
 * pixpec types — the contract between framework and DS packages.
 *
 * A Component is metadata only: `{ name, cases, noise }`. Nothing more.
 *
 * The React implementation (`impl.tsx`) lives on disk at
 * `<componentsDir>/<name>/impl.tsx` — by convention. The Vite harness loads
 * it dynamically when rendering. Node never imports it (so Vite-only features
 * like `import.meta.glob` work without leaking into Node verify scripts).
 *
 * The runner uses {name, cases, noise} to:
 *   - drive iteration
 *   - hand a render URL `?component=<name>&case=<caseName>` to Playwright
 *   - cfigma-export the matching Figma node by `case.nodeId`
 *   - measure HSB dE on the two PNGs
 *   - compare to noise(props): pass iff actualDE <= noise(props)
 *
 * `noise(props)` returns the per-case PASS threshold directly. No external
 * multiplier — the component author bakes their own safety margin in.
 * Conceptually: "what's the largest dE this case can produce while still
 * being a faithful render?"
 */
export type NoiseFn<P> = (props: P) => DE00

/**
 * One verifiable instance of a component: a props value paired with the
 * Figma node that should match it pixel-wise.
 *
 *   fileKey + nodeId — handed to cfigma for export.
 */
export interface Case<P> {
  /** Stable, human-readable identifier (used in reports + filenames). */
  name: string
  props: P
  fileKey: string
  nodeId: string
  /**
   * Optional React component that wraps the impl during render. Owns all
   * styling concerns (dim, padding, bg, color, layout) so the harness/type
   * system doesn't need to know every CSS property. Harness puts `data-case`
   * on an outer div around the wrapper, so the screenshot region = wrapper bounds.
   *
   *   import type { ComponentType, ReactNode } from 'react'
   *   wrapper: ({ children }) => <div style={{...}}>{children}</div>
   *
   * Use to:
   *   - lock dim (figma frame size in CSS px, no sub-pixel hug variance)
   *   - apply parent CSS context (color for currentColor SVGs, font, etc.)
   *   - simulate consumer environment (e.g., flex parent direction)
   */
  wrapper?: import('react').ComponentType<{ children: import('react').ReactNode }>
}

/**
 * Component definition. Four slots:
 *   impl  — produces HTML for given props (DS package handles React→HTML).
 *   noise — predicts dE (DS package implements via leaf-composition).
 *   cases — props ↔ Figma node mappings to verify.
 *   render config (optional) — viewport + clipSelector for screenshot.
 *
 * Scale (deviceScaleFactor) is set at runner level so Chromium and Figma
 * exports stay in lockstep — never let component override it.
 */
interface ComponentBase<P> {
  /** Matches the directory `<componentsDir>/<name>/`. */
  name: string
  cases: Case<P>[]
  noise: NoiseFn<P>
  /** CSS selector clipped on screenshot. Default: `#pixpec-target`. */
  clipSelector?: string
  /** Page viewport. Generous default; the clipSelector trims to content. */
  viewport?: { width: number; height: number }
  /**
   * Cases per page in batch mode. Smaller chunks → smaller DOM → faster
   * per-shot capture. Default 500. Pay nav (~5s) + mount (~1s) per chunk.
   */
  batchChunk?: number
  /**
   * Concurrent chunk workers. Each runs in its own Chromium browser context
   * (= tab). Default 4. Increase for more cores; decrease if memory-bound.
   */
  batchParallel?: number
}

export interface ComponentWithFigma<P> extends ComponentBase<P> {
  /**
   * Figma binding — generator uses this to recognize INSTANCE nodes
   * whose mainComponent.parent.key matches `componentSetKey` and convert
   * them to <Component {...propsFromFigma(raw)} /> JSX.
   */
  figma: FigmaBinding<P>
  /**
   * Effective default props for this component. Single source of truth for
   * BOTH:
   *   1. Runtime: the component's impl spreads `defaults` over incoming props
   *      so omitted keys fall back here.
   *   2. Codegen: the generator elides any prop on an instance whose value
   *      equals `defaults[key]` — keeping the generated JSX terse.
   *
   * Recommended source: `figmaDefaults(componentSetKey)` from the design-
   * system's tokens pipeline, plus any JS-only props (e.g. `height: 24`)
   * and exposed-instance props (e.g. `Icon: { Type: 'default' }`) that the
   * impl needs to render correctly when the prop is omitted.
   */
  defaults: Partial<P>
}

export interface ComponentWithoutFigma<P> extends ComponentBase<P> {
  figma?: undefined
  defaults?: Partial<P>
}

export type Component<P> = ComponentWithFigma<P> | ComponentWithoutFigma<P>

/**
 * Serialized figma INSTANCE shape (extracted by walker, no live figma API).
 * `props`: componentProperties values, keyed by full ("Label#524:131"),
 * Figma-short ("Label"), and normalized camelCase ("label") names —
 * propsFromFigma uses whichever is convenient.
 * `exposed`: nested instances surfaced for editing (icons, etc.).
 */
export interface FigmaInstanceRaw {
  id: string
  name: string
  mainComponentName: string
  componentSetKey: string
  props: Record<string, string | boolean>
  exposed: Array<{
    name: string
    mainComponentName: string
    props: Record<string, string | boolean>
  }>
  /** Figma node-set defaults (componentPropertyDefinitions). Available for
   * propsFromFigma to compare against and decide which props to emit. */
  defaults?: Record<string, unknown>
  /** Resolved instance dim. Differs from master when the instance was resized
   * (e.g., 24×24 Icon master used at 20×20). Lets propsFromFigma pass the
   * actual rendered size as a prop. */
  width?: number
  height?: number
  sizingH?: 'fixed' | 'hug' | 'fill'
  sizingV?: 'fixed' | 'hug' | 'fill'
  mainWidth?: number
  mainHeight?: number
  mainSizingH?: 'fixed' | 'hug' | 'fill'
  mainSizingV?: 'fixed' | 'hug' | 'fill'
}

export interface FigmaBinding<P> {
  /** Master ComponentSetNode.key (NOT individual variant key). Pass an array
   * when the same React component should match multiple figma component sets
   * (e.g. when a remote library was republished under a new key but the old
   * instances still exist in the file). */
  componentSetKey: string | string[]
  /** Pure function: serialized instance → React props. */
  propsFromFigma: (raw: FigmaInstanceRaw) => P
}

export function defineComponent<P>(c: Component<P>): Component<P> {
  return c
}

/**
 * Codegen plugin — extension point for design-system-specific quirks that
 * shouldn't live in the pixpec core (e.g. "Icon uses currentColor so its
 * parent's CSS color must be set"). Plugins hook into the walker (via raw
 * JS injected into the cfigma exec script) and the codegen (via post-emit
 * JSX wrapping). Loaded from `pixpec.config.ts` in the project root.
 */
export interface CodegenPlugin {
  /** Stable name for logs and debugging. */
  name: string
  /**
   * Raw JS source spliced into the walker's plugin script (cfigma exec
   * context — running INSIDE figma plugin). Has `node` (current FigmaNode)
   * and `ir` (the IR object being built for this node) in scope. Mutate
   * `ir` to attach extra fields. Runs after pixpec's built-in extraction.
   *
   *   walkExtend: `
   *     if (node.type === 'INSTANCE') {
   *       const fill = findFirstSolidFill(node);
   *       if (fill) ir.effectiveFill = rgbaHex(fill.color, fill.opacity);
   *     }
   *   `
   */
  walkExtend?: string
  /**
   * Codegen hook — called once per emitted IR node (frame/component/text/etc.)
   * AFTER the default JSX is built. Return a replacement JSX (typically a
   * wrapping span) to alter, or the input unchanged to pass through.
   *
   * Use `wrapWithCss` for Panda token-aware values, `wrapWithStyle` for
   * already-valid CSS inline values, and `appendJsxAttr`/`jsxAttr` for
   * direct prop edits on JSX self-closing elements.
   */
  emitWrap?: (
    n: import('./generator/ir.ts').IRNode,
    jsx: import('@typescript/native-preview/ast').JsxChild,
    ctx: EmitContext,
  ) => import('@typescript/native-preview/ast').JsxChild
}

export interface EmitContext {
  parentDir: 'row' | 'column' | 'none'
  /** figma variable id → panda token path (e.g. "core.accent"). */
  tokenMap: Record<string, string>
  /** Resolve figma variable ids, including live ids with remote-key prefixes. */
  resolveTokenPath: (tokenId: string | undefined) => string | undefined
  /** Convenience: wrap an existing JSX element in a `<span style={{...}}>`. */
  wrapWithStyle: (
    jsx: import('@typescript/native-preview/ast').JsxChild,
    style: Record<string, unknown>,
  ) => import('@typescript/native-preview/ast').JsxChild
  /** Convenience: wrap an existing JSX element in a `<span className={css({...})}>`. */
  wrapWithCss: (
    jsx: import('@typescript/native-preview/ast').JsxChild,
    style: Record<string, unknown>,
  ) => import('@typescript/native-preview/ast').JsxChild
  /** Build a JSX attribute from a primitive/object value. */
  jsxAttr: (name: string, value: unknown) => import('@typescript/native-preview/ast').JsxAttribute
  /** Build `style={...}` from a plain style object. */
  styleAttr: (style: Record<string, unknown>) => import('@typescript/native-preview/ast').JsxAttribute
  /** Append an attribute to a JSX self-closing element; returns input unchanged otherwise. */
  appendJsxAttr: (
    jsx: import('@typescript/native-preview/ast').JsxChild,
    attr: import('@typescript/native-preview/ast').JsxAttribute,
  ) => import('@typescript/native-preview/ast').JsxChild
}

/** Result for one (component, case) verification. */
export interface CaseResult {
  component: string
  case: string
  /** Measured ΔE00 (sum per case). */
  actualDE: DE00
  /** PASS threshold = noise(props). actualDE <= threshold → pass. */
  threshold: DE00
  pass: boolean
  /** Paths to the rendered PNGs, for debug visualization if FAIL. */
  artifacts: { figma: string; impl: string }
}

/**
 * Pluggable metric. Receives RGB buffers (HxWx3 uint8) for both sides;
 * returns a ΔE00 scalar.
 */
export type Metric = (
  figma: { width: number; height: number; data: Buffer },
  impl: { width: number; height: number; data: Buffer },
) => Promise<DE00> | DE00
