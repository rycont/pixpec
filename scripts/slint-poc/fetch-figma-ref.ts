/**
 * Throwaway PoC: pull a single figma node through pixpec's dump-figma
 * pipeline so the resulting PNG is rendered at danah's exact `scale`
 * setting (= identical condition to a chromium dump).
 *
 *   tsx fetch-figma-ref.ts
 *
 * Writes: <here>/work/figma/chip.png  (scale = danah pixpec.toml).
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rename, mkdir } from 'node:fs/promises'
import { dumpFigma } from '../../src/dump-figma.ts'
import { loadConfig } from '../../src/init.ts'
import { defineComponent } from '../../src/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DANAH_ROOT = resolve(HERE, '../../../danah')
const OUT_DIR = resolve(HERE, 'work/figma')

const FILE_KEY = 'XuZaMcO3FuA8B0GEZRYvLG'
const NODE_ID = '2137:1948'
const FIGMA_ID = `${FILE_KEY}:${NODE_ID}`

const fakeComponent = defineComponent({
  name: 'SlintPocChip',
  variants: [
    {
      key: 'poc-key',
      usecases: [{ figmaId: FIGMA_ID, props: {}, isMainCase: true }],
    },
  ],
}) as Parameters<typeof dumpFigma>[0]['component']

const { cfg } = await loadConfig(DANAH_ROOT)
console.log(`[fetch] using scale=${cfg.scale} bridge=${cfg.bridge}`)
await mkdir(OUT_DIR, { recursive: true })

await dumpFigma({
  component: fakeComponent,
  outDir: OUT_DIR,
  scale: cfg.scale,
  bridge: cfg.bridge,
  cfigmaBin: cfg.cfigmaBin,
})

// dumpFigma names the file by sanitized figmaId, e.g.
// XuZaMcO3FuA8B0GEZRYvLG_2137_1948.png. Rename to chip.png so the
// measure-rs pairing key matches our slint-rendered chip.png.
const safe = FIGMA_ID.replace(/[^A-Za-z0-9]/g, '_')
await rename(`${OUT_DIR}/${safe}.png`, `${OUT_DIR}/chip.png`)
console.log(`[fetch] wrote ${OUT_DIR}/chip.png`)
