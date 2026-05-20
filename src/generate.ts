/**
 * `pixpec generate <fileKey>:<nodeId>` — new pipeline:
 *   src dump (raw figma) → compiler (Design AST) → target codegen.
 *
 * Target is selected via --target when pixpec.toml declares more than one
 * destination target.
 */

import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

function makeGenerateAssetWriter(assetsDir: string) {
  const seen = new Set<string>()
  return async (bytes: Uint8Array, ext: string): Promise<string> => {
    const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 16)
    const kind = ext === 'svg' ? 'svg' : 'image'
    const filename = `${kind}_${hash}.${ext}`
    if (!seen.has(filename)) {
      await mkdir(assetsDir, { recursive: true })
      await writeFile(join(assetsDir, filename), bytes)
      seen.add(filename)
    }
    // Return path relative to the GPUI capture asset base
    // (`<generated_dir>`). The compile-time SVG fold persists bytes under
    // `<generated_dir>/pixpec-assets/`, matching codegen's putTextAsset
    // convention; without the prefix, runtime resolves to the wrong dir and
    // the image silently fails to load (e.g. star/rating icons missing in
    // the composed root frame).
    return `pixpec-assets/${filename}`
  }
}
import { dump, exportNodeSvg } from './dumper/index.ts'
import type { RawNode } from './dumper/raw-node.ts'
import { compile, loadRegistry, type Registry } from './compiler/index.ts'
import {
  resolveRegistryEntryForInstance,
  resolveRegistryVariant,
} from './compiler/registry.ts'
import type { DNode } from './compiler/design-ast.ts'
import { getTarget, resolveConfiguredTargets } from './targets/index.ts'
import { loadConfig } from './init.ts'
import {
  findComponentSetSourceByKey,
  findComponentSetSourceForVariant,
  listFigmaTabs,
} from './cfigma-meta.ts'
import type { ViewCodegenConfig } from './targets/types.ts'

export interface GenerateOptions {
  /** Target to generate. Required for runGenerate. */
  target?: string
  /** Component the generated file slots into. Defaults to the figma node's
   *  containing component (resolved from componentSet membership). */
  componentName?: string
  /** Output filename (without dir). Defaults to a sanitized figmaId. */
  outName?: string
  /** Directory to write generated target output into. Defaults to component generated dir. */
  outputDir?: string
  /** Component-owned prop keys to strip before forwarding root props. */
  propKeys?: string[]
  /** Props file for component output. Set null for view output. */
  propsFile?: string | null
  /** Compile INSTANCE nodes as detached raw subtrees. */
  detachInstances?: boolean
  /** Compile only the root INSTANCE as its resolved raw subtree, inlining any
   * component prop refs with their concrete override values. Intended for
   * breakdown sub-entry standalone rendering. */
  detachRootInstance?: boolean
  /** Where compile-side shared assets live on disk. When omitted, generate
   *  defaults to `<outputDir>/pixpec-assets`. Init passes the component's
   *  shared `assets/` dir so variant codegen reads from there. */
  assetsDir?: string
  /** Override pixpec.toml scale for generated target code. */
  renderScale?: number
  /** Normalized view.config.json data for view-level semantic codegen. */
  viewConfig?: ViewCodegenConfig
  /** Already-compiled Design AST. Used by init so target codegen consumes the
   * exact IR it just wrote, instead of redumping/recompiling the Figma node. */
  ast?: DNode
  /** Pre-dumped raw figma subtree. When set, generate skips the cfigma dump
   * step (~250-500ms per call). Breakdown dumps the full tree once and slices
   * subtrees out for each entry. */
  raw?: RawNode
  /** Pre-resolved figma tab key. Used alongside `raw` so the dump-skip path
   * still has a tab handle for SVG exports. */
  tabKey?: string
  /** Preloaded component registry. Init passes this so per-variant generation
   * does not repeatedly load the component tree it is currently writing. */
  registry?: Registry
  /** Format TypeScript output with Prettier. Defaults to true for CLI output;
   * init disables it for hundreds of generated variant files. */
  format?: boolean
}

export interface GenerateContext {
  cfg: Awaited<ReturnType<typeof loadConfig>>['cfg']
  root: string
  componentsDir: string
  tokenMap: Record<string, string>
  tokenValueMap: Record<string, number>
  tokenColorMap: Record<string, string>
  typographyMap: Record<string, string>
  fontManifest?: unknown
  registry: Registry
  targetRegistry: Map<string, { componentName: string; dir: string; hasProps: boolean }>
}

export interface MissingComponentRoot {
  componentSetKey: string
  variantKey?: string
  variantName?: string
  reason: "missing-component" | "missing-variant"
}

