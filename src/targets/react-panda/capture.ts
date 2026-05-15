/**
 * React/Panda destination capture — materializes a Pixpec-owned Vite harness,
 * renders component cases, and screenshots each case to PNG.
 */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { Renderer } from './browser-renderer.ts'
import type { CaptureRequest, CaptureResult } from '../types.ts'
import {
  assertSupportedCaptureKind,
  resolveTargetCaseCapturePlan,
} from '../../capture/resolve.ts'

export interface ReactPandaGeneratedCaptureRuntime {
  rootDir: string
  runtimeDir: string
  baseUrl: string
  remBase: number
  renderer: Renderer
  close(): Promise<void>
}

export async function captureReactPandaDestination(request: CaptureRequest): Promise<CaptureResult> {
  assertSupportedCaptureKind(request.kind)
  const plan = await resolveTargetCaseCapturePlan({ target: 'react-panda', ids: request.ids })
  const renderer = await Renderer.create()
  let ownedServer: { url: string; close: () => Promise<void> } | null = null
  try {
    await refreshReactPandaStyledSystem({
      runtimeDir: plan.runtimeDir,
      rootDir: plan.rootDir,
      componentsDir: plan.componentsDir,
    })
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

export async function prepareReactPandaGeneratedCaptureRuntime(opts: {
  runtimeDir: string
  rootDir: string
  remBase?: number
}): Promise<ReactPandaGeneratedCaptureRuntime> {
  await refreshReactPandaStyledSystem({
    runtimeDir: opts.runtimeDir,
    rootDir: opts.rootDir,
    componentsDir: opts.rootDir,
  })
  await writeReactPandaGeneratedHarness({
    runtimeDir: opts.runtimeDir,
    rootDir: opts.rootDir,
  })
  const renderer = await Renderer.create()
  let server: { url: string; close: () => Promise<void> } | null = null
  try {
    server = await startReactPandaHarnessServer({
      runtimeDir: opts.runtimeDir,
      rootDir: opts.rootDir,
      componentsDir: opts.rootDir,
    })
    return {
      rootDir: opts.rootDir,
      runtimeDir: opts.runtimeDir,
      baseUrl: server.url.replace(/\/$/, ''),
      remBase: opts.remBase ?? 16,
      renderer,
      async close() {
        await server?.close()
        await renderer.close()
      },
    }
  } catch (error) {
    await server?.close().catch(() => undefined)
    await renderer.close().catch(() => undefined)
    throw error
  }
}

export async function captureReactPandaGeneratedWithRuntime(opts: {
  runtime: ReactPandaGeneratedCaptureRuntime
  generatedPath: string
  width: number
  height: number
  outputScale: number
  outPath: string
}): Promise<void> {
  const url =
    `${opts.runtime.baseUrl}/index.html` +
    `?generated=${encodeURIComponent(opts.generatedPath)}`
  const session = await opts.runtime.renderer.openBatch({
    url,
    viewport: {
      width: Math.max(320, Math.ceil(opts.width) + 512),
      height: Math.max(240, Math.ceil(opts.height) + 512),
    },
    outputScale: opts.outputScale,
    remBase: opts.runtime.remBase,
    caseBox: { width: opts.width, height: opts.height },
  })
  try {
    await session.waitMounted(1)
    await session.screenshotMany([
      {
        selector: '[data-case="target"]',
        outPath: opts.outPath,
      },
    ])
  } finally {
    await session.close()
  }
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

async function writeReactPandaGeneratedHarness(opts: {
  runtimeDir: string
  rootDir: string
}): Promise<void> {
  await mkdir(opts.runtimeDir, { recursive: true })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    resolve(opts.runtimeDir, 'index.html'),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>pixpec react-panda breakdown harness</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 128px; background: transparent; }
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
    resolve(opts.runtimeDir, 'entry.tsx'),
    reactPandaGeneratedHarnessEntry({
      rootDir: opts.rootDir,
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

async function refreshReactPandaStyledSystem(opts: {
  runtimeDir: string
  rootDir: string
  componentsDir: string
}): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  const configPath = resolve(opts.rootDir, 'styled-system/debug/config.json')
  let config: Record<string, unknown>
  try {
    config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `react-panda capture requires styled-system/debug/config.json to regenerate Panda CSS\n` +
        `  Missing or invalid: ${configPath}\n` +
        `  Underlying: ${(error as Error).message}`,
    )
  }
  const staticCss = mergeStaticCss(config.staticCss, await readStaticTokenCss(opts.componentsDir))

  await mkdir(opts.runtimeDir, { recursive: true })
  const runtimeConfigPath = resolve(opts.runtimeDir, 'panda.config.mjs')
  await writeFile(runtimeConfigPath, reactPandaPandaConfigSource(config, staticCss), 'utf8')

  await runPandaCli(['codegen', '--config', runtimeConfigPath, '--cwd', opts.rootDir, '--silent'], opts.rootDir)
  await runPandaCli(
    [
      'cssgen',
      './src/**/*.{js,jsx,ts,tsx}',
      '--config',
      runtimeConfigPath,
      '--cwd',
      opts.rootDir,
      '--outfile',
      resolve(opts.rootDir, 'styled-system/styles.css'),
      '--silent',
    ],
    opts.rootDir,
  )
}

async function readStaticTokenCss(componentsDir: string): Promise<Record<string, string[]>> {
  const out: Record<string, Set<string>> = {}
  async function visit(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile() || entry.name !== 'static-tokens.json') continue
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      for (const [property, values] of Object.entries(raw)) {
        if (!Array.isArray(values)) continue
        const bucket = (out[property] ??= new Set<string>())
        for (const value of values) {
          if (typeof value === 'string') bucket.add(value)
        }
      }
    }
  }
  await visit(componentsDir)
  return Object.fromEntries(Object.entries(out).map(([property, values]) => [property, [...values].sort()]))
}

function mergeStaticCss(base: unknown, extraProperties: Record<string, string[]>): unknown {
  const extra = Object.fromEntries(Object.entries(extraProperties).filter(([, values]) => values.length > 0))
  if (Object.keys(extra).length === 0) return base
  const baseObject = isRecord(base) ? base : {}
  const cssItems = Array.isArray(baseObject.css) ? baseObject.css : []
  const first = cssItems[0]
  const firstProperties = isRecord(first) && isRecord(first.properties) ? first.properties : {}
  const mergedProperties: Record<string, string[]> = {}
  for (const [property, values] of Object.entries(firstProperties)) {
    if (!Array.isArray(values)) continue
    mergedProperties[property] = values.filter((value): value is string => typeof value === 'string')
  }
  for (const [property, values] of Object.entries(extra)) {
    mergedProperties[property] = [...new Set([...(mergedProperties[property] ?? []), ...values])].sort()
  }
  const mergedFirst = { ...(isRecord(first) ? first : {}), properties: mergedProperties }
  return { ...baseObject, css: [mergedFirst, ...cssItems.slice(1)] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function reactPandaPandaConfigSource(baseConfig: Record<string, unknown>, staticCss: unknown): string {
  return `const base = ${JSON.stringify(baseConfig)}
const staticCss = ${JSON.stringify(staticCss)}

export default {
  preflight: base.preflight ?? true,
  include: ['./src/**/*.{js,jsx,ts,tsx}'],
  exclude: [],
  jsxFramework: 'react',
  outdir: 'styled-system',
  staticCss,
  conditions: base.conditions,
  theme: {
    extend: {
      tokens: base.theme?.tokens,
      semanticTokens: base.theme?.semanticTokens,
      textStyles: base.theme?.textStyles,
    },
  },
  utilities: {
    extend: {
      minHeight: { values: { type: 'string' } },
      maxHeight: { values: { type: 'string' } },
      minWidth: { values: { type: 'string' } },
      maxWidth: { values: { type: 'string' } },
      width: { values: { type: 'string' } },
      height: { values: { type: 'string' } },
      insetBorder: {
        className: 'inset-bd',
        values: { type: 'string' },
        transform(value, { token }) {
          const [width, ...colorParts] = String(value).trim().split(/\\s+/)
          const colorValue = colorParts.join(' ')
          const borderWidth = /^-?\\d+(?:\\.\\d+)?$/.test(width) ? \`\${Number(width) / 16}rem\` : width
          const color = token(\`colors.\${colorValue}\`) ?? colorValue
          return { boxShadow: \`inset 0 0 0 \${borderWidth} \${color}\` }
        },
      },
      hugText: {
        className: 'hug-t',
        values: { type: 'boolean' },
        transform(value) {
          if (!value) return {}
          return {
            width: 'calc-size(max-content, round(up, size, 0.0625rem))',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }
        },
      },
      underline: {
        className: 'underline',
        values: { type: 'boolean' },
        transform(value) {
          if (!value) return {}
          return {
            position: 'relative',
            display: 'inline-block',
            textDecorationLine: 'underline',
            textUnderlineOffset: '0.19em',
            textDecorationThickness: '0.054em',
            '&::after': {
              content: '""',
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: '0.1640625rem',
              height: '0.125px',
              background: 'rgb(109,109,109)',
              boxShadow: '0 -0.0546875rem 0 rgb(80,80,80)',
              pointerEvents: 'none',
            },
          }
        },
      },
      innerBorderWidth: {
        className: 'ibw',
        values: { type: 'string' },
        transform(value) {
          return {
            '--inner-border-width': value,
            boxShadow: 'inset 0 0 0 var(--inner-border-width, 0px) var(--inner-border-color, currentColor)',
          }
        },
      },
      innerBorderColor: {
        className: 'ibc',
        values: 'colors',
        transform(value, { token }) {
          const color = token(\`colors.\${value}\`) ?? value
          return {
            '--inner-border-color': color,
            boxShadow: 'inset 0 0 0 var(--inner-border-width, 0px) var(--inner-border-color, currentColor)',
          }
        },
      },
      cornerShape: {
        property: 'cornerShape',
        values: {
          squircle: 'squircle',
          round: 'round',
          bevel: 'bevel',
          notch: 'notch',
          scoop: 'scoop',
          'se-2.5': 'superellipse(2.5)',
          'se-3': 'superellipse(3)',
          'se-3.5': 'superellipse(3.5)',
          'se-4': 'superellipse(4)',
          'se-5': 'superellipse(5)',
        },
      },
    },
  },
}
`
}

async function runPandaCli(args: string[], cwd: string): Promise<void> {
  const require = createRequire(import.meta.url)
  const pandaBin = resolve(dirname(require.resolve('@pandacss/dev/package.json')), 'bin.js')
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, [pandaBin, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolveRun()
        return
      }
      reject(
        new Error(
          `react-panda capture failed to run PandaCSS: panda ${args.join(' ')}\n` +
            `  exit code: ${code}\n` +
            `${stdout ? `  stdout:\n${stdout}` : ''}` +
            `${stderr ? `  stderr:\n${stderr}` : ''}`,
        ),
      )
    })
  })
}

