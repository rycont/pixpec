/**
 * Throwaway: regenerate RGG maps for the breakdown nodes (called once
 * after `breakdown.ts` to inspect remaining residuals visually).
 */
import { writeRggMaps } from '../../src/rgg.ts'

const F = '/home/rycont/dev/pixpec-workdir/danah/.pixpec-out/_slint-bd/4108_1696'
for (const n of ['4108_1697', '4108_1699', '4108_1696']) {
  const W = `${F}/BD_${n}/_work`
  await writeRggMaps(`${W}/figma/BD_${n}.png`, `${W}/chromium/BD_${n}.png`, `${W}/rgg`)
  console.log('rgg', n)
}
