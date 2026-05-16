/**
 * `pixpec breakdown <fileKey>:<nodeId>` — source-side structural view manifest.
 *
 * Dumps one arbitrary Figma node, records its DFS post-order descendants, and
 * delegates per-node target output to the normal generate flow.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { dump, type RawNode } from './dumper/index.ts'
import { loadConfig } from './init.ts'
import { listFigmaTabs } from './cfigma-meta.ts'
import { resolveConfiguredTargets } from './targets/index.ts'
import { runGenerate } from './generate.ts'
import { runBreakdownVerify, runInteractiveBreakdownVerify, type InteractiveBreakdownVerify } from './breakdown-verify.ts'
import { loadViewCodegenConfig } from './view-config.ts'

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
    sourceWidth?: number
    sourceHeight?: number
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

    // Cached figma dump. The cfigma dump for a 900-node tree costs a few
    // seconds upfront on every invocation, and the data is deterministic per
    // (fileKey, nodeId). Stash it under viewRoot/.pixpec-dump/<safeId>.json
    // so subsequent runs (which dominate codegen iteration) skip the round
    // trip entirely. PIXPEC_BREAKDOWN_REFRESH_DUMP=1 forces a re-dump when
    // the Figma file has actually changed.
    const dumpCacheDir = resolve(viewRoot, '.pixpec-dump')
    const dumpCacheKey = `${fileKey}_${nodeId}`.replace(/[^A-Za-z0-9._-]/g, '_')
    const dumpCachePath = resolve(dumpCacheDir, `${dumpCacheKey}.json`)
    let raw: RawNode
    if (existsSync(dumpCachePath) && process.env.PIXPEC_BREAKDOWN_REFRESH_DUMP !== '1') {
        raw = JSON.parse(await readFile(dumpCachePath, 'utf8')) as RawNode
    } else {
        raw = await dump({ cfigmaBin: cfg.cfigmaBin ?? 'cfigma', tab: tab.key, nodeId })
        await mkdir(dumpCacheDir, { recursive: true })
        await writeFile(dumpCachePath, JSON.stringify(raw))
    }
    const viewName = toPascalIdentifier(opts.name ?? raw.name, nodeId)
    const viewDir = resolve(viewRoot, viewName)
    const breakdownDir = resolve(viewDir, 'breakdown')
    const targets = opts.target ? [opts.target] : resolveConfiguredTargets(cfg)
    const renderScale = opts.scale ?? cfg.scale
    await mkdir(breakdownDir, { recursive: true })
    const viewConfig = await loadViewCodegenConfig(viewDir)
    for (const target of targets) {
        const targetDir = resolve(viewDir, 'impl', target)
        await rm(resolve(targetDir, 'generated'), { recursive: true, force: true })
        await rm(resolve(targetDir, 'breakdown'), { recursive: true, force: true })
        await rm(resolve(targetDir, '.pixpec'), { recursive: true, force: true })
    }

    // Index every subtree by id once so per-entry codegen below can hand the
    // pre-dumped slice to `runGenerate` and skip the per-entry cfigma round
    // trip (~250-500ms each). With 900+ entries this dominates breakdown time.
    const rawById = new Map<string, RawNode>()
    const indexRaw = (n: RawNode) => {
      rawById.set(n.id, n)
      for (const c of n.children ?? []) indexRaw(c)
    }
    indexRaw(raw)

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
            viewConfig,
            raw,
            tabKey: tab.key,
        })
        rootOutputs[target] = relativeFrom(viewDir, r.outPath)
    }

    const entries: BreakdownEntry[] = []
    const nodes = collectPostOrder(raw, !!opts.detachInstances)
    const verifyTarget = targets[0] ?? 'gpui'
    const manifestPath = resolve(breakdownDir, 'manifest.json')
    const viewPath = resolve(viewDir, 'view.json')

    // When --verify is set, drive codegen and verify in lock-step so a verify
    // failure aborts immediately — no need to wait for the remaining hundreds
    // of nodes to codegen before learning the iteration was wasted.
    let interactive: InteractiveBreakdownVerify | undefined
    const workerCount = Math.max(1, Number(process.env.PIXPEC_GPUI_WORKERS ?? 1))
    if (opts.verify) {
        const expectedSourceIds = nodes
            .filter(({ node }) => node.type !== 'TEXT' && (!opts.verifySourceId || node.id === opts.verifySourceId))
            .map(({ node }) => node.id)
        interactive = await runInteractiveBreakdownVerify({
            viewDir,
            manifestPath,
            target: verifyTarget,
            cfg: { ...cfg, scale: renderScale },
            maxBlob: opts.maxBlob,
            blobThreshold: opts.blobThreshold,
            figmaId,
            viewName,
            expectedSourceIds,
            totalEntries: nodes.length,
            workerCount,
        })
    }

    const writeManifest = async () => {
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
    }

    let verify: { pass: number; fail: number; total: number; skipped: number } | undefined
    // Track in-flight verify promises so codegen can keep pumping while N
    // capture workers process previous entries in parallel. fail-fast: the
    // first failed promise sets `firstFailure` and the codegen loop exits.
    // PIXPEC_BREAKDOWN_CONTINUE_ON_FAIL=1 disables fail-fast for diagnostic
    // runs (gather all failing entries in one pass).
    const continueOnFail = process.env.PIXPEC_BREAKDOWN_CONTINUE_ON_FAIL === '1'
    const inflight: Promise<unknown>[] = []
    let firstFailure: Error | undefined
    try {
        for (let index = 0; index < nodes.length; index += 1) {
            if (firstFailure) break
            const { node, depth } = nodes[index]
            const seq = String(index + 1).padStart(4, '0')
            const viewId = `${viewName}:${seq}_${safeFilename(node.id)}`
            const entry: BreakdownEntry = {
                index: index + 1,
                sourceId: node.id,
                sourceName: node.name,
                sourceType: node.type,
                sourceWidth: sourceWidth(node),
                sourceHeight: sourceHeight(node),
                depth,
                childCount: node.children?.length ?? 0,
                viewId,
                outputs: {},
                captureSkip: node.type === 'TEXT' ? 'text leaf' : undefined,
            }
            // Skip codegen entirely for entries the user is not verifying when
            // a single sourceId is targeted — otherwise the breakdown would
            // re-run runGenerate (which dumps each subtree via cfigma) for all
            // 900+ entries to feed one verify pass.
            const willVerifyThis = !opts.verifySourceId || node.id === opts.verifySourceId
            if (willVerifyThis) {
                for (const target of targets) {
                    try {
                        const subtree = rawById.get(node.id)
                        const r = await runGenerate(`${fileKey}:${node.id}`, {
                            target,
                            componentName: `${viewName}_${seq}`,
                            outputDir: resolve(viewDir, 'impl', target, 'breakdown'),
                            propsFile: null,
                            detachInstances: opts.detachInstances,
                            detachRootInstance: !opts.detachInstances && node.type === 'INSTANCE',
                            renderScale,
                            viewConfig,
                            raw: subtree,
                            tabKey: tab.key,
                        })
                        entry.outputs[target] = relativeFrom(viewDir, r.outPath)
                    } catch (e) {
                        entry.error = e instanceof Error ? e.stack ?? e.message : String(e)
                    }
                }
            }
            entries.push(entry)

            if (interactive && (!opts.verifySourceId || node.id === opts.verifySourceId)) {
                const captured = entry
                const p = interactive
                    .verifyEntry(captured as never)
                    .then((r) => {
                        if (!r.ok && !firstFailure && !continueOnFail) {
                            firstFailure = new Error(
                                r.error ?? `breakdown verify failed at entry ${captured.index} ${captured.sourceId}`,
                            )
                        } else if (!r.ok && continueOnFail) {
                            console.log(`[continue-on-fail] entry ${captured.index} ${captured.sourceId} FAILED: ${r.error}`)
                        }
                        // Remove this promise from the in-flight set once
                        // settled, so the backpressure check below sees an
                        // accurate count.
                        const i = inflight.indexOf(p)
                        if (i >= 0) inflight.splice(i, 1)
                    })
                inflight.push(p)
                // Bounded look-ahead: capture pool's semaphore already limits
                // concurrent rendering to `workerCount`, but cfigma codegen
                // shouldn't sprint a thousand entries ahead. When in-flight
                // hits 2× workers, wait for any to drain before queueing more.
                while (inflight.length >= workerCount * 2 && !firstFailure) {
                    await Promise.race(inflight.map((x) => x.catch(() => undefined)))
                }
            }
        }

        // Drain remaining verifies before checking final failure.
        await Promise.allSettled(inflight)
        if (firstFailure) {
            await writeManifest()
            if (interactive) verify = await interactive.finalize()
            throw firstFailure
        }

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
        await writeManifest()
        if (interactive) verify = await interactive.finalize()
    } finally {
        if (interactive) await interactive.close()
    }

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

function isOrthogonalSwapRotation(node: RawNode): boolean {
    if (typeof node.rotation !== 'number') return false
    const normalized = ((node.rotation % 360) + 360) % 360
    return Math.abs(normalized - 90) < 0.01 || Math.abs(normalized - 270) < 0.01
}

function sourceWidth(node: RawNode): number | undefined {
    if (typeof node.width !== 'number' && typeof node.height !== 'number') return undefined
    return isOrthogonalSwapRotation(node) ? node.height : node.width
}

function sourceHeight(node: RawNode): number | undefined {
    if (typeof node.width !== 'number' && typeof node.height !== 'number') return undefined
    return isOrthogonalSwapRotation(node) ? node.width : node.height
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