export interface EnsureRegistryResult {
  registry: Registry
  missingComponentRoots: MissingComponentRoot[]
}

export interface GenerateManyOptions extends Omit<GenerateOptions, 'target'> {
  target?: string
}

export async function prepareGenerateContext(opts: {
  cwd?: string
  registry?: Registry
} = {}): Promise<GenerateContext> {
  const { cfg, root } = await loadConfig(opts.cwd)
  const componentsDir = resolve(root, cfg.componentsDir ?? 'src/components')
  const { tokenMap, tokenValueMap, tokenColorMap } = await loadTokenMaps(root)
  const typographyMap = await loadTypographyMap(componentsDir)
  const fontManifest = await loadFontManifest(root)
  const registry = opts.registry ?? await loadRegistry(componentsDir)
  return {
    cfg,
    root,
    componentsDir,
    tokenMap,
    tokenValueMap,
    tokenColorMap,
    typographyMap,
    fontManifest,
    registry,
    targetRegistry: toTargetRegistry(registry),
  }
}

export async function runGenerateTargets(
  componentId: string,
  opts: GenerateManyOptions = {},
): Promise<Array<{ target: string; componentName: string; outPath: string; source: string }>> {
  const { cfg } = await loadConfig()
  const targets = opts.target ? [opts.target] : resolveConfiguredTargets(cfg)
  const results = []
  for (const target of targets) {
    const r = await runGenerate(componentId, { ...opts, target })
    results.push({ target, ...r })
  }
  return results
}

export async function runGenerate(componentId: string, opts: GenerateOptions = {}): Promise<{
  componentName: string
  outPath: string
  source: string
}> {
  const context = await prepareGenerateContext({ registry: opts.registry })
  return runGeneratePrepared(componentId, opts, context)
}

export async function runGeneratePrepared(
  componentId: string,
  opts: GenerateOptions = {},
  context: GenerateContext,
): Promise<{
  componentName: string
  outPath: string
  source: string
}> {
  if (!opts.target) {
    throw new Error('pixpec generate: target is required; use runGenerateTargets for configured targets')
  }
  const { cfg, root, componentsDir } = context

  const firstColon = componentId.indexOf(':')
  if (firstColon < 0) throw new Error(`pixpec generate: componentId must be <fileKey>:<nodeId>; got ${componentId}`)
  const fileKey = componentId.slice(0, firstColon)
  const nodeId = componentId.slice(firstColon + 1)

  let registry = opts.registry ?? context.registry

  // Owning component: prefer caller-provided --name; otherwise the entry
  // whose variant AST contains nodeId.
  let ownerEntry = opts.componentName
    ? [...registry.values()].find((e) => e.componentName === opts.componentName)
    : undefined
  if (!ownerEntry) {
    ownerEntry = [...registry.values()].find((e) =>
      Object.values(e.variants).some((variant) => variant.ast && hasDNodeSourceId(variant.ast, nodeId)),
    )
  }
  const componentName = opts.componentName ?? ownerEntry?.componentName ?? 'Generated'

  // Dump → compile → target codegen.
  const targetName = opts.target
  let ast = opts.ast
  let tab: { key: string } | undefined
  if (!ast) {
    let raw: RawNode
    let detachUnregisteredInstances = false
    if (opts.raw && opts.tabKey) {
      raw = opts.raw
      tab = { key: opts.tabKey }
    } else {
      const tabs = await listFigmaTabs({ cfigmaBin: cfg.cfigmaBin })
      tab = tabs.find((t) => t.key === fileKey)
      if (!tab) throw new Error(`pixpec generate: no open figma tab matches fileKey ${fileKey}`)
      raw = await dump({ cfigmaBin: cfg.cfigmaBin ?? 'cfigma', tab: tab.key, nodeId })
    }
    if (!opts.detachInstances) {
      const ensured = await ensureRegistryForRaw(raw, {
        registry,
        componentsDir,
        cfigmaBin: cfg.cfigmaBin,
        cwd: root,
      })
      registry = ensured.registry
      detachUnregisteredInstances = ensured.missingComponentRoots.length > 0
    }
    context.registry = registry
    context.targetRegistry = toTargetRegistry(registry)
    const tabKey = tab.key
    const safeIdForAssets = (fileKey + '_' + nodeId).replace(/[^A-Za-z0-9]/g, '_')
    // Write under <generated_dir>/pixpec-assets/ so the runtime's
    // AssetSource (rooted at the generated_dir) can resolve the relative
    // path the codegen emits.
    const assetsOutDir = opts.outputDir
      ? join(opts.outputDir, 'pixpec-assets')
      : resolve(componentsDir, componentName, 'generated', 'pixpec-assets')
    void safeIdForAssets
    ast = await compile(raw, {
      registry,
      tokenMap: context.tokenMap,
      tokenValueMap: context.tokenValueMap,
      tokenColorMap: context.tokenColorMap,
      exportSvg: (id) => exportNodeSvg({ cfigmaBin: cfg.cfigmaBin ?? 'cfigma', tab: tabKey, nodeId: id }),
      detachInstances: opts.detachInstances,
      detachRootInstance: opts.detachRootInstance,
      detachUnregisteredInstances,
      writeAsset: makeGenerateAssetWriter(assetsOutDir),
    })
  }
  const target = getTarget(targetName)
  // Land in the caller's outputDir, or a legacy generated dir when invoked
  // directly.
  const safeId = (fileKey + '_' + nodeId).replace(/[^A-Za-z0-9]/g, '_')
  const outDir = opts.outputDir ?? resolve(componentsDir, componentName, 'generated')
  const result = await target.codegen(ast, {
    componentName,
    designSystem: {
      tokens: context.tokenMap,
      tokenValues: context.tokenValueMap,
      tokenColors: context.tokenColorMap,
      typography: context.typographyMap,
      fonts: context.fontManifest,
    },
    registry: context.targetRegistry,
    remBase: cfg.remBase,
    renderScale: opts.renderScale ?? cfg.scale,
    propKeys: opts.propKeys,
    outputDir: outDir,
    rootDir: root,
    componentsDir,
    assetsDir: opts.assetsDir
      ?? (opts.outputDir
        ? join(opts.outputDir, 'pixpec-assets')
        : resolve(componentsDir, componentName, 'generated', 'pixpec-assets')),
    viewConfig: opts.viewConfig,
    propsFile: opts.propsFile === null
      ? undefined
      : opts.propsFile ?? resolve(componentsDir, componentName, 'schema.ts'),
  })

  const outName = opts.outName
    ? opts.outName.includes('.') ? opts.outName : `${opts.outName}.${result.fileExtension}`
    : `${safeId}.${result.fileExtension}`
  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, outName)
  let source = result.source
  if (opts.format !== false && (result.fileExtension === 'ts' || result.fileExtension === 'tsx')) {
    const prettier = await import('prettier')
    source = await prettier.format(source, {
      parser: 'typescript',
      tabWidth: 4,
      semi: false,
      singleQuote: true,
      trailingComma: 'all',
      printWidth: 100,
    })
  }
  await writeFile(outPath, source)
  for (const sc of result.sidecars ?? []) {
    const scPath = resolve(outDir, sc.relativePath)
    await mkdir(dirname(scPath), { recursive: true })
    await writeFile(scPath, sc.content)
  }
  return { componentName, outPath, source }
}

