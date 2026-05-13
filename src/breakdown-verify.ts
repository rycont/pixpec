import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { PixpecConfig } from './init.ts'
import { switchToPageContaining } from './cfigma-meta.ts'
import { exportFigmaNodes } from './figma.ts'
import {
  captureGpuiGeneratedWithRuntime,
  prepareGpuiCaptureRuntime,
} from './targets/gpui/capture.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const MEASURE_BIN = resolve(HERE, '../measure-rs/target/release/pixpec-measure')

export interface BreakdownVerifyEntry {
  index: number
  sourceId: string
  sourceName: string
  sourceType: string
  sourceWidth?: number
  sourceHeight?: number
  outputs: Record<string, string>
  captureSkip?: string
}

export interface BreakdownVerifyManifest {
  viewName: string
  figmaId: string
  entries: BreakdownVerifyEntry[]
}

export interface BreakdownVerifyOptions {
  cfg: PixpecConfig
  viewDir: string
  manifestPath: string
  target: string
  maxBlob?: number
  blobThreshold?: string
  sourceId?: string
  rootDir?: string
}

interface MeasureRecord {
  case: string
  dE00: number
  dE00_max: number
  blob_max_size: number
  blob_max_bbox: [number, number, number, number]
  artifacts: { figma: string; impl: string }
}

