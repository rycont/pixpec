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
export type NoiseFn<P> = (props: P) => number

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
   * Optional fixed-size wrapper around the impl. Eliminates dim mismatch
   * between figma frame width and chromium calc-size width — the two
   * renderers' "hug-content" algorithms diverge at sub-pixel level
   * occasionally, but if both are rendered into a known fixed-size box,
   * dim parity is guaranteed and only inner ink differs.
   *
   *   width/height — outer box dim in css px (must match figma frame post-padding)
   *   padding      — inner padding in css px (default 4)
   *   bg           — wrapper background (default white)
   *
   * Figma seed must wrap text/component in an auto-layout frame with the
   * same padding so figma's frame.width = inner_content + 2*padding.
   * Then this width is captured into `wrapper.width`.
   */
  wrapper?: { width: number; height: number; padding?: number; bg?: string }
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
export interface Component<P> {
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
  /**
   * Optional figma binding — generator uses this to recognize INSTANCE nodes
   * whose mainComponent.parent.key matches `componentSetKey` and convert
   * them to <Component {...fromInstance(raw)} /> JSX.
   */
  figma?: FigmaBinding<P>
}

/**
 * Serialized figma INSTANCE shape (extracted by walker, no live figma API).
 * `props`: componentProperties values, keyed by both qualified ("Size") and
 * full ("Label#524:131") names — fromInstance uses whichever is convenient.
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
}

export interface FigmaBinding<P> {
  /** Master ComponentSetNode.key (NOT individual variant key). */
  componentSetKey: string
  /** Pure function: serialized instance → React props. */
  fromInstance: (raw: FigmaInstanceRaw) => P
}

export function defineComponent<P>(c: Component<P>): Component<P> {
  return c
}

/** Result for one (component, case) verification. */
export interface CaseResult {
  component: string
  case: string
  actualDE: number
  /** Per-axis HSV breakdown of the residual that summed into actualDE. */
  axis: { dH: number; dS: number; dV: number }
  /** PASS threshold = noise(props). actualDE <= threshold → pass. */
  threshold: number
  pass: boolean
  /** Paths to the rendered PNGs, for debug RGG generation if FAIL. */
  artifacts: { figma: string; impl: string }
}

/**
 * Pluggable metric. Receives RGB buffers (HxWx3 uint8) for both sides;
 * returns a single dE scalar. pixpec ships an HSB default in `measure.ts`.
 */
export type Metric = (
  figma: { width: number; height: number; data: Buffer },
  impl: { width: number; height: number; data: Buffer },
) => Promise<number> | number
