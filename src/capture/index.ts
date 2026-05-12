import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Component } from '../types.ts'
import { captureFigmaSource } from './figma.ts'
import { getTarget, resolveConfiguredTargets } from '../targets/index.ts'
import { loadConfig } from '../init.ts'

export type CaptureSide = 'src' | 'dst'
export type SourceCaptureBackend = 'figma'
export type DestinationCaptureBackend = string
export type CaptureBackend = SourceCaptureBackend | DestinationCaptureBackend

export interface CaptureOptions {
  backend?: CaptureBackend
  tabPattern?: string
  clearOutDir?: boolean
}

export interface CaptureRunResult {
  componentDir: string
  outDir: string
  backend: CaptureBackend
}

export interface LoadedCaptureComponent {
  root: string
  componentDir: string
  component: Component<unknown>
  cfg: Awaited<ReturnType<typeof loadConfig>>['cfg']
}

export function componentPixpecDir(componentDir: string): string {
  return resolve(componentDir, '.pixpec')
}

export function captureDir(
  componentDir: string,
  side: CaptureSide,
  backend: CaptureBackend,
): string {
  return resolve(componentPixpecDir(componentDir), side, backend)
}

export function verifyMeasureDir(
  componentDir: string,
  srcBackend: SourceCaptureBackend,
  dstBackend: DestinationCaptureBackend,
): string {
  return resolve(componentPixpecDir(componentDir), 'verify', `${srcBackend}__${dstBackend}`, 'measure')
}

export async function loadCaptureComponent(componentName: string): Promise<LoadedCaptureComponent> {
  const { cfg, root } = await loadConfig()
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentDir = resolve(root, componentsDir, componentName)
  if (!existsSync(componentDir)) {
    throw new Error(`pixpec capture: no component dir ${componentDir}`)
  }
  const componentMod = (await import(resolve(componentDir, 'index.ts'))) as Record<string, unknown>
  const component = componentMod[componentName] as Component<unknown> | undefined
  if (!component || !Array.isArray(component.variants)) {
    throw new Error(`Component '${componentName}' not exported from ${componentDir}/index.ts`)
  }
  return { root, componentDir, component, cfg }
}

export async function runCapture(
  side: CaptureSide,
  componentName: string,
  opts: CaptureOptions = {},
): Promise<CaptureRunResult[]> {
  const loaded = await loadCaptureComponent(componentName)
  if (side === 'src') {
    const backend = resolveSourceCaptureBackend(opts.backend)
    const outDir = captureDir(loaded.componentDir, side, backend)
    if (opts.clearOutDir) await rm(outDir, { recursive: true, force: true })
    await mkdir(outDir, { recursive: true })
    console.log(`[capture src:figma] ${loaded.component.name} → ${outDir}`)
    await captureFigmaSource({
      component: loaded.component,
      outDir,
      tabPattern: opts.tabPattern,
      scale: loaded.cfg.scale,
      bridge: loaded.cfg.bridge,
      cfigmaBin: loaded.cfg.cfigmaBin,
    })
    return [{ componentDir: loaded.componentDir, outDir, backend }]
  }

  if (opts.backend === 'figma') throw new Error(`pixpec capture: "figma" is not a destination target`)
  const targets = opts.backend ? [opts.backend] : resolveConfiguredTargets(loaded.cfg)
  const results: CaptureRunResult[] = []
  for (const targetName of targets) {
    const target = getTarget(targetName)
    const outDir = captureDir(loaded.componentDir, side, targetName)
    if (opts.clearOutDir) await rm(outDir, { recursive: true, force: true })
    await mkdir(outDir, { recursive: true })
    console.log(`[capture dst:${targetName}] ${loaded.component.name} → ${outDir}`)
    const ids = loaded.component.variants.flatMap((v) => (v.usecases ?? []).map((u) => u.figmaId))
    await target.capture({ kind: 'case', ids })
    results.push({ componentDir: loaded.componentDir, outDir, backend: targetName })
  }
  return results
}

export async function stageMeasureInput(opts: {
  componentDir: string
  srcBackend: SourceCaptureBackend
  dstBackend: DestinationCaptureBackend
}): Promise<string> {
  const base = verifyMeasureDir(opts.componentDir, opts.srcBackend, opts.dstBackend)
  const figmaDir = resolve(base, 'figma')
  const dstDir = resolve(base, 'dst')
  await rm(base, { recursive: true, force: true })
  await mkdir(figmaDir, { recursive: true })
  await mkdir(dstDir, { recursive: true })
  await copyPngs(captureDir(opts.componentDir, 'src', opts.srcBackend), figmaDir)
  await copyPngs(captureDir(opts.componentDir, 'dst', opts.dstBackend), dstDir)
  return base
}

async function copyPngs(fromDir: string, toDir: string): Promise<void> {
  if (!existsSync(fromDir)) throw new Error(`pixpec capture: missing artifacts at ${fromDir}`)
  for (const f of (await readdir(fromDir)).filter((x) => x.endsWith('.png'))) {
    await copyFile(resolve(fromDir, f), resolve(toDir, basename(f)))
  }
}

function resolveSourceCaptureBackend(backend?: CaptureBackend): SourceCaptureBackend {
  if (!backend) return 'figma'
  if (backend !== 'figma') throw new Error(`pixpec capture: "${backend}" is not a source backend`)
  return backend
}
