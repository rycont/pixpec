# pixpec

Pixel-level visual regression testing framework for design systems.

## What pixpec is

A **frame** for verifying that React component implementations match Figma
designs at the pixel level — no more, no less. Three things:

1. **사상** — Leaf-Composition. Every component's noise (predicted dE)
   composes additively from leaf primitives + base residuals + multipliers.
   The framework provides the contract; you supply leaves.
2. **Convention** — directory layout and `defineComponent({ impl, noise, cases })`
   shape. Flat component registry.
3. **Runner** — Playwright with locked Chromium flags + cfigma bridge for
   Figma PNG export + default HSB metric. Compares actual vs predicted ×
   multiplier, returns PASS/FAIL.

## What pixpec is not

- A model. **No** atlas, font, or noise constants ship in pixpec.
- A measurement library. The default HSB measure is a sane choice, but
  swappable.
- A design system. pixpec is consumed by DS packages (e.g. `danah`).

## Three layers

```
pixpec     ← this package: types + runner + Chromium flags + default measure
  ↑
<your-DS>  ← e.g. `danah`: font, atlas, noise functions, components+cases
  ↑
<app>      ← imports the DS, runs `pixpec verify` in CI
```

## Component contract

```ts
import { defineComponent } from 'pixpec'

export default defineComponent({
  impl:  (props: ButtonProps) => string,    // HTML or React-rendered
  noise: (props: ButtonProps) => number,    // predicted dE
  cases: [
    { props: { ... }, fileKey: '...', nodeId: '...' },
    ...
  ],
})
```

`noise` and the multiplier(s) are **DS-side concerns**. pixpec only knows the
contract: actual dE vs `noise(props) * multiplier` → pass/fail. Multiplier is
passed at runner invocation, not embedded in the component.

## Runner

```bash
pixpec verify <dir-of-components> --multiplier 1.45
```

For each component × case:
1. Render `impl(props)` in Chromium with locked flags.
2. Export Figma node via `cfigma` (separately running bridge).
3. Measure dE via default HSB metric (or user-provided).
4. Compare to `noise(props) × multiplier`.
5. Report.

## Locked Chromium flags

pixpec runs Playwright with:
- `--disable-lcd-text`
- `--font-render-hinting=none`

These are part of the contract. DS packages that want different flags should
fork or override at runner-init time.

## Default metric

HSB Euclidean (cv2 HSV-space, hue-circular, saturation-weighted). Sub-pixel
LINEAR alignment via warpAffine. Suitable for grayscale text and colored UI.
Override at runner-init if needed.

## Status

Pre-alpha. Frame-only at the moment. No published package.
