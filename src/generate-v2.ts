/**
 * `pixpec generate-v2 <fileKey>:<nodeId>` — new pipeline:
 *   dumper (raw figma) → compiler (Design AST) → emitter (target source).
 *
 * Sits alongside the legacy `pixpec generate` until the new pipeline reaches
 * full parity. Emitter is selected via `pixpec.toml#emitter` (default
 * `react-panda`); other targets (Slint, Flutter, etc.) plug in by registering
 * in `src/emitter/index.ts`.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { dump } from './dumper/index.ts'
import { compile, loadRegistry } from './compiler/index.ts'
import { getEmitter } from './emitter/index.ts'
import { loadConfig } from './init.ts'
import { listFigmaTabs } from './cfigma-meta.ts'

export interface GenerateV2Options {
  /** Override the emitter chosen via pixpec.toml. */
  emitter?: string
  /** Component the generated file slots into. Defaults to the figma node's
   *  containing component (resolved from componentSet membership). */
  componentName?: string
  /** Output filename (without dir). Defaults to a sanitized figmaId. */
  outName?: string
}

export async function runGenerateV2(componentId: string, opts: GenerateV2Options = {}): Promise<{
  componentName: string
  outPath: string
  source: string
}> {
  const { cfg, root } = await loadConfig()
  const componentsDir = resolve(root, cfg.componentsDir ?? 'src/components')

  const firstColon = componentId.indexOf(':')
  if (firstColon < 0) throw new Error(`pixpec generate-v2: componentId must be <fileKey>:<nodeId>; got ${componentId}`)
  const fileKey = componentId.slice(0, firstColon)
  const nodeId = componentId.slice(firstColon + 1)

  // Resolve tab from fileKey.
  const tabs = await listFigmaTabs({ cfigmaBin: cfg.cfigmaBin })
  const tab = tabs.find((t) => t.key === fileKey)
  if (!tab) throw new Error(`pixpec generate-v2: no open figma tab matches fileKey ${fileKey}`)

  // Load token map (figma var id → semantic path) + intrinsic numeric values.
  const tokenMap: Record<string, string> = {}
  const tokenValueMap: Record<string, number> = {}
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
        }
      }
    }
  } catch { /* tokens file is optional */ }

  // Load typography map (textStyleId → typography component name).
  let typographyMap: Record<string, string> = {}
  try {
    typographyMap = JSON.parse(await readFile(resolve(componentsDir, 'typography/figma-binding.json'), 'utf8'))
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

  // Dump → compile → emit.
  const raw = await dump({ cfigmaBin: cfg.cfigmaBin ?? 'cfigma', tab: tab.key, nodeId })
  const ast = compile(raw, { registry, bindings: bindingsForNode, tokenMap, tokenValueMap })
  const emitterName = opts.emitter ?? (cfg as { emitter?: string }).emitter ?? 'react-panda'
  const emitter = getEmitter(emitterName)
  const result = await emitter.emit(ast, {
    componentName,
    designSystem: { tokens: tokenMap, typography: typographyMap },
    registry: new Map(
      [...registry].map(([, v]) => [v.componentName, { componentName: v.componentName, dir: v.dir, hasProps: true }]),
    ),
    plugins: plugins as never,
    remBase: cfg.remBase,
  })

  // Land in <componentsDir>/<componentName>/generated/<safeId>.<ext>
  const safeId = (fileKey + '_' + nodeId).replace(/[^A-Za-z0-9]/g, '_')
  const outName = opts.outName ?? `${safeId}.${result.fileExtension}`
  const outDir = resolve(componentsDir, componentName, 'generated')
  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, outName)
  await writeFile(outPath, result.source)
  for (const sc of result.sidecars ?? []) {
    const scPath = resolve(outDir, sc.relativePath)
    await mkdir(dirname(scPath), { recursive: true })
    await writeFile(scPath, sc.content)
  }
  return { componentName, outPath, source: result.source }
}

function hasDescId(root: import('./dumper/raw-node.ts').RawNode, id: string): boolean {
  if (root.id === id) return true
  if (!root.children) return false
  for (const c of root.children) if (hasDescId(c, id)) return true
  return false
}
