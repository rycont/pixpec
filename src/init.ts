/**
 * `pixpec init <componentId>` — scaffold a component directory from Figma.
 *
 * Reads `pixpec.toml` from cwd (or walks up). Fetches component metadata via
 * cfigma; auto-generates props type + cases from variants; exports each
 * component cases and runs a post-init capture/verify check.
 *
 * Files generated under `<componentsDir>/<Name>/`:
 *   impl.ts    — props interface + render stub (TODO body)
 *   cases.ts   — auto-filled from variants
 *   index.ts   — defineComponent
 *   .pixpec/   — capture and verify artifacts
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  fetchComponentMeta,
  listFigmaTabs,
  scanAllOpenTabsForInit,
  type FigmaComponentMeta,
  type FigmaExposedInstanceSchema,
  type FigmaPropertyDefinition,
  type FigmaPropValue,
  type FigmaVariantMeta,
  type ChildVariationSample,
  type UsageInstance,
} from "./cfigma-meta.ts";
import type { FigmaInstanceRaw } from "./types.ts";
import type { DNode } from "./compiler/design-ast.ts";
import type { DetachedUsageReport } from "./component-report.ts";
import type { NodeBindings } from "./compiler/registry.ts";
import {
  normalizeInstanceOverrides,
  unconsumedOverridesForProps,
} from "./compiler/props-context.ts";

export interface PixpecConfig {
  figmaFileId: string;
  /** Primary tab pattern — used by single-target capture/breakdown flows.
   * Equal to `tabPatterns[0]`. */
  tabPattern: string;
  /** All tab patterns the project may need to talk to. init walks this list
   * trying each until it finds the requested componentId (so a DS that
   * pulls masters from a separate library file can declare both). Falls
   * back to `[tabPattern]` for legacy single-tab toml. */
  tabPatterns: string[];
  /** Where component directories live. Default `src/components`. */
  componentsDir?: string;
  /** Destination compile/capture targets. */
  targets: string[];
  /** Override cfigma binary path. */
  cfigmaBin?: string;
  /** Default cfigma export scale. Default 2 (matches runner default). */
  scale?: number;
  /** cfigma bridge URL. Default http://127.0.0.1:9876. */
  bridge?: string;
  /** REM base in CSS px. Default 16 (matches CSS default html font-size).
   * Codegen emits all numeric figma-px values as `(value / remBase)rem`, so
   * a verify harness that scales html font-size by N× supersamples the
   * layout uniformly. Used to dodge Skia's dpr-dependent glyph advance:
   * scaling rem ×4 with dpr=2 yields 8× device-px-per-figma-unit (same as
   * dpr=8 supersample) but text advance is computed at dpr=2 precision. */
  remBase?: number;
}

/** Walk up from cwd until `pixpec.toml` is found. Exported for DS-side scripts. */
export async function loadConfig(start: string = process.cwd()): Promise<{
  cfg: PixpecConfig;
  root: string;
}> {
  let dir = resolve(start);
  while (true) {
    const p = join(dir, "pixpec.toml");
    if (existsSync(p)) {
      const raw = await readFile(p, "utf8");
      const parsed = parseToml(raw) as Record<string, unknown>;
      if (typeof parsed.figmaFileId !== "string")
        throw new Error(`${p}: missing figmaFileId`);
      // Accept either `tabPattern: string` (legacy single) or
      // `tabPatterns: string[]` (multi-tab projects pulling from a library).
      const tabPatterns: string[] = Array.isArray(parsed.tabPatterns)
        ? parsed.tabPatterns.filter((x): x is string => typeof x === "string")
        : typeof parsed.tabPattern === "string"
          ? [parsed.tabPattern]
          : [];
      if (tabPatterns.length === 0)
        throw new Error(`${p}: missing tabPattern (or tabPatterns array)`);
      const targets: string[] = Array.isArray(parsed.targets)
        ? parsed.targets.filter((x): x is string => typeof x === "string" && x.length > 0)
        : [];
      if (targets.length === 0)
        throw new Error(`${p}: missing targets array`);
      const cfg: PixpecConfig = {
        figmaFileId: parsed.figmaFileId,
        tabPattern: tabPatterns[0],
        tabPatterns,
        targets,
        componentsDir:
          typeof parsed.componentsDir === "string"
            ? parsed.componentsDir
            : "src/components",
        cfigmaBin:
          typeof parsed.cfigmaBin === "string" ? parsed.cfigmaBin : undefined,
        scale: typeof parsed.scale === "number" ? parsed.scale : 2,
        bridge: typeof parsed.bridge === "string" ? parsed.bridge : undefined,
        remBase: typeof parsed.remBase === "number" ? parsed.remBase : 16,
      };
      return { cfg, root: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("pixpec.toml not found (searched up from " + start + ")");
    }
    dir = parent;
  }
}

/** Make a filesystem-safe identifier from a Figma name. */
function sanitize(name: string): string {
  return (
    name
      .normalize("NFC")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/[\/\\]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/[^A-Za-z0-9._\-ᄀ-ᇿ㄰-㆏가-힯一-鿿]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_.]+|[_.]+$/g, "") || "unnamed"
  );
}

/** PascalCase the component name for TS identifiers. */
function pascalize(name: string): string {
  const s = sanitize(name);
  return (
    s
      .split(/[_\-]+/)
      .map((p) => (p.length > 0 ? p[0].toUpperCase() + p.slice(1) : ""))
      .join("") || "Component"
  );
}

function propName(name: string): string {
  // Preserve figma's prop name casing — figma stores VARIANT property names
  // like "Type" (PascalCase). We previously lowered the first letter for JS
  // camelCase, but that broke nested-instance binding emit: outer components
  // emitted `<Icon Type={iconType}/>` (figma case) while Icon's own
  // dispatcher read `props['type']` (lowered) → mismatch + always-default
  // fallback. Strip control chars + figma's `#…` suffix and collapse
  // non-alnum runs to nothing; keep the original capitalization.
  const stripped = name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/#[^#]*$/, "")
    .trim();
  const parts = stripped.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return "prop";
  const joined = parts.join("");
  // Avoid clobbering JSX `style` reserved-ish prop name on `<styled.*>`.
  return joined === "style" ? "styleVariant" : joined;
}

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

function normalizePropRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  const used = new Set<string>();
  for (const [rawName, value] of Object.entries(record)) {
    const base = propName(rawName);
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base}${i++}`;
    used.add(name);
    out[name] = cleanControlValue(value);
  }
  return out;
}

function normalizeMetaProps(meta: FigmaComponentMeta): FigmaComponentMeta {
  return {
    ...meta,
    propertyDefinitions: normalizePropRecord(meta.propertyDefinitions),
    variants: meta.variants.map((variant) => ({
      ...variant,
      propValues: normalizePropRecord(variant.propValues),
    })),
  };
}

function tsTypeForProp(def: FigmaPropertyDefinition): string {
  switch (def.type) {
    case "VARIANT":
      if (def.variantOptions && def.variantOptions.length > 0) {
        return def.variantOptions
          .map((v) => JSON.stringify(cleanControlValue(v)))
          .join(" | ");
      }
      return "string";
    case "TEXT":
      return "string";
    case "BOOLEAN":
      return "boolean";
    case "INSTANCE_SWAP":
      // ReactNode is the broad interpretation; user can narrow per-component.
      return "ReactNode";
  }
}

function definedVariantValues(values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string");
}

/** Mirror walker's `pixpecSetProp`: store each componentProperty value
 * under its full ("Status#1234:0"), short ("Status"), and camelCase
 * ("status") forms so a generated propsFromFigma can read whichever
 * form it picked. Used by init when it needs to build a scanned
 * instance without re-running the whole walker. */
function normalizeRawProps(
  componentProperties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(componentProperties)) {
    out[name] = value;
    const short = String(name).split("#")[0];
    if (!(short in out)) out[short] = value;
    const stripped = short.replace(/[\x00-\x1f\x7f]/g, "").trim();
    const parts = stripped.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (parts.length) {
      const camel =
        parts[0][0].toLowerCase() +
        parts[0].slice(1) +
        parts
          .slice(1)
          .map((p) => p[0].toUpperCase() + p.slice(1))
          .join("");
      if (!(camel in out)) out[camel] = value;
    }
  }
  return out;
}

function literalForValue(
  def: FigmaPropertyDefinition,
  value: FigmaPropValue,
): string {
  if (value === null || value === undefined) {
    if (def.type === "INSTANCE_SWAP") return "null /* TODO: <Icon/> ... */";
    if (def.type === "BOOLEAN") return "false";
    if (def.type === "TEXT") return '""';
    return '""';
  }
  if (def.type === "INSTANCE_SWAP") {
    const v = value as {
      mainComponentName?: string | null;
      mainComponentId?: string | null;
    };
    return `null /* TODO: replace with imported component (was Figma instance "${v.mainComponentName ?? "?"}" id=${v.mainComponentId ?? "?"}) */`;
  }
  if (def.type === "BOOLEAN") return value ? "true" : "false";
  return JSON.stringify(cleanControlValue(value));
}

function validateVariantPropValue(args: {
  componentName: string;
  propName: string;
  value: unknown;
  def: FigmaPropertyDefinition | undefined;
  figmaId: string;
  fileKey?: string;
  instanceName?: string;
  mainKey?: string | null;
}): void {
  if (args.def?.type !== "VARIANT" || typeof args.value !== "string") return;
  const options = args.def.variantOptions ?? [];
  if (options.includes(args.value)) return;
  throw new Error(
    [
      `pixpec init: stale remote component proxy detected for ${args.componentName}.${args.propName}`,
      `  value: ${JSON.stringify(args.value)}`,
      `  expected one of: ${options.map((v) => JSON.stringify(v)).join(", ")}`,
      `  usage: ${args.figmaId}`,
      args.fileKey ? `  fileKey: ${args.fileKey}` : null,
      args.instanceName ? `  layer: ${args.instanceName}` : null,
      args.mainKey ? `  mainVariantKey: ${args.mainKey}` : null,
      `Refresh/reload the consuming Figma file's remote component library before running init.`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
}

