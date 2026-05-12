/**
 * Fetch component metadata via cfigma exec.
 *
 * Sends a Figma plugin-API snippet to the user's connected tab; the plugin
 * walks the requested component (or component-set) and extracts:
 *   - propertyDefinitions (VARIANT / TEXT / BOOLEAN / INSTANCE_SWAP)
 *   - per-variant: id, name, propValues (variant + bound TEXT/BOOLEAN/INSTANCE_SWAP values)
 *
 * The same primitive `cfigma --tab <p> exec <code>` from figma.ts; we just
 * send a different code body.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function cleanControlValue<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") as T;
  }
  if (Array.isArray(value)) return value.map(cleanControlValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        cleanControlValue(v),
      ]),
    ) as T;
  }
  return value;
}

export type FigmaPropType = "VARIANT" | "TEXT" | "BOOLEAN" | "INSTANCE_SWAP";

export interface FigmaPropertyDefinition {
  type: FigmaPropType;
  defaultValue: unknown;
  variantOptions?: string[];
}

export interface FigmaInstanceSwapValue {
  kind: "instance";
  mainComponentId: string | null;
  mainComponentName: string | null;
}

export type FigmaPropValue = string | boolean | FigmaInstanceSwapValue | null;

/** Per-variant schema for an exposed nested instance slot — used by init
 * to emit a properly-typed sub-interface instead of `Record<string, unknown>`. */
export interface FigmaExposedInstanceSchema {
  /** componentSet key (preferred) or component key for figma binding. */
  mainKey: string | null;
  /** componentSet name (e.g. "Icon", "Button"). */
  mainName: string | null;
  /** Property definitions of the slot's componentSet — same shape as the
   * top-level componentPropertyDefinitions. Drives TS type emission. */
  propertyDefinitions: Record<string, FigmaPropertyDefinition>;
}

export interface FigmaVariantMeta {
  id: string;
  /** Cross-file durable key (figma's stable variant identifier). Library
   * instances inside other files reference variants by key, not by id. */
  key?: string;
  name: string;
  /**
   * Prop name → resolved value for this variant. Combines:
   *   - VARIANT / TEXT / BOOLEAN / INSTANCE_SWAP props from the variant itself
   *   - Nested-instance slots that the designer marked as `exposedInstances`
   *     in figma — keyed by the layer name (duplicate names get `_2`, `_3`
   *     suffixes), values are the slot's own resolved componentProperties.
   */
  propValues: Record<string, FigmaPropValue>;
  /** Schema for each exposed nested-instance slot (same keys as propValues
   * for slots that came from exposedInstances). init aggregates these
   * across variants and emits a typed sub-interface per slot. */
  exposedSchemas?: Record<string, FigmaExposedInstanceSchema>;
  /** Every TEXT descendant in this variant keyed by layer name → chars.
   * init pulls master values for usage-detected synthetic props (e.g.
   * `label` derived from a TEXT layer named "Label") so the master
   * variant's case props match what figma's master node renders. */
  textLayers?: Record<string, string>;
  /** Every nested INSTANCE descendant in this variant keyed by layer name
   * → propKey → resolved value. Same purpose as textLayers but for the
   * usage-detected nested-prop pattern (e.g. `iconType` ← Icon.Type). */
  nestedProps?: Record<string, Record<string, string | boolean>>;
  /** Per-node-id text descendant rows — used to build Variant.bindings
   * (node id → owner-prop). textLayers groups by name; this preserves
   * the underlying nodeIds so init can emit a per-id binding map. */
  textNodes?: Array<{
    id: string;
    name: string;
    chars: string;
    propRef?: string;
  }>;
  /** Per-node-id nested INSTANCE rows — same purpose as textNodes. */
  nestedNodes?: Array<{
    id: string;
    name: string;
    props: Record<string, unknown>;
  }>;
  /** Per-node-id visibility-binding rows — each node whose `visible` field
   *  is bound to an owner-component boolean property. init maps the raw
   *  figma key (`Left Icon#2137:0`) to a TS prop name and records it in
   *  `Variant.bindings[nodeId].node.visible`. */
  visibilityNodes?: Array<{ id: string; propRef: string }>;
  /** Master variant's intrinsic figma dim. Used by init to emit a
   * boxWrapper on master variant cases — impl's CSS-flex hug may differ
   * from figma's layout-engine hug by a sub-pixel, so locking the wrapper
   * to the figma dim keeps pixel parity. */
  width?: number;
  height?: number;
  renderWidth?: number;
  renderHeight?: number;
  renderOffsetX?: number;
  renderOffsetY?: number;
  /** Master variant's autolayout values — paddings + itemSpacing (gap).
   * Forwarded as explicit case props so impl can render variants whose
   * size-difference is encoded as padding/gap rather than a `Size`
   * componentProperty (figma sometimes ships sub-variants differing only
   * in autolayout values, with no exposed prop to switch them). */
  /** figma's layoutMode on this variant — `'HORIZONTAL'`, `'VERTICAL'`,
   *  or `'NONE'`. Init only emits padding/gap as case props for autolayout
   *  variants, since on a non-autolayout frame they're meaningless visual
   *  noise (no engine consumes them). */
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "NONE";
  layout?: {
    paddingTop: number | null;
    paddingRight: number | null;
    paddingBottom: number | null;
    paddingLeft: number | null;
    gap: number | null;
  };
}

