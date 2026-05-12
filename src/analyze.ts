/**
 * pixpec analyze — per-diff-blob shift + shape-diff diagnosis.
 *
 * Thin wrapper around the Rust `pixpec-analyze` binary
 * (`analyze-rs/target/release/pixpec-analyze`). Runs phase-correlation-style
 * integer sweep per blob, classifies shift|shift+shape|shape, writes
 * segments.json + per-segment crops + RGG maps to
 * `<component>/.pixpec/verify/figma__<target>/analysis/<case>/`.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { loadConfig } from './init.ts'
import { captureDir, componentPixpecDir } from './capture/index.ts'
import { resolveOneConfiguredTarget } from './targets/index.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ANALYZE_BIN = resolve(HERE, '..', 'analyze-rs', 'target', 'release', 'pixpec-analyze')

export async function runAnalyze(componentName: string, caseName: string, _crop = false, targetName?: string): Promise<void> {
  const { cfg, root } = await loadConfig()
  const target = resolveOneConfiguredTarget(cfg, targetName)
  const componentsDir = cfg.componentsDir ?? 'src/components'
  const componentDir = resolve(root, componentsDir, componentName)
  const figma = resolve(captureDir(componentDir, 'src', 'figma'), `${caseName}.png`)
  const dst = resolve(captureDir(componentDir, 'dst', target), `${caseName}.png`)
  const outDir = resolve(componentPixpecDir(componentDir), 'verify', `figma__${target}`, 'analysis', caseName)
  await mkdir(outDir, { recursive: true })
  const { stdout, stderr } = await execFileAsync(
    ANALYZE_BIN, [figma, dst, '--out', outDir],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
}
