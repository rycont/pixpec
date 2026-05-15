import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Component } from '../types.ts'
import { loadConfig } from '../init.ts'
import type { CaptureArtifact, CaptureKind } from '../targets/index.ts'
import { loadComponentFromPixpec } from '../compiler/registry.ts'

export interface TargetCaseCaptureItem {
  id: string
  safeId: string
  hasRenderBox: boolean
  pngPath: string
}

export interface TargetCaseCaptureGroup {
  component: Component<unknown>
  componentDir: string
  captureDir: string
  items: TargetCaseCaptureItem[]
}

export interface TargetCaseCapturePlan {
  rootDir: string
  componentsDir: string
  runtimeDir: string
  scale?: number
  remBase?: number
  groups: TargetCaseCaptureGroup[]
  artifacts: CaptureArtifact[]
}

export async function resolveTargetCaseCapturePlan(opts: {
  target: string
  ids: string[]
}): Promise<TargetCaseCapturePlan> {
  const { cfg, root } = await loadConfig()
  const componentsDir = resolve(root, cfg.componentsDir ?? 'src/components')
  const wanted = new Set(opts.ids)
  const groups: TargetCaseCaptureGroup[] = []
  const artifacts: CaptureArtifact[] = []

  for (const name of await readdir(componentsDir)) {
    const componentDir = resolve(componentsDir, name)
    if (!existsSync(resolve(componentDir, 'pixpec.json'))) continue
    const component = await loadComponentFromPixpec(componentDir) as Component<unknown>
    const captureDir = resolve(componentDir, '.pixpec', 'dst', opts.target)
    const items: TargetCaseCaptureItem[] = []
    for (const variant of component.variants) {
      const mainRender = variant.usecases?.find((usecase) => usecase.isMainCase)?.render
      const variantRender = variant.render ?? mainRender
      for (const usecase of variant.usecases ?? []) {
        if (!wanted.has(usecase.figmaId)) continue
        const safeId = safeCaptureId(usecase.figmaId)
        const pngPath = resolve(captureDir, `${safeId}.png`)
        items.push({
          id: usecase.figmaId,
          safeId,
          hasRenderBox: !!(usecase.render?.box ?? variantRender?.box),
          pngPath,
        })
        artifacts.push({ id: usecase.figmaId, pngPath })
        wanted.delete(usecase.figmaId)
      }
    }
    if (items.length > 0) groups.push({ component, componentDir, captureDir, items })
  }

  if (wanted.size > 0) {
    throw new Error(`pixpec capture: unknown case id(s): ${[...wanted].join(', ')}`)
  }
  for (const a of artifacts) {
    await mkdir(dirname(a.pngPath), { recursive: true })
    await rm(a.pngPath, { force: true })
  }
  return {
    rootDir: root,
    componentsDir,
    runtimeDir: resolve(root, '.pixpec', 'runtime', opts.target),
    scale: cfg.scale,
    remBase: cfg.remBase,
    groups,
    artifacts,
  }
}

export function assertSupportedCaptureKind(kind: CaptureKind): void {
  if (kind !== 'case') {
    throw new Error(`pixpec capture: view capture is not implemented yet`)
  }
}

export function safeCaptureId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, '_')
}