export async function ensureRegistryForRaw(
  raw: RawNode,
  opts: {
    registry: Registry
    componentsDir: string
    cfigmaBin?: string
    cwd: string
  },
): Promise<EnsureRegistryResult> {
  let registry = opts.registry
  const initialized = new Set<string>()
  const missingComponentRoots = new Map<string, MissingComponentRoot>()
  for (let pass = 0; pass < 12; pass += 1) {
    const missing = collectUnresolvedComponentDependencies(raw, registry).filter(
      (dep) => !initialized.has(dependencyKey(dep)),
    )
    if (missing.length === 0) {
      return { registry, missingComponentRoots: [...missingComponentRoots.values()] }
    }
    for (const dep of missing) {
      const source = dep.reason === "missing-variant"
        ? await findComponentSetSourceForVariant({
            componentSetKey: dep.componentSetKey,
            variantKey: dep.variantKey,
            variantName: dep.variantName,
            cfigmaBin: opts.cfigmaBin,
          })
        : await findComponentSetSourceByKey({
            componentSetKey: dep.componentSetKey,
            cfigmaBin: opts.cfigmaBin,
          })
      initialized.add(dependencyKey(dep))
      if (!source) {
        missingComponentRoots.set(dependencyKey(dep), dep)
        console.warn(
          `[generate] dependency root not found in open Figma tabs; will allow detach fallback for ${dep.componentSetKey}`,
        )
        continue
      }
      console.log(
        `[generate] auto-init dependency ${source.name} (${source.fileKey}:${source.nodeId})`,
      )
      const { init } = await import('./init.ts')
      await init({
        componentId: `${source.fileKey}:${source.nodeId}`,
        cwd: opts.cwd,
        skipExisting: true,
        allowRemoteProxy: dep.reason === "missing-variant",
      })
      registry = await loadRegistry(opts.componentsDir)
    }
  }
  throw new Error('pixpec generate: recursive component init exceeded 12 passes')
}

interface ComponentDependency {
  componentSetKey: string
  variantKey?: string
  variantName?: string
  reason: "missing-component" | "missing-variant"
}

