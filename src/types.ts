/**
 * pixpec types — the contract between framework and DS packages.
 *
 * A Component is metadata only: `{ name, variants, defaults }`. Nothing more.
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
  /**
   * Optional React component that wraps this individual usecase during
   * render. Used when a Figma instance has an explicit screenshot box
   * such as resized fixed dimensions.
   */
  wrapper?: import('react').ComponentType<{ children: import('react').ReactNode }>
}

/** Per-figma-node binding map — generate consumes this to annotate IR
 * nodes during walk so codegen emits `props.<ownerKey>` JSX expressions
 * in place of master-baked literals. Keyed by figma node id (within the
 * variant's master subtree); each entry classifies the bindings by kind
 * so future detachable-attribute additions slot in cleanly. */
export interface NodeBinding<P> {
  /** Direct attrs on the node — text content, color, visible, etc. */
  attr?: {
    text?: keyof P & string
    color?: keyof P & string
    fill?: keyof P & string
    textStyle?: keyof P & string
    visible?: keyof P & string
  }
  /** componentProperty key (figma's prop name on this INSTANCE) →
   * owning-component prop key. e.g. `{ Type: 'iconType' }` for a nested
   * Icon whose Type should track the owner's `iconType` prop. */
  instanceProps?: Record<string, keyof P & string>
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
 *
 *  `bindings` is the per-node owner-prop map init computed during scan
 *  — generate threads it through walker → codegen so the emitted
 *  per-variant tree is parametric without any post-processing pass. */
export interface Variant<P> {
  key: string
  bindings?: Record<string, NodeBinding<P>>
  usecases: Case<P>[]
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
  nestedProps?: Record<string, Record<string, unknown>>
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
  /** Pure function: serialized instance → React props. The second arg is
   * the compiled child Design AST nodes for this instance — present when
   * the parent contains nested INSTANCEs whose props the parent needs to
   * aggregate (e.g. a Tab whose `tabItems: TabItemProps[]` is collected
   * from N nested Tab_Item children). Most components ignore it. Filter
   * by `c.kind === NodeKind.Instance` to pick out the component children. */
  propsFromFigma: (
    raw: FigmaInstanceRaw,
    children?: import('./compiler/design-ast.ts').DNode[],
  ) => P
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
    n: import('./compiler/design-ast.ts').DNode,
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
