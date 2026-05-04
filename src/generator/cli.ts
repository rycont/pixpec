/**
 * Generator CLI: walk a figma node, emit React+PandaCSS JSX.
 *
 *   pnpm pixpec generate <nodeId> [--tab Sandbox] [--out path.tsx]
 *
 * Loads danah's component registry (via project's index.ts) so all
 * defineComponent() bindings with `figma` are recognized.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadConfig } from '../init.ts'
import type { Component } from '../types.ts'
import { walk, buildRegistry } from './walker.ts'
import { generate } from './codegen.ts'
import type { IRNode } from './ir.ts'

interface RegistryEntry { name: string; figma?: { componentSetKey: string } }
const isComponent = (v: unknown): v is Component<unknown> =>
  !!v && typeof v === 'object' && 'name' in v && 'cases' in v && 'noise' in v

export async function runGenerate(
  nodeId: string,
  opts: { tab?: string; out?: string } = {},
): Promise<{ jsx: string; ir: IRNode }> {
  const { cfg, root } = await loadConfig()
  if (!cfg.cfigmaBin) throw new Error('pixpec.toml: cfigmaBin required')
  const componentsDir = cfg.componentsDir ?? 'src/components'
  // Discover all components: read project's src/index.ts re-exports.
  const registryMod = (await import(resolve(root, 'src/index.ts'))) as Record<string, unknown>
  const components = Object.values(registryMod).filter(isComponent)
  console.log(`[generate] loaded ${components.length} components from registry`)
  const registry = buildRegistry(components)
  console.log(`[generate] figma-bound: ${Object.keys(registry).length} components`)

  const ir = await walk({
    cfigmaBin: cfg.cfigmaBin,
    tab: opts.tab ?? cfg.tabPattern,
    nodeId,
    registry,
  })
  const jsx = generate(ir, components)
  if (opts.out) {
    await writeFile(resolve(root, opts.out), jsx)
    console.log(`[generate] wrote ${opts.out}`)
  } else {
    console.log(jsx)
  }
  return { jsx, ir }
  void componentsDir
}