export interface FigmaComponentMeta {
  /** 'set' for ComponentSet (with variants), 'single' for standalone Component. */
  kind: "set" | "single";
  id: string;
  name: string;
  /** Stable component-set key for figma binding (used by registered DS
   * components to declare which figma master they implement). */
  key?: string;
  propertyDefinitions: Record<string, FigmaPropertyDefinition>;
  variants: FigmaVariantMeta[];
}

const PLUGIN_TEMPLATE = (componentId: string) => `
const targetId = ${JSON.stringify(componentId)};
// getNodeByIdAsync hits the page index without requiring all pages to be
// loaded — works regardless of which page is currently active.
const node = await figma.getNodeByIdAsync(targetId);
if (!node) throw new Error('component not found: ' + targetId);
if ((node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.remote) {
  let set = node.type === 'COMPONENT_SET' ? node : node.parent;
  while (set && set.type !== 'COMPONENT_SET') set = set.parent;
  throw new Error(
    'remote component proxy is not a valid init target: ' + targetId +
    ' (' + node.name + '). Open the source library file and run init with the original ' +
    (node.type === 'COMPONENT_SET' ? 'COMPONENT_SET' : 'COMPONENT') +
    ' node id. componentSetKey=' + (set && set.key || '<unknown>')
  );
}

function stripHashKey(k) { return String(k).replace(/#[^#]*$/, ''); }
function safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

function extractVariant(v) {
  const propValues = Object.assign({}, v.variantProperties || {});
  // Extra: capture every TEXT descendant (by layer name) and every nested
  // INSTANCE descendant's componentProperties. init uses these to fill
  // master-variant case props for synthetic label / iconType style props
  // that came from a usage-based scan (those props don't appear in
  // componentPropertyDefinitions, so extractVariant's normal binding walk
  // doesn't surface them — without these the master variants render with
  // arbitrary defaults and mismatch master figma export).
  // Per-layer-name aggregates (used by init for value defaults) AND
  // per-layer-name → list of (nodeId, …) entries (used by init to build
  // the variant.bindings node-id → owner-prop map). Multiple TEXTs with
  // the same layer name still get distinct ids — bindings emit picks
  // each one as a separate binding entry.
  const textLayers = {};
  const nestedProps = {};
  const textNodes = [];      // [{ id, name, chars }]
  const nestedNodes = [];    // [{ id, name, props }]
  const visitExtra = (n) => {
    if (n.type === 'TEXT') {
      textLayers[n.name] = n.characters;
      // propRef captures the figma component-property binding (e.g.
      // 'Label#516:44' from refs.characters). init uses it to emit a
      // props.label expression in JSX instead of the literal master string.
      const propRef = n.componentPropertyReferences?.characters;
      textNodes.push({ id: n.id, name: n.name, chars: n.characters, propRef });
    }
    if (n.type === 'INSTANCE') {
      const cp = safe(() => n.componentProperties || {}, {});
      const layer = nestedProps[n.name] = nestedProps[n.name] || {};
      const flat = {};
      for (const k of Object.keys(cp)) {
        const val = cp[k] && 'value' in cp[k] ? cp[k].value : cp[k];
        layer[k] = val;
        flat[k] = val;
      }
      nestedNodes.push({ id: n.id, name: n.name, props: flat });
      return; // don't recurse into nested instances
    }
    if (n.children) for (const c of n.children) visitExtra(c);
  };
  if (v.children) for (const c of v.children) visitExtra(c);

  // Step 1: Figma component-property bindings (TEXT / BOOLEAN / INSTANCE_SWAP).
  // componentPropertyReferences names point into the OWNING component's
  // propertyDefinitions; descending into nested INSTANCEs would leak THEIR
  // ref names (e.g. an inner TextButton's leftIcon prop) onto the variant
  // root. Stop recursion at INSTANCE boundaries — those are handled by
  // Step 2 (exposedInstances) instead.
  const visibilityNodes = [];
  const visit = (n) => {
    const refs = n.componentPropertyReferences;
    if (refs) {
      if (refs.characters && n.type === 'TEXT') {
        propValues[stripHashKey(refs.characters)] = n.characters;
      }
      if (refs.visible) {
        propValues[stripHashKey(refs.visible)] = n.visible !== false;
        visibilityNodes.push({ id: n.id, propRef: refs.visible });
      }
      if (refs.mainComponent && n.type === 'INSTANCE') {
        const mc = safe(() => n.mainComponent, null);
        propValues[stripHashKey(refs.mainComponent)] = {
          kind: 'instance',
          mainComponentId: mc ? mc.id : null,
          mainComponentName: mc ? mc.name : null,
        };
      }
    }
    if (n.type === 'INSTANCE') return;
    if (n.children) for (const c of n.children) visit(c);
  };
  if (v.children) for (const c of v.children) visit(c);

  // Step 2: only nested INSTANCEs that the designer explicitly marked
  // "Expose properties" in figma get surfaced as public props. The rest
  // are baked into the variant's render and the codegen reads their
  // resolved values from the IR walk, not from cases.ts. This mirrors
  // figma's own API surface.
  const exposed = v.exposedInstances || [];
  const taken = new Set(Object.keys(propValues));
  const exposedSchemas = {};
  for (const inst of exposed) {
    let key = inst.name;
    let i = 2;
    while (taken.has(key)) { key = inst.name + '_' + i; i++; }
    taken.add(key);

    const innerProps = {};
    const cp = safe(() => inst.componentProperties || {}, {});
    for (const k of Object.keys(cp)) {
      innerProps[stripHashKey(k)] = cp[k] && 'value' in cp[k] ? cp[k].value : cp[k];
    }
    propValues[key] = innerProps;

    // Capture the slot's componentSet schema so init can emit a proper TS
    // type for its props. Walk up to COMPONENT_SET (so all variants of the
    // referenced component share one definition).
    let main = safe(() => inst.mainComponent, null);
    let set = main;
    while (set && set.type !== 'COMPONENT_SET') set = set.parent;
    const root = set || main;
    exposedSchemas[key] = {
      mainKey: root ? root.key : null,
      mainName: root ? root.name : null,
      propertyDefinitions: stripHash(root ? root.componentPropertyDefinitions : {}),
    };
  }

  // Each master variant has its own intrinsic layout (padding/gap) that
  // produces its visible dim. Capture so init can emit them as explicit
  // case props — without this, impl can't tell variants apart when figma
  // doesn't expose Size as a componentProperty (different sub-variants
  // happen to share status=true but have padding 12 vs 20, etc.).
  const layout = {
    paddingTop: typeof v.paddingTop === 'number' ? v.paddingTop : null,
    paddingRight: typeof v.paddingRight === 'number' ? v.paddingRight : null,
    paddingBottom: typeof v.paddingBottom === 'number' ? v.paddingBottom : null,
    paddingLeft: typeof v.paddingLeft === 'number' ? v.paddingLeft : null,
    gap: typeof v.itemSpacing === 'number' ? v.itemSpacing : null,
  };
  const layoutMode = typeof v.layoutMode === 'string' ? v.layoutMode : 'NONE';
  const rb = safe(() => v.absoluteRenderBounds, null);
  const bb = safe(() => v.absoluteBoundingBox, null);
  const render =
    rb && bb
      ? {
          renderWidth: rb.width,
          renderHeight: rb.height,
          renderOffsetX: bb.x - rb.x,
          renderOffsetY: bb.y - rb.y,
        }
      : {};
  return { id: v.id, name: v.name, key: v.key, propValues, exposedSchemas, textLayers, nestedProps, textNodes, nestedNodes, visibilityNodes, width: v.width, height: v.height, ...render, layout, layoutMode };
}

function stripHash(defs) {
  const out = {};
  for (const k of Object.keys(defs || {})) {
    const name = String(k).replace(/#[^#]*$/, '');
    out[name] = defs[k];
  }
  return out;
}

if (node.type === 'COMPONENT_SET') {
  return {
    kind: 'set',
    id: node.id,
    name: node.name,
    key: node.key,
    propertyDefinitions: stripHash(node.componentPropertyDefinitions),
    variants: node.children
      .filter((c) => c.type === 'COMPONENT')
      .map(extractVariant),
  };
}
if (node.type === 'COMPONENT') {
  // Standalone COMPONENT (no variants) — use its own key. When the user
  // later wraps it in a COMPONENT_SET, init can be re-run.
  return {
    kind: 'single',
    id: node.id,
    name: node.name,
    key: node.key,
    propertyDefinitions: stripHash(node.componentPropertyDefinitions),
    variants: [extractVariant(node)],
  };
}
throw new Error('node ' + targetId + ' is ' + node.type + ', not a COMPONENT or COMPONENT_SET');
`;

