/**
 * Generator CLI: walk a figma node, write a real pixpec component to
 * src/components/<Name>/ that the runner can verify like any other.
 *
 *   pnpm pixpec generate <nodeId> [--name Generated] [--tab Sandbox]
 *
 * Produces:
 *   src/components/<Name>/
 *     impl.tsx     # generated React FC (the component under test)
 *     index.ts     # defineComponent({name, cases, noise: ()=>1e6})
 *     cases.ts     # single Case pointing to the source figma nodeId
 *
 * After generation, run the standard pipeline to verify:
 *   pnpm pixpec dump-chromium <Name>
 *   pnpm pixpec dump-figma <Name> [tab]
 *   pnpm pixpec-measure .pixpec-out/<Name>
 *
 * Goal: max Lab dE/px < 1 across generated nodes. If higher, the
 * recognizer/codegen needs to refine (or a missing figma binding to
 * register).
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadConfig } from '../init.ts'
import type { Component } from '../types.ts'
import { walk, buildRegistry } from './walker.ts'
import { generate } from './codegen.ts'
import type { IRNode } from './ir.ts'

const isComponent = (v: unknown): v is Component<unknown> =>
  !!v && typeof v === 'object' && 'name' in v && 'cases' in v && 'noise' in v

export interface FigmaPayload {
  ir: IRNode
  fileKey: string
  wrapper: { width?: number; height?: number; padding: number; bg: string }
}

/** Cache path used by `breakdown-prepare` to stash a per-node {ir, fileKey,
 * wrapper} so `runGenerate` can run later without any cfigma calls. */
export function breakdownCachePath(root: string, nodeId: string): string {
  const safe = nodeId.replace(/[^A-Za-z0-9]/g, '_')
  return resolve(root, '.pixpec-out/_breakdown-cache/ir', `${safe}.json`)
}

export async function discoverComponents(root: string, componentsDir: string): Promise<Component<unknown>[]> {
  const { readdir } = await import('node:fs/promises')
  const components: Component<unknown>[] = []
  const ents = await readdir(resolve(root, componentsDir), { withFileTypes: true })
  for (const ent of ents) {
    if (!ent.isDirectory()) continue
    try {
      const modPath = resolve(root, componentsDir, ent.name, 'index.ts')
      const mod = await import(modPath) as Record<string, unknown>
      const c = (mod.default || mod[ent.name] || Object.values(mod).find(isComponent)) as Component<unknown>
      if (c && isComponent(c)) components.push(c)
    } catch { /* skip non-component dirs */ }
  }
  return components
}