function variantKey(v: FigmaVariantMeta): string {
  // Prefer the Figma variant name (e.g. "size=md, state=default"); fall back to id.
  return sanitize(v.name) || v.id.replace(/:/g, "-");
}

/** Whether `name` is a bare JS identifier — emit unquoted when so. */
function isIdent(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function propsKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
}

function propAccess(root: string, key: string): string {
  return isIdent(key) ? `${root}.${key}` : `${root}[${JSON.stringify(key)}]`;
}

function optionalPropAccess(root: string, key: string): string {
  return isIdent(key) ? `${root}?.${key}` : `${root}?.[${JSON.stringify(key)}]`;
}

function objectShapeAccess(root: string, key: string): string {
  return isIdent(key)
    ? `${root}.shape.${key}`
    : `${root}.shape[${JSON.stringify(key)}]`;
}

/** Build TS field lines from a propertyDefinitions map (used both for the
 * top-level component interface and for each exposed nested-instance slot). */
function defsToFieldLines(
  defs: Record<string, FigmaPropertyDefinition>,
): string[] {
  return Object.entries(defs).map(([name, def]) => {
    const t = tsTypeForProp(def);
    const tag =
      def.type === "INSTANCE_SWAP"
        ? "  // INSTANCE_SWAP — narrow type if needed"
        : "";
    return `  ${propsKey(name)}?: ${t}${tag}`;
  });
}

/** A nested-instance slot's TS interface name, derived from componentSet name
 * (e.g. "Icon" → "ButtonFullRoundIconProps"). Falls back to the slot key if
 * there is no main component name. */
function nestedInterfaceName(
  componentName: string,
  slotKey: string,
  schema: FigmaExposedInstanceSchema,
): string {
  const base = schema.mainName
    ? pascalize(schema.mainName)
    : pascalize(slotKey);
  return `${componentName}${base}Props`;
}

function generateProps(
  componentName: string,
  defs: Record<string, FigmaPropertyDefinition>,
  nestedSchemas: Record<string, FigmaExposedInstanceSchema>,
  detectedItemsProp?: {
    propName: string;
    childComponentName: string;
    builtInstanceKeys: string[];
  },
  detectedNestedProps: Array<{
    propName: string;
    layerName: string;
    propKey: string;
    componentName?: string | null;
  }> = [],
): string {
  const nestedPropTypeByName = new Map<string, string>();
  const nestedPropImports = new Map<string, string>();
  for (const np of detectedNestedProps) {
    if (!np.componentName) continue;
    const childComponentName = np.componentName.replace(/[^A-Za-z0-9]/g, "");
    if (!childComponentName) continue;
    const childPropsName = `${childComponentName}Props`;
    nestedPropImports.set(
      childPropsName,
      `import type { ${childPropsName} } from '../${childComponentName}/props.ts'\n`,
    );
    nestedPropTypeByName.set(
      np.propName,
      `NonNullable<${childPropsName}[${JSON.stringify(np.propKey.replace(/#[^#]*$/, ""))}]>`,
    );
  }
  const ownLines = Object.entries(defs).map(([name, def]) => {
    const override = nestedPropTypeByName.get(name);
    const t = override ?? tsTypeForProp(def);
    const tag =
      def.type === "INSTANCE_SWAP"
        ? "  // INSTANCE_SWAP — narrow type if needed"
        : "";
    return `  ${propsKey(name)}?: ${t}${tag}`;
  });

  // Group nested slots by main componentSet key — slots referencing the
  // same DS component (e.g. left+right Icon) share one sub-interface.
  const interfaceByKey = new Map<
    string,
    { name: string; schema: FigmaExposedInstanceSchema; sampleSlot: string }
  >();
  const slotToInterfaceName: Record<string, string> = {};
  for (const [slotKey, schema] of Object.entries(nestedSchemas)) {
    const groupKey = schema.mainKey ?? slotKey; // ungrouped fallback
    if (!interfaceByKey.has(groupKey)) {
      const name = nestedInterfaceName(componentName, slotKey, schema);
      interfaceByKey.set(groupKey, { name, schema, sampleSlot: slotKey });
    }
    slotToInterfaceName[slotKey] = interfaceByKey.get(groupKey)!.name;
  }

  const nestedLines = Object.keys(nestedSchemas).map((slotKey) => {
    const ifaceName = slotToInterfaceName[slotKey];
    return `  ${propsKey(slotKey)}?: ${ifaceName}`;
  });

  const subInterfaceBlocks = [...interfaceByKey.values()].map(
    ({ name, schema }) => {
      const lines = defsToFieldLines(schema.propertyDefinitions);
      const sourceTag = schema.mainName ? ` (figma "${schema.mainName}")` : "";
      return `/** Exposed nested-instance slot${sourceTag}. */\nexport interface ${name} {\n${lines.join("\n") || "  // no properties"}\n}`;
    },
  );

  // Container pattern (auto-detected): props subset = the keys observed to
  // vary across same-kind sibling instances. Pulled FROM the child's
  // already-generated `<Child>Props` interface so types stay in sync —
  // `Pick<>` on the child means re-init of either component refreshes both.
  let containerImport = "";
  let containerLine = "";
  if (detectedItemsProp) {
    const camelChild = detectedItemsProp.childComponentName.replace(
      /[^A-Za-z0-9]/g,
      "",
    );
    const propsTypeName = `${camelChild}Props`;
    // Pick is computed bottom-up: init built each scanned child instance via
    // the child's own propsFromFigma and kept the keys whose values varied
    // across siblings. Re-init either side to refresh the surface.
    const keys = detectedItemsProp.builtInstanceKeys;
    containerImport = `import type { ${propsTypeName} } from '../${camelChild}/props.ts'\n`;
    containerLine = `  ${detectedItemsProp.propName}?: Array<Pick<${propsTypeName}, ${keys.map((k) => JSON.stringify(k)).join(" | ")}>>`;
  }

  const propLines = [
    ...ownLines,
    ...nestedLines,
    ...(containerLine ? [containerLine] : []),
  ].join("\n");
  const allDefs = [
    defs,
    ...[...interfaceByKey.values()].map((v) => v.schema.propertyDefinitions),
  ];
  const hasInstanceSwap = allDefs.some((d) =>
    Object.values(d).some((p) => p.type === "INSTANCE_SWAP"),
  );
  const reactNodeImport = hasInstanceSwap
    ? `import type { ReactNode } from 'react'\n`
    : "";
  const subBlock = subInterfaceBlocks.length
    ? `\n${subInterfaceBlocks.join("\n\n")}\n`
    : "";
  // Root props stay generic: every generated variant instantiates this
  // with the Panda prop type for its actual root component.
  const styledImport = `import type { BoxProps, FlexProps, StackProps } from '../../../styled-system/jsx'\n`;
  const headerImports = `${reactNodeImport}${containerImport}${[...nestedPropImports.values()].join("")}${styledImport}`;
  return `${headerImports}\n/**
 * AUTO-GENERATED from figma componentPropertyDefinitions for ${componentName}.
 * Re-run \`pixpec init\` to refresh after figma changes. Hand-edits here will
 * be overwritten — narrow types in impl.tsx instead.
 */
export interface ${componentName}OwnProps {
${propLines}
}
export type ${componentName}RootProps = BoxProps | FlexProps | StackProps
export type ${componentName}PixpecStyleProps = BoxProps
export type ${componentName}Props<TRootProps extends object = ${componentName}PixpecStyleProps> =
  ${componentName}OwnProps & TRootProps
${subBlock}`;
}

/**
 * Compose impl.tsx as a dispatcher over per-variant `Generated` FCs.
 * Routes by the VARIANT-typed figma props tuple. Non-VARIANT props (TEXT,
 * BOOLEAN, INSTANCE_SWAP) are forwarded through to the picked Generated.
 *
 * Re-init preserves a hand-edited impl.tsx (skipExisting), so this output
 * is just a useful baseline — users can replace it freely.
 */
function generateImpl(
  componentName: string,
  propertyDefinitions: Record<string, FigmaPropertyDefinition>,
  variants: Array<{
    propValues: Record<string, FigmaPropValue>;
    safeId: string;
  }>,
): string {
  const variantPropNames = Object.entries(propertyDefinitions)
    .filter(([, d]) => d.type === "VARIANT")
    .map(([n]) => n);
  const imports = variants
    .map(
      (v) =>
        `import { Generated as V_${v.safeId} } from './generated/${v.safeId}.tsx'`,
    )
    .join("\n");
  const buildKey = (pv: Record<string, FigmaPropValue>) =>
    variantPropNames.map((n) => `${n}=${String(pv[n])}`).join("|");
  const seenKeys = new Set<string>();
  const cases: string[] = [];
  for (const v of variants) {
    const k = buildKey(v.propValues);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    cases.push(
      `    ${JSON.stringify(k)}: V_${v.safeId},`,
    );
  }
  const fallback = variants[0]
    ? `V_${variants[0].safeId}`
    : "null";
  const keyExpr =
    variantPropNames.length === 0
      ? "''"
      : variantPropNames
          .map(
            (n) =>
              `\`${n}=\${String(mergedProps[${JSON.stringify(propsKey(n))}])}\``,
          )
          .join(" + '|' + ");
  return `import type { FC } from 'react'
import type { ${componentName}Props } from './props.ts'
import { defaults } from './defaults.ts'
${imports}

const VARIANTS: Record<string, FC<${componentName}Props>> = {
${cases.join("\n")}
}

/** Auto-generated dispatcher over per-variant Generated FCs. Replace this
 *  body to add behavior (refs, event handlers, runtime logic). */
export const impl: FC<${componentName}Props> = (props) => {
  const mergedProps: ${componentName}Props = { ...defaults, ...props }
  ${
    variantPropNames.length === 0
      ? `const Picked = ${fallback}`
      : `const key = ${keyExpr}\n  const Picked = VARIANTS[key] ?? ${fallback}`
  }
  return <Picked {...mergedProps} />
}

export type { ${componentName}Props }
`;
}