export async function fetchComponentMeta(opts: {
  tabPattern: string;
  componentId: string;
  cfigmaBin?: string;
}): Promise<FigmaComponentMeta> {
  const bin = opts.cfigmaBin ?? "cfigma";
  const code = PLUGIN_TEMPLATE(opts.componentId);
  const { stdout } = await execFileAsync(
    bin,
    ["--tab", opts.tabPattern, "exec", code],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return cleanControlValue(JSON.parse(stdout)) as FigmaComponentMeta;
}

/**
 * One descendant TEXT node observed across instance usages of a component
 * set. `descId` is figma's master-relative descendant id (so the same
 * `descId` matches the same text node across all instances). `samples` is
 * the set of distinct `characters` values seen; when length === 1 the text
 * is never overridden in practice and not a candidate prop.
 */
export interface InstanceTextSummary {
  /** Sample descId (any one) — used as a propsFromFigma lookup key when
   * the variant tree is single. `descIds` carries the full set so binding
   * code can OR-fallback across variants. */
  descId: string;
  descIds: string[];
  descName: string;
  /** True when at least one instance overrides `characters` away from the
   * master's value (figma marks 'characters' in `instance.overrides`). */
  hasOverride: boolean;
  /** How many of `instanceCount` actually override `characters`. init
   * applies a 20% threshold (overrideCount / totalInstances) to decide
   * whether the prop is exposed. */
  overrideCount: number;
  samples: string[];
  instanceCount: number;
}

/** Per-(nested-instance-name, propKey) summary — same role as
 * InstanceTextSummary but for variant/boolean/instance-swap properties on
 * INSTANCE descendants (e.g. an Icon's `Type` inside TabItem). init exposes
 * as `<nestedLayerName><PropKey>?: <type>` when overrideCount/instanceCount
 * exceeds the 20% threshold. */
export interface NestedPropSummary {
  /** Layer name of the nested INSTANCE (e.g. "Icon"). */
  layerName: string;
  /** Component set name of the nested INSTANCE. */
  componentName: string | null;
  /** componentSetKey of the nested instance — for type emission. */
  componentSetKey: string | null;
  /** Raw figma prop key (e.g. "Type"). camelCased by init. */
  propKey: string;
  /** Distinct values seen across instance overrides. */
  samples: unknown[];
  /** Number of usages where this nested instance EXISTED. */
  instanceCount: number;
  /** Number where the prop was OVERRIDDEN (value != master default). */
  overrideCount: number;
}

/**
 * List figma tabs currently open in the cfigma-connected browser. Returns
 * `[{ title, key }]` parsed from `cfigma tabs` (no `--json` flag, so parse
 * the line format: leading spaces, title, run of spaces, `key=<hex>`).
 */
export async function listFigmaTabs(opts: {
  cfigmaBin?: string;
}): Promise<Array<{ title: string; key: string }>> {
  const bin = opts.cfigmaBin ?? "cfigma";
  const { stdout } = await execFileAsync(bin, ["tabs"], { encoding: "utf8" });
  const tabs: Array<{ title: string; key: string }> = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s+(.+?)\s+key=(\S+)\s*$/);
    if (m) tabs.push({ title: m[1].trim(), key: m[2] });
  }
  return tabs;
}