export async function runGenerate(
  nodeId: string,
  opts: { tab?: string; name?: string; payload?: FigmaPayload; components?: Component<unknown>[] } = {},
): Promise<{ jsx: string; ir: IRNode; componentDir: string; componentName: string }> {
  const { cfg, root } = await loadConfig()
  const componentName = opts.name ?? `Gen_${nodeId.replace(/[^A-Za-z0-9]/g, '_')}`
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentDir = resolve(root, componentsDir, componentName)

  const components = opts.components ?? await discoverComponents(root, componentsDir)
  if (!opts.components) {
    console.log(`[generate] loaded ${components.length} components, ${components.filter(c => c.figma).length} with figma bindings`)
  }
  const registry = buildRegistry(components)


  // Optional codegen plugins from `pixpec.config.ts` in project root.
  // Plugins extend the walker (figma data extraction) and codegen (JSX
  // wrapping) for DS-specific conventions. See CodegenPlugin type.
  type Plugin = import('../types.ts').CodegenPlugin
  let plugins: Plugin[] = []
  const pluginConfigPath = resolve(root, 'pixpec.config.ts')
  const { existsSync: exists } = await import('node:fs')
  if (exists(pluginConfigPath)) {
    const mod = (await import(pluginConfigPath)) as { default?: { plugins?: Plugin[] }; plugins?: Plugin[] }
    plugins = mod.default?.plugins ?? mod.plugins ?? []
    console.log(`[generate] loaded ${plugins.length} codegen plugins: ${plugins.map(p => p.name).join(', ')}`)
  }
  const walkExtend = plugins.map(p => p.walkExtend ?? '').filter(Boolean).join('\n')

  const tab = opts.tab ?? cfg.tabPattern
  // Resolve the (ir, fileKey, wrapper) bundle. Priority:
  //   1. opts.payload — caller already has it (in-memory pass).
  //   2. .pixpec-out/_breakdown-cache/ir/<safeId>.json — pre-warmed by
  //      `breakdown-prepare`; avoids any cfigma call here.
  //   3. live figma — fall back to walking + bridge SVG export + getFileKey.
  const cachedPath = breakdownCachePath(root, nodeId)
  const cacheExists = (await import('node:fs')).existsSync(cachedPath)
  let payload: FigmaPayload
  if (opts.payload) {
    payload = opts.payload
  } else if (cacheExists) {
    payload = JSON.parse(await (await import('node:fs/promises')).readFile(cachedPath, 'utf8'))
    console.log(`[generate] using cached IR (.pixpec-out/_breakdown-cache/ir/${nodeId.replace(/[^A-Za-z0-9]/g, '_')}.json)`)
  } else {
    if (!cfg.cfigmaBin) throw new Error('pixpec.toml: cfigmaBin required (no cached IR for this nodeId)')
    const ir = await walk({ cfigmaBin: cfg.cfigmaBin, tab, nodeId, registry, walkExtend })
    if (ir.kind === 'text') {
      throw new Error(`Cannot generate from a bare TEXT node. figma exportAsync trims to ink bbox (render bounds), making dim-parity with chromium's line-box impossible. Wrap the text in a frame first, then generate from the frame's nodeId.`)
    }
    await resolveImages(ir, tab)
    const fileKey = await getFileKey(cfg.cfigmaBin, tab)
    const wrapper = await getNodeDim(cfg.cfigmaBin, tab, nodeId)
    payload = { ir, fileKey, wrapper }
  }
  const { ir } = payload
  const wrapper = payload.wrapper
  const fileKey = payload.fileKey
  if (ir.kind === 'text') {
    throw new Error(`Cannot generate from a bare TEXT node. figma exportAsync trims to ink bbox (render bounds), making dim-parity with chromium's line-box impossible. Wrap the text in a frame first, then generate from the frame's nodeId.`)
  }
  // Optional typography binding: textStyleId → wrapper component name.
  let typographyMap: Record<string, string> = {}
  try {
    const path = resolve(root, componentsDir, 'typography/figma-binding.json')
    typographyMap = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
    console.log(`[generate] loaded ${Object.keys(typographyMap).length} typography bindings`)
  } catch { /* optional */ }
  // Optional design-token binding: figma variable id → panda token path.
  // Source: tokens/figma-tokens.json (variable list with id+name). The figma
  // variable name uses '/' separators and matches the panda token path with
  // case-folded segments — "Background/Standard/Primary" → "background.standard.primary".
  let tokenMap: Record<string, string> = {}
  // Numeric token values keyed by figma variable id. Codegen compares
  // figma's effective node value (e.g. 6.857 from a scaled instance) to
  // the variable's intrinsic value (e.g. radius/200 → 6); when they
  // diverge, codegen emits the raw value instead of the token path so
  // the rendered CSS reflects figma's scaled raster.
  let tokenValueMap: Record<string, number> = {}
  try {
    const path = resolve(root, 'tokens/figma-tokens.json')
    const ft = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')) as { variables: { id: string; name: string; key?: string; resolvedType: string; valuesByMode?: Record<string, unknown> }[] }
    for (const v of ft.variables) {
      const tokenPath = v.name
        // Strip control characters (figma variable names sometimes carry a
        // leading \b sort marker) and whitespace within segments.
        .replace(/[\x00-\x1f]/g, '')
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
    console.log(`[generate] loaded ${Object.keys(tokenMap).length} design-token bindings (${Object.keys(tokenValueMap).length} numeric)`)
  } catch { /* optional */ }
  const jsx = generate(ir, components, typographyMap, tokenMap, plugins, cfg.remBase, tokenValueMap)

  await mkdir(componentDir, { recursive: true })
  // Format generator output with Prettier so the source is human-reviewable.
  // ts-printer + JSX-from-factory produces single-line megaspans otherwise.
  const prettier = await import('prettier')
  const fmt = (src: string, parser: 'typescript' | 'babel-ts') =>
    prettier.format(src, { parser, semi: false, singleQuote: true, printWidth: 100 })
  // Generator emits a full self-contained tsx (with FC type, Generated, impl).
  const implRaw =
`/**
 * AUTO-GENERATED by \`pixpec generate ${nodeId}\`.
 * Source figma node: ${nodeId}
 */
${jsx}export interface GeneratedProps {}
`
  await writeFile(resolve(componentDir, 'impl.tsx'), await fmt(implRaw, 'babel-ts'))
  const casesRaw =
`// AUTO-GENERATED by \`pixpec generate ${nodeId}\`.
import type { Case } from 'pixpec/spec'
import { boxWrapper } from 'pixpec/spec'
import type { GeneratedProps } from './impl.tsx'

export const cases: Case<GeneratedProps>[] = [
  {
    name: ${JSON.stringify(`${componentName}_main`)},
    props: {},
    fileKey: ${JSON.stringify(fileKey)},
    nodeId: ${JSON.stringify(nodeId)},
    wrapper: boxWrapper({ ${wrapper.width !== undefined ? `width: ${wrapper.width}, ` : ''}${wrapper.height !== undefined ? `height: ${wrapper.height}, ` : ''}padding: 0, bg: '#ffffff' }),
  },
]
`
  await writeFile(resolve(componentDir, 'cases.ts'), await fmt(casesRaw, 'typescript'))
  // index.ts: skip if it already exists. Once written, it's user-owned —
  // typically holds a calibrated `noise` threshold that pins this generated
  // node as a regression case. Re-running `generate` should refresh impl.tsx
  // / cases.ts (figma-derived) without clobbering that contract.
  const indexPath = resolve(componentDir, 'index.ts')
  const { existsSync } = await import('node:fs')
  if (!existsSync(indexPath)) {
    await writeFile(indexPath,
`// AUTO-GENERATED.
import { defineComponent, dE00 } from 'pixpec/spec'
import { cases } from './cases.ts'
import type { GeneratedProps } from './impl.tsx'

export type { GeneratedProps }

export const ${componentName} = defineComponent<GeneratedProps>({
  name: ${JSON.stringify(componentName)},
  cases,
  noise: () => dE00(1e6), // generator output: pass-through, dE checked manually
})
`)
  } else {
    console.log(`[generate] index.ts exists, kept user copy (noise threshold preserved)`)
  }
  console.log(`[generate] wrote → ${componentDir}`)
  console.log(`\nNext steps:`)
  console.log(`  1. Add \`export { ${componentName} } from './components/${componentName}/index.ts'\` to src/index.ts`)
  console.log(`  2. pnpm pixpec dump-chromium ${componentName}`)
  console.log(`  3. pnpm pixpec dump-figma ${componentName} ${tab}`)
  console.log(`  4. pnpm pixpec-measure .pixpec-out/${componentName}`)
  return { jsx, ir, componentDir, componentName }
}

/** Query node dim + sizing mode via cfigma exec. Wrapper omits dim on HUG axes
 * so the rendered root expresses its intrinsic size (CSS-equivalent of HUG). */
/** Walk + resolveImages + getFileKey for a root node, returning data needed
 * by `breakdown-prepare` to slice per-subtree caches. Single bridge round
 * for the whole tree (vs N per-node walks). */
export async function buildRootPayload(
  rootNodeId: string,
  tab: string,
): Promise<{ ir: IRNode; fileKey: string }> {
  const { cfg, root } = await loadConfig()
  if (!cfg.cfigmaBin) throw new Error('pixpec.toml: cfigmaBin required')
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const components = await discoverComponents(root, componentsDir)
  const registry = buildRegistry(components)
  type Plugin = import('../types.ts').CodegenPlugin
  let plugins: Plugin[] = []
  const pluginConfigPath = resolve(root, 'pixpec.config.ts')
  if ((await import('node:fs')).existsSync(pluginConfigPath)) {
    const mod = (await import(pluginConfigPath)) as { default?: { plugins?: Plugin[] }; plugins?: Plugin[] }
    plugins = mod.default?.plugins ?? mod.plugins ?? []
  }
  const walkExtend = plugins.map(p => p.walkExtend ?? '').filter(Boolean).join('\n')
  const ir = await walk({ cfigmaBin: cfg.cfigmaBin, tab, nodeId: rootNodeId, registry, walkExtend })
  await resolveImages(ir, tab)
  const fileKey = await getFileKey(cfg.cfigmaBin, tab)
  return { ir, fileKey }
}

/** Compute the chromium wrapper dim from IR alone — no cfigma call. Mirrors
 * `getNodeDim`'s rule (omit dim on HUG axes so the rendered root expresses
 * its intrinsic size). */
export function wrapperFromIr(ir: IRNode): FigmaPayload['wrapper'] {
  const sH = (ir as { layout?: { sizingH?: string } }).layout?.sizingH
    ?? (ir as { sizingH?: string }).sizingH
  const sV = (ir as { layout?: { sizingV?: string } }).layout?.sizingV
    ?? (ir as { sizingV?: string }).sizingV
  const rotation = (ir as { rotation?: number }).rotation
  const isRotated = typeof rotation === 'number' && Math.abs(rotation) >= 0.01
  // For rotated roots we MUST give the boxWrapper an explicit dim — the
  // rotation-wrap codegen uses position:absolute (escaping flex centering),
  // which removes it from the wrapper's intrinsic sizing. A HUG-along-axis
  // root would collapse to 0 dim and produce a degenerate screenshot bbox.
  // Use the IR's resolved dim regardless of HUG, then take post-rotation bbox.
  const rawW = (ir as { width?: number }).width
  const rawH = (ir as { height?: number }).height
  let w = (sH === 'hug' && !isRotated) ? undefined : rawW
  let h = (sV === 'hug' && !isRotated) ? undefined : rawH
  if (isRotated && typeof w === 'number' && typeof h === 'number') {
    const css = (-rotation) * Math.PI / 180
    const c = Math.abs(Math.cos(css)), s = Math.abs(Math.sin(css))
    const snap = (v: number) => Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v
    const rotW = snap(w * c + h * s)
    const rotH = snap(w * s + h * c)
    w = rotW
    h = rotH
  }
  return {
    width: w,
    height: h,
    padding: 0, bg: '#ffffff',
  }
}

/** DFS the IR, yielding (node, subtreeIr) for every node id encountered.
 * `breakdown-prepare` uses this to write a per-subtree cache file from a
 * single root walk. */
export function* walkIrSubtrees(ir: IRNode): Iterable<{ id: string; ir: IRNode }> {
  yield { id: ir.figmaId, ir: standaloneRoot(ir) }
  if (ir.kind === 'frame') {
    for (const c of ir.children) yield* walkIrSubtrees(c)
  }
}

function standaloneRoot(ir: IRNode): IRNode {
  if (!ir.absolute) return ir
  const clone = { ...ir }
  delete clone.absolute
  delete clone.absX
  delete clone.absY
  return clone
}

async function getNodeDim(cfigmaBin: string, tab: string, nodeId: string): Promise<{
  width?: number; height?: number; padding: number; bg: string;
  sH: 'FIXED' | 'HUG' | 'FILL'; sV: 'FIXED' | 'HUG' | 'FILL';
}> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const { stdout } = await execFileAsync(cfigmaBin,
    ['--tab', tab, 'exec', `const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)}); return { width: n.width, height: n.height, sH: n.layoutSizingHorizontal, sV: n.layoutSizingVertical, rotation: typeof n.rotation === 'number' ? n.rotation : 0 };`],
    { encoding: 'utf8',
      env: { ...process.env, CFIGMA_CDP_PORT: process.env.CFIGMA_CDP_PORT ?? '9222' } })
  const r = JSON.parse(stdout) as { width: number; height: number; sH: 'FIXED' | 'HUG' | 'FILL'; sV: 'FIXED' | 'HUG' | 'FILL'; rotation: number }
  // Rotated frames need POST-rotation axis-aligned bbox as the wrapper
  // dim — the codegen rotation wrap renders that bbox.
  let w = r.sH === 'HUG' ? undefined : r.width
  let h = r.sV === 'HUG' ? undefined : r.height
  if (Math.abs(r.rotation) >= 0.01 && typeof w === 'number' && typeof h === 'number') {
    const css = (-r.rotation) * Math.PI / 180
    const c = Math.abs(Math.cos(css)), s = Math.abs(Math.sin(css))
    const rotW = w * c + h * s
    const rotH = w * s + h * c
    const snap = (v: number) => Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v
    w = snap(rotW)
    h = snap(rotH)
  }
  return { width: w, height: h, padding: 0, bg: '#ffffff', sH: r.sH, sV: r.sV }
}

