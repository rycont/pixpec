/**
 * Round-trip: feed every variant's ast.json through codegen and compare against
 * the previously-generated react-panda/index.tsx. Single tsgo boot, sequential
 * codegen calls in-process.
 *
 *   pnpm tsx src/targets/react-panda/test-real.ts                # all components
 *   pnpm tsx src/targets/react-panda/test-real.ts Badge          # one component
 *   pnpm tsx src/targets/react-panda/test-real.ts Badge VARIANT  # one variant
 */

import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DDataScope, DNode } from '../../compiler/design-ast.ts'
import type { CodegenContext } from '../types.ts'
import { codegenReactPanda } from './codegen.ts'

const DANAH_ROOT = '/home/rycont/dev/pixpec-workdir/danah'
const COMPONENTS_DIR = resolve(DANAH_ROOT, 'src/components')

async function loadVariant(componentName: string, variantDir: string) {
    const variantPath = resolve(COMPONENTS_DIR, componentName, 'variants', variantDir)
    const ast = JSON.parse(await readFile(resolve(variantPath, 'ast.json'), 'utf8')) as DNode
    if (ast.kind !== 'dataScope') {
        throw new Error(`${variantDir}: expected DataScope root, got ${ast.kind}`)
    }
    ;(ast as DDataScope).componentName = componentName
    const existing = await readFile(resolve(variantPath, 'react-panda/index.tsx'), 'utf8')
    return { ast, existing, outputDir: resolve(variantPath, 'react-panda') }
}

async function loadDesignSystem() {
    let tokens: Record<string, string> = {}
    let typography: Record<string, string> = {}
    try {
        tokens = JSON.parse(await readFile(resolve(DANAH_ROOT, 'design-ir/tokens.json'), 'utf8'))
    } catch {}
    try {
        typography = JSON.parse(
            await readFile(resolve(COMPONENTS_DIR, 'typography/__pixpec-typography.json'), 'utf8'),
        )
    } catch {}
    return { tokens, typography }
}

async function buildTargetRegistry() {
    const entries = await readdir(COMPONENTS_DIR, { withFileTypes: true })
    const registry = new Map<string, { componentName: string; dir: string; hasProps: boolean }>()
    for (const e of entries) {
        if (!e.isDirectory() || e.name === 'typography') continue
        registry.set(e.name, {
            componentName: e.name,
            dir: resolve(COMPONENTS_DIR, e.name),
            hasProps: true,
        })
    }
    return registry
}

async function listVariants(componentName: string): Promise<string[]> {
    const variantsDir = resolve(COMPONENTS_DIR, componentName, 'variants')
    if (!existsSync(variantsDir)) return []
    const entries = await readdir(variantsDir, { withFileTypes: true })
    return entries
        .filter(
            (e) =>
                e.isDirectory() &&
                existsSync(resolve(variantsDir, e.name, 'react-panda/index.tsx')),
        )
        .map((e) => e.name)
}

async function listComponents(): Promise<string[]> {
    const entries = await readdir(COMPONENTS_DIR, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && e.name !== 'typography').map((e) => e.name)
}

function normalize(s: string): string {
    return s.replace(/\s+/g, ' ').trim()
}

async function runOne(
    componentName: string,
    variantDir: string,
    designSystem: { tokens: Record<string, string>; typography: Record<string, string> },
    registry: Map<string, { componentName: string; dir: string; hasProps: boolean }>,
): Promise<{ pass: boolean; diff?: string }> {
    const { ast, existing, outputDir } = await loadVariant(componentName, variantDir)
    const ctx: CodegenContext = {
        componentName,
        designSystem,
        registry,
        remBase: 16,
        outputDir,
        rootDir: DANAH_ROOT,
        componentsDir: COMPONENTS_DIR,
    }
    const result = await codegenReactPanda(ast, ctx)
    if (process.env.WRITE_BASELINES === '1') {
        await writeFile(resolve(outputDir, 'index.tsx'), result.source)
        return { pass: true }
    }
    const newNorm = normalize(result.source)
    const expectedNorm = normalize(existing)
        .replace(/\bGeneratedProps\b/g, `${componentName}Props`)
        .replace(/\bGenerated\b/g, componentName)
    if (newNorm === expectedNorm) return { pass: true }
    // Compute small diff sample.
    let i = 0
    while (i < newNorm.length && i < expectedNorm.length && newNorm[i] === expectedNorm[i]) i++
    const span = 80
    return {
        pass: false,
        diff:
            `expected: ...${expectedNorm.slice(Math.max(0, i - 20), i + span)}\n` +
            `actual:   ...${newNorm.slice(Math.max(0, i - 20), i + span)}`,
    }
}

const [, , compArg, variantArg] = process.argv

const designSystem = await loadDesignSystem()
const registry = await buildTargetRegistry()

let components: string[]
if (compArg) components = [compArg]
else components = await listComponents()

let total = 0
let passed = 0
const failures: Array<{ comp: string; variant: string; diff?: string }> = []

const t0 = Date.now()
for (const comp of components) {
    const variants = variantArg ? [variantArg] : await listVariants(comp)
    for (const v of variants) {
        total++
        const r = await runOne(comp, v, designSystem, registry)
        if (r.pass) passed++
        else failures.push({ comp, variant: v, diff: r.diff })
    }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

console.log(`TOTAL: ${total} PASSED: ${passed} FAILED: ${failures.length} (${elapsed}s)`)
for (const f of failures) {
    console.log(`✗ ${f.comp}/${f.variant}`)
    if (f.diff) console.log(f.diff)
}
if (failures.length) process.exit(1)
