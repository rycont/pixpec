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
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { listFigmaTabs, scanAllOpenTabsForInit } from "./cfigma-meta.ts";
import { runCurrentCliChild } from "./cli-child.ts";
import { preflightCfigmaExport } from "./figma.ts";
import { dump, dumpMany, exportNodeSvg } from "./dumper/index.ts";
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
  "borderRadius",
  "borderWidth",
  "borderColor",
  "textStyle",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "fontFamily",
  "fontWeight",
] as const;

/** Figma field path → Panda CSS property name. detectPromotions surfaces
 *  promotions by figma field name; collectStaticTokens needs to bucket the
 *  observed values under the corresponding Panda CSS property so Panda's
 *  static analysis emits the matching utility class. */
const FIELD_TO_CSS_PROPERTY: Record<string, StaticCssProperty> = {
  cornerRadius: "borderRadius",
  "border.width": "borderWidth",
  "border.paint": "borderColor",
  // Vector fill is rendered via SVG currentColor, driven by CSS `color` on a
  // surrounding Panda wrapper. Bucket promoted Fill props under `color` so
  // every observed value (token path or literal RGB) is registered for Panda
  // staticCss — without this, the wrapper's color prop resolves to an empty
  // class and the SVG paints its inherited (black) color.
  fill: "color",
};