/** Walk IR collecting 'image' kind nodes (figma GROUP/VECTOR/BOOLEAN_OPERATION).
 * Batch-export them as SVG via cfigma bridge, mutate svg in place. Vector
 * output preserves DPR-independent quality and keeps semantic structure. */
async function resolveImages(ir: IRNode, tab: string): Promise<void> {
  const targets: Array<{ node: IRNode & { kind: 'image' } }> = []
  const visit = (n: IRNode): void => {
    if (n.kind === 'image') targets.push({ node: n })
    else if (n.kind === 'frame') for (const c of n.children) visit(c)
  }
  visit(ir)
  if (targets.length === 0) return
  const { getBridge } = await import('../cfigma-bridge.ts')
  const bridge = getBridge()
  const ids = targets.map((t) => t.node.figmaId)
  console.log(`[generate] exporting ${ids.length} image node(s) as SVG via figma.exportAsync…`)
  // SVG export sometimes fails for INSTANCE nodes whose mainComponent is in
  // a remote library (figma reports "no visible layers" even when ink is
  // present). Fall back to PNG (DPR=8) so the layout at least gets a raster.
  const code = `
    const ids = ${JSON.stringify(ids)};
    const dec = new TextDecoder('utf-8');
    const out = [];
    for (const id of ids) {
      const n = await figma.getNodeByIdAsync(id);
      if (!n) { out.push({ id, error: 'not found' }); continue; }
      try {
        const bytes = await n.exportAsync({ format: 'SVG' });
        out.push({ id, svg: dec.decode(bytes) });
      } catch (e) {
        try {
          const png = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 8 }, useAbsoluteBounds: true });
          out.push({ id, png: figma.base64Encode(png) });
        } catch (e2) {
          out.push({ id, error: String(e2?.message ?? e2) });
        }
      }
    }
    return out;
  `
  const res = await bridge.exec<Array<{ id: string; svg?: string; png?: string; error?: string }>>(tab, code)
  const byId = new Map(res.map((r) => [r.id, r]))
  for (const { node } of targets) {
    const r = byId.get(node.figmaId)
    if (r?.svg) {
      const b64 = Buffer.from(r.svg, 'utf-8').toString('base64')
      node.dataUrl = `data:image/svg+xml;base64,${b64}`
    } else if (r?.png) {
      node.dataUrl = `data:image/png;base64,${r.png}`
    } else {
      console.warn(`[generate] image export failed for ${node.figmaId}: ${r?.error ?? 'no result'}`)
    }
  }
}

async function getFileKey(cfigmaBin: string, tab: string): Promise<string> {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(cfigmaBin, ['tabs'], { encoding: 'utf8',
    env: { ...process.env, CFIGMA_CDP_PORT: process.env.CFIGMA_CDP_PORT ?? '9222' } })
  const m = out.split('\n').find(l => l.toLowerCase().includes(tab.toLowerCase()))
  const k = m?.match(/key=(\w+)/)
  if (!k) throw new Error(`could not resolve fileKey for tab '${tab}'`)
  return k[1]
}
