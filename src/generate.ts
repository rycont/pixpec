/**
 * `pixpec generate <fileKey>:<nodeId>` — new pipeline:
 *   src dump (raw figma) → compiler (Design AST) → target codegen.
 *
 * Target is selected via --target when pixpec.toml declares more than one
 * destination target.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { dump, exportNodeSvg } from './dumper/index.ts'
import { compile, loadRegistry } from './compiler/index.ts'
import { getTarget, resolveConfiguredTargets } from './targets/index.ts'
import { loadConfig } from './init.ts'
import { listFigmaTabs } from './cfigma-meta.ts'
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
  /** Override pixpec.toml scale for generated target code. */
  renderScale?: number
  /** Normalized view.config.json data for view-level semantic codegen. */
  viewConfig?: ViewCodegenConfig
}

export interface GenerateManyOptions extends Omit<GenerateOptions, 'target'> {
  target?: string
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
  if (!opts.target) {
    throw new Error('pixpec generate: target is required; use runGenerateTargets for configured targets')
  }
  const { cfg, root } = await loadConfig()
  const componentsDir = resolve(root, cfg.componentsDir ?? 'src/components')

  const firstColon = componentId.indexOf(':')
  if (firstColon < 0) throw new Error(`pixpec generate: componentId must be <fileKey>:<nodeId>; got ${componentId}`)
  const fileKey = componentId.slice(0, firstColon)
  const nodeId = componentId.slice(firstColon + 1)

  // Resolve tab from fileKey.
  const tabs = await listFigmaTabs({ cfigmaBin: cfg.cfigmaBin })
  const tab = tabs.find((t) => t.key === fileKey)
  if (!tab) throw new Error(`pixpec generate: no open figma tab matches fileKey ${fileKey}`)

  // Load token map (figma var id → semantic path) + intrinsic numeric values.
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

  // Load typography map (textStyleId → typography component name).
  let typographyMap: Record<string, string> = {}
  try {
    typographyMap = JSON.parse(await readFile(resolve(componentsDir, 'typography/figma-binding.json'), 'utf8'))
  } catch { /* optional */ }

  // Load optional font calibration metadata shared by capture/codegen targets.
  let fontManifest: unknown
  try {
    fontManifest = JSON.parse(await readFile(resolve(root, 'src/fonts/__pixpec-fonts.json'), 'utf8'))
  } catch { /* optional */ }

  // Load codegen plugins from pixpec.config.ts (icon currentColor etc.).
  let plugins: unknown[] = []
  try {
    const cfgPath = resolve(root, 'pixpec.config.ts')
    if (existsSync(cfgPath)) {
      const mod = (await import(cfgPath)) as { default?: { plugins?: unknown[] }; plugins?: unknown[] }
      plugins = mod.default?.plugins ?? mod.plugins ?? []
    }
  } catch { /* optional */ }

  const registry = await loadRegistry(componentsDir)

  // Owning component: prefer caller-provided --name; otherwise the entry
  // whose master-snapshot contains nodeId. Bindings carry variant content
  // / visibility / instance-prop wiring needed for the parametric tree.
  let ownerEntry = opts.componentName
    ? [...registry.values()].find((e) => e.componentName === opts.componentName)
    : undefined
  if (!ownerEntry) {
    ownerEntry = [...registry.values()].find((e) =>
      Object.values(e.masterSnapshot).some((root) => root && (root.id === nodeId || hasDescId(root, nodeId))),
    )
  }
  const bindingsForNode = ownerEntry?.bindings
  const componentName = opts.componentName ?? ownerEntry?.componentName ?? 'Generated'

  // Dump → compile → target codegen.
  const targetName = opts.target
  const raw = await dump({ cfigmaBin: cfg.cfigmaBin ?? 'cfigma', tab: tab.key, nodeId })
  const ast = await compile(raw, {
    registry, bindings: bindingsForNode, tokenMap, tokenValueMap, tokenColorMap,
    exportSvg: (id) => exportNodeSvg({ cfigmaBin: cfg.cfigmaBin ?? 'cfigma', tab: tab.key, nodeId: id }),
    detachInstances: opts.detachInstances || targetName === 'gpui',
  })
  const target = getTarget(targetName)
  // Land in <componentsDir>/<componentName>/generated/<safeId>.<ext> unless
  // the caller delegates a different output directory.
  const safeId = (fileKey + '_' + nodeId).replace(/[^A-Za-z0-9]/g, '_')
  const outDir = opts.outputDir ?? resolve(componentsDir, componentName, 'generated')
  const result = await target.codegen(ast, {
    componentName,
    designSystem: {
      tokens: tokenMap,
      tokenValues: tokenValueMap,
      tokenColors: tokenColorMap,
      typography: typographyMap,
      fonts: fontManifest,
    },
    registry: new Map(
      [...registry].map(([, v]) => [v.componentName, { componentName: v.componentName, dir: v.dir, hasProps: true }]),
    ),
    plugins: plugins as never,
    remBase: cfg.remBase,
    renderScale: opts.renderScale ?? cfg.scale,
    propKeys: opts.propKeys,
    outputDir: outDir,
    rootDir: root,
    componentsDir,
    viewConfig: opts.viewConfig,
    propsFile: opts.propsFile === null
      ? undefined
      : opts.propsFile ?? resolve(componentsDir, componentName, 'props.ts'),
  })

  const outName = opts.outName ?? `${safeId}.${result.fileExtension}`
  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, outName)
  let source = result.source
  if (result.fileExtension === 'ts' || result.fileExtension === 'tsx') {
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

function hasDescId(root: import('./dumper/raw-node.ts').RawNode, id: string): boolean {
  if (root.id === id) return true
  if (!root.children) return false
  for (const c of root.children) if (hasDescId(c, id)) return true
  return false
}