type StaticCssProperty = (typeof STATIC_CSS_PROPERTIES)[number];
type StaticTokenMap = Record<StaticCssProperty, Set<string>>;
type CompileDesignContext = {
  tokenMap: Record<string, string>;
  tokenValueMap: Record<string, number>;
  tokenColorMap: Record<string, string>;
  typographyMap: Record<string, string>;
};
const INIT_USAGE_DUMP_BATCH_SIZE = 100;

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
  allowRemoteProxy?: boolean;
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
  await preflightCfigmaExport({
    cfigmaBin: cfg.cfigmaBin,
    tabPattern: tab.key,
    nodeId: preflightExportNodeId(raw),
    bridge: cfg.bridge,
  });
  let registry = await loadRegistry(componentsDir);
  const { ensureRegistryForRaw } = await import("./generate.ts");
  const ensured = await ensureRegistryForRaw(raw, {
    registry,
    componentsDir,
    cfigmaBin: cfg.cfigmaBin,
    cwd: root,
  });
  registry = ensured.registry;
  const detachUnregisteredInstances = ensured.missingComponentRoots.length > 0;
  const designContext = await loadCompileDesignContext(root, componentsDir);
  const typeTransformer = new DesignAstTypeTransformer();
  // Compute the component name from the raw figma name up-front so the
  // shared `assets/` dir is known before compile starts writing into it.
  const componentName = await resolveComponentName(
    componentsDir,
    pascalize(raw.name),
    raw.key,
    nodeId,
  );
  const componentDir = join(componentsDir, componentName);
  await mkdir(componentDir, { recursive: true });
  const masterAssetsDir = join(componentDir, "assets");
  const caseAssetsDir = join(componentDir, ".pixpec", "case-assets");
  await rm(masterAssetsDir, { recursive: true, force: true });
  await rm(caseAssetsDir, { recursive: true, force: true });
  const component = await buildComponentSource(
    raw,
    registry,
    designContext,
    masterAssetsDir,
    opts.allowRemoteProxy === true,
    { cfigmaBin: cfg.cfigmaBin ?? "cfigma", tab: tab.key },
    detachUnregisteredInstances,
  );
  const analysisRegistry = component.key
    ? new Map([...registry].filter(([key]) => key !== component.key))
    : registry;

  const scan = component.key
    ? await scanAllOpenTabsForInit({
        componentSetKey: component.key,
        cfigmaBin: cfg.cfigmaBin,
      })
    : undefined;

  const tabByKey = new Map(tabs.map((t) => [t.key, t]));
  const usecases: UsecaseSource[] = [];
  const usageRawById = await dumpUsageRawsForInit(scan?.usages ?? [], tabByKey, cfg);
  for (const u of scan?.usages ?? []) {
    if (!u.fileKey) continue;
    const usageRaw = usageRawById.get(`${u.fileKey}:${u.id}`);
    if (!usageRaw) continue;
    usecases.push({
      figmaId: `${u.fileKey}:${u.id}`,
      variantKey: u.mainKey,
      raw: usageRaw,
      ir: await compileUsageForInit(
        usageRaw,
        analysisRegistry,
        designContext,
        caseAssetsDir,
        { cfigmaBin: cfg.cfigmaBin ?? "cfigma", tab: u.fileKey },
        detachUnregisteredInstances,
      ),
      render: parseRenderBox(usageRaw),
    });
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
      componentName,
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
      const usecase = makeUsecaseWithParser(
        parser,
        component.defs,
        meta.variant,
        u,
        cfg.remBase ?? 16,
      );
      return usecase ? [usecase] : [];
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
    const { prepareGenerateContext, runGeneratePrepared } = await import("./generate.ts");
    const generateContext = await prepareGenerateContext({
      cwd: root,
      registry: analysisRegistry,
    });
    const jobs = variantMetas.flatMap((meta) =>
      cfg.targets.map((target) => ({ meta, target })),
    );
    const generated = await mapLimit(
      jobs,
      Number(process.env.PIXPEC_INIT_GENERATE_PARALLEL ?? 4),
      async ({ meta, target }) => {
        const result = await runGeneratePrepared(`${fileKey}:${meta.variant.id}`, {
          target,
          componentName,
          outputDir: join(componentDir, meta.path, target),
          outName: "index",
          propsFile: join(componentDir, "schema.ts"),
          ast: meta.ast,
          // Variant codegen reads asset bytes from the component's shared
          // assets dir (compile wrote them there during init's variant pass).
          assetsDir: masterAssetsDir,
          format: false,
        }, generateContext);
        return { target, outPath: result.outPath };
      },
    );
    for (const target of cfg.targets) {
      const count = generated.filter((item) => item.target === target).length;
      console.log(`[init] generated ${componentName} [${target}] ${count} variants`);
    }
  }

  for (const target of cfg.targets) {
    const implDir = join(componentDir, "impl", target);
    await mkdir(implDir, { recursive: true });
    const implSource = emitImpl(componentName, component.defs, variantMetas, target);
    // prettier parses TS/TSX only; gpui emits Rust so it must skip fmt().
    const formatted = target === "gpui" ? implSource : await fmt(implSource);
    await writeFile(
      join(implDir, target === "gpui" ? "mod.rs" : "index.tsx"),
      formatted,
    );
  }

  if (!opts.skipVerify && process.env.PIXPEC_SKIP_INIT_VERIFY !== "1") {
    if (process.env.PIXPEC_INIT_VERIFY_IN_PROCESS === "1") {
      const { runVerify } = await import("./verify.ts");
      await runVerify(componentName);
    } else {
      await runCurrentCliChild(["verify", componentName], { cwd: root });
    }
  }

  return {
    componentName,
    componentDir,
    variantCount: component.variants.length,
  };
}

function preflightExportNodeId(raw: RawNode): string {
  if (raw.type === "COMPONENT_SET") {
    const firstVariant = (raw.children ?? []).find(
      (child) => child.type === "COMPONENT",
    );
    if (firstVariant) return firstVariant.id;
  }
  return raw.id;
}