function generateDefaults(
  componentName: string,
  defs: Record<string, FigmaPropertyDefinition>,
): string {
  const entries = Object.entries(defs).filter(([, def]) => def.defaultValue !== undefined);
  const lines = entries.map(([name, def]) =>
    `  ${propsKey(name)}: ${literalForValue(def, def.defaultValue as FigmaPropValue)},`,
  );
  return `import type { ${componentName}Props } from './props.ts'

/** Defaults pulled from figma componentPropertyDefinitions[].defaultValue —
 * used by codegen as the "what you'd get without overriding" baseline so
 * generated JSX can elide redundant prop emissions on instance call sites. */
export const defaults: Partial<Pick<${componentName}Props, ${
    entries
      .map(([k]) => k)
      .map((k) => JSON.stringify(k))
      .join(" | ") || "never"
  }>> = {
${lines.join("\n")}
}
`;
}

/** A generated case row — used both for master variants (dim unknown,
 * fileKey = library file) and for real usage instances (with figma dim
 * and the consuming file's fileKey). `signature` is the dedup key. */
interface CaseRow {
  /** Combined `<fileKey>:<nodeId>` — the only addressable form Case
   * carries now (matches the `pixpec init` CLI form). */
  figmaId: string;
  /** True for variant-row entries (figma master nodes). Emit as
   * `isMainCase: true` so consumers can pick the bucket's master without
   * a second sweep through the variants list. */
  isMain?: boolean;
  /** For variant rows: the figma cross-file durable key — Variant.key in
   * the emitted cases.ts. For usage rows: the matching master variant's
   * key (= `inst.mainComponent.key`), used for bucketing under the
   * right variant without any per-file id translation. */
  variantKey?: string;
  /** For variant rows only: generated variant-local zod schema const. */
  schemaName?: string;
  /** For variant rows only: per-node bindings spec emitted as
   * `Variant.bindings` in cases.ts. generate threads this through the
   * walker so IR nodes get parametric annotations. */
  bindings?: Record<
      string,
      {
        node?: {
          content?: string;
          visible?: string;
          paint?: string;
          textStyle?: string;
        };
        component?: Record<string, string>;
      }
    >;
  /** Pre-rendered TS object literal (already-formatted prop entries
   * with `literalForValue`-friendly value forms). */
  propsLiteral: string;
  /** JSON.stringify of an order-stable {props, width, height} blob. Two
   * rows with the same signature collapse to one (the first wins). */
  signature: string;
  /** Platform-neutral render/capture context literal for this usecase. */
  renderLiteral?: string;
}

type DetectedNestedPropBinding = {
  propName: string;
  layerName: string;
  propKey: string;
  componentName?: string | null;
};

function buildVariantBindings(
  meta: FigmaComponentMeta,
  variant: FigmaVariantMeta,
  detectedLabelProp: { name: string } | undefined,
  detectedNestedProps: DetectedNestedPropBinding[],
  fillBindingsByVariantKey: Map<string, Set<string>>,
  textStyleBindingsByVariantKey: Map<string, Set<string>>,
): NodeBindings {
  const bindings: NodeBindings = {};
  if (variant.textNodes) {
    for (const tn of variant.textNodes) {
      if (!tn.propRef) continue;
      const propRefBare = tn.propRef.split("#")[0];
      const propKey = propName(propRefBare);
      if (!meta.propertyDefinitions[propRefBare]) continue;
      bindings[tn.id] = bindings[tn.id] ?? {};
      bindings[tn.id].node = {
        ...(bindings[tn.id].node ?? {}),
        content: propKey,
      };
    }
  }
  if (detectedLabelProp && variant.textNodes) {
    for (const tn of variant.textNodes) {
      if (tn.name !== detectedLabelProp.name) continue;
      bindings[tn.id] = bindings[tn.id] ?? {};
      bindings[tn.id].node = {
        ...(bindings[tn.id].node ?? {}),
        content: "label",
      };
    }
  }
  if (variant.nestedNodes) {
    for (const nn of variant.nestedNodes) {
      for (const np of detectedNestedProps) {
        if (nn.name !== np.layerName) continue;
        if (!(np.propKey in nn.props)) continue;
        bindings[nn.id] = bindings[nn.id] ?? {};
        bindings[nn.id].component = {
          ...(bindings[nn.id].component ?? {}),
          [propName(np.propKey)]: np.propName,
        };
      }
    }
  }
  if (variant.visibilityNodes) {
    for (const vn of variant.visibilityNodes) {
      const propKey = propName(vn.propRef);
      bindings[vn.id] = bindings[vn.id] ?? {};
      bindings[vn.id].node = {
        ...(bindings[vn.id].node ?? {}),
        visible: propKey,
      };
    }
  }
  const fillNodes = variant.key
    ? fillBindingsByVariantKey.get(variant.key)
    : undefined;
  if (fillNodes) {
    for (const nodeId of fillNodes) {
      bindings[nodeId] = bindings[nodeId] ?? {};
      bindings[nodeId].node = {
        ...(bindings[nodeId].node ?? {}),
        paint: "_fill",
      };
    }
  }
  const textStyleNodes = variant.key
    ? textStyleBindingsByVariantKey.get(variant.key)
    : undefined;
  if (textStyleNodes) {
    for (const nodeId of textStyleNodes) {
      bindings[nodeId] = bindings[nodeId] ?? {};
      bindings[nodeId].node = {
        ...(bindings[nodeId].node ?? {}),
        textStyle: "_textStyle",
      };
    }
  }
  return bindings;
}

function stableSignature(
  props: Record<string, unknown>,
  width?: number,
  height?: number,
): string {
  const sorted = Object.keys(props)
    .sort()
    .reduce<Record<string, unknown>>((a, k) => {
      a[k] = props[k];
      return a;
    }, {});
  return JSON.stringify({ p: sorted, w: width ?? null, h: height ?? null });
}

