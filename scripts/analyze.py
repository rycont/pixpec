#!/usr/bin/env python3
"""
pixpec analyze — per-diff-blob shift + shape-diff diagnosis.

Reads .pixpec-out/<C>/figma/<case>.png + chromium/<case>.png, segments diff
pixels via threshold + dilation, runs phase correlation per blob (with sweep
fallback for tiny blobs), writes segments.json + optionally crops.

Usage:
  python analyze.py <out_dir> <case_name> [--crop]
"""
import sys, json, os
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage
import cv2

DIFF_THRESH = 30
DIL_ITER = 2
MIN_AREA = 30
PAD = 8
PHASE_MIN_SIDE = 16  # below this → sweep fallback


def load(p):
    img = Image.open(p)
    if img.mode == 'RGBA':
        bg = Image.new('RGB', img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        img = bg
    return np.array(img.convert('RGB')).astype(np.float32)


def sweep_shift(a, b, R=5):
    ah, aw = a.shape
    best = None
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            ay = slice(max(0, -dy), ah - max(0, dy))
            by = slice(max(0, dy), ah - max(0, -dy))
            ax = slice(max(0, -dx), aw - max(0, dx))
            bx = slice(max(0, dx), aw - max(0, -dx))
            d = float(np.abs(a[ay, ax] - b[by, bx]).sum())
            if best is None or d < best[0]:
                best = (d, dy, dx)
    return best  # (residual, dy, dx)


def phase_shift(a, b):
    h, w = a.shape
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    aw = (a - a.mean()) * win
    bw = (b - b.mean()) * win
    (dx, dy), response = cv2.phaseCorrelate(aw, bw)
    return dx, dy, response


def analyze(out_dir: Path, case_name: str, crop: bool = False) -> dict:
    figma_path = out_dir / 'figma' / f'{case_name}.png'
    chrom_path = out_dir / 'chromium' / f'{case_name}.png'
    if not figma_path.exists() or not chrom_path.exists():
        raise FileNotFoundError(f'PNG missing: {figma_path} or {chrom_path}')

    f = load(figma_path)
    i = load(chrom_path)
    H = min(f.shape[0], i.shape[0])
    W = min(f.shape[1], i.shape[1])
    f = f[:H, :W]
    i = i[:H, :W]
    f_g = f.mean(axis=2).astype(np.float32)
    i_g = i.mean(axis=2).astype(np.float32)

    diff = np.abs(f - i).max(axis=2)
    diff_dil = ndimage.binary_dilation(diff > DIFF_THRESH, iterations=DIL_ITER)
    lbl, n = ndimage.label(diff_dil)

    blobs = []
    for k in range(1, n + 1):
        region = (lbl == k)
        area = int(region.sum())
        if area < MIN_AREA:
            continue
        ys, xs = np.where(region)
        y0 = max(0, int(ys.min()) - PAD)
        y1 = min(H, int(ys.max()) + PAD)
        x0 = max(0, int(xs.min()) - PAD)
        x1 = min(W, int(xs.max()) + PAD)
        fc = f_g[y0:y1, x0:x1]
        ic = i_g[y0:y1, x0:x1]
        if min(fc.shape) < 4:
            continue

        # Pre-shift dE
        dE_before = float(np.abs(fc - ic).sum())

        # Choose method by size
        if min(fc.shape) >= PHASE_MIN_SIDE:
            pdx, pdy, response = phase_shift(fc, ic)
            method = 'phase'
            dx, dy = pdx, pdy
        else:
            res_after, sdy, sdx = sweep_shift(fc, ic)
            response = max(0.0, 1.0 - res_after / dE_before) if dE_before > 0 else 0
            method = 'sweep'
            dx, dy = float(sdx), float(sdy)

        # Compute residual after shift (round to integer for int-px fill)
        idx, idy = int(round(dx)), int(round(dy))
        ah, aw = fc.shape
        ay = slice(max(0, -idy), ah - max(0, idy))
        by = slice(max(0, idy), ah - max(0, -idy))
        ax_ = slice(max(0, -idx), aw - max(0, idx))
        bx_ = slice(max(0, idx), aw - max(0, -idx))
        dE_after = float(np.abs(fc[ay, ax_] - ic[by, bx_]).sum())
        reduction = (1 - dE_after / dE_before) if dE_before > 0 else 0

        # Classify
        if reduction > 0.7 and response > 0.7:
            kind = 'shift'
        elif reduction > 0.4:
            kind = 'shift+shape'
        else:
            kind = 'shape'

        blob = {
            'id': k,
            'bbox': [int(x0), int(y0), int(x1), int(y1)],
            'area': area,
            'dx': round(float(dx), 3),
            'dy': round(float(dy), 3),
            'response': round(float(response), 3),
            'dE_before': round(dE_before, 1),
            'dE_after': round(dE_after, 1),
            'reduction': round(reduction, 3),
            'method': method,
            'kind': kind,
        }
        blobs.append(blob)

        if crop:
            seg_dir = out_dir / 'analysis' / case_name / f'seg_{k}'
            seg_dir.mkdir(parents=True, exist_ok=True)
            Image.fromarray(f[y0:y1, x0:x1].astype(np.uint8)).save(seg_dir / 'figma.png')
            Image.fromarray(i[y0:y1, x0:x1].astype(np.uint8)).save(seg_dir / 'impl.png')

    blobs.sort(key=lambda b: -b['area'])

    # Trend
    shift_blobs = [b for b in blobs if b['kind'] == 'shift']
    summary = {'total_blobs': len(blobs), 'shift_blobs': len(shift_blobs)}
    if shift_blobs:
        dxs = [b['dx'] for b in shift_blobs]
        dys = [b['dy'] for b in shift_blobs]
        summary['shift_dx'] = {'mean': round(float(np.mean(dxs)), 3), 'std': round(float(np.std(dxs)), 3)}
        summary['shift_dy'] = {'mean': round(float(np.mean(dys)), 3), 'std': round(float(np.std(dys)), 3)}

    return {'case': case_name, 'summary': summary, 'blobs': blobs}


def main():
    if len(sys.argv) < 3:
        print('usage: analyze.py <out_dir> <case_name> [--crop]', file=sys.stderr)
        sys.exit(2)
    out_dir = Path(sys.argv[1])
    case = sys.argv[2]
    crop = '--crop' in sys.argv[3:]

    result = analyze(out_dir, case, crop=crop)

    analysis_dir = out_dir / 'analysis' / case
    analysis_dir.mkdir(parents=True, exist_ok=True)
    json_path = analysis_dir / 'segments.json'
    json_path.write_text(json.dumps(result, indent=2))

    # Print summary
    s = result['summary']
    print(f"\n=== {case} ===")
    print(f"  blobs: {s['total_blobs']} (shift: {s['shift_blobs']})")
    if 'shift_dx' in s:
        print(f"  shift dx: mean={s['shift_dx']['mean']:+.2f}  std={s['shift_dx']['std']:.2f}")
        print(f"  shift dy: mean={s['shift_dy']['mean']:+.2f}  std={s['shift_dy']['std']:.2f}")
    print(f"\n  {'b':>3} {'bbox':<22} {'area':>5} {'dx':>6} {'dy':>6} {'resp':>5} {'reduction':>9} {'kind':<12}")
    for b in result['blobs'][:15]:
        bb = '(' + ','.join(map(str, b['bbox'])) + ')'
        sx = f"{b['dx']:+.2f}"
        sy = f"{b['dy']:+.2f}"
        print(f"  {b['id']:>3} {bb:<22} {b['area']:>5} {sx:>6} {sy:>6} {b['response']:>5.3f} {b['reduction']:>9.2f} {b['kind']:<12}")
    print(f"\n  → {json_path}")
    if crop:
        print(f"  → {analysis_dir}/seg_*/figma.png + impl.png")


if __name__ == '__main__':
    main()