/**
 * Combined scan result — one cfigma round-trip returns BOTH the
 * per-descendant text summaries (for the single-text label detection)
 * and the per-parent child variation samples (for the array-prop
 * detection). Consolidating avoids paying figma's
 * findAllWithCriteria-over-35k-nodes cost twice per tab.
 */
export interface UsageInstance {
  /** Stripped instance node id (no `I<...>;` prefix). */
  id: string;
  name: string;
  /** Raw figma `instance.componentProperties` map (key#hash → resolved
   * value). init `normalizeRawProps` to add short + camelCase aliases. */
  componentProperties: Record<string, unknown>;
  /** Per-text-layer override `{ <layerName>: characters }`, only for
   * descendants whose `characters` differ from master default. */
  textOverrides: Record<string, string>;
  /** Raw figma `inst.overrides` — list of { id, fields } per overridden
   *  descendant. init checks each instance's overrides against the
   *  detected props; any field not covered by an exposed prop drops the
   *  whole instance from cases.ts (the "20% rule" extended to filtering). */
  overrides?: Array<{ id: string; fields: string[] }>;
  /** Per-nested-INSTANCE override `{ <layerName>: { <propKey>: value } }`,
   * only entries that diverge from the nested master's default. */
  nestedProps: Record<string, Record<string, string | boolean>>;
  /** Resolved fill colors per overridden descendant — keyed by stripped
   *  master-relative descendant id. init checks if all entries share a
   *  single hex; if so the usage is a fill-prop candidate. When the
   *  overridden node lives inside a nested INSTANCE, owner* points at the
   *  nearest such INSTANCE so a parent can propagate `_fill` to a child
   *  component that declared support for it during its own init. */
  fillOverrides?: Record<
    string,
    {
      hex: string;
      opacity: number;
      ownerInstanceId?: string | null;
      ownerComponentSetKey?: string | null;
    }
  >;
  /** Resolved textStyleId per overridden TEXT descendant, keyed by stripped
   *  master-relative descendant id. */
  textStyleOverrides?: Record<string, string>;
  width: number;
  height: number;
  /** instance.mainComponent.id — which master variant this usage maps
   * to. init nests the usecase under that variant (figmaId-matched) in
   * cases.ts. `null` if the master can't be resolved (rare detached). */
  mainNodeId: string | null;
  /** instance.mainComponent.key — durable cross-file id of the master
   * variant. Required for v2-client instances whose mc.id is a local
   * proxy distinct from the library variant's own id; bucketing by key
   * lands them on the right library variant. */
  mainKey: string | null;
  /** Master variant's intrinsic dim (instance.mainComponent.width/height).
   * `null` if the master couldn't be resolved. init compares this to
   * width/height to decide whether the usage overrode the root sizing
   * and therefore needs a dim-locking wrapper in its emitted case. */
  mainWidth: number | null;
  mainHeight: number | null;
  /** Instance autolayout values (paddings + gap). init compares to
   * `mainLayout` to find the keys that were overridden vs the master
   * and emits ONLY those as case props — most usages inherit the master
   * defaults so the emitted case prop set stays minimal. */
  layout: {
    paddingTop: number | null;
    paddingRight: number | null;
    paddingBottom: number | null;
    paddingLeft: number | null;
    gap: number | null;
  };
  /** Master variant's autolayout values, captured at scan time so init
   * can diff against `layout` without a second cfigma round trip. */
  mainLayout: {
    paddingTop: number | null;
    paddingRight: number | null;
    paddingBottom: number | null;
    paddingLeft: number | null;
    gap: number | null;
  } | null;
  /** Stamped by `scanAllOpenTabsForInit` from the tab key — the figma
   * file that contains this usage (typically the consuming app, not
   * the library where the master lives). */
  fileKey?: string;
}

