/**
 * `pixpec verify-generated <Component>` — validates the per-variant
 * `generated/<safeId>.tsx` files DIRECTLY against every figma usecase,
 * before impl synthesis. Each usecase is rendered through its variant's
 * main-case generated tree (the only generated file that exists per
 * variant) with defaults+props merged — so we exercise both codegen
 * fidelity AND prop parameterization without any impl involvement.
 *
 * Pipeline mirrors `verify`:
 *   1. runDumpChromium with { source: 'generated', clearOutDir: true }
 *   2. pad to multiples of 8
 *   3. pixpec-measure → results.json
 *   4. report PASS/FAIL per usecase
 *
 * Precondition: `.pixpec-out/<Component>/figma/` populated by `dump-figma`.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { runDumpChromium } from './dump-chromium.ts'
import { loadConfig } from './init.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const MEASURE_BIN = resolve(HERE, '../measure-rs/target/release/pixpec-measure')

export interface VerifyGeneratedOptions {
    blobThreshold?: string
    maxBlob?: string
}

export async function runVerifyGenerated(
    componentName: string,
    opts: VerifyGeneratedOptions = {},
): Promise<{ pass: number; fail: number; total: number; failed: string[] }> {
    const { cfg, root } = await loadConfig()
    const componentsDir = cfg.componentsDir ?? 'src/components'
    const componentDir = resolve(root, componentsDir, componentName)
    if (!existsSync(componentDir))
        throw new Error(
            `pixpec verify-generated: no component dir ${componentDir}`,
        )
    const figmaDir = resolve(root, '.pixpec-out', componentName, 'figma')
    if (!existsSync(figmaDir)) {
        throw new Error(
            `pixpec verify-generated: no figma references at ${figmaDir}. ` +
                `Run \`pixpec dump-figma ${componentName}\` first.`,
        )
    }
    await ensurePandaCss(root)
    console.log(
        `[verify-generated] rendering ${componentName} usecases (source=generated)…`,
    )
    await runDumpChromium(componentName, {
        source: 'generated',
        clearOutDir: true,
    })

    const sharp = (await import('sharp')).default
    const { readdir, writeFile } = await import('node:fs/promises')
    const padToMul = (v: number) => Math.ceil(v / 8) * 8
    // First pass: collect dims per case so we can reconcile figma↔chromium
    // mismatches (sub-pixel rounding differs between figma's exporter and
    // chromium's render). We pad both to the per-case max(w,h), and to a
    // multiple of 8 (measure-rs tile alignment requirement).
    const figmaDir2 = resolve(root, '.pixpec-out', componentName, 'figma')
    const chromiumDir = resolve(root, '.pixpec-out', componentName, 'chromium')
    const dimsByCase = new Map<
        string,
        { fw?: number; fh?: number; cw?: number; ch?: number }
    >()
    for (const [sub, dir] of [
        ['figma', figmaDir2],
        ['chromium', chromiumDir],
    ] as const) {
        if (!existsSync(dir)) continue
        for (const f of (await readdir(dir)).filter((x) =>
            x.endsWith('.png'),
        )) {
            const meta = await sharp(`${dir}/${f}`).metadata()
            const entry = dimsByCase.get(f) ?? {}
            if (sub === 'figma') {
                entry.fw = meta.width!
                entry.fh = meta.height!
            } else {
                entry.cw = meta.width!
                entry.ch = meta.height!
            }
            dimsByCase.set(f, entry)
        }
    }
    for (const [f, d] of dimsByCase) {
        const targetW = padToMul(Math.max(d.fw ?? 0, d.cw ?? 0))
        const targetH = padToMul(Math.max(d.fh ?? 0, d.ch ?? 0))
        for (const [sub, dir, w, h] of [
            ['figma', figmaDir2, d.fw, d.fh] as const,
            ['chromium', chromiumDir, d.cw, d.ch] as const,
        ]) {
            if (w === undefined || h === undefined) continue
            if (w === targetW && h === targetH) continue
            const p = `${dir}/${f}`
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
    const measureArgs = [
        resolve(root, '.pixpec-out', componentName),
        ...(opts.blobThreshold ? ['--blob-threshold', opts.blobThreshold] : []),
    ]
    console.log(`[verify-generated] measuring…`)
    await execFileAsync(MEASURE_BIN, measureArgs, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
    const results = JSON.parse(
        await readFile(
            resolve(root, '.pixpec-out', componentName, 'results.json'),
            'utf8',
        ),
    ) as Array<{
        case: string
        blob_max_size: number
        dE00_max: number
        dE00: number
    }>
    const maxBlob = opts.maxBlob ? parseInt(opts.maxBlob, 10) : 24
    // Parse cases.ts for `skipVerify: '...'` markers — keyed by safeId(figmaId).
    // Skipped cases are reported as ⊘ with the reason and don't count toward
    // pass/fail. Regex-based read avoids importing the user's TS source.
    const skipMap = new Map<string, string>()
    try {
        const casesText = await readFile(
            resolve(componentDir, 'cases.ts'),
            'utf8',
        )
        // Match each `skipVerify: '...'` and pair with the nearest preceding
        // `figmaId: '...'` within ~800 chars (typical case stanza span). Using a
        // [\s\S] window instead of [^{}] so wrapper's `boxWrapper({...})` braces
        // don't break the pairing.
        // Tempered token forbids another `figmaId:` from sneaking in between —
        // each skipVerify pairs with its IMMEDIATELY preceding figmaId.
        const re =
            /figmaId:\s*['"`]([^'"`]+)['"`](?:(?!figmaId:)[\s\S]){0,800}?skipVerify:\s*['"`]([^'"`]+)['"`]/g
        for (const m of casesText.matchAll(re)) {
            const figmaId = m[1]
            const reason = m[2]
            if (figmaId && reason)
                skipMap.set(figmaId.replace(/[^A-Za-z0-9]/g, '_'), reason)
        }
    } catch {
        /* no cases.ts → no skips */
    }
    let pass = 0
    const failed: string[] = []
    let skipped = 0
    for (const r of results) {
        const reason = skipMap.get(r.case)
        if (reason) {
            console.log(
                `  ⊘ ${r.case} blob=${r.blob_max_size} max=${r.dE00_max.toFixed(2)} sum=${r.dE00.toFixed(0)}  [skip: ${reason}]`,
            )
            skipped++
            continue
        }
        const ok = r.blob_max_size <= maxBlob
        console.log(
            `  ${ok ? '✓' : '✗'} ${r.case} blob=${r.blob_max_size} max=${r.dE00_max.toFixed(2)} sum=${r.dE00.toFixed(0)}`,
        )
        if (ok) pass++
        else failed.push(r.case)
    }
    const considered = results.length - skipped
    const tail = skipped ? ` (${skipped} skipped)` : ''
    console.log(
        `\n${pass}/${considered} passed${failed.length ? `, ${failed.length} failed` : ''}${tail}`,
    )
    return { pass, fail: failed.length, total: considered, failed }
}

async function ensurePandaCss(root: string): Promise<void> {
    if (!existsSync(resolve(root, 'panda.config.ts'))) return
    try {
        await execFileAsync('pnpm', ['exec', 'panda', 'cssgen'], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        })
    } catch (e) {
        const err = e as Error & { stderr?: string; stdout?: string }
        throw new Error(
            'pixpec verify-generated: failed to refresh Panda CSS via `pnpm exec panda cssgen`: ' +
                (err.stderr || err.stdout || err.message),
        )
    }
}
