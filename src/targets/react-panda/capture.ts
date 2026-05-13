/**
 * React/Panda destination capture — materializes a Pixpec-owned Vite harness,
 * renders component cases, and screenshots each case to PNG.
 */
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Renderer } from './browser-renderer.ts'
import type { CaptureRequest, CaptureResult } from '../types.ts'
import {
  assertSupportedCaptureKind,
  resolveTargetCaseCapturePlan,
} from '../../capture/resolve.ts'

export async function captureReactPandaDestination(request: CaptureRequest): Promise<CaptureResult> {
  assertSupportedCaptureKind(request.kind)
  const plan = await resolveTargetCaseCapturePlan({ target: 'react-panda', ids: request.ids })
  const renderer = await Renderer.create()
  let ownedServer: { url: string; close: () => Promise<void> } | null = null
  try {
    await writeReactPandaHarness({
      runtimeDir: plan.runtimeDir,
      rootDir: plan.rootDir,
      componentsDir: plan.componentsDir,
    })
    ownedServer = await startReactPandaHarnessServer({
      runtimeDir: plan.runtimeDir,
      rootDir: plan.rootDir,
      componentsDir: plan.componentsDir,
    })
    const baseUrl = ownedServer.url.replace(/\/$/, '')
    try {
      const res = await fetch(baseUrl, { method: 'GET' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      throw new Error(
        `capture dst:react-panda cannot reach dev server at ${baseUrl}\n` +
        `  Underlying: ${(e as Error).message}`,
      )
    }
    for (const group of plan.groups) {
      const comp = group.component
      const CHUNK = comp.batchChunk ?? 500
      const N = group.items.length
      const PARALLEL = comp.batchParallel ?? 2

      const chunks: { s: number; e: number }[] = []
      for (let s = 0; s < N; s += CHUNK) chunks.push({ s, e: Math.min(s + CHUNK, N) })

      const sessions: import('./browser-renderer.ts').BatchSession[] = []
      const runChunk = async ({ s, e }: { s: number; e: number }) => {
        const ids = group.items.slice(s, e).map((item) => item.id)
        const url =
          `${baseUrl}/index.html` +
          `?component=${encodeURIComponent(comp.name)}&ids=${encodeURIComponent(JSON.stringify(ids))}`
        const t0 = Date.now()
        const session = await renderer.openBatch({
          url,
          viewport: comp.viewport ?? { width: 4000, height: 8000 },
          outputScale: plan.scale ?? 2,
          remBase: plan.remBase ?? 16,
        })
        sessions.push(session)

        const tNav = Date.now()
        const tryWait = async (isRetry = false) => {
          try {
            await session.waitMounted(e - s)
          } catch (err) {
            const msg = String(err)
            if (!isRetry && msg.includes('component not found')) {
              await new Promise((r) => setTimeout(r, 1000))
              await session.reload()
              await session.navigateTo(url)
              await tryWait(true)
              return
            }
            throw err
          }
        }
        await tryWait()

        const tMount = Date.now()
        const items = group.items.slice(s, e).map((item) => ({
          selector: item.hasRenderBox
            ? `[data-case="${item.safeId}"]`
            : `[data-case="${item.safeId}"] > *`,
          outPath: item.pngPath,
          clipToElement: item.hasRenderBox,
        }))
        await session.screenshotMany(items)
        const tShots = Date.now()
        console.log(
          `  chunk [${s}..${e}) nav=${tNav - t0}ms mount=${tMount - tNav}ms shots=${tShots - tMount}ms`,
        )
      }

      let nextIdx = 0
      const worker = async () => {
        while (nextIdx < chunks.length) {
          const idx = nextIdx++
          await runChunk(chunks[idx])
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker))
      } finally {
        await Promise.all(sessions.map((session) => session.close()))
      }
    }
  } finally {
    await ownedServer?.close()
    await renderer.close()
  }
  return { artifacts: plan.artifacts }
}

async function writeReactPandaHarness(opts: {
  runtimeDir: string
  rootDir: string
  componentsDir: string
}): Promise<void> {
  const harnessDir = opts.runtimeDir
  await mkdir(harnessDir, { recursive: true })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    resolve(harnessDir, 'index.html'),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>pixpec react-panda harness</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  #pixpec-target { display: inline-block; line-height: normal; }
</style>
</head>
<body>
<div id="pixpec-target"></div>
<script type="module" src="./entry.tsx"></script>
</body>
</html>
`,
  )
  await writeFile(
    resolve(harnessDir, 'entry.tsx'),
    reactPandaHarnessEntry({
      rootDir: opts.rootDir,
      componentsDir: opts.componentsDir,
    }),
  )
}

async function startReactPandaHarnessServer(opts: {
  runtimeDir: string
  rootDir: string
  componentsDir: string
}): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const svgr = (await import('vite-plugin-svgr')).default
  const prev = process.env.VR_TEST
  process.env.VR_TEST = '1'
  const server = await createServer({
    root: opts.runtimeDir,
    configFile: false,
    plugins: [
      react(),
      svgr({
        include: /\.svg(\?.*)?[?&]react(&|$)/,
      }),
    ],
    server: {
      host: '127.0.0.1',
      port: 0,
      fs: { allow: [opts.runtimeDir, opts.rootDir, opts.componentsDir] },
    },
  })
  await server.listen()
  if (prev === undefined) delete process.env.VR_TEST
  else process.env.VR_TEST = prev
  const url = server.resolvedUrls?.local[0]
  if (!url) {
    await server.close()
    throw new Error('capture dst:react-panda failed to start Vite harness')
  }
  return { url, close: () => server.close() }
}

function reactPandaHarnessEntry(opts: { rootDir: string; componentsDir: string }): string {
  return `import { createRoot } from 'react-dom/client'
import { createElement, Fragment, type ComponentType } from 'react'

type RegistryEntry = {
  name: string
  variants: Array<{
    figmaId: string
    usecases: Array<{
      figmaId: string
      props: Record<string, unknown>
      render?: {
        box?: {
          width?: number
          height?: number
          padding?: number
          paddingTop?: number
          paddingRight?: number
          paddingBottom?: number
          paddingLeft?: number
          bg?: string
          color?: string
          overflow?: 'hidden' | 'visible'
        }
      }
      isMainCase?: boolean
    }>
  }>
}

const ROOT_DIR = ${JSON.stringify(`/@fs/${opts.rootDir}`)}
const COMPONENTS_DIR = ${JSON.stringify(`/@fs/${opts.componentsDir}`)}
const safeId = (figmaId: string) => figmaId.replace(/[^A-Za-z0-9]/g, '_')
const isEntry = (v: unknown): v is RegistryEntry =>
  !!v && typeof v === 'object' && 'name' in v && 'variants' in v

async function tryImport(path: string): Promise<any> {
  try {
    return await import(/* @vite-ignore */ path)
  } catch {
    return undefined
  }
}

await tryImport(\`\${ROOT_DIR}/src/fonts/__pixpec-fonts.css\`)
await tryImport(\`\${ROOT_DIR}/styled-system/styles.css\`)
const fontManifestMod = await tryImport(\`\${ROOT_DIR}/src/fonts/__pixpec-fonts.json\`)
const fontManifest = (fontManifestMod?.default ?? fontManifestMod ?? {}) as {
  fonts?: Array<{
    family?: string
    yShift?: Record<string, number>
    xShift?: Record<string, number>
  }>
}

function lookupFontShift(map: Record<string, number> | undefined, fontSize: number): number {
  if (!map) return 0
  const rounded = Math.round(fontSize)
  const direct = map[String(rounded)]
  if (typeof direct === 'number') return direct
  let best: { distance: number; value: number } | null = null
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'number') continue
    const distance = Math.abs(Number(key) - fontSize)
    if (distance <= 0.5 && (!best || distance < best.distance)) best = { distance, value }
  }
  return best?.value ?? 0
}

function textLeaves(): HTMLElement[] {
  const walker = document.createTreeWalker(
    document.querySelector('#pixpec-target') ?? document.body,
    NodeFilter.SHOW_TEXT,
  )
  const seen = new Set<HTMLElement>()
  const elements: HTMLElement[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (!node.textContent?.trim()) continue
    const el = node.parentElement
    if (!el || seen.has(el)) continue
    seen.add(el)
    elements.push(el)
  }
  return elements
}

function applyTextWidthSnap() {
  for (const el of textLeaves()) {
    const className = String(el.getAttribute('class') ?? '')
    const hasExplicitWidth =
      !!el.style.width ||
      /\b(?:w|width)_/.test(className) ||
      /\b(?:min-w|minWidth|max-w|maxWidth)_/.test(className)
    el.style.display = el.style.display || 'inline-block'
    el.style.verticalAlign = el.style.verticalAlign || 'top'
    if (!hasExplicitWidth) {
      el.style.width = 'calc-size(max-content, round(up, size, 0.0625rem))'
    }
  }
}

function applyFontShifts() {
  const fonts = fontManifest.fonts ?? []
  if (fonts.length === 0) return
  const elements = textLeaves()
  for (const el of elements) {
    const style = window.getComputedStyle(el)
    const font = fonts.find((f) => f.family && style.fontFamily.includes(f.family))
    if (!font) continue
    const fontSize = Number.parseFloat(style.fontSize)
    if (!Number.isFinite(fontSize)) continue
    const x = lookupFontShift(font.xShift, fontSize)
    const y = lookupFontShift(font.yShift, fontSize)
    if (x === 0 && y === 0) continue
    const base = el.dataset.pixpecTransformBase ?? el.style.transform
    el.dataset.pixpecTransformBase = base
    el.style.transformOrigin = 'center center'
    el.style.transform = [base, \`translate(\${x}px, \${y}px)\`].filter(Boolean).join(' ')
  }
}

;(window as any).__pixpecSettle = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  applyTextWidthSnap()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  applyFontShifts()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
}

const target = document.querySelector<HTMLElement>('#pixpec-target')
if (!target) throw new Error('pixpec react-panda harness: #pixpec-target not found')
const root = createRoot(target)

async function render() {
  try {
    const url = new URL(window.location.href)
    const compName = url.searchParams.get('component')
    const sourceMode = url.searchParams.get('source') === 'generated' ? 'generated' : 'impl'
    const idsParam = url.searchParams.get('ids')
    const ids = idsParam ? new Set(JSON.parse(idsParam) as string[]) : null
    if (!compName) return

    const ts = Date.now()
    const componentDir = \`\${COMPONENTS_DIR}/\${compName}\`
    const registryMod = await import(/* @vite-ignore */ \`\${componentDir}/index.ts?t=\${ts}\`) as Record<string, unknown>
    const casesMod = await import(/* @vite-ignore */ \`\${componentDir}/cases.ts?t=\${ts}\`) as Record<string, unknown>
    const comp = (registryMod.default ||
      registryMod[compName] ||
      Object.values(registryMod).find(isEntry)) as RegistryEntry
    if (!comp || !isEntry(comp)) {
      throw new Error(\`pixpec react-panda harness: valid component export not found for \${compName}\`)
    }
    if (Array.isArray(casesMod.variants)) comp.variants = casesMod.variants as RegistryEntry['variants']

    let defaults: Record<string, unknown> = {}
    if (sourceMode === 'generated') {
      const defaultsMod = await tryImport(\`\${componentDir}/defaults.ts?t=\${ts}\`)
      const d = defaultsMod?.defaults ?? defaultsMod?.default
      if (d && typeof d === 'object') defaults = d
    }

    let Impl: ComponentType<unknown> | null = null
    if (sourceMode === 'impl') {
      const implMod = await import(/* @vite-ignore */ \`\${componentDir}/impl.tsx?t=\${ts}\`) as Record<string, unknown>
      Impl = (implMod.impl ?? implMod.default) as ComponentType<unknown>
      if (typeof Impl !== 'function') {
        throw new Error(\`pixpec react-panda harness: \${componentDir}/impl.tsx must export impl or default\`)
      }
    }

    const variantMainByCaseId = new Map<string, string>()
    if (sourceMode === 'generated') {
      for (const v of comp.variants) {
        const main = (v.usecases ?? []).find((u) => u.isMainCase)
        if (!main) throw new Error(\`pixpec react-panda harness: variant \${v.figmaId} has no isMainCase usecase\`)
        for (const u of v.usecases ?? []) variantMainByCaseId.set(u.figmaId, main.figmaId)
      }
    }

    const resolveComponentFor = async (figmaId: string): Promise<ComponentType<unknown>> => {
      if (Impl) return Impl
      const mainId = variantMainByCaseId.get(figmaId)
      if (!mainId) throw new Error(\`pixpec react-panda harness: no variant main case for \${figmaId}\`)
      const genMod = await import(
        /* @vite-ignore */ \`\${componentDir}/generated/\${safeId(mainId)}.tsx?t=\${ts}\`
      ) as Record<string, unknown>
      const G = (genMod.Generated ?? genMod.impl ?? genMod.default) as ComponentType<unknown> | undefined
      if (typeof G !== 'function') {
        throw new Error(\`pixpec react-panda harness: generated file for \${mainId} has no component export\`)
      }
      return G
    }

    const allUsecases = comp.variants.flatMap((v) => v.usecases ?? [])
    const usecases = ids ? allUsecases.filter((u) => ids.has(u.figmaId)) : allUsecases
    const comps = await Promise.all(usecases.map((c) => resolveComponentFor(c.figmaId)))
    const variantRenderByCaseId = new Map<string, RegistryEntry['variants'][number]['usecases'][number]['render']>()
    for (const v of comp.variants) {
      const mainRender = (v.usecases ?? []).find((u) => u.isMainCase)?.render
      const variantRender = (v as any).render ?? mainRender
      for (const u of v.usecases ?? []) variantRenderByCaseId.set(u.figmaId, variantRender)
    }
    const px2rem = (v: number) => \`\${+(v / 16).toFixed(6)}rem\`
    const boxStyle = (box: NonNullable<RegistryEntry['variants'][number]['usecases'][number]['render']>['box']) => {
      const style: Record<string, unknown> = {
        background: box?.bg ?? 'transparent',
        ...(box?.color ? { color: box.color } : {}),
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: box?.overflow ?? 'hidden',
      }
      if (typeof box?.padding === 'number') style.padding = px2rem(box.padding)
      else {
        style.paddingTop = px2rem(box?.paddingTop ?? 0)
        style.paddingRight = px2rem(box?.paddingRight ?? 0)
        style.paddingBottom = px2rem(box?.paddingBottom ?? 0)
        style.paddingLeft = px2rem(box?.paddingLeft ?? 0)
      }
      if (
        box?.paddingTop !== undefined ||
        box?.paddingRight !== undefined ||
        box?.paddingBottom !== undefined ||
        box?.paddingLeft !== undefined
      ) {
        style.alignItems = 'flex-start'
        style.justifyContent = 'flex-start'
      }
      if (box?.width !== undefined) style.width = px2rem(box.width)
      if (box?.height !== undefined) style.height = px2rem(box.height)
      return style
    }
    root.render(
      createElement(
        Fragment,
        null,
        ...usecases.map((c, i) => {
          const C = comps[i]
          const props = sourceMode === 'generated' ? { ...defaults, ...c.props } : c.props
          const child = createElement(C, props)
          const renderSpec = c.render ?? variantRenderByCaseId.get(c.figmaId)
          const rendered = renderSpec?.box
            ? createElement('div', { style: boxStyle(renderSpec.box) }, child)
            : child
          return createElement(
            'div',
            {
              key: c.figmaId,
              'data-case': safeId(c.figmaId),
              style: {
                display: 'inline-block',
                verticalAlign: 'top',
                margin: '0 32px 32px 0',
                fontSize: 0,
                lineHeight: 0,
              },
            },
            rendered,
          )
        }),
      ),
    )
  } catch (e) {
    ;(window as any).__pixpecError = e instanceof Error ? e.stack || e.message : String(e)
    console.error(e)
  }
}

void render()
`
}