function generateCases(
  componentName: string,
  fileKey: string,
  meta: FigmaComponentMeta,
  schemaDefs: Record<string, FigmaPropertyDefinition>,
  usageRows: CaseRow[] = [],
  // Synthetic-prop hooks detected by usage scan — init injects each master
  // variant's actual TEXT chars / nested-INSTANCE values so master cases
  // render identically to figma's master node (otherwise impl falls back to
  // defaults that are sample-derived, not master-authored).
  detectedLabelProp?: { name: string },
  detectedNestedProps: Array<{
    propName: string;
    layerName: string;
    propKey: string;
    componentName?: string | null;
  }> = [],
  detectedItemsProp?: {
    propName: string;
    childComponentName: string;
    builtInstanceKeys: string[];
  },
  // Map of prop key → default value (built from augmentedDefs at the call
  // site). Variant rows drop fields equal to this map so the emitted
  // master case props stay slim — impl spreads `{...defaults, ...props}`
  // and recovers any dropped fields from defaults.ts.
  defaultsMap: Record<string, unknown> = {},
  fillBindingsByVariantKey: Map<string, Set<string>> = new Map(),
  textStyleBindingsByVariantKey: Map<string, Set<string>> = new Map(),
): string {
  const schemaForProp = (
    _name: string,
    def: FigmaPropertyDefinition,
  ): string => {
    if (def.type === "TEXT") return "z.string().optional()";
    if (def.type === "BOOLEAN") {
      return "z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]).optional()";
    }
    if (def.type === "INSTANCE_SWAP") return "z.undefined().optional()";
    const options = definedVariantValues(def.variantOptions ?? []).map(
      cleanControlValue,
    );
    if (options.length === 0) return "z.string().optional()";
    return `z.enum([${options
      .map((option) => JSON.stringify(option))
      .join(", ")}]).optional()`;
  };
  const schemaForField = (
    name: string,
    def: FigmaPropertyDefinition,
  ): string => {
    if (detectedNestedProps.some((nested) => nested.propName === name))
      return "z.unknown().optional()";
    return schemaForProp(name, def);
  };
  const schemaBody = `z.object({
${Object.entries(schemaDefs)
  .map(([name, def]) => `  ${propsKey(name)}: ${schemaForField(name, def)},`)
  .join("\n")}
})`;
  const propMappings = Object.entries(schemaDefs)
    .flatMap(([name, def]) => {
      const k = propsKey(name);
      if (name === "label" && detectedLabelProp) {
        const access = optionalPropAccess("raw.textOverrides", detectedLabelProp.name);
        return [`      ${k}: ${access},`];
      }
      const nested = detectedNestedProps.find((n) => n.propName === name);
      if (nested) {
        const access = `${optionalPropAccess("raw.nestedProps", nested.layerName)}?.${propsKey(nested.propKey)}`;
        return [`      ${k}: ${access},`];
      }
      if (def.type === "INSTANCE_SWAP") {
        return [
          `      ${k}: undefined, // INSTANCE_SWAP — wire to a React node lookup`,
        ];
      }
      return [];
    })
    .join("\n");
  let containerMapping = "";
  if (detectedItemsProp) {
    const pickFields = detectedItemsProp.builtInstanceKeys
      .map((k) => `${k}: c.props[${JSON.stringify(k)}]`)
      .join(", ");
    containerMapping = `\n      ${detectedItemsProp.propName}: (children ?? [])
      .filter((c) => c.kind === 'instance')
      .map((c) => ({ ${pickFields} })),`;
  }
  const hasPropMapping = propMappings.length > 0 || containerMapping.length > 0;
  const parseInput = hasPropMapping
    ? `{
      ...raw.props,
${propMappings}${containerMapping}
    }`
    : "raw.props";
  // Master variants live in the library file (`fileKey` arg); usage rows
  // already arrived with their own `figmaId` (per-tab fileKey baked in).
  const variantRows: CaseRow[] = meta.variants.map((v) => {
    // Build the full prop set first; emit only the diff vs defaults
    // (computed below from augmentedDefs). Mirrors usecase emit so case
    // props stay minimal across both layers.
    const allProps: Record<string, unknown> = { ...v.propValues };
    if (detectedLabelProp && v.textLayers) {
      const chars = v.textLayers[detectedLabelProp.name];
      if (chars !== undefined) allProps.label = chars;
    }
    for (const np of detectedNestedProps) {
      const val = v.nestedProps?.[np.layerName]?.[np.propKey];
      if (val !== undefined) allProps[np.propName] = val;
    }
    // Master layout is baked into the generated variant JSX itself. Emitting
    // the same values as case props only creates noisy Panda style-prop
    // overrides, especially for leaf components like Icon where all values
    // are commonly zero.
    // Drop fields whose value equals the default impl will spread.
    const slimProps: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(allProps)) {
      const defVal = defaultsMap[k] as unknown;
      if (
        defVal === undefined ||
        JSON.stringify(defVal) !== JSON.stringify(val)
      ) {
        slimProps[k] = val;
      }
    }
    const propEntries = Object.entries(slimProps).map(([name, value]) => {
      const def = schemaDefs[name] ?? meta.propertyDefinitions[name];
      if (!def) return `    ${name}: ${JSON.stringify(value)}`;
      return `    ${propsKey(name)}: ${literalForValue(def, value as FigmaPropValue)}`;
    });
    // Lock master variant case to its figma dim so platform renderers use
    // the same capture box as figma export.
    const hasRenderBounds =
      v.renderWidth != null &&
      v.renderHeight != null &&
      v.renderOffsetX != null &&
      v.renderOffsetY != null &&
      v.width != null &&
      v.height != null &&
      (Math.abs(v.renderWidth - v.width) > 0.5 ||
        Math.abs(v.renderHeight - v.height) > 0.5 ||
        Math.abs(v.renderOffsetX) > 0.5 ||
        Math.abs(v.renderOffsetY) > 0.5);
    const renderLiteral =
      v.width != null && v.height != null
        ? hasRenderBounds
          ? `{ box: { width: ${v.renderWidth}, height: ${v.renderHeight}, paddingLeft: ${v.renderOffsetX}, paddingTop: ${v.renderOffsetY}, overflow: 'visible' } }`
          : `{ box: { width: ${v.width}, height: ${v.height} } }`
        : undefined;
    const bindings = buildVariantBindings(
      meta,
      v,
      detectedLabelProp,
      detectedNestedProps,
      fillBindingsByVariantKey,
      textStyleBindingsByVariantKey,
    );
    return {
      figmaId: `${fileKey}:${v.id}`,
      variantKey: v.key,
      schemaName: `S_${`${fileKey}_${v.id}`.replace(/[^A-Za-z0-9]/g, "_")}`,
      propsLiteral: `{\n${propEntries.join(",\n")}\n    }`,
      bindings: Object.keys(bindings).length > 0 ? bindings : undefined,
      // Include w/h so two visually-identical masters with different dims
      // (e.g. Tab_Item Status=true at 96×64 vs same props at 132×64)
      // don't collapse to one variant.
      signature: stableSignature(allProps, v.width, v.height),
      renderLiteral,
      isMain: true,
    };
  });
  // Hierarchical model:
  //   variants — every master variant of this component. Each carries a
  //              nested `usecases` array of figma instance occurrences
  //              that map to it (instance.mainComponent.id === variant
  //              figmaId). breakdown + codegen iterate the variant level;
  //              usecases inside feed runtime data + optional regression.
  // Composition (impl synthesis) consumes the variant level, never the
  // nested usecases — those just describe how designers actually used
  // each variant.
  const dedup = (rows: CaseRow[]): CaseRow[] => {
    const seen = new Set<string>();
    return rows.filter((r) => {
      if (seen.has(r.signature)) return false;
      seen.add(r.signature);
      return true;
    });
  };
  // Variant is a pure key bucket — no figma id, no render data of its
  // own. The master figma node becomes ONE of the bucket's `usecases`
  // (the entry with isMainCase). Bucketing matches by figma's cross-file
  // durable variant key — usecase.variantKey === variant.key — so no
  // per-file id translation is ever needed.
  const allUsecases = dedup([...variantRows, ...usageRows]);
  const knownVariantKeys = new Set(
    variantRows.map((v) => v.variantKey).filter((k): k is string => !!k),
  );
  const usecasesByVariant = new Map<string, CaseRow[]>();
  for (const u of allUsecases) {
    const key =
      u.variantKey && knownVariantKeys.has(u.variantKey)
        ? u.variantKey
        : "<unknown>";
    if (!usecasesByVariant.has(key)) usecasesByVariant.set(key, []);
    usecasesByVariant.get(key)!.push(u);
  }
  const renderUsecase = (r: CaseRow) => {
    const render = r.renderLiteral
      ? `\n        render: ${r.renderLiteral},`
      : "";
    const main = r.isMain ? `\n        isMainCase: true,` : "";
    return `      {
        props: ${r.propsLiteral.replace(/\n/g, "\n    ")},
        figmaId: ${JSON.stringify(r.figmaId)},${render}${main}
      }`;
  };
  const variantByKey = new Map(
    variantRows.filter((v) => v.variantKey).map((v) => [v.variantKey!, v]),
  );
  const renderVariant = (variantKey: string) => {
    const variant = variantByKey.get(variantKey);
    const us = usecasesByVariant.get(variantKey) ?? [];
    const bindingsLit = variant?.bindings
      ? `\n    bindings: ${JSON.stringify(variant.bindings, null, 2).replace(/\n/g, "\n    ")},`
      : "";
    const schemaName = variant?.schemaName ?? "z.object({})";
    const parserLit = `\n    propsSchema: ${schemaName},\n    propsFromFigma: (raw, children) => ${schemaName}.parse(${parseInput.replace(/\n/g, "\n    ")}),`;
    return `  {
    key: ${JSON.stringify(variantKey)},${bindingsLit}${parserLit}
    usecases: [
${us.map(renderUsecase).join(",\n")},
    ],
  }`;
  };
  const variantKeys = variantRows
    .map((v) => v.variantKey)
    .filter((k): k is string => !!k);
  const schemaBlocks = variantRows
    .map((v) => `const ${v.schemaName} = ${schemaBody}`)
    .join("\n\n");
  return `import { z } from 'pixpec/spec'
import type { Variant } from 'pixpec/spec'
import type { ${componentName}Props } from './props.ts'

${schemaBlocks}

/** Master variants — what breakdown / codegen / verify iterate. Each
 *  carries a nested usecases array of figma instance occurrences that
 *  map to it (deduped by props+dim). impl is composed from the per-variant
 *  generated trees; usecases feed the runtime + optional regression. */
export const variants: Variant<${componentName}Props>[] = [
${variantKeys.map(renderVariant).join(",\n")},
]
`;
}

function generateIndex(
  componentName: string,
  componentSetKey: string | undefined,
  componentSetId: string | undefined,
  _defs: Record<string, FigmaPropertyDefinition>,
  _autoLabelLayerName?: string,
  _detectedItemsProp?: {
    propName: string;
    childComponentName: string;
    builtInstanceKeys: string[];
  },
  _detectedNestedProps: Array<{
    propName: string;
    layerName: string;
    propKey: string;
    componentName?: string | null;
  }> = [],
): string {
  const figmaBlock = componentSetKey
    ? `,
  figma: {
    componentSetKey: ${JSON.stringify(componentSetKey)},${componentSetId ? `\n    componentSetId: ${JSON.stringify(componentSetId)},` : ""}
  }`
    : "";
  return `import { defineComponent } from 'pixpec/spec'
import { variants } from './cases.ts'
import { defaults } from './defaults.ts'
import type { ${componentName}Props } from './props.ts'

export type { ${componentName}Props }
export { defaults }

export const ${componentName} = defineComponent<${componentName}Props>({
  name: ${JSON.stringify(componentName)},
  variants,
  defaults${figmaBlock},
})
`;
}

export interface InitResult {
  componentDir: string;
  componentName: string;
  variantCount: number;
  variantIds: string[];
}