function dependencyKey(dep: ComponentDependency): string {
  return [
    dep.reason,
    dep.componentSetKey,
    dep.variantKey ?? "",
    dep.variantName ?? "",
  ].join("\0")
}

function collectUnresolvedComponentDependencies(
  raw: RawNode,
  registry: Registry,
): ComponentDependency[] {
  const out = new Map<string, ComponentDependency>()
  const visit = (node: RawNode) => {
    if (node.type === 'INSTANCE') {
      const key = node.mainComponent?.parentKey ?? node.mainComponent?.key
      if (key) {
        const entry = resolveRegistryEntryForInstance(
          registry,
          key,
          node.mainComponent?.key,
          node.mainComponent?.name,
        )
        if (!entry) {
          const dep: ComponentDependency = {
            componentSetKey: key,
            variantKey: node.mainComponent?.key,
            variantName: node.mainComponent?.name,
            reason: "missing-component",
          }
          out.set(dependencyKey(dep), dep)
        } else if (
          !resolveRegistryVariant(
            entry,
            node.mainComponent?.key,
            node.mainComponent?.name,
          )
        ) {
          const dep: ComponentDependency = {
            componentSetKey: key,
            variantKey: node.mainComponent?.key,
            variantName: node.mainComponent?.name,
            reason: "missing-variant",
          }
          out.set(dependencyKey(dep), dep)
        }
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(raw)
  return [...out.values()]
}

async function loadTokenMaps(root: string): Promise<{
  tokenMap: Record<string, string>
  tokenValueMap: Record<string, number>
  tokenColorMap: Record<string, string>
}> {
  const tokenMap: Record<string, string> = {}
  const tokenValueMap: Record<string, number> = {}
  const tokenColorMap: Record<string, string> = {}
  try {
    const ft = JSON.parse(await readFile(resolve(root, 'tokens/figma-tokens.json'), 'utf8')) as {
      variables: Array<{ id: string; key?: string; name: string; resolvedType: string; valuesByMode?: Record<string, unknown> }>
    }
    for (const v of ft.variables) {
      const tokenPath = v.name.replace(/[\x00-\x1f]/g, '')
        .split('/').map((s) => s.replace(/\s+/g, '').replace(/^./, (c) => c.toLowerCase()))
        .join('.')
      tokenMap[v.id] = tokenPath
      if (v.key) tokenMap[v.key] = tokenPath
      if (v.resolvedType === 'FLOAT' && v.valuesByMode) {
        const num = Object.values(v.valuesByMode).find((x): x is number => typeof x === 'number')
        if (typeof num === 'number') {
          tokenValueMap[v.id] = num
          if (v.key) tokenValueMap[v.key] = num
          tokenValueMap[tokenPath] = num
        }
      }
      if (v.resolvedType === 'COLOR' && v.valuesByMode) {
        const color = Object.values(v.valuesByMode).map(colorTokenToCss).find((x): x is string => !!x)
        if (color) {
          tokenColorMap[v.id] = color
          if (v.key) tokenColorMap[v.key] = color
          tokenColorMap[tokenPath] = color
        }
      }
    }
  } catch { /* tokens file is optional */ }
  return { tokenMap, tokenValueMap, tokenColorMap }
}

async function loadTypographyMap(componentsDir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(resolve(componentsDir, 'typography/figma-binding.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function loadFontManifest(root: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(root, 'src/fonts/__pixpec-fonts.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function toTargetRegistry(registry: Registry): GenerateContext['targetRegistry'] {
  return new Map(
    [...registry].map(([, v]) => [
      v.componentName,
      { componentName: v.componentName, dir: v.dir, hasProps: true },
    ]),
  )
}

function colorTokenToCss(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const c = value as { r?: unknown; g?: unknown; b?: unknown; a?: unknown }
  if (typeof c.r !== 'number' || typeof c.g !== 'number' || typeof c.b !== 'number') return undefined
  const r = Math.round(Math.max(0, Math.min(1, c.r)) * 255)
  const g = Math.round(Math.max(0, Math.min(1, c.g)) * 255)
  const b = Math.round(Math.max(0, Math.min(1, c.b)) * 255)
  const a = typeof c.a === 'number' ? Math.max(0, Math.min(1, c.a)) : 1
  if (a >= 1) return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`
  return `rgba(${r},${g},${b},${+a.toFixed(6)})`
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0')
}

function hasDNodeSourceId(root: import('./compiler/design-ast.ts').DNode, id: string): boolean {
  if (root.sourceId === id) return true
  const children = (root as { children?: unknown }).children
  if (!Array.isArray(children)) return false
  for (const c of children as import('./compiler/design-ast.ts').DNode[]) if (hasDNodeSourceId(c, id)) return true
  return false
}