async function dumpUsageRawsForInit(
  usages: Array<{ id: string; fileKey?: string | null }>,
  tabByKey: Map<string, { key: string }>,
  cfg: PixpecConfig,
): Promise<Map<string, RawNode>> {
  const out = new Map<string, RawNode>();
  const byFileKey = groupBy(
    usages.filter((usage): usage is { id: string; fileKey: string } => !!usage.fileKey && tabByKey.has(usage.fileKey)),
    (usage) => usage.fileKey,
  );
  for (const [fileKey, group] of byFileKey) {
    const tab = tabByKey.get(fileKey);
    if (!tab) continue;
    const ids = [...new Set(group.map((usage) => usage.id))];
    for (let start = 0; start < ids.length; start += INIT_USAGE_DUMP_BATCH_SIZE) {
      const chunk = ids.slice(start, start + INIT_USAGE_DUMP_BATCH_SIZE);
      const dumped = await dumpMany({
        cfigmaBin: cfg.cfigmaBin ?? "cfigma",
        tab: tab.key,
        nodeIds: chunk,
      });
      for (const [id, raw] of dumped) out.set(`${fileKey}:${id}`, raw);
    }
  }
  return out;
}

async function buildComponentSource(
  raw: RawNode,
  registry: Awaited<ReturnType<typeof loadRegistry>>,
  designContext: CompileDesignContext,
  masterAssetsDir: string,
  allowRemoteProxy = false,
  exportContext?: { cfigmaBin: string; tab: string },
  detachUnregisteredInstances = false,
) {
  if (raw.remote && !allowRemoteProxy) {
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
      ir: await compileForInit(
        variantRaw,
        registry,
        designContext,
        masterAssetsDir,
        exportContext,
        detachUnregisteredInstances,
      ),
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
  assetsDir: string,
  exportContext?: { cfigmaBin: string; tab: string },
  detachUnregisteredInstances = false,
): Promise<DNode> {
  return compile(raw, {
    registry,
    tokenMap: design.tokenMap,
    tokenValueMap: design.tokenValueMap,
    tokenColorMap: design.tokenColorMap,
    typographyMap: design.typographyMap,
    writeAsset: makeAssetWriter(assetsDir),
    detachUnregisteredInstances,
    exportSvg: exportContext
      ? (id) =>
          exportNodeSvg({
            cfigmaBin: exportContext.cfigmaBin,
            tab: exportContext.tab,
            nodeId: id,
          })
      : undefined,
  });
}

async function compileUsageForInit(
  raw: RawNode,
  registry: Awaited<ReturnType<typeof loadRegistry>>,
  design: CompileDesignContext,
  assetsDir: string,
  exportContext?: { cfigmaBin: string; tab: string },
  detachUnregisteredInstances = false,
): Promise<DNode> {
  return compile(raw, {
    registry,
    detachRootInstance: true,
    detachUnregisteredInstances,
    tokenMap: design.tokenMap,
    tokenValueMap: design.tokenValueMap,
    tokenColorMap: design.tokenColorMap,
    typographyMap: design.typographyMap,
    writeAsset: makeAssetWriter(assetsDir),
    exportSvg: exportContext
      ? (id) =>
          exportNodeSvg({
            cfigmaBin: exportContext.cfigmaBin,
            tab: exportContext.tab,
            nodeId: id,
          })
      : undefined,
  });
}

/** Build a writeAsset hook that persists bytes to `<dir>/<kind>_<hash>.<ext>`
 *  and returns the bare filename. Identical bytes dedupe to a single file.
 *  The hook writes lazily — once per filename per process. */
function makeAssetWriter(assetsDir: string) {
  const seen = new Set<string>();
  return async (bytes: Uint8Array, ext: string): Promise<string> => {
    const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 16);
    const kind = ext === "svg" ? "svg" : "image";
    const filename = `${kind}_${hash}.${ext}`;
    if (!seen.has(filename)) {
      await mkdir(assetsDir, { recursive: true });
      await writeFile(join(assetsDir, filename), bytes);
      seen.add(filename);
    }
    return filename;
  };
}

