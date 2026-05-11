/**
 * `pixpec breakdown <fileKey>:<nodeId>` — view-oriented structural codegen.
 *
 * Dumps one arbitrary Figma node, emits it as a view under src/view, and also
 * emits every descendant subtree in DFS post-order so codegen failures can be
 * localized from the leaves upward. INSTANCE and TEXT nodes are terminal
 * leaves for this traversal.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dump, exportNodeSvg, type RawNode } from './dumper/index.ts'
import { compile, loadRegistry, type Registry } from './compiler/index.ts'
import { getEmitter, type EmitResult, type EmitterComponentMeta } from './emitter/index.ts'
import { loadConfig } from './init.ts'
import { listFigmaTabs, switchToPageContaining } from './cfigma-meta.ts'
import { exportFigmaNodes } from './figma.ts'
import { Renderer } from './render.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const MEASURE_BIN = resolve(HERE, '../measure-rs/target/release/pixpec-measure')

export interface BreakdownOptions {
    emitter?: string
    name?: string
}

export interface BreakdownResult {
    viewName: string
    viewDir: string
    indexPath: string
    rootPath: string
    manifestPath: string
    entryCount: number
    failedCount: number
    verifiedCount: number
    verifyFailedCount: number
}

interface TokenMaps {
    tokenMap: Record<string, string>
    tokenValueMap: Record<string, number>
}

interface BreakdownEntry {
    index: number
    sourceId: string
    sourceName: string
    sourceType: string
    depth: number
    childCount: number
    path?: string
    error?: string
    verifySkip?: string
    figmaPng?: string
    chromiumPng?: string
    verify?: {
        ok: boolean
        blobMaxSize: number
        dE00Max: number
        dE00: number
    }
}

export async function runBreakdown(
    figmaId: string,
    opts: BreakdownOptions = {},
): Promise<BreakdownResult> {
    const { cfg, root } = await loadConfig()
    const componentsDir = resolve(root, cfg.componentsDir ?? 'src/components')
    const viewRoot = resolve(root, 'src/view')

    const firstColon = figmaId.indexOf(':')
    if (firstColon < 0) {
        throw new Error(`pixpec breakdown: figmaId must be <fileKey>:<nodeId>; got ${figmaId}`)
    }
    const fileKey = figmaId.slice(0, firstColon)
    const nodeId = figmaId.slice(firstColon + 1)

    const tabs = await listFigmaTabs({ cfigmaBin: cfg.cfigmaBin })
    const tab = tabs.find((t) => t.key === fileKey)
    if (!tab) throw new Error(`pixpec breakdown: no open figma tab matches fileKey ${fileKey}`)

    const { tokenMap, tokenValueMap } = await loadTokenMaps(root)
    const typographyMap = await loadTypographyMap(componentsDir)
    const plugins = await loadPlugins(root)
    const registry = await loadRegistry(componentsDir)
    const emitterName = opts.emitter ?? (cfg as { emitter?: string }).emitter ?? 'react-panda'
    const emitter = getEmitter(emitterName)

    const raw = await dump({ cfigmaBin: cfg.cfigmaBin ?? 'cfigma', tab: tab.key, nodeId })
    const viewName = toPascalIdentifier(opts.name ?? raw.name, nodeId)
    const viewDir = resolve(viewRoot, viewName)
    const generatedDir = resolve(viewDir, 'generated')
    const breakdownDir = resolve(viewDir, 'breakdown')
    await mkdir(generatedDir, { recursive: true })
    await mkdir(breakdownDir, { recursive: true })

    const emitContext = {
        componentName: viewName,
        designSystem: { tokens: tokenMap, tokenValues: tokenValueMap, typography: typographyMap },
        registry: registryToEmitterMeta(registry),
        plugins: plugins as never,
        remBase: cfg.remBase,
        rootDir: root,
        componentsDir,
    }
    const compileContext = {
        registry,
        tokenMap,
        tokenValueMap,
        exportSvg: (id: string) =>
            exportNodeSvg({ cfigmaBin: cfg.cfigmaBin ?? 'cfigma', tab: tab.key, nodeId: id }),
    }

    const rootAst = await compile(asStandaloneRoot(raw), compileContext)
    const rootResult = await emitter.emit(rootAst, {
        ...emitContext,
        outputDir: generatedDir,
        sourceId: raw.id,
    })
    const rootPath = await writeEmitResult(generatedDir, `${viewName}.${rootResult.fileExtension}`, rootResult)

    const entries: BreakdownEntry[] = []
    const nodes = collectPostOrder(raw)
    for (let i = 0; i < nodes.length; i += 1) {
        const { node, depth } = nodes[i]
        const outName = `${String(i + 1).padStart(4, '0')}_${safeFilename(node.id)}`
        const entry: BreakdownEntry = {
            index: i + 1,
            sourceId: node.id,
            sourceName: node.name,
            sourceType: node.type,
            depth,
            childCount: node.children?.length ?? 0,
            verifySkip: node.type === 'TEXT'
                ? 'text leaf'
                : isTextOnlySubtree(node)
                    ? 'text-only subtree'
                    : undefined,
        }
        try {
            const subtreeAst = await compile(asStandaloneRoot(node), compileContext)
            const result = await emitter.emit(subtreeAst, {
                ...emitContext,
                componentName: `${viewName}_${String(i + 1).padStart(4, '0')}`,
                outputDir: breakdownDir,
                sourceId: node.id,
            })
            const outPath = await writeEmitResult(
                breakdownDir,
                `${outName}.${result.fileExtension}`,
                result,
            )
            entry.path = relativeFrom(viewDir, outPath)
        } catch (e) {
            entry.error = e instanceof Error ? e.stack ?? e.message : String(e)
        }
        entries.push(entry)
    }

    const verifyBase = resolve(root, '.pixpec-out', `breakdown-${viewName}`)
    await verifyBreakdownEntries({
        entries,
        viewName,
        root,
        verifyBase,
        tab: tab.key,
        cfg,
    })

    const indexPath = resolve(viewDir, 'index.tsx')
    await writeFormatted(
        indexPath,
        [
            `import { Generated } from './generated/${viewName}.tsx'`,
            '',
            `export const ${viewName} = Generated`,
            `export default ${viewName}`,
            '',
        ].join('\n'),
    )

    await writeFile(
        resolve(viewDir, 'view.json'),
        `${JSON.stringify(
            {
                name: viewName,
                layerName: raw.name,
                figmaId,
                sourceId: raw.id,
                sourceType: raw.type,
                generated: relativeFrom(viewDir, rootPath),
                breakdownManifest: 'breakdown/manifest.json',
            },
            null,
            4,
        )}\n`,
    )
    const manifestPath = resolve(breakdownDir, 'manifest.json')
    await writeFile(
        manifestPath,
        `${JSON.stringify(
            {
                viewName,
                layerName: raw.name,
                figmaId,
                count: entries.length,
                failedCount: entries.filter((e) => e.error).length,
                verifiedCount: entries.filter((e) => e.verify).length,
                verifyFailedCount: entries.filter((e) => e.verify && !e.verify.ok).length,
                verifyBase,
                entries,
            },
            null,
            4,
        )}\n`,
    )

    return {
        viewName,
        viewDir,
        indexPath,
        rootPath,
        manifestPath,
        entryCount: entries.length,
        failedCount: entries.filter((e) => e.error).length,
        verifiedCount: entries.filter((e) => e.verify).length,
        verifyFailedCount: entries.filter((e) => e.verify && !e.verify.ok).length,
    }
}

async function verifyBreakdownEntries(opts: {
    entries: BreakdownEntry[]
    viewName: string
    root: string
    verifyBase: string
    tab: string
    cfg: { cfigmaBin?: string; scale?: number; bridge?: string; remBase?: number; devServerUrl?: string }
}): Promise<void> {
    const valid = opts.entries.filter((e) => e.path && !e.error && !e.verifySkip)
    if (valid.length === 0) return
    await rm(opts.verifyBase, { recursive: true, force: true })

    const devUrl = process.env.PIXPEC_DEV_URL ?? opts.cfg.devServerUrl ?? 'http://localhost:5180'
    await assertDevServer(devUrl)
    console.log(`[breakdown] verifying visual parity (${valid.length})…`)
    const renderer = await Renderer.create()
    try {
        for (const e of valid) {
            const caseDir = resolve(opts.verifyBase, String(e.index).padStart(4, '0'))
            const figmaDir = resolve(caseDir, 'figma')
            const chromiumDir = resolve(caseDir, 'chromium')
            await mkdir(figmaDir, { recursive: true })
            await mkdir(chromiumDir, { recursive: true })
            await switchToPageContaining({
                tabPattern: opts.tab,
                nodeId: e.sourceId,
                cfigmaBin: opts.cfg.cfigmaBin,
            })
            await exportFigmaNodes({
                tabPattern: opts.tab,
                nodeIds: [e.sourceId],
                outDir: figmaDir,
                scale: opts.cfg.scale ?? 2,
                bridge: opts.cfg.bridge,
                cfigmaBin: opts.cfg.cfigmaBin,
            })
            e.figmaPng = relativeFrom(opts.verifyBase, resolve(figmaDir, `${safeFilename(e.sourceId)}.png`))
            const file = e.path!.slice(e.path!.lastIndexOf('/') + 1).replace(/\.tsx$/, '')
            const safe = safeFilename(e.sourceId)
            await renderer.renderUrl({
                url: `${devUrl.replace(/\/$/, '')}/?view=${encodeURIComponent(opts.viewName)}&breakdown=${encodeURIComponent(file)}`,
                outPath: resolve(chromiumDir, `${safe}.png`),
                viewport: { width: 4000, height: 8000 },
                outputScale: opts.cfg.scale ?? 2,
                remBase: opts.cfg.remBase ?? 16,
                clipSelector: `[data-case="${file}"]`,
            })
            e.chromiumPng = relativeFrom(opts.verifyBase, resolve(chromiumDir, `${safe}.png`))
            await padPairedPngs(figmaDir, chromiumDir)
            await execFileAsync(MEASURE_BIN, [caseDir], {
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
            })
            const results = JSON.parse(await readFile(resolve(caseDir, 'results.json'), 'utf8')) as
                Array<{ case: string; blob_max_size: number; dE00_max: number; dE00: number }>
            const r = results.find((row) => row.case === safe)
            if (!r) throw new Error(`pixpec breakdown: missing measure result for ${e.sourceId}`)
            e.verify = {
                ok: r.blob_max_size <= 24,
                blobMaxSize: r.blob_max_size,
                dE00Max: r.dE00_max,
                dE00: r.dE00,
            }
            if (!e.verify.ok) {
                e.error = `visual verify failed: blob=${e.verify.blobMaxSize} max=${e.verify.dE00Max.toFixed(2)}`
                break
            }
        }
    } finally {
        await renderer.close()
    }
}

async function assertDevServer(devUrl: string): Promise<void> {
    try {
        const res = await fetch(devUrl.replace(/\/$/, ''), { method: 'GET' })
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
        throw new Error(
            `pixpec breakdown: cannot reach dev server at ${devUrl}. ` +
            `Start it first with \`VR_TEST=1 pnpm dev\`. Underlying: ${(e as Error).message}`,
        )
    }
}

async function padPairedPngs(figmaDir: string, chromiumDir: string): Promise<void> {
    const sharp = (await import('sharp')).default
    const { readdir } = await import('node:fs/promises')
    const names = new Set<string>()
    for (const dir of [figmaDir, chromiumDir]) {
        for (const f of (await readdir(dir)).filter((x) => x.endsWith('.png'))) names.add(f)
    }
    const padToMul = (v: number) => Math.ceil(v / 8) * 8
    for (const f of names) {
        const fp = resolve(figmaDir, f)
        const cp = resolve(chromiumDir, f)
        if (!existsSync(fp) || !existsSync(cp)) continue
        const fm = await sharp(fp).metadata()
        const cm = await sharp(cp).metadata()
        const targetW = padToMul(Math.max(fm.width ?? 0, cm.width ?? 0))
        const targetH = padToMul(Math.max(fm.height ?? 0, cm.height ?? 0))
        for (const [p, m] of [[fp, fm], [cp, cm]] as const) {
            const w = m.width ?? 0
            const h = m.height ?? 0
            if (w === targetW && h === targetH) continue
            const buf = await sharp(p)
                .extend({
                    top: 0,
                    left: 0,
                    right: targetW - w,
                    bottom: targetH - h,
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                })
                .png()
                .toBuffer()
            await writeFile(p, buf)
        }
    }
}

function collectPostOrder(root: RawNode): Array<{ node: RawNode; depth: number }> {
    const out: Array<{ node: RawNode; depth: number }> = []
    const visit = (node: RawNode, depth: number) => {
        if (node.type !== 'INSTANCE' && node.type !== 'TEXT') {
            for (const child of node.children ?? []) visit(child, depth + 1)
        }
        out.push({ node, depth })
    }
    visit(root, 0)
    return out
}

function isTextOnlySubtree(node: RawNode): boolean {
    const children = node.children ?? []
    return children.length > 0 && children.every((child) =>
        child.type === 'TEXT' || isTextOnlySubtree(child),
    )
}

function asStandaloneRoot(node: RawNode): RawNode {
    return {
        ...node,
        x: 0,
        y: 0,
        layoutPositioning: 'AUTO',
        constraints: undefined,
    }
}

function registryToEmitterMeta(registry: Registry): Map<string, EmitterComponentMeta> {
    return new Map(
        [...registry].map(([, v]) => [
            v.componentName,
            { componentName: v.componentName, dir: v.dir, hasProps: true },
        ]),
    )
}

async function loadTokenMaps(root: string): Promise<TokenMaps> {
    const tokenMap: Record<string, string> = {}
    const tokenValueMap: Record<string, number> = {}
    try {
        const ft = JSON.parse(await readFile(resolve(root, 'tokens/figma-tokens.json'), 'utf8')) as {
            variables: Array<{
                id: string
                key?: string
                name: string
                resolvedType: string
                valuesByMode?: Record<string, unknown>
            }>
        }
        for (const v of ft.variables) {
            const tokenPath = v.name
                .replace(/[\x00-\x1f]/g, '')
                .split('/')
                .map((s) => s.replace(/\s+/g, '').replace(/^./, (c) => c.toLowerCase()))
                .join('.')
            tokenMap[v.id] = tokenPath
            if (v.key) tokenMap[v.key] = tokenPath
            if (v.resolvedType === 'FLOAT' && v.valuesByMode) {
                const num = Object.values(v.valuesByMode).find(
                    (x): x is number => typeof x === 'number',
                )
                if (typeof num === 'number') {
                    tokenValueMap[v.id] = num
                    if (v.key) tokenValueMap[v.key] = num
                    tokenValueMap[tokenPath] = num
                }
            }
        }
    } catch {
        // tokens file is optional
    }
    return { tokenMap, tokenValueMap }
}

async function loadTypographyMap(componentsDir: string): Promise<Record<string, string>> {
    try {
        return JSON.parse(await readFile(resolve(componentsDir, 'typography/figma-binding.json'), 'utf8'))
    } catch {
        return {}
    }
}

async function loadPlugins(root: string): Promise<unknown[]> {
    try {
        const cfgPath = resolve(root, 'pixpec.config.ts')
        if (!existsSync(cfgPath)) return []
        const mod = (await import(cfgPath)) as {
            default?: { plugins?: unknown[] }
            plugins?: unknown[]
        }
        return mod.default?.plugins ?? mod.plugins ?? []
    } catch {
        return []
    }
}

async function writeEmitResult(outDir: string, filename: string, result: EmitResult): Promise<string> {
    await mkdir(outDir, { recursive: true })
    const outPath = resolve(outDir, filename)
    await writeFormatted(outPath, result.source)
    for (const sidecar of result.sidecars ?? []) {
        const sidecarPath = resolve(outDir, sidecar.relativePath)
        await mkdir(dirname(sidecarPath), { recursive: true })
        await writeFile(sidecarPath, sidecar.content)
    }
    return outPath
}

async function writeFormatted(path: string, source: string): Promise<void> {
    let out = source
    if (path.endsWith('.ts') || path.endsWith('.tsx')) {
        const prettier = await import('prettier')
        out = await prettier.format(source, {
            parser: 'typescript',
            tabWidth: 4,
            semi: false,
            singleQuote: true,
            trailingComma: 'all',
            printWidth: 100,
        })
    }
    await writeFile(path, out)
}

function toPascalIdentifier(name: string, nodeId: string): string {
    const words = name
        .normalize('NFKD')
        .replace(/[^A-Za-z0-9_$]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    const candidate = words
        .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
        .join('')
        .replace(/^[^A-Za-z_$]+/, '')
        .replace(/[^A-Za-z0-9_$]/g, '')
    if (candidate && /^[A-Za-z_$]/.test(candidate)) return candidate
    return `View_${safeFilename(nodeId)}`
}

function safeFilename(id: string): string {
    return id.replace(/[^A-Za-z0-9]/g, '_')
}

function relativeFrom(fromDir: string, toPath: string): string {
    return relative(fromDir, toPath).replace(/\\/g, '/')
}