export async function runBreakdownVerify(opts: BreakdownVerifyOptions): Promise<{
  pass: number
  fail: number
  total: number
  skipped: number
}> {
  if (opts.target !== 'gpui' && opts.target !== 'react-panda') {
    throw new Error(`breakdown verify: target ${opts.target} is not supported yet`)
  }

  const manifest = JSON.parse(await readFile(opts.manifestPath, 'utf8')) as BreakdownVerifyManifest
  const fileKey = manifest.figmaId.slice(0, manifest.figmaId.indexOf(':'))
  const maxBlob = opts.maxBlob ?? 25
  const gpuiOutputScale = Math.max(
    1,
    Number(process.env.PIXPEC_BREAKDOWN_VERIFY_OUTPUT_SCALE ?? 1),
  )
  const outRoot = resolve(opts.viewDir, 'breakdown', 'verify', opts.target)
  const figmaDir = resolve(outRoot, 'figma')
  const dstDir = resolve(outRoot, 'dst')
  const measureRoot = resolve(outRoot, 'measure')
  const runtimeDir = resolve(outRoot, 'runtime')
  const resultsPath = resolve(outRoot, 'results.json')
  if (process.env.PIXPEC_BREAKDOWN_VERIFY_PRESERVE !== '1') {
    await rm(outRoot, { recursive: true, force: true })
  }
  await mkdir(figmaDir, { recursive: true })
  await mkdir(dstDir, { recursive: true })
  await mkdir(measureRoot, { recursive: true })

  const runtime =
    opts.target === 'gpui'
      ? await prepareGpuiCaptureRuntime(runtimeDir)
      : await (await import('./targets/react-panda/capture.ts')).prepareReactPandaGeneratedCaptureRuntime({
          runtimeDir,
          rootDir: opts.rootDir ?? resolve(opts.viewDir, '../../..'),
          remBase: opts.cfg.remBase,
        })
  const records: Array<{
    entry: Pick<BreakdownVerifyEntry, 'index' | 'sourceId' | 'sourceName' | 'sourceType'>
    ok: boolean
    measure?: MeasureRecord
    error?: string
    skipped?: string
  }> = []

  const startIndex = Number(process.env.PIXPEC_BREAKDOWN_VERIFY_START_INDEX ?? 0)
  const endIndex = Number(process.env.PIXPEC_BREAKDOWN_VERIFY_END_INDEX ?? 0)
  const entries = (opts.sourceId
    ? manifest.entries.filter((entry) => entry.sourceId === opts.sourceId)
    : manifest.entries
  ).filter((entry) => {
    if (startIndex > 0 && entry.index < startIndex) return false
    if (endIndex > 0 && entry.index > endIndex) return false
    return true
  })
  if (opts.sourceId && entries.length === 0) {
    throw new Error(`breakdown verify: no manifest entry for sourceId ${opts.sourceId}`)
  }

  try {
  for (const entry of entries) {
    if (entry.captureSkip) {
      records.push({
        entry: summarize(entry),
        ok: true,
        skipped: entry.captureSkip,
      })
      await writeResults()
      console.log(
        `[breakdown verify:${opts.target}] ${entry.index}/${manifest.entries.length} ${entry.sourceId} skipped: ${entry.captureSkip}`,
      )
      continue
    }

    const caseName = `${String(entry.index).padStart(4, '0')}_${safeName(entry.sourceId)}`
    const generatedRel = entry.outputs[opts.target]
    if (!generatedRel) {
      await recordFailure()
      throw new Error(`breakdown verify: entry ${entry.index} has no ${opts.target} output`)
    }

    try {
      console.log(`[breakdown verify:${opts.target}] ${entry.index}/${manifest.entries.length} ${entry.sourceId}`)
      const generatedPath = resolve(opts.viewDir, generatedRel)
      if (!existsSync(generatedPath)) {
        throw new Error(`missing generated file: ${generatedPath}`)
      }

      const sourcePng = await exportSourcePng({
        cfg: opts.cfg,
        fileKey,
        nodeId: entry.sourceId,
        outDir: figmaDir,
        caseName,
      })
      const sharp = (await import('sharp')).default
      const meta = await sharp(sourcePng).metadata()
      const width = Math.max(1, meta.width ?? 0, Math.ceil(entry.sourceWidth ?? 0))
      const height = Math.max(1, meta.height ?? 0, Math.ceil(entry.sourceHeight ?? 0))
      const dstPng = resolve(dstDir, `${caseName}.png`)
      if (opts.target === 'gpui') {
        const capturePng = gpuiOutputScale > 1
          ? resolve(dstDir, `${caseName}@${gpuiOutputScale}x.png`)
          : dstPng
        await captureGpuiGeneratedWithRuntime({
          runtime: runtime as Awaited<ReturnType<typeof prepareGpuiCaptureRuntime>>,
          caseDir: resolve(runtimeDir, caseName),
          generatedPath,
          width,
          height,
          outputScale: gpuiOutputScale,
          outPath: capturePng,
        })
        if (capturePng !== dstPng) {
          await downsampleCopy(capturePng, dstPng, width, height)
        }
      } else {
        const { captureReactPandaGeneratedWithRuntime } = await import('./targets/react-panda/capture.ts')
        await captureReactPandaGeneratedWithRuntime({
          runtime: runtime as never,
          generatedPath,
          width,
          height,
          outputScale: opts.cfg.scale ?? 2,
          outPath: dstPng,
        })
      }

      const measure = await measurePair({
        caseName,
        sourcePng,
        dstPng,
        measureRoot,
        blobThreshold: opts.blobThreshold,
      })
      const ok = measure.blob_max_size <= maxBlob
      records.push({
        entry: summarize(entry),
        ok,
        measure,
      })
      await writeResults()
      console.log(
        `  ${ok ? 'pass' : 'fail'} blob=${measure.blob_max_size} max=${measure.dE00_max.toFixed(2)} sum=${measure.dE00.toFixed(0)}`,
      )
      if (!ok) {
        throw new Error(
          `breakdown verify failed at entry ${entry.index} ${entry.sourceId}: blob=${measure.blob_max_size} > maxBlob=${maxBlob}`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      if (records.at(-1)?.entry.index !== entry.index) {
        records.push({
          entry: summarize(entry),
          ok: false,
          error: message,
        })
      } else if (records.at(-1)) {
        records[records.length - 1]!.error = message
      }
      await writeResults()
      throw error
    }
  }

  return {
    pass: records.filter((r) => r.ok && !r.skipped).length,
    fail: records.filter((r) => !r.ok).length,
    skipped: records.filter((r) => r.skipped).length,
    total: records.length,
  }
  } finally {
    if ('close' in runtime && typeof runtime.close === 'function') {
      await runtime.close()
    }
  }

  async function recordFailure() {
    await writeResults()
  }

  async function writeResults() {
    await mkdir(outRoot, { recursive: true })
    await writeFile(
      resultsPath,
      `${JSON.stringify(
        {
          viewName: manifest.viewName,
          target: opts.target,
          maxBlob,
          stoppedAt: records.find((r) => !r.ok)?.entry ?? null,
          pass: records.filter((r) => r.ok && !r.skipped).length,
          fail: records.filter((r) => !r.ok).length,
          skipped: records.filter((r) => r.skipped).length,
          totalChecked: records.length,
          records,
        },
        null,
        2,
      )}\n`,
    )
  }
}

async function exportSourcePng(opts: {
  cfg: PixpecConfig
  fileKey: string
  nodeId: string
  outDir: string
  caseName: string
}): Promise<string> {
  const target = resolve(opts.outDir, `${opts.caseName}.png`)
  if (process.env.PIXPEC_BREAKDOWN_VERIFY_CACHE_FIGMA === '1' && existsSync(target)) {
    return target
  }
  await retryFigmaControl(() =>
    switchToPageContaining({
      tabPattern: opts.fileKey,
      nodeId: opts.nodeId,
      cfigmaBin: opts.cfg.cfigmaBin,
    }),
  )
  const map = await retryFigmaExport(() =>
    exportFigmaNodes({
      tabPattern: opts.fileKey,
      nodeIds: [opts.nodeId],
      outDir: opts.outDir,
      scale: opts.cfg.scale ?? 2,
      bridge: opts.cfg.bridge,
      cfigmaBin: opts.cfg.cfigmaBin,
    }),
  )
  const exported = map.get(opts.nodeId)
  if (!exported) throw new Error(`breakdown verify: no Figma export for ${opts.nodeId}`)
  await rm(target, { force: true })
  await copyFile(exported, target)
  return target
}

async function retryFigmaExport<T>(fn: () => Promise<T>): Promise<T> {
  return retryFigmaControl(fn)
}

async function retryFigmaControl<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === 3) break
      await sleep(attempt * 750)
    }
  }
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function measurePair(opts: {
  caseName: string
  sourcePng: string
  dstPng: string
  measureRoot: string
  blobThreshold?: string
}): Promise<MeasureRecord> {
  const sharp = (await import('sharp')).default
  const base = resolve(opts.measureRoot, opts.caseName)
  const figmaDir = resolve(base, 'figma')
  const dstDir = resolve(base, 'dst')
  await rm(base, { recursive: true, force: true })
  await mkdir(figmaDir, { recursive: true })
  await mkdir(dstDir, { recursive: true })
  const sourceForMeasure = resolve(base, 'source.trim.png')
  const dstForMeasure = resolve(base, 'dst.trim.png')
  await Promise.all([
    trimTransparentCopy(opts.sourcePng, sourceForMeasure),
    trimTransparentCopy(opts.dstPng, dstForMeasure),
  ])

  const [srcMeta, dstMeta] = await Promise.all([
    sharp(sourceForMeasure).metadata(),
    sharp(dstForMeasure).metadata(),
  ])
  const targetW = padToMul(Math.max(srcMeta.width ?? 0, dstMeta.width ?? 0), 8)
  const targetH = padToMul(Math.max(srcMeta.height ?? 0, dstMeta.height ?? 0), 8)
  await Promise.all([
    padCopy(sourceForMeasure, resolve(figmaDir, `${opts.caseName}.png`), targetW, targetH),
    padCopy(dstForMeasure, resolve(dstDir, `${opts.caseName}.png`), targetW, targetH),
  ])

  await execFileAsync(
    MEASURE_BIN,
    [base, ...(opts.blobThreshold ? ['--blob-threshold', opts.blobThreshold] : [])],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const results = JSON.parse(await readFile(resolve(base, 'results.json'), 'utf8')) as MeasureRecord[]
  const record = results[0]
  if (!record) throw new Error(`breakdown verify: measure produced no record for ${opts.caseName}`)
  return record
}

async function trimTransparentCopy(from: string, to: string): Promise<void> {
  const sharp = (await import('sharp')).default
  const image = sharp(from).ensureAlpha()
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
  let minX = info.width
  let minY = info.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3]
      if (alpha <= 0) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) {
    await sharp(from).png().toFile(to)
    return
  }
  await sharp(from)
    .extract({
      left: minX,
      top: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    })
    .png()
    .toFile(to)
}

async function padCopy(from: string, to: string, width: number, height: number): Promise<void> {
  const sharp = (await import('sharp')).default
  const meta = await sharp(from).metadata()
  const w = meta.width ?? width
  const h = meta.height ?? height
  await sharp(from)
    .extend({
      top: 0,
      left: 0,
      right: width - w,
      bottom: height - h,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(to)
}

async function downsampleCopy(from: string, to: string, width: number, height: number): Promise<void> {
  const sharp = (await import('sharp')).default
  await sharp(from)
    .resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(to)
}

function summarize(entry: BreakdownVerifyEntry) {
  return {
    index: entry.index,
    sourceId: entry.sourceId,
    sourceName: entry.sourceName,
    sourceType: entry.sourceType,
    ...(entry.captureSkip ? { captureSkip: entry.captureSkip } : {}),
  }
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '_')
}

function padToMul(value: number, mul: number): number {
  return Math.max(mul, Math.ceil(value / mul) * mul)
}