export async function loadCompileDesignContext(
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
  const masterRoot = masterNodes.get("$root");
  const counts = new Map<string, { source: PromotedField; count: number }>();
  for (const usecase of usecases) {
    const usageNodes = indexDNodes(usecase.ir);
    const usageNodesByBareId = indexDNodesByBareId(usecase.ir);
    const seen = new Set<string>();
    for (const [nodeId, masterNode] of masterNodes) {
      if (nodeId !== "$root" && masterNode === masterRoot) continue;
      const usageNode =
        usageNodes.get(nodeId) ?? usageNodesByBareId.get(stripPrefix(nodeId));
      if (!usageNode || usageNode.kind !== masterNode.kind) continue;
      for (const rawDiff of masterNode.visualDiff(usageNode)) {
        // cornerRadius can be scalar OR a CornerRadii composite; if either
        // side is composite, split into 4 per-corner diffs so promotion can
        // produce primitive (length) props instead of one opaque object.
        const splits =
          rawDiff.field === "cornerRadius" &&
          (isCornerRadiiObj(rawDiff.before) || isCornerRadiiObj(rawDiff.after))
            ? (["tl", "tr", "br", "bl"] as const).map((corner) => ({
                field: `cornerRadius.${corner}`,
                before: cornerOf(rawDiff.before, corner),
                after: cornerOf(rawDiff.after, corner),
              })).filter((d) => stableJsonStr(d.before) !== stableJsonStr(d.after))
            : [rawDiff];
        for (const diff of splits) {
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
  }
  const promoted = [...counts.values()]
    .filter((x) => x.count / usecases.length >= 0.2)
    .map((x) => x.source);
  const byProp = groupBy(promoted, (p) => p.prop);
  const conflicts = [...byProp.entries()].filter(
    ([, items]) => items.length > 1,
  );
  if (conflicts.length > 0) {
    const details = conflicts
      .map(([prop, items]) => {
        const sources = items
          .map((item) => `${item.nodeId}:${item.field}`)
          .join(", ");
        return `${prop} <= ${sources}`;
      })
      .join("\n");
    throw new Error(
      `pixpec init: ambiguous promoted prop name(s). Rename the source layers ` +
        `or adjust promotion naming so each promoted field has a unique prop.\n${details}`,
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
  componentName: string,
  defs: Record<string, PropDef>,
  exposedSlots: Record<string, ExposedSlot>,
  promotions: PromotedField[],
): DNode {
  const data = dataScopeEntries(variant, defs, exposedSlots, promotions);
  return {
    kind: NodeKind.DataScope,
    componentName,
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
  // Special-case cornerRadius.<corner>: scalar/undefined master must first
  // be upgraded to a CornerRadii composite (spreading the scalar to every
  // corner) so individual corners can be promoted to per-prop expressions
  // without losing the existing radius on untouched corners.
  if (parts.length === 2 && parts[0] === "cornerRadius") {
    const existing = target.cornerRadius;
    if (!existing || !isCornerRadiiObj(existing)) {
      const scalar = existing ?? null;
      target.cornerRadius = { tl: scalar, tr: scalar, br: scalar, bl: scalar };
    }
  }
  // Same shape-upgrade for flip: master without any flip needs a stub
  // composite so flip.x / flip.y promotions can be written as expressions.
  if (parts.length === 2 && parts[0] === "flip") {
    const existing = target.flip;
    if (!existing || typeof existing !== "object") {
      target.flip = { x: false, y: false };
    }
  }
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
  return (
    typeof value.value === "number" && (value.unit === "px" || value.unit === "%")
  );
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
    props,
    figmaId,
    render: parseRenderBox(variant.raw),
    sourceHash: hashRawNode(variant.raw),
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
    props,
    figmaId: usecase.figmaId,
    render: parseRenderBox(usecase.raw),
    sourceHash: hashRawNode(usecase.raw),
  };
}

function hashRawNode(raw: RawNode): string {
  return createHash("sha1").update(stableJson(raw)).digest("hex");
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
  if (target === "gpui") {
    return emitGpuiImpl(componentName, defs, variants);
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
    .map((v) => `import { ${componentName} as V_${v.id} } from '${v.importPath}'`)
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
    .map((v) => `import { ${componentName} as V_${v.id} } from '${v.importPath}'`)
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

function emitGpuiImpl(
  componentName: string,
  defs: Record<string, PropDef>,
  variants: Array<{ variant: VariantSource; path: string; ast: DNode }>,
): string {
  // GPUI dispatcher: include each variant's generated `index.rs` as a `#[path]`
  // submodule (each defines its own `pub struct Generated; impl Render`),
  // expose a public component struct keyed on the variant props, and pick a
  // variant at render time by composing the same `Name=Value|…` key the
  // react-panda dispatcher uses. Variant `Generated` types differ per
  // submodule, so we erase them via `cx.new(|_| …).into_any_element()` —
  // `Entity<V: Render>` implements `IntoElement` in gpui.
  const variantProps = Object.entries(defs)
    .filter(([, def]) => def.kind === "variant")
    .map(([name]) => name);
  const entries = variants.map((v) => ({
    modName: `v_${safeId(v.variant.key ?? v.variant.id).toLowerCase()}`,
    importPath: `../../${v.path}/gpui/index.rs`,
    key: variantProps
      .map((name) => `${name}=${String(v.variant.props[name])}`)
      .join("|"),
  }));
  // Dedupe by key so a duplicate match arm never sneaks in (which would be a
  // hard compile error). Init guarantees unique variant-prop combos so this
  // only matters when variantProps is empty (all keys collapse to "").
  const seen = new Set<string>();
  const dedup = entries.filter((e) => {
    if (seen.has(e.key)) return false;
    seen.add(e.key);
    return true;
  });
  const modDecls = entries
    .map((e) => `#[path = ${JSON.stringify(e.importPath)}]\nmod ${e.modName};`)
    .join("\n");
  const fields = variantProps
    .map((name) => `    pub ${name}: String,`)
    .join("\n");
  // Empty braced struct is valid Rust and keeps `Default` derivable for the
  // zero-variant-prop case.
  const structBody = fields ? `{\n${fields}\n}` : "{}";
  const keyExpr =
    variantProps.length === 0
      ? `String::new()`
      : `format!(${JSON.stringify(
          variantProps.map((n) => `${n}={}`).join("|"),
        )}, ${variantProps.map((n) => `self.${n}`).join(", ")})`;
  const arms = dedup
    .map(
      (e) =>
        `            ${JSON.stringify(e.key)} => cx.new(|_| ${e.modName}::Generated).into_any_element(),`,
    )
    .join("\n");
  const fallback = entries[0]
    ? `cx.new(|_| ${entries[0].modName}::Generated).into_any_element()`
    : `gpui::div().into_any_element()`;
  return `// AUTO-GENERATED by pixpec init.
// Component: ${componentName}

#![allow(unused_imports, non_snake_case)]

use gpui::{div, AnyElement, Context, IntoElement, Render, Window};
use gpui::prelude::*;

${modDecls}

#[derive(Clone, Default)]
pub struct ${componentName} ${structBody}

impl Render for ${componentName} {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let key = ${keyExpr};
        match key.as_str() {
${arms}
            _ => ${fallback},
        }
    }
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
  const masterRoot = masterNodes.get("$root");
  const usageNodes = indexDNodes(usage);
  const usageNodesByBareId = indexDNodesByBareId(usage);
  for (const [nodeId, masterNode] of masterNodes) {
    if (nodeId !== "$root" && masterNode === masterRoot) continue;
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

async function resolveComponentName(
  componentsDir: string,
  baseName: string,
  componentSetKey: string | undefined,
  nodeId: string,
): Promise<string> {
  const base = baseName || "Component";
  if (!componentSetKey) return base;
  let candidate = base;
  let suffix = sanitize(nodeId).replace(/_/g, "") || "Source";
  let index = 1;
  while (true) {
    const pixpecPath = join(componentsDir, candidate, "pixpec.json");
    if (!existsSync(pixpecPath)) return candidate;
    try {
      const parsed = JSON.parse(await readFile(pixpecPath, "utf8")) as {
        figma?: { componentSetKey?: string | string[]; componentSetId?: string };
      };
      const keys = Array.isArray(parsed.figma?.componentSetKey)
        ? parsed.figma?.componentSetKey
        : parsed.figma?.componentSetKey
          ? [parsed.figma.componentSetKey]
          : [];
      if (
        keys.includes(componentSetKey) &&
        (!parsed.figma?.componentSetId || parsed.figma.componentSetId === nodeId)
      ) {
        return candidate;
      }
    } catch (_) {
      return candidate;
    }
    candidate = `${base}${suffix}${index === 1 ? "" : index}`;
    index += 1;
  }
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
  const promotedCssFields = new Map<string, StaticCssProperty>();
  for (const promotion of promotions) {
    const property = cssPropertyForField(promotion.field);
    if (property) promotedCssFields.set(promotion.prop, property);
  }
  for (const c of cases) {
    for (const [key, value] of Object.entries(c.props)) {
      const property = isStaticCssProperty(key)
        ? key
        : promotedCssFields.get(key);
      if (!property) continue;
      const normalized = staticCssValueFromProp(value);
      if (normalized !== undefined) out[property].add(normalized);
    }
  }
}

/** Normalize a usecase prop value into a string the Panda cssgen will look up
 *  as a static value. Strings pass through; length literals get rendered as
 *  rem (matching codegen) so cssgen emits the corresponding utility class. */
function staticCssValueFromProp(value: unknown): string | undefined {
  if (typeof value === "string") {
    // Bare token path (e.g. "content.standard.primary") — Panda recognises
    // these as design tokens and emits the var() form for matching utility
    // classes. Pass through so staticCss enumerates the token.
    if (isStaticCssValue(value) || looksLikeTokenPath(value)) return value;
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if (rec.kind === "literal" && rec.value && typeof rec.value === "object") {
    const v = rec.value as Record<string, unknown>;
    if (typeof v.value === "number" && typeof v.unit === "string") {
      if (v.unit === "px") return `${+(v.value / 16).toFixed(6)}rem`;
      if (v.unit === "rem") return `${+v.value.toFixed(6)}rem`;
      return `${v.value}${v.unit}`;
    }
    // Literal RGB color → CSS string Panda can extract as a utility class.
    // Without this, raw figma colors with no token binding never reach
    // staticCss and render as inherited (black) at runtime.
    if (typeof v.r === "number" && typeof v.g === "number" && typeof v.b === "number") {
      const a = typeof v.a === "number" ? v.a : 1;
      if (a >= 1) {
        return `#${[v.r, v.g, v.b].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
      }
      // Match capture's colorRecordToCss formatting (no spaces) so the
      // staticCss-registered value and the runtime prop value land in the
      // exact same Panda class lookup key.
      return `rgba(${v.r},${v.g},${v.b},${+a.toFixed(6)})`;
    }
  }
  return undefined;
}

function looksLikeTokenPath(value: string): boolean {
  return (
    value.includes(".") &&
    !value.startsWith("#") &&
    !value.startsWith("rgb") &&
    !value.startsWith("hsl") &&
    !value.startsWith("var(") &&
    !/^\d/.test(value) &&
    !/[\s/(]/.test(value)
  );
}

function cssPropertyForField(field: string): StaticCssProperty | undefined {
  if (isStaticCssProperty(field)) return field;
  return FIELD_TO_CSS_PROPERTY[field];
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
  const lengthLiteral = `z.object({ value: z.number(), unit: z.union([z.literal("px"), z.literal("%")]) })`;
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

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function literal(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "undefined";
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

const stableJsonStr = stableJson;

function isCornerRadiiObj(v: unknown): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !("kind" in (v as Record<string, unknown>)) &&
    ("tl" in (v as Record<string, unknown>) ||
      "tr" in (v as Record<string, unknown>) ||
      "br" in (v as Record<string, unknown>) ||
      "bl" in (v as Record<string, unknown>))
  );
}

function cornerOf(v: unknown, corner: "tl" | "tr" | "br" | "bl"): unknown {
  if (isCornerRadiiObj(v)) return (v as Record<string, unknown>)[corner];
  return v;
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
