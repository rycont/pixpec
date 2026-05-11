#!/usr/bin/env bash
# Throwaway PoC runner — verifies three things end-to-end:
#   1. .slint hand-authored ≈ figma node "Chip / 뉴진스" (codegen feasibility)
#   2. slint-viewer can render it to PNG headless (screenshot feasibility)
#   3. measure-rs ΔE00 against figma reference (verification feasibility)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$HERE/work"
SLINT_FILE="$HERE/chip.slint"
OUT_PNG="$WORK/chromium/chip.png"
MEASURE_BIN="$HERE/../../measure-rs/target/release/pixpec-measure"

echo "[1/3] rendering $SLINT_FILE → $OUT_PNG"
# Software backend so this works headless (no X / no GPU required).
SLINT_BACKEND=winit-software slint-viewer \
    --save-screenshot "$OUT_PNG" \
    "$SLINT_FILE"

echo "[2/3] dims:"
file "$WORK/figma/chip.png" "$OUT_PNG"

echo "[3/3] measuring..."
"$MEASURE_BIN" "$WORK"
echo "--- results.json ---"
cat "$WORK/results.json"