function reactPandaHarnessEntry(opts: { rootDir: string; componentsDir: string }): string {
  return `import { createRoot } from 'react-dom/client'
import { createElement, Fragment, type ComponentType } from 'react'

type RegistryEntry = {
  name: string
  variants: Array<{
    path: string
    figmaId: string
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
    const manifestMod = await import(/* @vite-ignore */ \`\${componentDir}/pixpec.json?t=\${ts}\`) as Record<string, unknown>
    const manifest = (manifestMod.default ?? manifestMod) as {
      name: string
      variants: Array<{ path: string; figmaId: string; render?: RegistryEntry['variants'][number]['render'] }>
    }
    const comp: RegistryEntry = {
      name: manifest.name,
      variants: await Promise.all(manifest.variants.map(async (variant) => {
        const usecasesMod = await import(/* @vite-ignore */ \`\${componentDir}/\${variant.path}/usecases.json?t=\${ts}\`) as Record<string, unknown>
        return {
          path: variant.path,
          figmaId: variant.figmaId,
          render: variant.render,
          usecases: (usecasesMod.default ?? usecasesMod) as RegistryEntry['variants'][number]['usecases'],
        }
      })),
    }

    let Impl: ComponentType<unknown> | null = null
    if (sourceMode === 'impl') {
      const implMod = await import(/* @vite-ignore */ \`\${componentDir}/impl/react-panda/index.tsx?t=\${ts}\`) as Record<string, unknown>
      Impl = (implMod.impl ?? implMod.default) as ComponentType<unknown>
      if (typeof Impl !== 'function') {
        throw new Error(\`pixpec react-panda harness: \${componentDir}/impl/react-panda/index.tsx must export impl or default\`)
      }
    }

    const resolveComponentFor = async (figmaId: string): Promise<ComponentType<unknown>> => {
      if (Impl) return Impl
      const variant = comp.variants.find((v) => (v.usecases ?? []).some((u) => u.figmaId === figmaId))
      if (!variant) throw new Error(\`pixpec react-panda harness: no variant for \${figmaId}\`)
      const genMod = await import(
        /* @vite-ignore */ \`\${componentDir}/\${variant.path}/react-panda/index.tsx?t=\${ts}\`
      ) as Record<string, unknown>
      const G = (genMod.Generated ?? genMod.impl ?? genMod.default) as ComponentType<unknown> | undefined
      if (typeof G !== 'function') {
        throw new Error(\`pixpec react-panda harness: generated file for \${variant.path} has no component export\`)
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
          const props = c.props
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

function reactPandaGeneratedHarnessEntry(opts: { rootDir: string }): string {
  return `import { createRoot } from 'react-dom/client'
import { createElement, type ComponentType } from 'react'

const ROOT_DIR = ${JSON.stringify(`/@fs/${opts.rootDir}`)}

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
      /\\b(?:w|width)_/.test(className) ||
      /\\b(?:min-w|minWidth|max-w|maxWidth)_/.test(className)
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
  for (const el of textLeaves()) {
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
if (!target) throw new Error('pixpec react-panda breakdown harness: #pixpec-target not found')
const root = createRoot(target)

async function render() {
  try {
    const url = new URL(window.location.href)
    const generatedPath = url.searchParams.get('generated')
    if (!generatedPath) return
    const mod = await import(/* @vite-ignore */ \`/@fs\${generatedPath}?t=\${Date.now()}\`) as Record<string, unknown>
    const Generated = (mod.Generated ?? mod.impl ?? mod.default) as ComponentType<unknown> | undefined
    if (typeof Generated !== 'function') {
      throw new Error(\`pixpec react-panda breakdown harness: generated file has no component export: \${generatedPath}\`)
    }
    root.render(
      createElement(
        'div',
        {
          'data-case': 'target',
          style: {
            display: 'inline-block',
            verticalAlign: 'top',
            ...((window as any).__pixpecGeneratedCaseBox
              ? {
                  width: \`\${(window as any).__pixpecGeneratedCaseBox.width}px\`,
                  height: \`\${(window as any).__pixpecGeneratedCaseBox.height}px\`,
                }
              : {}),
          },
        },
        createElement(Generated),
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
