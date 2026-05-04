/**
 * pixpec analyze — per-diff-blob shift + shape-diff diagnosis.
 * Shells out to scripts/analyze.py (numpy/scipy/cv2 logic).
 *
 * Output: .pixpec-out/<C>/analysis/<case>/segments.json
 *   + (with --crop) per-segment figma.png/impl.png
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './init.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', 'scripts', 'analyze.py')

export async function runAnalyze(componentName: string, caseName: string, crop = false): Promise<void> {
  const { root } = await loadConfig()
  const outDir = resolve(root, `.pixpec-out/${componentName}`)
  await new Promise<void>((res, rej) => {
    const proc = spawn(
      'python3',
      [SCRIPT, outDir, caseName, ...(crop ? ['--crop'] : [])],
      { stdio: 'inherit' },
    )
    proc.on('exit', (code) => (code === 0 ? res() : rej(new Error(`analyze.py exit ${code}`))))
  })
}