export async function init(opts: {
  componentId: string;
  /** Override config root (otherwise walked up from cwd). */
  cwd?: string;
  /** Skip overwriting impl.tsx when it exists (preserves user code).
   * cases.ts / defaults.ts / index.ts are always rewritten — they mirror figma. */
  skipExisting?: boolean;
}): Promise<InitResult> {
  const { cfg, root } = await loadConfig(opts.cwd);
  // componentId MUST be `<fileKey>:<nodeId>` (e.g.
  // "XuZaMcO3FuA8B0GEZRYvLG:2128:1609"). Figma file keys are 20+
  // alphanumeric chars; node ids contain a colon. Splits on the FIRST
  // colon. Pinning on fileKey eliminates the ambiguous-tab guessing the
  // older bare-nodeId form required.
  const firstColon = opts.componentId.indexOf(":");
  const head = firstColon > 0 ? opts.componentId.slice(0, firstColon) : "";
  const nodeId = firstColon > 0 ? opts.componentId.slice(firstColon + 1) : "";
  if (!head || !nodeId.includes(":") || !/^[A-Za-z0-9]{20,}$/.test(head)) {
    throw new Error(
      `pixpec init: componentId must be in <fileKey>:<nodeId> form (e.g. "XuZaMcO3FuA8B0GEZRYvLG:2128:1609"). Got: ${opts.componentId}`,
    );
  }
  const explicitFileKey = head;
  const tabs = await listFigmaTabs({ cfigmaBin: cfg.cfigmaBin });
  const tab = tabs.find((t) => t.key === explicitFileKey);
  if (!tab)
    throw new Error(
      `pixpec init: no open figma tab matches fileKey ${explicitFileKey} (open tabs: ${tabs.map((t) => `${t.title} (${t.key})`).join(", ") || "<none>"})`,
    );
  const meta = await fetchComponentMeta({
    tabPattern: tab.key,
    componentId: nodeId,
    cfigmaBin: cfg.cfigmaBin,
  });
  const normalizedMeta = normalizeMetaProps(meta);
  const componentsDir = resolve(root, cfg.componentsDir ?? "src/components");
  const componentName = resolveComponentName(
    componentsDir,
    pascalize(normalizedMeta.name),
    normalizedMeta.key,
  );
  const componentDir = join(componentsDir, componentName);
  // Wipe any prior scaffolding so figma is the only source of truth on
  // re-init. impl.tsx is opt-in preserved via skipExisting; everything else
  // is regenerated.
  let preservedImpl: string | undefined;
  if (existsSync(componentDir)) {
    if (opts.skipExisting) {
      const implP = join(componentDir, "impl.tsx");
      if (existsSync(implP)) preservedImpl = await readFile(implP, "utf8");
    }
    await rm(componentDir, { recursive: true, force: true });
  }
  await mkdir(componentDir, { recursive: true });
  await mkdir(join(componentDir, "generated"), { recursive: true });

  const writeStub = async (
    p: string,
    body: string,
    preserved: string | undefined,
  ) => {
    await writeFile(p, preserved ?? body);
  };
  // Aggregate exposed-instance schemas across all variants. All variants
  // of the same component should agree on the slot name + main key (figma
  // requires this), so first-seen wins.
  const nestedSchemas: Record<string, FigmaExposedInstanceSchema> = {};
  for (const v of normalizedMeta.variants) {
    for (const [slotKey, schema] of Object.entries(v.exposedSchemas ?? {})) {
      if (!nestedSchemas[slotKey]) nestedSchemas[slotKey] = schema;
    }
  }

  // Auto-detect "the only descendant TEXT that varies across instance
  // usages" → expose as a `label` prop. Spares the design system author
  // from manually exposing TEXT properties in figma + plumbing
  // propsFromFigma. Scans every open figma tab so usages in any consuming
  // file count. Skipped silently when normalizedMeta.key is unset (no
  // ComponentSet → no instance fan-out to scan).
  // Single combined scan across all open tabs (parallel) — yields BOTH
  // label-detection summaries and child-variation samples in one pass.
  let detectedLabelProp: { name: string; sample: string } | undefined;
  let scanResult: import("./cfigma-meta.ts").InitScanResult | undefined;
  if (normalizedMeta.key) {
    try {
      const tScan = Date.now();
      scanResult = await scanAllOpenTabsForInit({
        componentSetKey: normalizedMeta.key,
        cfigmaBin: cfg.cfigmaBin,
      });
      console.log(
        `[init] instance scan complete (${Date.now() - tScan}ms): ${scanResult.textSummaries.length} text summaries, ${scanResult.childVariations.length} container parents`,
      );
      // 20% threshold: only expose when ≥20% of usages override the value.
      const THRESHOLD = 0.2;
      const total = scanResult.totalInstances || 1;
      const variable = scanResult.textSummaries.filter(
        (s) => s.overrideCount / total >= THRESHOLD,
      );
      if (variable.length === 1) {
        const v = variable[0];
        detectedLabelProp = { name: v.descName, sample: v.samples[0] };
        console.log(
          `[init] detected single-text override pattern (${v.overrideCount}/${total} = ${((v.overrideCount / total) * 100).toFixed(0)}%) → exposing as 'label' prop (layer name: ${JSON.stringify(v.descName)})`,
        );
      } else if (variable.length > 1) {
        console.log(
          `[init] ${variable.length} descendant texts cross 20% override threshold — ambiguous, no auto-prop`,
        );
      }
    } catch (e) {
      console.warn(`[init] instance scan failed: ${(e as Error).message}`);
    }
  }
  const { loadRegistry } = await import("./compiler/registry.ts");
  const componentRegistry = await loadRegistry(componentsDir);
  const childSupportsFill = (componentSetKey?: string | null): boolean => {
    if (!componentSetKey) return false;
    const entry = componentRegistry.get(componentSetKey);
    return Object.values(entry?.bindings ?? {}).some(
      (b) => b.node?.paint === "_fill",
    );
  };
  // Auto-expose nested INSTANCE component properties whose ≥20% of usages
  // override the master default. propsFromFigma reads them from
  // `raw.nestedProps[layerName][propKey]`. Prop name = camelCase of
  // `<layerName><PropKey>` (e.g. Icon's Type → `iconType`).
  type DetectedNestedProp = {
    /** TS prop name on the parent component. */
    propName: string;
    /** figma layer name of the nested INSTANCE (e.g. "Icon"). */
    layerName: string;
    /** Raw figma componentProperty key (e.g. "Type"). */
    propKey: string;
    /** Component name for the nested instance's component set. */
    componentName?: string | null;
    /** Distinct values seen across overrides. Used to emit a union TS type. */
    samples: unknown[];
  };
  const detectedNestedProps: DetectedNestedProp[] = [];
  if (scanResult && scanResult.totalInstances > 0) {
    const THRESHOLD = 0.2;
    // Skip nested-instance kinds already covered by the container pattern
    // (e.g. Tab.tabItems already exposes Tab_Item state — exposing
    // `tabItemStatus` on top is redundant). Container child layer names
    // come from sample[0].name → grab from childComponentSetName.
    const containerChildSetName =
      scanResult.childVariations.length > 0
        ? scanResult.childVariations[0].childComponentSetName
        : null;
    for (const ns of scanResult.nestedPropSummaries) {
      // Threshold against this nested kind's own occurrences (e.g. 47
      // Tabs × 3 Tab_Items = 141), not the parent count.
      if (
        ns.instanceCount === 0 ||
        ns.overrideCount / ns.instanceCount < THRESHOLD
      )
        continue;
      if (containerChildSetName && ns.layerName === containerChildSetName)
        continue;
      // camelCase: lowercase first of layer + camelCase of propKey.
      // Strip figma key suffix (`#2137:0`) before camelCase — those are
      // figma internal property ids, not part of the prop name.
      const cleanPropKey = ns.propKey.replace(/#[^#]*$/, "");
      const propName =
        (ns.layerName[0].toLowerCase() + ns.layerName.slice(1)).replace(
          /[^A-Za-z0-9]/g,
          "",
        ) +
        cleanPropKey
          .replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase())
          .replace(/^(.)/, (m) => m.toUpperCase());
      detectedNestedProps.push({
        propName,
        layerName: ns.layerName,
        propKey: ns.propKey,
        componentName: ns.componentName,
        samples: ns.samples,
      });
      console.log(
        `[init] detected nested override (${ns.overrideCount}/${ns.instanceCount} = ${((ns.overrideCount / ns.instanceCount) * 100).toFixed(0)}%) → exposing '${propName}' (nested ${ns.layerName}.${ns.propKey})`,
      );
    }
  }
  const fillValue = (entry: { hex: string; opacity: number }): string =>
    entry.opacity < 1
      ? `rgba(${parseInt(entry.hex.slice(1, 3), 16)}, ${parseInt(entry.hex.slice(3, 5), 16)}, ${parseInt(entry.hex.slice(5, 7), 16)}, ${entry.opacity})`
      : entry.hex;
  const singleFillValue = (u: {
    fillOverrides?: Record<string, { hex: string; opacity: number }>;
  }): string | undefined => {
    if (!u.fillOverrides) return undefined;
    const entries = Object.values(u.fillOverrides);
    if (entries.length === 0) return undefined;
    const first = entries[0];
    const allSame = entries.every(
      (e) => e.hex === first.hex && Math.abs(e.opacity - first.opacity) < 1e-3,
    );
    if (!allSame) return undefined;
    return fillValue(first);
  };
  let detectedFillProp: { sample: string } | undefined;
  if (scanResult && scanResult.totalInstances > 0) {
    const THRESHOLD = 0.2;
    const samples = scanResult.usages
      .map(singleFillValue)
      .filter((v): v is string => !!v);
    if (samples.length / scanResult.totalInstances >= THRESHOLD) {
      detectedFillProp = { sample: samples[0] };
      console.log(
        `[init] detected fill override pattern (${samples.length}/${scanResult.totalInstances} = ${((samples.length / scanResult.totalInstances) * 100).toFixed(0)}%) → exposing '_fill' prop`,
      );
    }
  }
  let typographyMap: Record<string, string> = {};
  try {
    typographyMap = JSON.parse(
      await readFile(
        resolve(componentsDir, "typography/figma-binding.json"),
        "utf8",
      ),
    );
  } catch {
    /* optional */
  }
  const lookupTextStyle = (liveId: string): string | undefined => {
    if (typographyMap[liveId]) return typographyMap[liveId];
    for (const k of Object.keys(typographyMap)) {
      if (liveId.startsWith(k) || k.startsWith(liveId)) return typographyMap[k];
    }
    return undefined;
  };
  const singleTextStyleValue = (
    u: Pick<UsageInstance, "textStyleOverrides">,
  ): string | undefined => {
    if (!u.textStyleOverrides) return undefined;
    const entries = Object.values(u.textStyleOverrides)
      .map(lookupTextStyle)
      .filter((v): v is string => !!v);
    if (entries.length === 0) return undefined;
    const first = entries[0];
    return entries.every((v) => v === first) ? first : undefined;
  };
  let detectedTextStyleProp: { sample: string } | undefined;
  if (scanResult) {
    const samples = scanResult.usages
      .map(singleTextStyleValue)
      .filter((v): v is string => !!v);
    if (samples.length > 0) {
      detectedTextStyleProp = { sample: samples[0] };
      console.log(
        `[init] detected textStyle override pattern (${samples.length}/${scanResult.totalInstances}) → exposing '_textStyle' prop`,
      );
    }
  }
  // Splice the synthetic 'label' definition onto the propertyDefinitions so
  // generateProps emits the prop alongside figma's own componentProperties.
  // Defaults for synthetic props (`label`, nested-derived `iconType` etc.)
  // come from the FIRST master variant's authored values — that's the
  // canonical "what figma renders when you drop the master in" baseline.
  // Falls back to samples[0] from the usage scan only if the master itself
  // doesn't carry the layer/nested-instance (rare; means the variant has
  // a different structure than the usages init was scanning).
  const masterVariant = normalizedMeta.variants[0] as
    | FigmaVariantMeta
    | undefined;
  const augmentedDefs: Record<string, FigmaPropertyDefinition> = {
    ...normalizedMeta.propertyDefinitions,
  };
  if (detectedLabelProp) {
    const masterChars = masterVariant?.textLayers?.[detectedLabelProp.name];
    augmentedDefs.label = {
      type: "TEXT",
      defaultValue: masterChars ?? detectedLabelProp.sample,
    };
  }
  if (detectedFillProp) {
    augmentedDefs._fill = {
      type: "TEXT",
      defaultValue: undefined as unknown as FigmaPropValue,
    };
  }
  if (detectedTextStyleProp) {
    augmentedDefs._textStyle = {
      type: "TEXT",
      defaultValue: "",
    };
  }
  for (const np of detectedNestedProps) {
    const masterVal = masterVariant?.nestedProps?.[np.layerName]?.[np.propKey];
    const variantOptions = np.samples.filter(
      (s): s is string => typeof s === "string",
    );
    if (typeof masterVal === "string" && !variantOptions.includes(masterVal)) {
      variantOptions.unshift(masterVal);
    }
    augmentedDefs[np.propName] = {
      type: "VARIANT",
      defaultValue: (masterVal ?? np.samples[0]) as FigmaPropValue,
      variantOptions,
    };
  }
  // padding/gap/width/height are no longer surfaced as explicit props —
  // every component now extends HTMLStyledProps<'div'>, so Panda CSS props
  // flow straight through to the Generated FC's outer container. Master
  // defaults already live inline in the per-variant Generated JSX, so
  // there's nothing to forward here.

  // ---- Detect "container of N same-kind children with varying props" ----
  // Scope (per user direction): only fire when ALL direct children of a
  // parent instance are INSTANCEs of one componentSet, AND at least one
  // componentProperty/text-override key varies across siblings within any
  // scanned parent. The varying keys + child component name become an
  // array prop on the parent (`<childName>s?: Array<{...}>`) plus a
  // generated propsFromFigma that walks `node.children` in codegen.
  // Container pattern is fully bottom-up: the child component must
  // already be init'd (its variants expose propsFromFigma, which knows how
  // to map its own raw → typed Props). Init dynamically imports the child,
  // builds each scanned child instance with the child's OWN propsFromFigma,
  // then diffs the resulting typed objects to find
  // which child props vary across usages. That set becomes the parent's
  // `Pick<ChildProps, ...>` — derived from built instance values, not from
  // figma raw keys, so child-only knowledge (label layer name, nested
  // Icon→iconType remap, etc.) flows up correctly.
  let detectedItemsProp:
    | undefined
    | {
        propName: string;
        childComponentName: string;
        childComponentSetKey: string;
        /** Built child-instance TS-prop keys whose values differ across at
         * least one sibling pair within a parent. These are the keys that
         * go into the parent's `Pick<ChildProps, ...>`. */
        builtInstanceKeys: string[];
      };
  // Captured so the post-detect case generator can reuse the same child
  // instance builder (no need to re-import) when building usage-based cases.
  let buildChildInstanceProps:
    | ((
        raw: FigmaInstanceRaw,
        children?: DNode[],
        variantKey?: string | null,
      ) => Record<string, unknown>)
    | undefined;
  if (normalizedMeta.key && scanResult) {
    try {
      const samples = scanResult.childVariations;
      const childKeys = new Set(
        samples.map((s) => s.childComponentSetKey).filter(Boolean) as string[],
      );
      if (samples.length > 0 && childKeys.size === 1) {
        const childKey = [...childKeys][0];
        const childRawName =
          samples[0].childComponentSetName ??
          samples[0].childComponentName ??
          "Child";
        const childComponentName = pascalize(childRawName);
        // Locate the already-init'd child dir and import its defineComponent.
        const childDir = join(componentsDir, childComponentName);
        const childIndex = join(childDir, "index.ts");
        let childMod: { [k: string]: unknown };
        try {
          const { pathToFileURL } = await import("node:url");
          childMod = (await import(pathToFileURL(childIndex).href)) as {
            [k: string]: unknown;
          };
        } catch (e) {
          throw new Error(
            `child component '${childComponentName}' must be init'd first ` +
              `(expected '${childIndex}'). Run \`pixpec init <fileKey>:${childKey}\` ` +
              `before initing this container. Underlying error: ${(e as Error).message}`,
          );
        }
        const childExport = childMod[childComponentName] as
          | {
              variants?: Array<{
                key?: string;
                propsFromFigma?: (
                  raw: FigmaInstanceRaw,
                  children?: DNode[],
                ) => Record<string, unknown>;
              }>;
            }
          | undefined;
        const childVariants = childExport?.variants ?? [];
        const firstParser = childVariants.find(
          (v) => typeof v.propsFromFigma === "function",
        )?.propsFromFigma;
        if (typeof firstParser !== "function") {
          throw new Error(
            `child '${childComponentName}' has no variant propsFromFigma — re-init it`,
          );
        }
        const propsFromFigma = (
          raw: FigmaInstanceRaw,
          children: DNode[] = [],
          variantKey?: string | null,
        ): Record<string, unknown> => {
          const parser =
            (variantKey
              ? childVariants.find((v) => v.key === variantKey)?.propsFromFigma
              : undefined) ?? firstParser;
          return parser(raw, children);
        };
        // Build every scanned child instance via the child's own
        // propsFromFigma, then diff per-parent. Aggregate varying keys
        // across all parents.
        const varyingBuiltInstanceKeys = new Set<string>();
        for (const s of samples) {
          if (s.children.length < 2) continue;
          const builtInstances = s.children.map((c) => {
            const raw: FigmaInstanceRaw = {
              id: "",
              name: "",
              mainComponentName: "",
              componentSetKey: childKey,
              props: normalizeRawProps(c.componentProperties) as Record<
                string,
                string | boolean
              >,
              exposed: [],
              textOverrides: c.textOverrides,
              nestedProps: c.nestedProps,
            };
            try {
              return propsFromFigma(raw, [], c.mainKey);
            } catch {
              return {};
            }
          });
          const allKeys = new Set<string>();
          for (const h of builtInstances)
            for (const k of Object.keys(h)) allKeys.add(k);
          for (const k of allKeys) {
            const vals = new Set(
              builtInstances.map((h) => JSON.stringify(h[k] ?? null)),
            );
            if (vals.size > 1) varyingBuiltInstanceKeys.add(k);
          }
        }
        if (varyingBuiltInstanceKeys.size > 0) {
          buildChildInstanceProps = propsFromFigma;
          const propName = (
            childComponentName[0].toLowerCase() +
            childComponentName.slice(1) +
            "s"
          ).replace(/[^A-Za-z0-9]/g, "");
          detectedItemsProp = {
            propName,
            childComponentName,
            childComponentSetKey: childKey,
            builtInstanceKeys: [...varyingBuiltInstanceKeys],
          };
          console.log(
            `[init] detected container pattern: ${samples.length} parent instance(s), ` +
              `all children are ${childComponentName} → exposing as ` +
              `'${propName}: Array<Pick<${childComponentName}Props, ${[...varyingBuiltInstanceKeys].join(" | ")}>>' ` +
              `(built via ${childComponentName}.propsFromFigma)`,
          );
        }
      }
    } catch (e) {
      console.warn(
        `[init] container-pattern scan failed: ${(e as Error).message}`,
      );
    }
  }
  // impl.tsx is generated AFTER variant codegen below — once we know every
  // variant's Generated FC exists, impl can dispatch to them. (Or preserved
  // from a prior run via skipExisting — user-customized impl wins.)
  // props.ts / cases.ts / defaults.ts / index.ts always rewritten — mirrors figma.
  // Format every emit with prettier so the output stays human-reviewable.
  const prettier = await import("prettier");
  const fmt = (src: string) =>
    prettier.format(src, {
      parser: "typescript",
      tabWidth: 4,
      semi: false,
      singleQuote: true,
      trailingComma: "all",
      printWidth: 100,
    });
  await writeFile(
    join(componentDir, "props.ts"),
    await fmt(
      generateProps(
        componentName,
        augmentedDefs,
        nestedSchemas,
        detectedItemsProp,
        detectedNestedProps,
      ),
    ),
  );
  // Usage-based cases — one row per real INSTANCE of this component
  // anywhere across the configured tabs. We replicate the same logic
  // init wrote into propsFromFigma (own componentProperties → camelCase,
  // auto-detected `label` from textOverrides[layerName], detected
  // nested-INSTANCE props from nestedProps[layer][propKey], and — when
  // the component is a container — `Pick<ChildProps>` items built
  // via the child's own propsFromFigma). Master variants + usages then
  // share a single dedup pass keyed by {props, width, height}.
  // Collect per-property unique values that arrive at runtime via prop
  // spread on Generated trees. panda's static extractor doesn't recognize
  // bare object literals in cases.ts, so without help it never emits CSS
  // rules for instance-only widths/paddings/etc. Init writes these into
  // tokens/panda-runtime-values.json keyed by component, and panda.config
  // re-feeds them into staticCss to force rule generation.
  const runtimeDims: Record<string, Set<string>> = {
    width: new Set(),
    height: new Set(),
    paddingTop: new Set(),
    paddingRight: new Set(),
    paddingBottom: new Set(),
    paddingLeft: new Set(),
    gap: new Set(),
    color: new Set(),
    textStyle: new Set(),
  };
  const addRemStatic = (
    prop: "width" | "height",
    value: number | undefined,
  ) => {
    if (value != null) runtimeDims[prop].add(`${+(value / 16).toFixed(6)}rem`);
  };
  for (const v of normalizedMeta.variants) {
    addRemStatic("width", v.width);
    addRemStatic("height", v.height);
  }
  const stripPrefix = (id: string) =>
    id.includes(";") ? id.substring(id.lastIndexOf(";") + 1) : id;
  const fillBindingsByVariantKey = new Map<string, Set<string>>();
  if (detectedFillProp && scanResult) {
    for (const u of scanResult.usages) {
      if (!u.mainKey || !u.fillOverrides || !singleFillValue(u)) continue;
      let nodes = fillBindingsByVariantKey.get(u.mainKey);
      if (!nodes) {
        nodes = new Set();
        fillBindingsByVariantKey.set(u.mainKey, nodes);
      }
      for (const [nodeId, entry] of Object.entries(u.fillOverrides)) {
        if (nodeId === u.id && u.mainNodeId) {
          nodes.add(stripPrefix(u.mainNodeId));
        } else if (entry.ownerInstanceId) {
          if (childSupportsFill(entry.ownerComponentSetKey))
            nodes.add(entry.ownerInstanceId);
        } else {
          nodes.add(nodeId);
        }
      }
    }
  }
  const textStyleBindingsByVariantKey = new Map<string, Set<string>>();
  if (detectedTextStyleProp && scanResult) {
    for (const u of scanResult.usages) {
      if (!u.mainKey || !u.textStyleOverrides || !singleTextStyleValue(u))
        continue;
      let nodes = textStyleBindingsByVariantKey.get(u.mainKey);
      if (!nodes) {
        nodes = new Set();
        textStyleBindingsByVariantKey.set(u.mainKey, nodes);
      }
      for (const nodeId of Object.keys(u.textStyleOverrides)) nodes.add(nodeId);
    }
  }
  const variantBindingsByKey = new Map<string, NodeBindings>();
  for (const v of normalizedMeta.variants) {
    if (!v.key) continue;
    variantBindingsByKey.set(
      v.key,
      buildVariantBindings(
        normalizedMeta,
        v,
        detectedLabelProp,
        detectedNestedProps,
        fillBindingsByVariantKey,
        textStyleBindingsByVariantKey,
      ),
    );
  }
  const usageRows: CaseRow[] = [];
  const detachedUsages: DetachedUsageReport[] = [];
  let droppedUnconsumed = 0;
  if (scanResult) {
    const ownPropKeys = Object.keys(normalizedMeta.propertyDefinitions);
    // Index containerVariations by parent id so non-container usages
    // skip the children walk (they have no container array prop).
    const containerByParentId = new Map<string, ChildVariationSample>();
    if (detectedItemsProp) {
      for (const s of scanResult.childVariations) {
        if (s.childComponentSetKey === detectedItemsProp.childComponentSetKey) {
          containerByParentId.set(s.parentId, s);
        }
      }
    }
    const sourceUsageById = new Map<string, UsageInstance>();
    for (const u of scanResult.usages) {
      if (!u.id.includes(";")) sourceUsageById.set(u.id, u);
    }
    for (const u of scanResult.usages) {
      const inheritedSourceUsage = u.id.includes(";")
        ? sourceUsageById.get(stripPrefix(u.id))
        : undefined;
      const rawProps = normalizeRawProps(u.componentProperties);
      const fullProps: Record<string, unknown> = {};
      for (const name of ownPropKeys) {
        const k = propsKey(name);
        // figma componentProperties — accept any of the key forms
        // normalizeRawProps populated.
        if (k in rawProps) fullProps[k] = rawProps[k];
        else if (name in rawProps) fullProps[k] = rawProps[name];
      }
      // Synthetic `label` prop: mirrors detectedNestedProps below — must
      // live OUTSIDE the ownPropKeys loop because the synthetic key is on
      // `augmentedDefs`, not on `normalizedMeta.propertyDefinitions`.
      // Reads u.textOverrides keyed by layer name to match propsFromFigma.
      if (detectedLabelProp) {
        const v = u.textOverrides[detectedLabelProp.name];
        if (v !== undefined) fullProps.label = v;
      }
      // Auto-detected nested INSTANCE props (e.g. iconType ← Icon.Type).
      for (const np of detectedNestedProps) {
        const v = u.nestedProps[np.layerName]?.[np.propKey];
        if (v !== undefined) fullProps[np.propName] = v;
      }
      // Container array prop — only for parents whose children matched
      // the container shape during scan. Non-container components and
      // container parents missing from the scan leave the field unset.
      if (detectedItemsProp && buildChildInstanceProps) {
        const cv = containerByParentId.get(u.id);
        if (cv) {
          const items = cv.children.map((c) => {
            const raw: FigmaInstanceRaw = {
              id: "",
              name: "",
              mainComponentName: "",
              componentSetKey: detectedItemsProp!.childComponentSetKey,
              props: normalizeRawProps(c.componentProperties) as Record<
                string,
                string | boolean
              >,
              exposed: [],
              textOverrides: c.textOverrides,
              nestedProps: c.nestedProps,
            };
            let builtInstance: Record<string, unknown> = {};
            try {
              builtInstance = buildChildInstanceProps!(raw, [], c.mainKey);
            } catch {
              /* skip */
            }
            const picked: Record<string, unknown> = {};
            for (const k of detectedItemsProp!.builtInstanceKeys)
              picked[k] = builtInstance[k];
            return picked;
          });
          fullProps[detectedItemsProp.propName] = items;
        }
      }
      // `_fill` is a synthetic prop produced only when this component's own
      // usages crossed the fill-override threshold. It is intentionally not
      // the public Panda `color` prop: it represents Figma `fills`.
      if (detectedFillProp) {
        const v = singleFillValue(u);
        if (v !== undefined) fullProps._fill = v;
      }
      if (detectedTextStyleProp) {
        const v = singleTextStyleValue(u);
        if (v !== undefined) fullProps._textStyle = v;
      }
      // Layout overrides: figma instances can override paddingTop/Right/
      // Bottom/Left/itemSpacing on the root frame WITHOUT detaching. The
      // generated variant JSX already bakes the master layout, so emit only
      // values that differ from the usage's main component.
      const layoutKeys = [
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "gap",
      ] as const;
      for (const k of layoutKeys) {
        const inst = u.layout[k];
        const main = u.mainLayout?.[k] ?? null;
        if (inst != null && main != null && Math.abs(inst - main) > 0.01) {
          fullProps[k] = `${+(inst / 16).toFixed(6)}rem`;
        }
      }
      // Width/height override: figma `overrides` reports width/height/
      // sizingMode when designer resized the instance. Emit when actual
      // dim diverges from master so impl can lock the root box. Goes
      // through the same diff-vs-defaults pass below.
      if (u.mainWidth != null && Math.abs(u.width - u.mainWidth) > 0.5) {
        fullProps.width = `${+(u.width / 16).toFixed(6)}rem`;
      }
      if (u.mainHeight != null && Math.abs(u.height - u.mainHeight) > 0.5) {
        fullProps.height = `${+(u.height / 16).toFixed(6)}rem`;
      }
      if (
        typeof u.scaleFactor === "number" &&
        Number.isFinite(u.scaleFactor) &&
        Math.abs(u.scaleFactor - 1) > 0.001
      ) {
        detachedUsages.push({
          figmaId: `${u.fileKey ?? explicitFileKey}:${u.id}`,
          reason: `scaled component instance (scaleFactor=${+u.scaleFactor.toFixed(6)})`,
          fields: ["scaleFactor"],
          targets: [{ nodeId: u.id, fields: ["scaleFactor"] }],
        });
        droppedUnconsumed++;
        continue;
      }
      const variantBindings = u.mainKey
        ? variantBindingsByKey.get(u.mainKey)
        : undefined;
      if (variantBindings) {
        const rawForConsumption: FigmaInstanceRaw = {
          id: u.id,
          name: u.name,
          mainComponentName: "",
          componentSetKey: normalizedMeta.key ?? "",
          props: rawProps as Record<string, string | boolean>,
          exposed: [],
          textOverrides: u.textOverrides,
          nestedProps: u.nestedProps,
          width: u.width,
          height: u.height,
          mainWidth: u.mainWidth ?? undefined,
          mainHeight: u.mainHeight ?? undefined,
        };
        const mergedFillOverrides = {
          ...(inheritedSourceUsage?.fillOverrides ?? {}),
          ...(u.fillOverrides ?? {}),
        };
        const rawOverridesForConsumption = [
          ...(inheritedSourceUsage?.overrides ?? []),
          ...(u.overrides ?? []),
          ...Object.keys(mergedFillOverrides).map((id) => ({
            id,
            fields: ["fills"],
          })),
        ];
        rawForConsumption.overrides = normalizeInstanceOverrides(
          rawForConsumption,
          u.id,
          rawOverridesForConsumption,
        );
        const unconsumed = unconsumedOverridesForProps(
          rawForConsumption,
          fullProps,
          variantBindings,
        );
        if (unconsumed.length > 0) {
          detachedUsages.push({
            figmaId: `${u.fileKey ?? explicitFileKey}:${u.id}`,
            reason: "unconsumed override outside built component props",
            fields: [...new Set(unconsumed.flatMap((ov) => ov.fields))].sort(),
            targets: unconsumed
              .map((ov) => ({ nodeId: ov.nodeId, fields: ov.fields }))
              .sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
          });
          droppedUnconsumed++;
          continue;
        }
      }
      // Diff against defaults — drop fields whose value matches the
      // default that defaults.ts emits + impl spreads via `{...defaults,
      // ...props}`. Keeps the per-usecase prop set minimal (the typical
      // usecase only changes label / iconType / a stretched dim).
      const slimProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fullProps)) {
        const defVal = augmentedDefs[k]?.defaultValue as unknown;
        if (
          defVal === undefined ||
          JSON.stringify(defVal) !== JSON.stringify(v)
        ) {
          const def = augmentedDefs[k];
          validateVariantPropValue({
            componentName,
            propName: k,
            value: v,
            def,
            figmaId: `${u.fileKey ?? explicitFileKey}:${u.id}`,
            fileKey: u.fileKey,
            instanceName: u.name,
            mainKey: u.mainKey,
          });
          slimProps[k] = v;
        }
      }
      const lit = JSON.stringify(slimProps, null, 2)
        .split("\n")
        .map((l, i) => (i === 0 ? l : "    " + l))
        .join("\n");
      // Dim-locking render box only for usages whose root sizing diverges
      // from the master — i.e. designer expanded/shrank the instance
      // beyond hug-content. Skipping when dim matches master keeps the
      // emitted file slim (most cases) and lets impl's natural layout drive.
      const dimOverridden =
        u.mainWidth != null &&
        u.mainHeight != null &&
        (Math.abs(u.width - u.mainWidth) > 0.5 ||
          Math.abs(u.height - u.mainHeight) > 0.5);
      const renderLiteral = dimOverridden
        ? `{ box: { width: ${u.width}, height: ${u.height} } }`
        : undefined;
      // Stash any concrete value for panda staticCss (see runtimeDims init).
      // Skip pure keyword tokens (none, transparent, currentColor) — those
      // resolve via Panda's preset utilities; concrete colors/dims need a
      // generated arbitrary-value class. NB: hex like `#ffffff` has no digit
      // so a `/[0-9]/` filter would reject it.
      const stashable = (s: string): boolean =>
        s.startsWith("#") || s.startsWith("rgb") || /[0-9]/.test(s);
      for (const k of Object.keys(runtimeDims)) {
        const v = fullProps[k];
        if (typeof v === "string" && (k === "textStyle" || stashable(v)))
          runtimeDims[k].add(v);
      }
      if (typeof fullProps._textStyle === "string" && fullProps._textStyle) {
        runtimeDims.textStyle.add(fullProps._textStyle);
      }
      usageRows.push({
        figmaId: `${u.fileKey ?? explicitFileKey}:${u.id}`,
        // Master variant key (cross-file durable). All Variant lookups
        // happen on this — no per-file id translation needed.
        variantKey: u.mainKey ?? undefined,
        propsLiteral: lit,
        signature: stableSignature(fullProps, u.width, u.height),
        renderLiteral,
      });
    }
    console.log(
      `[init] usage-based cases: ${usageRows.length} usage(s) built (pre-dedup)`,
    );
    if (droppedUnconsumed > 0) {
      console.log(
        `[init] detached ${droppedUnconsumed} usage(s) with overrides not consumed by built props`,
      );
    }
  }
  await writeFile(
    join(componentDir, "cases.ts"),
    await fmt(
      generateCases(
        componentName,
        explicitFileKey,
        normalizedMeta,
        augmentedDefs,
        usageRows,
        detectedLabelProp,
        detectedNestedProps,
        detectedItemsProp,
        // Map for diff-vs-default trimming. Pulled from augmentedDefs so
        // variant + usecase emit both reference the same baseline that
        // defaults.ts itself emits.
        Object.fromEntries(
          Object.entries(augmentedDefs).map(([k, d]) => [k, d.defaultValue]),
        ),
        fillBindingsByVariantKey,
        textStyleBindingsByVariantKey,
      ),
    ),
  );
  // panda staticCss feeder — one file per component, co-located so re-init
  // replaces just this component's slice. panda.config globs every
  // `static-tokens.json` under componentsDir and merges. Without this,
  // runtime spreads (`<Flex {...rest}>`) hit panda's static extractor as
  // bare object literals → no CSS rule emitted → Flex collapses to its
  // hardcoded master width.
  {
    const tokensPath = join(componentDir, "static-tokens.json");
    const payload = Object.fromEntries(
      Object.entries(runtimeDims).map(([k, s]) => [k, [...s].sort()]),
    );
    await writeFile(tokensPath, JSON.stringify(payload, null, 2) + "\n");
  }
  await writeFile(
    join(componentDir, "defaults.ts"),
    await fmt(generateDefaults(componentName, augmentedDefs)),
  );
  await writeFile(
    join(componentDir, "index.ts"),
    await fmt(
      generateIndex(
        componentName,
        normalizedMeta.key,
        normalizedMeta.id,
        augmentedDefs,
        detectedLabelProp?.name,
        detectedItemsProp,
        detectedNestedProps,
      ),
    ),
  );
  // master-snapshot.json — raw figma dump of each master variant. The
  // compiler reads this off disk to (a) compare instance overrides for
  // detach decisions and (b) supply variant context to target codegen
  // without going back to figma. Keyed by variant.key (cross-file
  // durable id). Skipped silently when the dumper isn't available
  // (offline scenarios — registry just falls back to empty snapshots).
  try {
    const { dump } = await import("./dumper/index.ts");
    const snapshot: Record<string, unknown> = {};
    for (const v of normalizedMeta.variants) {
      if (!v.key) continue;
      try {
        snapshot[v.key] = await dump({
          cfigmaBin: cfg.cfigmaBin ?? "cfigma",
          tab: tab.key,
          nodeId: v.id,
        });
      } catch (e) {
        console.warn(
          `[init] master-snapshot dump failed for variant ${v.id} (${v.name}): ${(e as Error).message}`,
        );
      }
    }
    await writeFile(
      join(componentDir, "master-snapshot.json"),
      JSON.stringify(snapshot, null, 2) + "\n",
    );
  } catch (e) {
    console.warn(`[init] master-snapshot disabled: ${(e as Error).message}`);
  }
  // Auto-run codegen for every variant — produces generated/<safeId>.tsx
  // so the component is immediately ready to compose. Fail fast: if any
  // variant errors (e.g. references an unregistered nested component),
  // abort so the user fixes the dependency before re-running init.
  const { runGenerateTargets } = await import("./generate.ts");
  const generatedVariants: Array<{
    propValues: Record<string, FigmaPropValue>;
    safeId: string;
  }> = [];
  for (const v of normalizedMeta.variants) {
    try {
      const propKeys = [
        ...Object.keys(augmentedDefs),
        ...Object.keys(nestedSchemas),
        ...(detectedItemsProp ? [detectedItemsProp.propName] : []),
      ];
      const results = await runGenerateTargets(`${explicitFileKey}:${v.id}`, {
        componentName,
        propKeys,
      });
      for (const r of results) {
        console.log(`[init] generated ${componentName}/${v.name} [${r.target}] → ${r.outPath}`);
      }
      const safeId = `${explicitFileKey}_${v.id}`.replace(/[^A-Za-z0-9]/g, "_");
      generatedVariants.push({ propValues: v.propValues, safeId });
    } catch (e) {
      throw new Error(
        `[init] codegen failed for variant ${v.id} (${v.name}): ${(e as Error).message}`,
      );
    }
  }
  // Now write impl.tsx — every variant's Generated FC exists, so the
  // dispatcher can route by VARIANT-prop tuple. Preserves an existing
  // impl.tsx so user customizations survive re-init.
  await writeStub(
    join(componentDir, "impl.tsx"),
    await fmt(
      generateImpl(
        componentName,
        normalizedMeta.propertyDefinitions,
        generatedVariants,
      ),
    ),
    preservedImpl,
  );
  {
    const componentMod = (await import(resolve(componentDir, "index.ts"))) as Record<string, unknown>;
    const component = componentMod[componentName];
    if (component && typeof component === "object" && Array.isArray((component as { variants?: unknown }).variants)) {
      const { writeComponentReport } = await import("./component-report.ts");
      await writeComponentReport({
        componentName,
        componentDir,
        component: component as never,
        targets: cfg.targets,
        detachedUsages,
      });
    }
  }
  if (process.env.PIXPEC_SKIP_INIT_VERIFY === "1") {
    return {
      componentDir,
      componentName,
      variantCount: normalizedMeta.variants.length,
      variantIds: normalizedMeta.variants.map((v) => v.id),
    };
  }
  // Verification step — capture target output and pixel-compare against
  // the figma source export. This is a post-init health
  // check, not part of the generator transaction: init must still leave the
  // freshly generated component on disk when visual verification trips on a
  // screenshot/runtime edge case.
  console.log(`[init] verifying ${componentName} against figma…`);
  try {
    const { runVerify } = await import("./verify.ts");
    const vr = await runVerify(componentName);
    if (vr.fail > 0) {
      console.warn(
        `[init] ${componentName}: ${vr.fail}/${vr.total} usecase(s) failed pixel verify. ` +
          `Failed: ${vr.failed.slice(0, 5).join(", ")}${vr.failed.length > 5 ? ` (+${vr.failed.length - 5} more)` : ""}. ` +
          `Inspect ${componentDir}/.pixpec/verify/ for diffs.`,
      );
    } else {
      console.log(
        `[init] ✓ ${componentName} verified (${vr.pass}/${vr.total} usecases pass)`,
      );
    }
  } catch (e) {
    console.warn(
      `[init] ${componentName}: post-init visual verify failed after generation: ${(e as Error).message}. ` +
        `Run \`pixpec verify ${componentName}\` after fixing the render issue.`,
    );
  }
  return {
    componentDir,
    componentName,
    variantCount: normalizedMeta.variants.length,
    variantIds: normalizedMeta.variants.map((v) => v.id),
  };
}

function resolveComponentName(
  componentsDir: string,
  baseName: string,
  componentSetKey?: string,
): string {
  const existingKey = readExistingComponentSetKey(
    join(componentsDir, baseName),
  );
  if (!existingKey || existingKey === componentSetKey) return baseName;
  const suffix =
    (componentSetKey ?? "unknown").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) ||
    "unknown";
  let candidate = `${baseName}_${suffix}`;
  let i = 2;
  while (true) {
    const key = readExistingComponentSetKey(join(componentsDir, candidate));
    if (!key || key === componentSetKey) return candidate;
    candidate = `${baseName}_${suffix}_${i++}`;
  }
}

function readExistingComponentSetKey(componentDir: string): string | undefined {
  const indexPath = join(componentDir, "index.ts");
  if (!existsSync(indexPath)) return undefined;
  try {
    const src = readFileSync(indexPath, "utf8");
    const match = src.match(/componentSetKey:\s*['"]([^'"]+)['"]/);
    return match?.[1];
  } catch {
    return undefined;
  }
}