export interface ChildVariationSample {
  parentId: string;
  parentName: string;
  parentProps: Record<string, unknown>;
  parentWidth: number;
  parentHeight: number;
  childComponentSetKey: string | null;
  childComponentSetName: string | null;
  childComponentName: string | null;
  children: Array<{
    componentProperties: Record<string, unknown>;
    textOverrides: Record<string, string>;
    nestedProps: Record<string, Record<string, string | boolean>>;
  }>;
  parentFileKey?: string;
}

export interface InitScanResult {
  textSummaries: InstanceTextSummary[];
  nestedPropSummaries: NestedPropSummary[];
  childVariations: ChildVariationSample[];
  /** One entry per matched INSTANCE — full per-usage raw dump that init
   * hydrates inline to emit a case row per real usage. */
  usages: UsageInstance[];
  /** Total number of INSTANCE usages of the scanned componentSetKey.
   * init divides per-summary `overrideCount` by this to apply the
   * 20% threshold. */
  totalInstances: number;
}

/**
 * Scan a tab for INSTANCEs of `componentSetKey` and return both
 * label-detection and child-variation data in one pass. Sets
 * `figma.skipInvisibleInstanceChildren = true` to halve traversal cost.
 */
export async function scanInstancesForInit(opts: {
  tabPattern: string;
  componentSetKey: string;
  cfigmaBin?: string;
}): Promise<InitScanResult> {
  const bin = opts.cfigmaBin ?? "cfigma";
  const code = `
const targetKey = ${JSON.stringify(opts.componentSetKey)};
// Skips traversal into hidden instance children — measured ~50% faster on
// large project files (35k → 31k INSTANCE nodes for danah's v2 Client).
figma.skipInvisibleInstanceChildren = true;
await figma.loadAllPagesAsync();
const stripPrefix = (id) => id.includes(';') ? id.substring(id.lastIndexOf(';') + 1) : id;
// Single full-tree pass — collect matching INSTANCEs once, then run both
// label and container detections off the same list.
const matches = [];
for (const page of figma.root.children) {
  for (const inst of page.findAllWithCriteria({ types: ['INSTANCE'] })) {
    const main = inst.mainComponent;
    if (!main) continue;
    let p = main; while (p && p.type !== 'COMPONENT_SET') p = p.parent;
    const key = (p && p.key) || (main && main.key);
    // Skip invisible / un-renderable matches:
    //   - inst.visible === false           → hidden by designer
    //   - any ancestor.visible === false   → hidden via parent
    //   - absoluteRenderBounds === null    → no rendered content (e.g.
    //                                        masked away, behind other
    //                                        clip, or outside its parent
    //                                        clip region)
    // cfigma's exportAsync returns a 1x1 placeholder for any of these,
    // which then fails measure with a dim mismatch.
    let visible = inst.visible !== false && inst.absoluteRenderBounds != null;
    if (visible) {
      let p = inst.parent;
      while (p) {
        if (p.visible === false) { visible = false; break; }
        p = p.parent;
      }
    }
    if (key === targetKey && visible) matches.push(inst);
  }
}
// ---- Label + nested-prop detection: walk DIRECT descendants only. ----
// Direct = owned by this instance, not bubbled up from a nested INSTANCE
// (those are properties of the nested kind, not this one).
const isOwn = (n, inst) => {
  let p = n.parent;
  while (p && p.id !== inst.id) {
    if (p.type === 'INSTANCE') return false;
    p = p.parent;
  }
  return true;
};
const perDesc = {};      // text layer name → { samples, overrideCount, ... }
const perNested = {};    // "<layerName>|<propKey>" → { samples, overrideCount, ... }
const usages = [];       // per-instance raw dump for case generation
for (const inst of matches) {
  // text descendants
  const texts = inst.findAllWithCriteria({ types: ['TEXT'] });
  const overriddenIds = new Set();
  for (const ov of (inst.overrides || [])) {
    if ((ov.overriddenFields || []).includes('characters')) overriddenIds.add(ov.id);
  }
  // Per-instance text override snapshot keyed by layer name (matches what
  // a generated propsFromFigma reads for the auto-detected label prop).
  const instTextOverrides = {};
  for (const t of texts) {
    if (!isOwn(t, inst)) continue;
    const descId = stripPrefix(t.id);
    const groupKey = t.name;
    if (!perDesc[groupKey]) perDesc[groupKey] = { descId, descName: t.name, hasOverride: false, overrideCount: 0, samples: [], instanceCount: 0, descIds: [] };
    perDesc[groupKey].instanceCount++;
    if (perDesc[groupKey].descIds.indexOf(descId) === -1) perDesc[groupKey].descIds.push(descId);
    // Always record the rendered characters. inst.overrides only flags
    // 'characters' when the LOCAL instance overrode it; nested instances
    // baked into a parent component master (e.g. Tabbar_legacy authoring
    // each inner TabItem with a real label) DON'T appear in inst.overrides
    // even though t.characters still reflects the parent-baked value.
    // init.ts diffs against defaults later — any trivial match is dropped.
    instTextOverrides[t.name] = t.characters;
    if (overriddenIds.has(t.id)) {
      perDesc[groupKey].hasOverride = true;
      perDesc[groupKey].overrideCount++;
    }
    if (perDesc[groupKey].samples.indexOf(t.characters) === -1) perDesc[groupKey].samples.push(t.characters);
  }
  // nested INSTANCE descendants — capture their componentProperties.
  // Counts are per-occurrence (each nested INSTANCE is one observation):
  // a Tab with 3 Tab_Item children counts as 3 toward "Tab_Item.Status"
  // instanceCount. The ratio overrideCount/instanceCount thus reflects
  // the fraction of nested-instance occurrences that diverge from master
  // default — what the 20% threshold actually means.
  const nesteds = inst.findAllWithCriteria({ types: ['INSTANCE'] });
  // Per-instance nested dump: { layerName: { propKey: value } } — only for
  // values that DIFFER from the nested master's default (matches what a
  // generated propsFromFigma reads via raw.nestedProps[layer][prop]).
  const instNested = {};
  for (const ni of nesteds) {
    if (!isOwn(ni, inst)) continue;
    const nm = ni.mainComponent;
    let np = nm; while (np && np.type !== 'COMPONENT_SET') np = np.parent;
    const nKey = (np && np.key) || (nm && nm.key) || null;
    const masterDefs = (np && np.componentPropertyDefinitions) || (nm && nm.componentPropertyDefinitions) || {};
    const cprops = ni.componentProperties || {};
    for (const [pk, pv] of Object.entries(cprops)) {
      const groupKey = ni.name + '|' + pk;
      if (!perNested[groupKey]) perNested[groupKey] = { layerName: ni.name, componentName: (np && np.name) || (nm && nm.name) || null, componentSetKey: nKey, propKey: pk, samples: [], instanceCount: 0, overrideCount: 0 };
      perNested[groupKey].instanceCount++;
      if (perNested[groupKey].samples.indexOf(pv.value) === -1) perNested[groupKey].samples.push(pv.value);
      const masterDefault = masterDefs[pk] && masterDefs[pk].defaultValue;
      if (pv.value !== masterDefault) {
        perNested[groupKey].overrideCount++;
        const layer = instNested[ni.name] = instNested[ni.name] || {};
        layer[pk] = pv.value;
      }
    }
  }
  const ipprops = {};
  for (const [k, v] of Object.entries(inst.componentProperties || {})) ipprops[k] = v.value;
  // Capture the master variant's intrinsic dim so init can detect when
  // a usage overrode the root sizing (instance.width != mainComponent.width
  // or similar) — only those usages need a dim-locking wrapper.
  const mc = inst.mainComponent;
  // Capture instance autolayout values + the master's, so init can diff
  // and emit explicit padding/gap props only when they were overridden
  // (most instances inherit master values, no override needed).
  const instLayout = {
    paddingTop: typeof inst.paddingTop === 'number' ? inst.paddingTop : null,
    paddingRight: typeof inst.paddingRight === 'number' ? inst.paddingRight : null,
    paddingBottom: typeof inst.paddingBottom === 'number' ? inst.paddingBottom : null,
    paddingLeft: typeof inst.paddingLeft === 'number' ? inst.paddingLeft : null,
    gap: typeof inst.itemSpacing === 'number' ? inst.itemSpacing : null,
  };
  const mainLayout = mc ? {
    paddingTop: typeof mc.paddingTop === 'number' ? mc.paddingTop : null,
    paddingRight: typeof mc.paddingRight === 'number' ? mc.paddingRight : null,
    paddingBottom: typeof mc.paddingBottom === 'number' ? mc.paddingBottom : null,
    paddingLeft: typeof mc.paddingLeft === 'number' ? mc.paddingLeft : null,
    gap: typeof mc.itemSpacing === 'number' ? mc.itemSpacing : null,
  } : null;
  // Resolved fill colors per overridden descendant. init checks if all
  // entries share one hex; if so the usage can flow through the fill prop.
  const fillOverrides = {};
  for (const ov of (inst.overrides || [])) {
    if (!Array.isArray(ov.overriddenFields) || ov.overriddenFields.indexOf('fills') < 0) continue;
    try {
      const node = await figma.getNodeByIdAsync(ov.id);
      if (!node || !Array.isArray(node.fills)) continue;
      const fill = node.fills.find(p => p && p.type === 'SOLID' && p.visible !== false);
      if (!fill) continue;
      const r = Math.round(fill.color.r * 255), g = Math.round(fill.color.g * 255), b = Math.round(fill.color.b * 255);
      const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
      const opacity = typeof fill.opacity === 'number' ? fill.opacity : 1;
      let ownerInstanceId = null;
      let ownerComponentSetKey = null;
      let p = node.parent;
      while (p && p.id !== inst.id) {
        if (p.type === 'INSTANCE') {
          ownerInstanceId = stripPrefix(p.id);
          const nm = p.mainComponent;
          let np = nm; while (np && np.type !== 'COMPONENT_SET') np = np.parent;
          ownerComponentSetKey = (np && np.key) || (nm && nm.key) || null;
          break;
        }
        p = p.parent;
      }
      fillOverrides[stripPrefix(ov.id)] = { hex, opacity, ownerInstanceId, ownerComponentSetKey };
    } catch (_) { /* best-effort */ }
  }
  const textStyleOverrides = {};
  for (const ov of (inst.overrides || [])) {
    if (!Array.isArray(ov.overriddenFields) || ov.overriddenFields.indexOf('textStyleId') < 0) continue;
    try {
      const node = await figma.getNodeByIdAsync(ov.id);
      if (!node || node.type !== 'TEXT' || !node.textStyleId) continue;
      textStyleOverrides[stripPrefix(ov.id)] = node.textStyleId;
    } catch (_) { /* best-effort */ }
  }
  usages.push({
    // Keep the full figma node id verbatim. For nested instances this is
    // I<parentInst>;<descId>, the form figma plugin getNodeByIdAsync /
    // exportAsync accepts. Stripping the prefix would collapse every
    // nested copy onto the same master id, breaking dedup.
    id: inst.id,
    name: inst.name,
    componentProperties: ipprops,
    textOverrides: instTextOverrides,
    nestedProps: instNested,
    // Per-instance override field list — init filters out instances whose
    // overrides aren't covered by the detected component props (the
    // "uncovered overrides → detach" rule). Each entry is a node id plus
    // the figma overriddenFields that diverge from master.
    overrides: (inst.overrides || []).map(o => ({
      id: o.id,
      fields: (o.overriddenFields || []).slice(),
    })),
    width: inst.width,
    height: inst.height,
    mainNodeId: (mc && mc.id) || null,
    // mainComponent.key — durable cross-file identifier of the master
    // VARIANT (one entry of the COMPONENT_SET). Required when an
    // instance lives in a consuming file and its mc.id is the local
    // library-copy proxy (not the library's own variant id) — bucketing
    // by id would fall through to '<unknown>'; bucketing by key matches.
    mainKey: (mc && mc.key) || null,
    mainWidth: (mc && mc.width) || null,
    mainHeight: (mc && mc.height) || null,
    layout: instLayout,
    mainLayout: mainLayout,
    fillOverrides: fillOverrides,
    textStyleOverrides: textStyleOverrides,
  });
}
// ---- Container detection: parents whose direct children are all INSTANCEs of one set. ----
const childVariations = [];
for (const inst of matches) {
  const kids = (inst.children || []).filter((c) => c.visible !== false);
  if (kids.length < 2) continue;
  if (kids.some((c) => c.type !== 'INSTANCE')) continue;
  let childKey = null, childSetName = null, childCompName = null;
  let consistent = true;
  for (const c of kids) {
    const cm = c.mainComponent;
    let cp = cm; while (cp && cp.type !== 'COMPONENT_SET') cp = cp.parent;
    const ck = (cp && cp.key) || (cm && cm.key);
    if (childKey === null) { childKey = ck; childSetName = cp ? cp.name : (cm && cm.name); childCompName = cm && cm.name; }
    else if (ck !== childKey) { consistent = false; break; }
  }
  if (!consistent || !childKey) continue;
  const childSnaps = [];
  // Container detection only needs to confirm the children are uniform
  // (same componentSet); per-key variation analysis is no longer used.
  // The parent forwards each child's hydrated props wholesale, so what
  // matters at codegen is the child's TS interface, not figma variation.
  for (const c of kids) {
    const cprops = {};
    for (const [k, v] of Object.entries(c.componentProperties || {})) cprops[k] = v.value;
    const tov = {};
    const cNested = {};
    for (const ov of (c.overrides || [])) {
      const fields = ov.overriddenFields || [];
      const t = await figma.getNodeByIdAsync(ov.id);
      if (!t) continue;
      if (t.type === 'TEXT' && fields.includes('characters')) {
        tov[t.name] = t.characters;
      } else if (t.type === 'INSTANCE' && fields.includes('componentProperties')) {
        const layer = cNested[t.name] = cNested[t.name] || {};
        for (const [pk, pv] of Object.entries(t.componentProperties || {})) layer[pk] = pv.value;
      }
    }
    childSnaps.push({ componentProperties: cprops, textOverrides: tov, nestedProps: cNested });
  }
  // Parent metadata so init can emit one case per real usage:
  // id (instance node id, stripped to a stable in-file ref), name (for
  // case naming), parent's own componentProperties (Tab.count/size etc),
  // and resolved dim. fileKey is attached at the per-tab wrapper layer
  // since this exec doesn't know which tab it's running in.
  const pprops = {};
  for (const [k, v] of Object.entries(inst.componentProperties || {})) pprops[k] = v.value;
  childVariations.push({
    parentId: stripPrefix(inst.id),
    parentName: inst.name,
    parentProps: pprops,
    parentWidth: inst.width,
    parentHeight: inst.height,
    childComponentSetKey: childKey,
    childComponentSetName: childSetName,
    childComponentName: childCompName,
    children: childSnaps,
  });
}
return { textSummaries: Object.values(perDesc), nestedPropSummaries: Object.values(perNested), childVariations, usages, totalInstances: matches.length };
`;
  const { stdout } = await execFileAsync(
    bin,
    ["--tab", opts.tabPattern, "exec", code],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return cleanControlValue(JSON.parse(stdout)) as InitScanResult;
}

/**
 * Scan ALL currently-open figma tabs in parallel. Returns merged label
 * summaries (deduped by descName across tabs) plus concatenated child
 * variations. Parallelization caps total time at the slowest single tab
 * instead of the sum.
 */
export async function scanAllOpenTabsForInit(opts: {
  componentSetKey: string;
  cfigmaBin?: string;
}): Promise<InitScanResult> {
  const tabs = await listFigmaTabs({ cfigmaBin: opts.cfigmaBin });
  const settled = await Promise.allSettled(
    tabs.map(async (tab) => {
      const r = await scanInstancesForInit({
        tabPattern: tab.key,
        componentSetKey: opts.componentSetKey,
        cfigmaBin: opts.cfigmaBin,
      });
      // Stamp source-file key on every per-tab artifact so downstream
      // case-emit knows which figma file owns each usage.
      for (const cv of r.childVariations) cv.parentFileKey = tab.key;
      for (const u of r.usages) u.fileKey = tab.key;
      return r;
    }),
  );
  const mergedTexts: Record<string, InstanceTextSummary> = {};
  const mergedNested: Record<string, NestedPropSummary> = {};
  const childVariations: ChildVariationSample[] = [];
  const usages: UsageInstance[] = [];
  let totalInstances = 0;
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    totalInstances += s.value.totalInstances;
    for (const row of s.value.textSummaries) {
      const key = row.descName;
      if (!mergedTexts[key]) {
        mergedTexts[key] = {
          ...row,
          samples: [...row.samples],
          descIds: [...(row.descIds ?? [row.descId])],
        };
        continue;
      }
      const dst = mergedTexts[key];
      dst.instanceCount += row.instanceCount;
      dst.overrideCount += row.overrideCount;
      if (row.hasOverride) dst.hasOverride = true;
      for (const v of row.samples)
        if (dst.samples.indexOf(v) === -1) dst.samples.push(v);
      for (const id of row.descIds ?? [row.descId])
        if (dst.descIds.indexOf(id) === -1) dst.descIds.push(id);
    }
    for (const row of s.value.nestedPropSummaries) {
      const key = row.layerName + "|" + row.propKey;
      if (!mergedNested[key]) {
        mergedNested[key] = { ...row, samples: [...row.samples] };
        continue;
      }
      const dst = mergedNested[key];
      dst.instanceCount += row.instanceCount;
      dst.overrideCount += row.overrideCount;
      for (const v of row.samples)
        if (dst.samples.indexOf(v) === -1) dst.samples.push(v);
    }
    childVariations.push(...s.value.childVariations);
    usages.push(...s.value.usages);
  }
  return {
    textSummaries: Object.values(mergedTexts),
    nestedPropSummaries: Object.values(mergedNested),
    childVariations,
    usages,
    totalInstances,
  };
}

/**
 * Walk up from a node to its containing PAGE and set `figma.currentPage` there.
 * cfigma export refuses cross-page selection, so we prep the page once before
 * exporting variant PNGs.
 */
export async function switchToPageContaining(opts: {
  tabPattern: string;
  nodeId: string;
  cfigmaBin?: string;
}): Promise<{ pageId: string; pageName: string } | null> {
  const bin = opts.cfigmaBin ?? "cfigma";
  const code = `
const target = ${JSON.stringify(opts.nodeId)};
await figma.loadAllPagesAsync();
const node = await figma.getNodeByIdAsync(target);
if (!node) return null;
let p = node;
while (p && p.type !== 'PAGE') p = p.parent;
if (!p) return null;
await figma.setCurrentPageAsync(p);
return { pageId: p.id, pageName: p.name };
`;
  const { stdout } = await execFileAsync(
    bin,
    ["--tab", opts.tabPattern, "exec", code],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout) as { pageId: string; pageName: string } | null;
}
