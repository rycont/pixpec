/**
 * `pixpec init <fileKey>:<nodeId>`
 *
 * Init is intentionally small:
 *   1. collect master variants and real usecases
 *   2. compile them to Pixpec IR
 *   3. promote IR fields that vary in at least 20% of usecases
 *   4. emit component files
 *
 * Figma/raw knowledge stays in dumper/compiler. Init reasons over component
 * props, exposed instances, and DNode fields.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { listFigmaTabs, scanAllOpenTabsForInit } from "./cfigma-meta.ts";
import { dump } from "./dumper/index.ts";
import type { RawNode } from "./dumper/raw-node.ts";
import {
  compile,
  compileComponentPropDefs,
  compileComponentRefDefaults,
  compileVariantProps,
  loadRegistry,
  rawComponentPropValues,
  rawComponentPropsForVariant,
} from "./compiler/index.ts";
import {
  NodeKind,
  type DataScopeEntry,
  type DInstance,
  type DNode,
} from "./compiler/design-ast.ts";
import type { ComponentPropDef as PropDef } from "./compiler/component-props.ts";
import { indexDNodeClasses, materializeDNode } from "./compiler/nodes/index.ts";
import type { DNodeClass } from "./compiler/nodes/index.ts";
import { DesignAstTypeTransformer } from "./compiler/type-transformer.ts";
import type { CaseRenderSpec, RenderBoxSpec } from "./types.ts";

export interface PixpecConfig {
  figmaFileId: string;
  tabPattern: string;
  tabPatterns: string[];
  componentsDir?: string;
  targets: string[];
  cfigmaBin?: string;
  scale?: number;
  bridge?: string;
  remBase?: number;
}

export interface InitResult {
  componentName: string;
  componentDir: string;
  variantCount: number;
}

interface VariantSource {
  id: string;
  key?: string;
  name: string;
  props: Record<string, unknown>;
  raw: RawNode;
  ir: DNode;
  render?: CaseRenderSpec;
}

interface UsecaseSource {
  figmaId: string;
  variantKey?: string | null;
  raw: RawNode;
  ir: DNode;
  render?: CaseRenderSpec;
}

interface ExposedSlot {
  prop: string;
  sourceId: string;
  componentName: string;
}

interface PromotedField {
  prop: string;
  nodeId: string;
  field: string;
  valueType: string;
  componentName?: string;
}

const STATIC_CSS_PROPERTIES = [
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "gap",
  "rowGap",
  "columnGap",
  "color",
  "background",
  "backgroundColor",
  "textStyle",
] as const;

type StaticCssProperty = (typeof STATIC_CSS_PROPERTIES)[number];
type StaticTokenMap = Record<StaticCssProperty, Set<string>>;
type CompileDesignContext = {
  tokenMap: Record<string, string>;
  tokenValueMap: Record<string, number>;
  tokenColorMap: Record<string, string>;
  typographyMap: Record<string, string>;
};

export async function loadConfig(start: string = process.cwd()): Promise<{
  cfg: PixpecConfig;
  root: string;
}> {
  let dir = resolve(start);
  while (true) {
    const p = join(dir, "pixpec.toml");
    if (existsSync(p)) {
      const parsed = parseToml(await readFile(p, "utf8")) as Record<
        string,
        unknown
      >;
      if (typeof parsed.figmaFileId !== "string")
        throw new Error(`${p}: missing figmaFileId`);
      const tabPatterns = Array.isArray(parsed.tabPatterns)
        ? parsed.tabPatterns.filter((x): x is string => typeof x === "string")
        : typeof parsed.tabPattern === "string"
          ? [parsed.tabPattern]
          : [];
      if (tabPatterns.length === 0)
        throw new Error(`${p}: missing tabPattern (or tabPatterns array)`);
      const targets = Array.isArray(parsed.targets)
        ? parsed.targets.filter(
            (x): x is string => typeof x === "string" && x.length > 0,
          )
        : [];
      if (targets.length === 0) throw new Error(`${p}: missing targets array`);
      return {
        root: dir,
        cfg: {
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
        },
      };
    }
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(`pixpec.toml not found (searched up from ${start})`);
    dir = parent;
  }
}

export async function init(opts: {
  componentId: string;
  cwd?: string;
  skipExisting?: boolean;
  skipVerify?: boolean;
}): Promise<InitResult> {
  const { cfg, root } = await loadConfig(opts.cwd);
  const { fileKey, nodeId } = parseComponentId(opts.componentId);
  const componentsDir = resolve(root, cfg.componentsDir ?? "src/components");
  const tabs = await listFigmaTabs({ cfigmaBin: cfg.cfigmaBin });
  const tab = tabs.find((t) => t.key === fileKey);
  if (!tab)
    throw new Error(
      `pixpec init: no open figma tab matches fileKey ${fileKey}`,
    );

  const raw = await dump({
    cfigmaBin: cfg.cfigmaBin ?? "cfigma",
    tab: tab.key,
    nodeId,
  });
  let registry = await loadRegistry(componentsDir);
  const { ensureRegistryForRaw } = await import("./generate.ts");
  registry = await ensureRegistryForRaw(raw, {
    registry,
    componentsDir,
    cfigmaBin: cfg.cfigmaBin,
    cwd: root,
  });
  const designContext = await loadCompileDesignContext(root, componentsDir);
  const typeTransformer = new DesignAstTypeTransformer();
  const component = await buildComponentSource(raw, registry, designContext);
  const componentName = pascalize(component.name);
  const componentDir = join(componentsDir, componentName);
  await mkdir(componentDir, { recursive: true });
  const analysisRegistry = component.key
    ? new Map([...registry].filter(([key]) => key !== component.key))
    : registry;

  const scan = component.key
    ? await scanAllOpenTabsForInit({
        componentSetKey: component.key,
        cfigmaBin: cfg.cfigmaBin,
      }).catch((e) => {
        console.warn(`[init] usecase scan failed: ${(e as Error).message}`);
        return undefined;
      })
    : undefined;

  const tabByKey = new Map(tabs.map((t) => [t.key, t]));
  const usecases: UsecaseSource[] = [];
  for (const u of scan?.usages ?? []) {
    if (!u.fileKey) continue;
    const usageTab = tabByKey.get(u.fileKey);
    if (!usageTab) continue;
    try {
      const usageRaw = await dump({
        cfigmaBin: cfg.cfigmaBin ?? "cfigma",
        tab: usageTab.key,
        nodeId: u.id,
      });
      usecases.push({
        figmaId: `${u.fileKey}:${u.id}`,
        variantKey: u.mainKey,
        raw: usageRaw,
        ir: await compileForInit(usageRaw, analysisRegistry, designContext),
        render: parseRenderBox(usageRaw),
      });
    } catch (e) {
      if (isFatalInitError(e)) throw e;
      console.warn(
        `[init] skipped usecase ${u.fileKey}:${u.id}: ${(e as Error).message}`,
      );
    }
  }

  const usecasesByVariant = groupBy(
    usecases,
    (u) => u.variantKey ?? "<unknown>",
  );
  const promotionsByVariant = new Map<string, PromotedField[]>();
  for (const variant of component.variants) {
    if (!variant.key) continue;
    promotionsByVariant.set(
      variant.key,
      await detectPromotions(
        variant.ir,
        usecasesByVariant.get(variant.key) ?? [],
        typeTransformer,
      ),
    );
  }

  const exposedSlots = collectExposedSlots(component.variants);
  const allPromotions = uniquePromotions(
    [...promotionsByVariant.values()].flat(),
  );

  await rm(join(componentDir, "generated"), { recursive: true, force: true });
  await rm(join(componentDir, "variants"), { recursive: true, force: true });
  await rm(join(componentDir, "impl"), { recursive: true, force: true });
  await rm(join(componentDir, "impl.tsx"), { force: true });
  await rm(join(componentDir, "cases.ts"), { force: true });
  await rm(join(componentDir, "defaults.ts"), { force: true });
  await rm(join(componentDir, "props.ts"), { force: true });
  await rm(join(componentDir, "master-snapshot.json"), { force: true });
  await rm(join(componentDir, "static-tokens.json"), { force: true });

  await writeFile(
    join(componentDir, "schema.ts"),
    await fmt(
      emitSchema(componentName, component.defs, exposedSlots, allPromotions),
    ),
  );
  const variantMetas = component.variants.map((variant) => ({
    variant,
    ast: dataScopeAst(
      variant,
      component.defs,
      exposedSlots,
      promotionsByVariant.get(variant.key ?? "") ?? [],
    ),
    dirName: uniqueDirName(component.variants, variant),
    path: `variants/${uniqueDirName(component.variants, variant)}`,
  }));
  for (const meta of variantMetas) {
    const promotions = promotionsByVariant.get(meta.variant.key ?? "") ?? [];
    const variantDir = join(componentDir, meta.path);
    await mkdir(variantDir, { recursive: true });
    await writeFile(
      join(variantDir, "ast.json"),
      JSON.stringify(meta.ast, null, 2) + "\n",
    );
    await writeFile(
      join(variantDir, "parser.ts"),
      await fmt(
        emitVariantParser(
          componentName,
          component.defs,
          exposedSlots,
          meta.variant,
          promotions,
        ),
      ),
    );
  }
  await writeFile(
    join(componentDir, "pixpec.json"),
    JSON.stringify(
      {
        name: componentName,
        figma: component.key
          ? { componentSetKey: component.key, componentSetId: component.id }
          : undefined,
        variants: variantMetas.map((meta) => ({
          name: meta.variant.name,
          key: meta.variant.key ?? meta.variant.id,
          path: meta.path,
          figmaId: `${fileKey}:${meta.variant.id}`,
          render: parseRenderBox(meta.variant.raw),
        })),
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(componentDir, "pixpec.md"),
    emitPixpecMd(componentName, component.variants),
  );
  const staticTokens = emptyStaticTokenMap();
  for (const meta of variantMetas) {
    const variantDir = join(componentDir, meta.path);
    const parser = await importFresh(join(variantDir, "parser.ts"));
    const promotions = promotionsByVariant.get(meta.variant.key ?? "") ?? [];
    const masterCase = makeCaseWithParser(
      parser,
      component.defs,
      meta.variant,
      `${fileKey}:${meta.variant.id}`,
      cfg.remBase ?? 16,
      true,
    );
    const usecases = (
      usecasesByVariant.get(meta.variant.key ?? "") ?? []
    ).flatMap((u) => {
      try {
        const usecase = makeUsecaseWithParser(
          parser,
          component.defs,
          meta.variant,
          u,
          cfg.remBase ?? 16,
        );
        return usecase ? [usecase] : [];
      } catch (e) {
        if (isFatalInitError(e)) throw e;
        console.warn(
          `[init] skipped usecase ${u.figmaId}: ${(e as Error).message}`,
        );
        return [];
      }
    });
    const cases = [masterCase, ...usecases];
    collectStaticTokens(staticTokens, cases, promotions);
    await writeFile(
      join(variantDir, "usecases.json"),
      JSON.stringify(cases, null, 2) + "\n",
    );
  }
  await writeStaticTokens(
    join(componentDir, "static-tokens.json"),
    staticTokens,
  );
  await writeFile(
    join(componentDir, "index.ts"),
    await fmt(emitIndex(componentName, component.key, component.id)),
  );

  if (process.env.PIXPEC_SKIP_INIT_GENERATE !== "1") {
    const { runGenerate } = await import("./generate.ts");
    for (const meta of variantMetas) {
      for (const target of cfg.targets) {
        const result = await runGenerate(`${fileKey}:${meta.variant.id}`, {
          target,
          componentName,
          outputDir: join(componentDir, meta.path, target),
          outName: "index",
          propsFile: join(componentDir, "schema.ts"),
          ast: meta.ast,
        });
        console.log(
          `[init] generated ${componentName}/${meta.variant.name} [${target}] → ${result.outPath}`,
        );
      }
    }
  }

  for (const target of cfg.targets) {
    const implDir = join(componentDir, "impl", target);
    await mkdir(implDir, { recursive: true });
    await writeFile(
      join(implDir, target === "gpui" ? "mod.go" : "index.tsx"),
      await fmt(emitImpl(componentName, component.defs, variantMetas, target)),
    );
  }

  if (!opts.skipVerify && process.env.PIXPEC_SKIP_INIT_VERIFY !== "1") {
    const { runVerify } = await import("./verify.ts");
    await runVerify(componentName);
  }

  return {
    componentName,
    componentDir,
    variantCount: component.variants.length,
  };
}

async function buildComponentSource(
  raw: RawNode,
  registry: Awaited<ReturnType<typeof loadRegistry>>,
  designContext: CompileDesignContext,
) {
  if (raw.remote) {
    throw new Error(
      `remote component proxy is not a valid init target: ${raw.id} (${raw.name})`,
    );
  }
  if (raw.type !== "COMPONENT_SET" && raw.type !== "COMPONENT") {
    throw new Error(
      `pixpec init: node ${raw.id} is ${raw.type}, not a component`,
    );
  }
  const variantRaws =
    raw.type === "COMPONENT_SET"
      ? (raw.children ?? []).filter((child) => child.type === "COMPONENT")
      : [raw];
  const variants: VariantSource[] = [];
  for (const variantRaw of variantRaws) {
    variants.push({
      id: variantRaw.id,
      key: variantRaw.key,
      name: variantRaw.name,
      props: {
        ...compileVariantProps(variantRaw),
        ...compileComponentRefDefaults(variantRaw),
      },
      raw: variantRaw,
      ir: await compileForInit(variantRaw, registry, designContext),
      render: parseRenderBox(variantRaw),
    });
  }
  return {
    id: raw.id,
    key: raw.key,
    name: raw.name,
    defs: compileComponentPropDefs(raw),
    variants,
  };
}

async function compileForInit(
  raw: RawNode,
  registry: Awaited<ReturnType<typeof loadRegistry>>,
  design: CompileDesignContext,
): Promise<DNode> {
  return compile(raw, {
    registry,
    detachUnregisteredInstances: true,
    tokenMap: design.tokenMap,
    tokenValueMap: design.tokenValueMap,
    tokenColorMap: design.tokenColorMap,
    typographyMap: design.typographyMap,
  });
}

async function loadCompileDesignContext(
  root: string,
  componentsDir: string,
): Promise<CompileDesignContext> {
  const { tokenMap, tokenValueMap, tokenColorMap } = await loadTokenMaps(root);
  const typographyMap = await loadTypographyMap(componentsDir);
  return { tokenMap, tokenValueMap, tokenColorMap, typographyMap };
}

async function loadTokenMaps(root: string): Promise<{
  tokenMap: Record<string, string>;
  tokenValueMap: Record<string, number>;
  tokenColorMap: Record<string, string>;
}> {
  const tokenMap: Record<string, string> = {};
  const tokenValueMap: Record<string, number> = {};
  const tokenColorMap: Record<string, string> = {};
  try {
    const ft = JSON.parse(
      await readFile(resolve(root, "tokens/figma-tokens.json"), "utf8"),
    ) as {
      variables: Array<{
        id: string;
        key?: string;
        name: string;
        resolvedType: string;
        valuesByMode?: Record<string, unknown>;
      }>;
    };
    for (const v of ft.variables) {
      const tokenPath = tokenPathFromFigmaName(v.name);
      tokenMap[v.id] = tokenPath;
      if (v.key) tokenMap[v.key] = tokenPath;
      if (v.resolvedType === "FLOAT" && v.valuesByMode) {
        const num = Object.values(v.valuesByMode).find(
          (x): x is number => typeof x === "number",
        );
        if (typeof num === "number") {
          tokenValueMap[v.id] = num;
          if (v.key) tokenValueMap[v.key] = num;
          tokenValueMap[tokenPath] = num;
        }
      }
      if (v.resolvedType === "COLOR" && v.valuesByMode) {
        const color = Object.values(v.valuesByMode)
          .map(colorTokenToCss)
          .find((x): x is string => !!x);
        if (color) {
          tokenColorMap[v.id] = color;
          if (v.key) tokenColorMap[v.key] = color;
          tokenColorMap[tokenPath] = color;
        }
      }
    }
  } catch {
    // Token file is optional for non-design-system projects.
  }
  return { tokenMap, tokenValueMap, tokenColorMap };
}

async function loadTypographyMap(
  componentsDir: string,
): Promise<Record<string, string>> {
  try {
    return JSON.parse(
      await readFile(
        resolve(componentsDir, "typography/figma-binding.json"),
        "utf8",
      ),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function tokenPathFromFigmaName(name: string): string {
  return name
    .replace(/[\x00-\x1f]/g, "")
    .split("/")
    .map((s) => s.replace(/\s+/g, "").replace(/^./, (c) => c.toLowerCase()))
    .join(".");
}

function colorTokenToCss(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const c = value as { r?: unknown; g?: unknown; b?: unknown; a?: unknown };
  if (
    typeof c.r !== "number" ||
    typeof c.g !== "number" ||
    typeof c.b !== "number"
  )
    return undefined;
  const r = Math.round(Math.max(0, Math.min(1, c.r)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, c.g)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, c.b)) * 255);
  const a = typeof c.a === "number" ? Math.max(0, Math.min(1, c.a)) : 1;
  if (a >= 1) return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
  return `rgba(${r},${g},${b},${+a.toFixed(6)})`;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

async function detectPromotions(
  master: DNode,
  usecases: UsecaseSource[],
  typeTransformer: DesignAstTypeTransformer,
): Promise<PromotedField[]> {
  if (usecases.length === 0) return [];
  const masterNodes = indexDNodes(master);
  const counts = new Map<string, { source: PromotedField; count: number }>();
  for (const usecase of usecases) {
    const usageNodes = indexDNodes(usecase.ir);
    const usageNodesByBareId = indexDNodesByBareId(usecase.ir);
    const seen = new Set<string>();
    for (const [nodeId, masterNode] of masterNodes) {
      const usageNode =
        usageNodes.get(nodeId) ?? usageNodesByBareId.get(stripPrefix(nodeId));
      if (!usageNode || usageNode.kind !== masterNode.kind) continue;
      for (const diff of masterNode.visualDiff(usageNode)) {
        const prop = promotedPropName(
          masterNode.sourceName ?? "node",
          diff.field,
        );
        const key = `${prop}\0${nodeId}\0${diff.field}`;
        if (seen.has(key)) continue;
        seen.add(key);
        counts.set(key, {
          source: {
            prop,
            nodeId,
            field: diff.field,
            valueType: "string",
            componentName:
              masterNode.kind === NodeKind.Instance &&
              diff.field.startsWith("component.")
                ? (masterNode.toJSON() as { componentName?: string })
                    .componentName
                : undefined,
          },
          count: (counts.get(key)?.count ?? 0) + 1,
        });
      }
    }
  }
  const promoted = [...counts.values()]
    .filter((x) => x.count / usecases.length >= 0.2)
    .map((x) => x.source);
  const byProp = groupBy(promoted, (p) => p.prop);
  const conflicts = [...byProp.entries()].filter(
    ([, items]) => items.length > 1,
  );
  if (conflicts.length > 0) {
    throw new Error(
      `pixpec init: ambiguous promoted prop(s): ${conflicts
        .map(([prop]) => JSON.stringify(prop))
        .join(", ")}`,
    );
  }
  return promoted.map((source) => {
    const masterNode = indexDNodes(master).get(source.nodeId);
    if (!masterNode) return source;
    if (source.field.startsWith("component.")) return source;
    return {
      ...source,
      valueType: typeTransformer.fieldTypeForNode(masterNode.kind, source.field)
        .valueType,
    };
  });
}

function normalizePromotedValue(value: unknown): unknown {
  return normalizePropValue(value);
}

function dataScopeAst(
  variant: VariantSource,
  defs: Record<string, PropDef>,
  exposedSlots: Record<string, ExposedSlot>,
  promotions: PromotedField[],
): DNode {
  const data = dataScopeEntries(variant, defs, exposedSlots, promotions);
  if (Object.keys(data).length === 0) return variant.ir;
  return {
    kind: NodeKind.DataScope,
    data,
    child: applyPromotedExpressions(variant.ir, promotions),
  };
}

function dataScopeEntries(
  variant: VariantSource,
  defs: Record<string, PropDef>,
  exposedSlots: Record<string, ExposedSlot>,
  promotions: PromotedField[],
): Record<string, DataScopeEntry> {
  const entries: Record<string, DataScopeEntry> = {};
  for (const [name, def] of Object.entries(defs)) {
    entries[name] = {
      type: def.dataType,
      default: variant.props[name] ?? def.defaultValue,
    };
  }
  const variantNodes = indexDNodes(variant.ir);
  const variantNodesByBareId = indexDNodesByBareId(variant.ir);
  for (const slot of Object.values(exposedSlots)) {
    const node =
      variantNodes.get(slot.sourceId) ??
      variantNodesByBareId.get(stripPrefix(slot.sourceId));
    const props = node?.instanceProps();
    if (!props) continue;
    entries[slot.prop] = {
      type: `component:${slot.componentName}`,
      default: props,
    };
  }
  for (const promotion of promotions) {
    const node =
      variantNodes.get(promotion.nodeId) ??
      variantNodesByBareId.get(stripPrefix(promotion.nodeId));
    entries[promotion.prop] = {
      type: promotion.valueType,
      default: node ? node.readField(promotion.field) : undefined,
    };
  }
  return entries;
}

function indexDNodesByBareId(root: DNode): Map<string, DNodeClass> {
  const out = new Map<string, DNodeClass>();
  for (const [id, node] of indexDNodes(root)) out.set(stripPrefix(id), node);
  return out;
}

function applyPromotedExpressions(
  root: DNode,
  promotions: PromotedField[],
): DNode {
  const clone = structuredClone(root) as DNode;
  const nodes = indexDNodeObjects(clone);
  const nodesByBareId = new Map<string, DNode>();
  for (const [id, node] of nodes) nodesByBareId.set(stripPrefix(id), node);
  for (const promotion of promotions) {
    const node =
      promotion.nodeId === "$root"
        ? clone
        : (nodes.get(promotion.nodeId) ??
          nodesByBareId.get(stripPrefix(promotion.nodeId)));
    if (!node) continue;
    const expression = propValue(promotion.prop);
    if (
      promotion.field.startsWith("component.") &&
      node.kind === NodeKind.Instance
    ) {
      const key = promotion.field.slice("component.".length);
      (node as DInstance).props = {
        ...(node as DInstance).props,
        [key]: expression,
      };
      continue;
    }
    writePath(
      node as unknown as Record<string, unknown>,
      promotion.field,
      expression,
    );
  }
  return clone;
}

function propValue(name: string) {
  return { kind: "expression", type: "prop", name } as const;
}

function indexDNodeObjects(root: DNode): Map<string, DNode> {
  const out = new Map<string, DNode>();
  const visit = (node: DNode) => {
    if ("sourceId" in node && node.sourceId) out.set(node.sourceId, node);
    if (node.kind === NodeKind.DataScope) visit(node.child);
    else if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  out.set("$root", root);
  return out;
}

function writePath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".").filter(Boolean);
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object") return;
    current = next as Record<string, unknown>;
  }
  const last = parts.at(-1);
  if (last) current[last] = value;
}

function normalizePropValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizePropValue);
  const record = value as Record<string, unknown>;
  if (record.kind === "literal") return record;
  if (record.kind === "expression") return undefined;
  const shadow = shadowToCssString(record);
  if (shadow) return shadow;
  throw new Error(
    `pixpec init: promoted value is not primitive-normalizable: ${stableJson(record)}`,
  );
}

function shadowToCssString(
  record: Record<string, unknown>,
): string | undefined {
  if (
    !("x" in record) ||
    !("y" in record) ||
    !("blur" in record) ||
    !("color" in record)
  )
    return undefined;
  const x = lengthNumber(record.x);
  const y = lengthNumber(record.y);
  const blur = lengthNumber(record.blur);
  const spread = record.spread === undefined ? 0 : lengthNumber(record.spread);
  const color =
    typeof record.color === "string" ? record.color : colorCss(record.color);
  if (
    x === undefined ||
    y === undefined ||
    blur === undefined ||
    spread === undefined ||
    !color
  )
    return undefined;
  return `${x}px ${y}px ${blur}px ${spread}px ${color}`;
}

function primitiveType(value: unknown): string {
  const type = typeof value;
  if (type === "string" || type === "boolean" || type === "number") return type;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.kind === "literal") return literalType(record.value);
    if (isColorLiteral(record)) return "color";
    if (isLengthLiteral(record)) return "length";
  }
  throw new Error(
    `pixpec init: promoted value is not primitive: ${stableJson(value)}`,
  );
}

function literalType(value: unknown): string {
  const type = typeof value;
  if (type === "string" || type === "boolean" || type === "number") return type;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (isColorLiteral(record)) return "color";
    if (isLengthLiteral(record)) return "length";
  }
  throw new Error(
    `pixpec init: promoted literal value is not typed: ${stableJson(value)}`,
  );
}

function isLengthLiteral(value: Record<string, unknown>): boolean {
  return typeof value.value === "number" && value.unit === "px";
}

function lengthNumber(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "literal" ||
    !record.value ||
    typeof record.value !== "object"
  )
    return undefined;
  const length = record.value as Record<string, unknown>;
  return isLengthLiteral(length) ? (length.value as number) : undefined;
}

function colorCss(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const color =
    record.kind === "literal" &&
    record.value &&
    typeof record.value === "object"
      ? (record.value as Record<string, unknown>)
      : record;
  if (!isColorLiteral(color)) return undefined;
  const { r, g, b, a } = color;
  if (a === undefined || a === 1)
    return `#${[r, g, b].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${r},${g},${b},${+Number(a).toFixed(6)})`;
}

function isColorLiteral(value: Record<string, unknown>): boolean {
  const { r, g, b, a } = value;
  return (
    typeof r === "number" &&
    typeof g === "number" &&
    typeof b === "number" &&
    (a === undefined || typeof a === "number")
  );
}

function indexDNodes(root: DNode): Map<string, DNodeClass> {
  const node = materializeDNode(root);
  const out = indexDNodeClasses([node]);
  out.set("$root", node);
  return out;
}

function collectExposedSlots(
  variants: VariantSource[],
): Record<string, ExposedSlot> {
  const out: Record<string, ExposedSlot> = {};
  for (const variant of variants) {
    for (const exposed of variant.raw.exposedInstances ?? []) {
      const child = findNodeById(variant.raw, exposed.id);
      if (!child || child.type !== "INSTANCE") continue;
      const prop = propName(exposed.name);
      if (out[prop]) continue;
      out[prop] = {
        prop,
        sourceId: child.id,
        componentName:
          child.mainComponent?.parentName ??
          child.mainComponent?.name ??
          exposed.name,
      };
    }
  }
  return out;
}

function emitSchema(
  componentName: string,
  defs: Record<string, PropDef>,
  exposedSlots: Record<string, ExposedSlot>,
  promotions: PromotedField[],
): string {
  const imports = new Map<string, string>();
  for (const slot of Object.values(exposedSlots)) {
    const childName = pascalize(slot.componentName);
    const typeName = `${childName}Props`;
    imports.set(
      typeName,
      `import type { ${typeName} } from '../${childName}/schema.ts'`,
    );
  }
  for (const promotion of promotions) {
    if (!promotion.componentName || !promotion.field.startsWith("component."))
      continue;
    const childName = pascalize(promotion.componentName);
    const typeName = `${childName}Props`;
    imports.set(
      typeName,
      `import type { ${typeName} } from '../${childName}/schema.ts'`,
    );
  }
  const reactNodeImport = Object.values(defs).some((d) => d.kind === "instance")
    ? "import type { ReactNode } from 'react'\n"
    : "";
  const schemaLines = [
    ...Object.entries(defs).map(
      ([name, def]) => `  ${propsKey(name)}: ${zodForDef(def)},`,
    ),
    ...Object.values(exposedSlots).map(
      (slot) =>
        `  ${propsKey(slot.prop)}: z.custom<${pascalize(slot.componentName)}Props>().optional(),`,
    ),
  ];
  const promotionLines = promotions.map(
    (p) => `  ${propsKey(p.prop)}: ${zodForPromotion(p, true)},`,
  );
  const valueTypeImport = promotions.length
    ? "import type { Color, LengthValue, Paint, Shadow, TextStyleValue, Value } from 'pixpec/spec'\n"
    : "";
  return `import { z } from 'pixpec/spec'
${valueTypeImport}${reactNodeImport}${[...imports.values()].join("\n")}
import type { BoxProps, FlexProps, StackProps } from '../../../styled-system/jsx'

export const BaseSchema = z.object({
${schemaLines.join("\n")}
})

export const PropsSchema = BaseSchema.extend({
${promotionLines.join("\n")}
})

export type ${componentName}OwnProps = z.infer<typeof PropsSchema>

export type ${componentName}RootProps = BoxProps | FlexProps | StackProps
export type ${componentName}PixpecStyleProps = BoxProps
export type ${componentName}Props<TRootProps extends object = ${componentName}PixpecStyleProps> =
  ${componentName}OwnProps & TRootProps
`;
}

function emitVariantParser(
  componentName: string,
  defs: Record<string, PropDef>,
  exposedSlots: Record<string, ExposedSlot>,
  variant: VariantSource,
  promotions: PromotedField[],
): string {
  const imports = new Map<string, string>();
  for (const promotion of promotions) {
    if (!promotion.componentName || !promotion.field.startsWith("component."))
      continue;
    const childName = pascalize(promotion.componentName);
    const typeName = `${childName}Props`;
    imports.set(
      typeName,
      `import type { ${typeName} } from '../../../${childName}/schema.ts'`,
    );
  }
  const valueTypeImport = promotions.length
    ? "import type { Color, LengthValue, Paint, Shadow, TextStyleValue, Value } from 'pixpec/spec'\n"
    : "";
  const inputLines = [
    ...Object.keys(defs).map(
      (name) =>
        `    ${propsKey(name)}: componentProps[${JSON.stringify(defs[name]?.rawKey ?? name)}],`,
    ),
    ...promotions.map(
      (source) =>
        `    ${propsKey(source.prop)}: fields.consume(${JSON.stringify(source.nodeId)}, ${JSON.stringify(source.field)}),`,
    ),
    ...Object.values(exposedSlots)
      .filter((slot) => !!findNodeById(variant.raw, slot.sourceId))
      .map(
        (slot) =>
          `    ${propsKey(slot.prop)}: exposed[${JSON.stringify(slot.sourceId)}],`,
      ),
  ];
  return `import { z } from 'pixpec/spec'
${valueTypeImport}${[...imports.values()].join("\n")}
import { BaseSchema, type ${componentName}Props } from '../../schema.ts'

export const PropsSchema = BaseSchema.extend({
${promotions.map((p) => `  ${propsKey(p.prop)}: ${zodForPromotion(p, true)},`).join("\n")}
})

export function propsFromFigma(
  componentProps: Record<string, string | number | boolean | undefined>,
  exposed: Record<string, unknown>,
  fields: { consume<T>(nodeId: string, field: string): T | undefined },
): ${componentName}Props {
  return PropsSchema.parse({
${inputLines.join("\n")}
  }) as ${componentName}Props
}
`;
}

function makeCaseWithParser(
  parser: Record<string, unknown>,
  defs: Record<string, PropDef>,
  variant: VariantSource,
  figmaId: string,
  remBase: number,
  isMainCase = false,
) {
  const propsFromFigma = parser.propsFromFigma;
  if (typeof propsFromFigma !== "function")
    throw new Error(
      `pixpec init: generated parser for ${variant.name} does not export propsFromFigma`,
    );
  const props = propsFromFigma(
    rawComponentPropsForVariant(variant.raw, defs),
    {},
    initFieldConsumer(variant.ir, remBase),
  ) as Record<string, unknown>;
  return {
    props: { ...props, ...rootSizeStyleProps(variant.raw, remBase, false) },
    figmaId,
    render: parseRenderBox(variant.raw),
    ...(isMainCase ? { isMainCase: true } : {}),
  };
}

function makeUsecaseWithParser(
  parser: Record<string, unknown>,
  defs: Record<string, PropDef>,
  variant: VariantSource,
  usecase: UsecaseSource,
  remBase: number,
) {
  const propsFromFigma = parser.propsFromFigma;
  if (typeof propsFromFigma !== "function")
    throw new Error(
      `pixpec init: generated parser does not export propsFromFigma`,
    );
  const fields = initFieldConsumer(usecase.ir, remBase);
  const props = propsFromFigma(
    rawComponentPropValues(defs, usecase.raw),
    {},
    fields,
  ) as Record<string, unknown>;
  if (hasUnconsumedDNodeDiff(variant.ir, usecase.ir, fields.consumed)) {
    console.warn(
      `[init] detached usecase ${usecase.figmaId}: unconsumed visual override`,
    );
    return undefined;
  }
  return {
    props: { ...props, ...rootSizeStyleProps(usecase.raw, remBase, true) },
    figmaId: usecase.figmaId,
    render: parseRenderBox(usecase.raw),
  };
}

function isFatalInitError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("SVG paint override");
}

function emitIndex(
  componentName: string,
  componentSetKey?: string,
  componentSetId?: string,
): string {
  const figma = componentSetKey
    ? `,
  figma: {
    componentSetKey: ${JSON.stringify(componentSetKey)},${componentSetId ? `\n    componentSetId: ${JSON.stringify(componentSetId)},` : ""}
  }`
    : "";
  return `import { defineComponent } from 'pixpec/spec'
import type { ${componentName}Props } from './schema.ts'
import manifest from './pixpec.json'

export type { ${componentName}Props }

export const ${componentName} = defineComponent<${componentName}Props>({
  name: ${JSON.stringify(componentName)},
  variants: []${figma},
})

export default ${componentName}
export { manifest }
`;
}

function emitImpl(
  componentName: string,
  defs: Record<string, PropDef>,
  variants: Array<{ variant: VariantSource; path: string; ast: DNode }>,
  target: string,
): string {
  if (target === "react-panda") {
    return emitReactPandaImpl(componentName, defs, variants);
  }
  const variantProps = Object.entries(defs)
    .filter(([, def]) => def.kind === "variant")
    .map(([name]) => name);
  const generated = variants.map((v) => ({
    id: safeId(v.variant.key ?? v.variant.id),
    importPath: `../../${v.path}/${target}/index.tsx`,
    key: variantProps
      .map((name) => `${name}=${String(v.variant.props[name])}`)
      .join("|"),
  }));
  const imports = generated
    .map((v) => `import { Generated as V_${v.id} } from '${v.importPath}'`)
    .join("\n");
  const cases = generated
    .map((v) => `  ${JSON.stringify(v.key)}: V_${v.id},`)
    .join("\n");
  const keyExpr =
    variantProps.length === 0
      ? "''"
      : variantProps
          .map(
            (name) => `\`${name}=\${String(props[${JSON.stringify(name)}])}\``,
          )
          .join(" + '|' + ");
  return `import type { FC } from 'react'
import type { ${componentName}Props } from '../../schema.ts'
${imports}

const VARIANTS: Record<string, FC<${componentName}Props>> = {
${cases}
}

export const impl: FC<${componentName}Props> = (props) => {
  const key = ${keyExpr}
  const Picked = VARIANTS[key] ?? ${generated[0] ? `V_${generated[0].id}` : "null"}
  return Picked ? <Picked {...props} /> : null
}

export type { ${componentName}Props }
`;
}

function emitReactPandaImpl(
  componentName: string,
  defs: Record<string, PropDef>,
  variants: Array<{ variant: VariantSource; path: string; ast: DNode }>,
): string {
  const variantProps = Object.entries(defs)
    .filter(([, def]) => def.kind === "variant")
    .map(([name]) => name);
  const generated = variants.map((v) => ({
    id: safeId(v.variant.key ?? v.variant.id),
    importPath: `../../${v.path}/react-panda/index.tsx`,
    key: variantProps
      .map((name) => `${name}=${String(v.variant.props[name])}`)
      .join("|"),
  }));
  const dataByProp = collectTargetDataScope(variants.map((v) => v.ast));
  for (const name of variantProps) {
    if (!dataByProp.has(name)) dataByProp.set(name, { type: "string", count: variants.length });
  }
  const fields = [...dataByProp.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, info]) => {
      return `  ${propsKey(name)}?: ${reactPandaDataType(info.type)};`;
    })
    .join("\n");
  const imports = generated
    .map((v) => `import { Generated as V_${v.id} } from '${v.importPath}'`)
    .join("\n");
  const cases = generated
    .map((v) => `  ${JSON.stringify(v.key)}: V_${v.id},`)
    .join("\n");
  const keyExpr =
    variantProps.length === 0
      ? "''"
      : variantProps
          .map(
            (name) => `\`${name}=\${String(props[${JSON.stringify(name)}])}\``,
          )
          .join(" + '|' + ");
  return `import type { FC, ReactNode } from 'react'
import type { BoxProps } from '../../../../../styled-system/jsx'
${imports}

export interface ${componentName}Props extends BoxProps {
${fields}
}

const VARIANTS = {
${cases}
}

export const impl: FC<${componentName}Props> = (props) => {
  const key = ${keyExpr}
  const Picked = (VARIANTS as unknown as Record<string, FC<${componentName}Props>>)[key] ?? V_${generated[0]?.id}
  return Picked ? <Picked {...props} /> : null
}
`;
}

function collectTargetDataScope(asts: DNode[]): Map<
  string,
  { type: string; count: number }
> {
  const out = new Map<string, { type: string; count: number }>();
  for (const ast of asts) {
    if (ast.kind !== NodeKind.DataScope) continue;
    for (const [name, entry] of Object.entries(ast.data)) {
      const previous = out.get(name);
      const type = mergeReactPandaDataType(previous?.type, entry.type);
      out.set(name, { type, count: (previous?.count ?? 0) + 1 });
    }
  }
  return out;
}

function mergeReactPandaDataType(a: string | undefined, b: string): string {
  if (!a || a === b) return b;
  const ta = reactPandaDataType(a);
  const tb = reactPandaDataType(b);
  return ta === tb ? b : "unknown";
}

function reactPandaDataType(type: string): string {
  if (type === "boolean") return "boolean";
  if (type === "number") return "number";
  if (type === "length") return "string | number";
  if (
    type === "string" ||
    type === "color" ||
    type === "paint" ||
    type === "textStyle" ||
    type === "shadow"
  ) {
    return "string";
  }
  if (type.startsWith("component:")) return "ReactNode";
  return "string";
}

function initFieldConsumer(ir: DNode, remBase: number) {
  const nodes = indexDNodes(ir);
  const nodesByBareId = indexDNodesByBareId(ir);
  const consumed = new Set<string>();
  return {
    consumed,
    consume(nodeId: string, field: string): unknown {
      consumed.add(`${nodeId}\0${field}`);
      const node = nodes.get(nodeId) ?? nodesByBareId.get(stripPrefix(nodeId));
      if (!node) return undefined;
      return normalizePromotedValue(node.readField(field));
    },
  };
}

function hasUnconsumedDNodeDiff(
  master: DNode,
  usage: DNode,
  consumedFields: Set<string>,
): boolean {
  const masterNodes = indexDNodes(master);
  const usageNodes = indexDNodes(usage);
  const usageNodesByBareId = indexDNodesByBareId(usage);
  for (const [nodeId, masterNode] of masterNodes) {
    const usageNode =
      usageNodes.get(nodeId) ?? usageNodesByBareId.get(stripPrefix(nodeId));
    if (!usageNode || usageNode.kind !== masterNode.kind) return true;
    for (const diff of masterNode.visualDiff(usageNode)) {
      if (consumedFields.has(`${nodeId}\0${diff.field}`)) continue;
      return true;
    }
  }
  return false;
}

async function importFresh(path: string): Promise<Record<string, unknown>> {
  return (await import(
    `${pathToFileURL(path).href}?t=${Date.now()}`
  )) as Record<string, unknown>;
}

function uniqueDirName(
  variants: VariantSource[],
  variant: VariantSource,
): string {
  const base = sanitize(variant.name) || "Variant";
  const sameBefore = variants
    .slice(0, variants.indexOf(variant))
    .filter((item) => (sanitize(item.name) || "Variant") === base).length;
  return sameBefore === 0 ? base : `${base}_${sameBefore + 1}`;
}

function emitPixpecMd(
  componentName: string,
  variants: VariantSource[],
): string {
  return `# ${componentName}

Generated by pixpec init.

## Variants

${variants.map((variant) => `- ${variant.name} (${variant.key ?? variant.id})`).join("\n")}
`;
}

function parseRenderBox(n: RawNode): CaseRenderSpec | undefined {
  const width = n.absoluteRenderBounds?.width ?? n.width;
  const height = n.absoluteRenderBounds?.height ?? n.height;
  if (typeof width !== "number" || typeof height !== "number") return undefined;
  const box: RenderBoxSpec = { width, height };
  const bb = n.absoluteBoundingBox;
  const rb = n.absoluteRenderBounds;
  if (bb && rb) {
    const paddingLeft = bb.x - rb.x;
    const paddingTop = bb.y - rb.y;
    const paddingRight = rb.x + rb.width - (bb.x + bb.width);
    const paddingBottom = rb.y + rb.height - (bb.y + bb.height);
    if (Math.abs(paddingLeft) >= 0.001) box.paddingLeft = paddingLeft;
    if (Math.abs(paddingTop) >= 0.001) box.paddingTop = paddingTop;
    if (Math.abs(paddingRight) >= 0.001) box.paddingRight = paddingRight;
    if (Math.abs(paddingBottom) >= 0.001) box.paddingBottom = paddingBottom;
  }
  return { box };
}

function rootSizeStyleProps(
  n: RawNode,
  remBase: number,
  standaloneInstance: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (
    (standaloneInstance || n.layoutSizingHorizontal === "FIXED") &&
    typeof n.width === "number"
  ) {
    out.width = pxToRem(n.width, remBase);
  }
  if (
    (standaloneInstance || n.layoutSizingVertical === "FIXED") &&
    typeof n.height === "number"
  ) {
    out.height = pxToRem(n.height, remBase);
  }
  return out;
}

function emptyStaticTokenMap(): StaticTokenMap {
  return Object.fromEntries(
    STATIC_CSS_PROPERTIES.map((property) => [property, new Set<string>()]),
  ) as StaticTokenMap;
}

function collectStaticTokens(
  out: StaticTokenMap,
  cases: Array<{ props: Record<string, unknown> }>,
  promotions: PromotedField[],
): void {
  const promotedCssFields = new Map(
    promotions
      .filter(
        (
          promotion,
        ): promotion is PromotedField & { field: StaticCssProperty } =>
          isStaticCssProperty(promotion.field),
      )
      .map((promotion) => [promotion.prop, promotion.field]),
  );
  for (const c of cases) {
    for (const [key, value] of Object.entries(c.props)) {
      const property = isStaticCssProperty(key)
        ? key
        : promotedCssFields.get(key);
      if (!property || typeof value !== "string") continue;
      if (isStaticCssValue(value)) out[property].add(value);
    }
  }
}

async function writeStaticTokens(
  path: string,
  tokens: StaticTokenMap,
): Promise<void> {
  const payload = Object.fromEntries(
    STATIC_CSS_PROPERTIES.map((property) => [
      property,
      [...tokens[property]].sort(),
    ]),
  );
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n");
}

function isStaticCssProperty(value: string): value is StaticCssProperty {
  return (STATIC_CSS_PROPERTIES as readonly string[]).includes(value);
}

function isStaticCssValue(value: string): boolean {
  return (
    value.startsWith("#") || value.startsWith("rgb") || /[0-9]/.test(value)
  );
}

function pxToRem(value: number, remBase: number): string {
  return `${+(value / remBase).toFixed(6)}rem`;
}

function zodForDef(def: PropDef): string {
  if (def.zodExpr) return def.zodExpr;
  if (def.kind === "boolean") return "z.boolean()";
  if (def.kind === "string") return "z.string()";
  if (def.kind === "variant" && def.variantOptions?.length)
    return `z.enum([${def.variantOptions.map((v) => JSON.stringify(v)).join(", ")}])`;
  if (def.kind === "variant") return "z.string()";
  if (def.kind === "instance") return "z.custom<ReactNode>().optional()";
  throw new Error(`pixpec init: unsupported prop kind ${def.kind}`);
}

function zodForType(type: string, optional = false): string {
  const suffix = optional ? ".optional()" : "";
  const literal = (schema: string) =>
    `z.object({ kind: z.literal("literal"), value: ${schema} })`;
  const lengthLiteral = `z.object({ value: z.number(), unit: z.literal("px") })`;
  const colorLiteral = `z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() })`;
  const textStyleLiteral = `z.object({
    fontFamily: z.string().optional(),
    fontWeight: z.number().optional(),
    fontSize: z.union([z.string(), ${literal(lengthLiteral)}]).optional(),
    lineHeight: z.union([z.string(), ${literal(lengthLiteral)}]).optional(),
    paragraphSpacing: z.union([z.string(), ${literal(lengthLiteral)}]).optional(),
  })`;
  const shadowLiteral = `z.object({
    x: z.union([z.string(), ${literal(lengthLiteral)}]),
    y: z.union([z.string(), ${literal(lengthLiteral)}]),
    blur: z.union([z.string(), ${literal(lengthLiteral)}]),
    spread: z.union([z.string(), ${literal(lengthLiteral)}]).optional(),
    color: z.union([z.string(), ${literal(colorLiteral)}]),
  })`;
  if (type === "string")
    return `(z.union([z.string(), ${literal("z.string()")}]) as z.ZodType<Value<string>>)${suffix}`;
  if (type === "boolean")
    return `(z.union([z.boolean(), ${literal("z.boolean()")}]) as z.ZodType<Value<boolean>>)${suffix}`;
  if (type === "number")
    return `(z.union([z.number(), ${literal("z.number()")}]) as z.ZodType<Value<number>>)${suffix}`;
  if (type === "length")
    return `(z.union([z.string(), ${literal(lengthLiteral)}]) as z.ZodType<LengthValue>)${suffix}`;
  if (type === "color")
    return `(z.union([z.string(), ${literal(colorLiteral)}]) as z.ZodType<Color>)${suffix}`;
  if (type === "paint")
    return `(z.union([
      z.string(),
      ${literal(colorLiteral)},
      ${literal(`z.object({
        kind: z.literal("linearGradient"),
        angle: z.number(),
        stops: z.array(z.object({
          offset: z.number(),
          color: z.union([z.string(), ${literal(colorLiteral)}]),
        })),
      })`)},
    ]) as z.ZodType<Paint>)${suffix}`;
  if (type === "textStyle")
    return `(z.union([
      z.string(),
      ${literal(textStyleLiteral)},
      z.object({
        base: z.string(),
        fontFamily: z.string().optional(),
        fontWeight: z.number().optional(),
        fontSize: z.union([z.string(), ${literal(lengthLiteral)}]).optional(),
        lineHeight: z.union([z.string(), ${literal(lengthLiteral)}]).optional(),
        paragraphSpacing: z.union([z.string(), ${literal(lengthLiteral)}]).optional(),
      }),
    ]) as z.ZodType<TextStyleValue>)${suffix}`;
  if (type === "shadow")
    return `(${shadowLiteral} as z.ZodType<Shadow>)${suffix}`;
  throw new Error(`pixpec init: unsupported promoted value type ${type}`);
}

function zodForPromotion(promotion: PromotedField, optional = false): string {
  if (promotion.componentName && promotion.field.startsWith("component.")) {
    const childName = pascalize(promotion.componentName);
    const propName = promotion.field.slice("component.".length);
    return `z.custom<${childName}Props[${JSON.stringify(propName)}]>()${optional ? ".optional()" : ""}`;
  }
  return zodForType(promotion.valueType, optional);
}

function uniquePromotions(promotions: PromotedField[]): PromotedField[] {
  const out = new Map<string, PromotedField>();
  for (const promotion of promotions) {
    if (!out.has(promotion.prop)) out.set(promotion.prop, promotion);
  }
  return [...out.values()];
}

function promotedPropName(layerName: string, field: string): string {
  return propName(
    `${layerName} ${field[0]?.toUpperCase() ?? ""}${field.slice(1)}`,
  );
}

function parseComponentId(componentId: string): {
  fileKey: string;
  nodeId: string;
} {
  const i = componentId.indexOf(":");
  if (i < 0)
    throw new Error(
      `pixpec init: componentId must be <fileKey>:<nodeId>; got ${componentId}`,
    );
  return { fileKey: componentId.slice(0, i), nodeId: componentId.slice(i + 1) };
}

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

function pascalize(name: string): string {
  const s = sanitize(name);
  return (
    s
      .split(/[_\-]+/)
      .filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join("") || "Component"
  );
}

function propName(name: string): string {
  const parts = name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/#[^#]*$/, "")
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (!parts.length) return "prop";
  return parts.map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

function propsKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "_");
}

function stripPrefix(id: string): string {
  return id.includes(";") ? id.slice(id.lastIndexOf(";") + 1) : id;
}

function findNodeById(root: RawNode, id: string): RawNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return undefined;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k) ?? [];
    bucket.push(item);
    out.set(k, bucket);
  }
  return out;
}

function literal(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "undefined";
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortJson(v)]),
  );
}

async function fmt(src: string): Promise<string> {
  try {
    const prettier = await import("prettier");
    return prettier.format(src, { parser: "typescript" });
  } catch {
    return src;
  }
}
