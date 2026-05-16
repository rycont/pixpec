/**
 * pixpec types — the contract between framework and DS packages.
 *
 * A Component is metadata only: `{ name, variants }`. Nothing more.
 *
 * The React implementation (`impl.tsx`) lives on disk at
 * `<componentsDir>/<name>/impl.tsx` — by convention. The Vite harness loads
 * it dynamically when rendering. Node never imports it (so Vite-only features
 * like `import.meta.glob` work without leaking into Node verify scripts).
 *
 * The runner uses {name, variants} to:
 *   - drive iteration
 *   - hand a render URL `?component=<name>&case=<caseName>` to Playwright
 *   - cfigma-export the matching Figma node by `case.nodeId`
 *   - measure HSB dE on the two PNGs
 */

/**
 * One verifiable instance of a component: a props value paired with the
 * Figma node that should match it pixel-wise.
 *
 *   fileKey + nodeId — handed to cfigma for export.
 */
export interface Case<P> {
  props: P
  /** Combined figma reference `<fileKey>:<nodeId>` — the SOLE identifier
   * used everywhere downstream: filenames (sanitize → `_`), the harness
   * `data-case` attribute, the React key, measure-rs's pair key. caseName
   * was redundant once everything keyed off this; figmaId carries enough
   * uniqueness, and the figma node label can be re-fetched lazily for
   * human-facing reports if needed. */
  figmaId: string
  /** Marks the master figma node within its variant bucket — the canonical
   * one whose IR feeds codegen for that variant. Exactly one usecase per
   * variant should carry this flag. Composition picks the main case's
   * generated tree and parametrises it for the bucket's other usecases. */
  isMainCase?: boolean
  /** Skip pixel verify for this usecase. Reason string is logged in the
   * verify report (use to document why parity isn't achievable, e.g.
   * known figma↔Skia rasterizer divergence on sub-pixel curve sampling). */
  skipVerify?: string
  /** Platform-neutral render/capture context for this usecase. */
  render?: CaseRenderSpec
  /** Hash of the raw Figma subtree used to decide whether source PNG capture
   * can safely reuse a previous export. */
  sourceHash?: string
}

export interface RenderBoxSpec {
  /** Omit when the rendered root should hug this axis. */
  width?: number
  height?: number
  padding?: number
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  bg?: string
  color?: string
  overflow?: 'hidden' | 'visible'
}

export interface CaseRenderSpec {
  /** Fixed capture box around the rendered component, expressed in design px. */
  box?: RenderBoxSpec
}

/** A master variant of a registered component — pure addressable
 *  bucket. Variant carries no render data; the master is one of the
 *  `usecases` (the entry with `isMainCase: true`). breakdown / codegen /
 *  verify iterate the variant level (one bucket = one IR codegen
 *  output); usecases sit nested as runtime data + optional regression.
 *
 *  `key` is figma's cross-file durable variant key (the same id figma
 *  uses internally to resolve published library components). It's
 *  globally unique and resolvable in any file via
 *  `figma.importComponentByKeyAsync(key)`, so downstream tooling never
 *  needs an extra (fileKey + nodeId) lookup to find the master.
 */
export interface Variant<P> {
  key: string
  /** Variant-local runtime schema (usually a Zod object). Kept opaque so
   * pixpec/spec stays schema-library-light at the type boundary. */
  propsSchema?: unknown
  /** Variant-local parser. The same semantic prop can map to different
   * Figma node ids per variant, so props hydration lives next to bindings. */
  propsFromFigma?: (...args: unknown[]) => P
  usecases: Case<P>[]
  /** Platform-neutral render/capture context inherited by this variant's usecases. */
  render?: CaseRenderSpec
}

/**
 * Component definition. Three slots:
 *   impl  — produces HTML for given props (DS package handles React→HTML).
 *   variants — master variants + per-variant usecases ↔ Figma node mappings.
 *   render config (optional) — viewport + clipSelector for screenshot.
 *
 * Scale (deviceScaleFactor) is set at runner level so Chromium and Figma
 * exports stay in lockstep — never let component override it.
 */
interface ComponentBase<P> {
  /** Matches the directory `<componentsDir>/<name>/`. */
  name: string
  /** Master variants — what breakdown / codegen / verify iterate. Each
   *  variant carries a nested `usecases` array of figma instance
   *  occurrences that map to it; composition consumes the variant level
   *  only, while usecases feed runtime data + optional regression. */
  variants: Variant<P>[]
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
  /** Legacy component-level defaults. New pixpec init does not emit this. */
  defaults?: Partial<P>
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
  /** Per-descendant TEXT `characters` overrides keyed by master-relative
   * descendant id (figma reports instance child id as `I<inst>;<masterId>`;
   * walker strips the prefix). Undefined when no descendant text was
   * overridden. propsFromFigma reads this when `pixpec init` detected the
   * single-varying-text pattern and emitted a `label` prop binding. */
  textOverrides?: Record<string, string>
  /** Per-(nested-instance-layer-name, propKey) componentProperties overrides
   * — figma instances can change variant/boolean values on nested instances
   * (e.g. an Icon child's Type) without detaching. Walker dumps all such
   * overrides; init's auto-detect picks which (layer, prop) combos are
   * worth exposing as parent-level props. */
  nestedProps?: Record<string, Record<string, string | boolean>>
  /** Component-relevant overrides after Pixpec normalization. Metadata and
   * root layout fields are removed before propsFromFigma receives them. */
  overrides?: FigmaOverride[]
}

export interface FigmaOverride {
  nodeId: string
  fields: string[]
}

export interface FigmaBinding<P> {
  /** Master ComponentSetNode.key (NOT individual variant key). Pass an array
   * when the same React component should match multiple figma component sets
   * (e.g. when a remote library was republished under a new key but the old
   * instances still exist in the file). */
  componentSetKey: string | string[]
  /** Master ComponentSetNode.id within the source figma file. Optional —
   * `pixpec init <ComponentName>` reads this to refetch metadata without
   * the user re-passing the figma node id. The key is the durable cross-
   * file identifier; this is the in-file node reference (changes if the
   * master is moved/duplicated to a new file). */
  componentSetId?: string
}

/** Split a `<fileKey>:<nodeId>` figmaId into its parts. Splits on the
 * FIRST `:` only — nodeIds themselves contain `:` (e.g. `2127:1825`)
 * and `;` (nested-instance `I<inst>;<descId>`). */
export function splitFigmaId(figmaId: string): { fileKey: string; nodeId: string } {
  const i = figmaId.indexOf(':')
  if (i < 0) throw new Error(`splitFigmaId: missing ':' separator in '${figmaId}' (expected '<fileKey>:<nodeId>')`)
  return { fileKey: figmaId.slice(0, i), nodeId: figmaId.slice(i + 1) }
}

export function defineComponent<P>(c: Component<P>): Component<P> {
  return c
}

