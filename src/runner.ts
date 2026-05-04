/**
 * DEPRECATED — `runComponents` removed. Use the split scripts in danah/scripts:
 *   - dump-figma.ts <component>     — exports Figma frames to .pixpec-out/<c>/figma/
 *   - dump-chromium.ts <component>  — renders + screenshots to .pixpec-out/<c>/chromium/
 *   - measure.ts <component>         — compares + writes results.json
 *
 * Original implementation preserved at runner.ts.deprecated for reference.
 */
export function runComponents(): never {
  throw new Error('runComponents() is deprecated. See scripts/dump-figma.ts, dump-chromium.ts, measure.ts')
}
export interface RunOptions { _deprecated: true }
