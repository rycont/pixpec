/**
 * `pixpec breakdown <fileKey>:<nodeId>` — source-side structural view manifest.
 *
 * Dumps one arbitrary Figma node, records its DFS post-order descendants, and
 * delegates per-node target output to the normal generate flow.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { dump, type RawNode } from './dumper/index.ts'
import { loadConfig } from './init.ts'
import { listFigmaTabs } from './cfigma-meta.ts'
import { resolveConfiguredTargets } from './targets/index.ts'
import { runGenerate } from './generate.ts'
import { runBreakdownVerify } from './breakdown-verify.ts'

export interface BreakdownOptions {
    name?: string
    target?: string
    detachInstances?: boolean
    verify?: boolean
    scale?: number
    maxBlob?: number
    blobThreshold?: string
    verifySourceId?: string
}

export interface BreakdownResult {
    viewName: string
    viewDir: string
    viewPath: string
    manifestPath: string
    entryCount: number
    verify?: { pass: number; fail: number; total: number; skipped: number }
}

interface BreakdownEntry {
    index: number
    sourceId: string
    sourceName: string
    sourceType: string
    depth: number
    childCount: number
    viewId: string
    outputs: Record<string, string>
    captureSkip?: string
    error?: string
}

export async function runBreakdown(
    figmaId: string,
    opts: BreakdownOptions = {},
): Promise<BreakdownResult> {
    const { cfg, root } = await loadConfig()
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

    const raw = await dump({ cfigmaBin: cfg.cfigmaBin ?? 'cfigma', tab: tab.key, nodeId })
    const viewName = toPascalIdentifier(opts.name ?? raw.name, nodeId)
    const viewDir = resolve(viewRoot, viewName)
    const breakdownDir = resolve(viewDir, 'breakdown')
    const targets = opts.target ? [opts.target] : resolveConfiguredTargets(cfg)
    const renderScale = opts.scale ?? cfg.scale
    await mkdir(breakdownDir, { recursive: true })

    const rootOutputs: Record<string, string> = {}
    for (const target of targets) {
        const outDir = resolve(viewDir, 'impl', target, 'generated')
        const r = await runGenerate(figmaId, {
            target,
            componentName: viewName,
            outputDir: outDir,
            propsFile: null,
            detachInstances: opts.detachInstances,
            renderScale,
        })
        rootOutputs[target] = relativeFrom(viewDir, r.outPath)
    }

    const entries: BreakdownEntry[] = []
    const nodes = collectPostOrder(raw, !!opts.detachInstances)
    for (let index = 0; index < nodes.length; index += 1) {
        const { node, depth } = nodes[index]
        const seq = String(index + 1).padStart(4, '0')
        const viewId = `${viewName}:${seq}_${safeFilename(node.id)}`
        const entry: BreakdownEntry = {
            index: index + 1,
            sourceId: node.id,
            sourceName: node.name,
            sourceType: node.type,
            depth,
            childCount: node.children?.length ?? 0,
            viewId,
            outputs: {},
            captureSkip: node.type === 'TEXT' ? 'text leaf' : undefined,
        }
        for (const target of targets) {
            try {
                const r = await runGenerate(`${fileKey}:${node.id}`, {
                    target,
                    componentName: `${viewName}_${seq}`,
                    outputDir: resolve(viewDir, 'impl', target, 'breakdown'),
                    propsFile: null,
                    detachInstances: opts.detachInstances,
                    renderScale,
                })
                entry.outputs[target] = relativeFrom(viewDir, r.outPath)
            } catch (e) {
                entry.error = e instanceof Error ? e.stack ?? e.message : String(e)
            }
        }
        entries.push(entry)
    }

    const viewPath = resolve(viewDir, 'view.json')
    await writeFile(
        viewPath,
        `${JSON.stringify(
            {
                name: viewName,
                layerName: raw.name,
                figmaId,
                sourceId: raw.id,
                sourceType: raw.type,
                targets,
                outputs: rootOutputs,
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
                targets,
                count: entries.length,
                entries,
            },
            null,
            4,
        )}\n`,
    )

    const verify = opts.verify
        ? await runBreakdownVerify({
            viewDir,
            manifestPath,
            target: targets[0] ?? 'gpui',
            cfg: { ...cfg, scale: renderScale },
            maxBlob: opts.maxBlob,
            blobThreshold: opts.blobThreshold,
            sourceId: opts.verifySourceId,
        })
        : undefined

    return {
        viewName,
        viewDir,
        viewPath,
        manifestPath,
        entryCount: entries.length,
        verify,
    }
}

function collectPostOrder(
    root: RawNode,
    detachInstances: boolean,
): Array<{ node: RawNode; depth: number }> {
    const out: Array<{ node: RawNode; depth: number }> = []
    const visit = (node: RawNode, depth: number) => {
        if ((node.type !== 'INSTANCE' || detachInstances) && node.type !== 'TEXT') {
            for (const child of node.children ?? []) visit(child, depth + 1)
        }
        out.push({ node, depth })
    }
    visit(root, 0)
    return out
}

function safeFilename(s: string): string {
    return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

function relativeFrom(base: string, target: string): string {
    return relative(base, target).replace(/\\/g, '/')
}

function toPascalIdentifier(name: string, fallback: string): string {
    const base = name
        .normalize('NFC')
        .replace(/[^A-Za-z0-9가-힯]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join('')
    const asciiSafe = base.replace(/^[^A-Za-z_]+/, '')
    return asciiSafe || `View_${safeFilename(fallback)}`
}
