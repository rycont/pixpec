/**
 * pixpec analyze — per-diff-blob shift + shape-diff diagnosis.
 *
 * Thin wrapper around the Rust `pixpec-analyze` binary
 * (`analyze-rs/target/release/pixpec-analyze`). Runs phase-correlation-style
 * integer sweep per blob, classifies shift|shift+shape|shape, writes
 * segments.json + per-segment crops + RGG maps to
 * `.pixpec-out/<C>/analysis/<case>/`.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { loadConfig } from './init.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ANALYZE_BIN = resolve(HERE, '..', 'analyze-rs', 'target', 'release', 'pixpec-analyze')

export async function runAnalyze(componentName: string, caseName: string, _crop = false): Promise<void> {
  const { root } = await loadConfig()
  const baseDir = resolve(root, `.pixpec-out/${componentName}`)
  const figma = resolve(baseDir, 'figma', `${caseName}.png`)
  const chrom = resolve(baseDir, 'chromium', `${caseName}.png`)
  const outDir = resolve(baseDir, 'analysis', caseName)
  await mkdir(outDir, { recursive: true })
  const { stdout, stderr } = await execFileAsync(
    ANALYZE_BIN, [figma, chrom, '--out', outDir],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
}
