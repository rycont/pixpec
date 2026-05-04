//! pixpec-analyze — single-pair diff diagnosis. Per-blob shift+shape kind.
//!
//! Pipeline:
//!   1. Load figma + chrom PNGs (alpha→white flatten).
//!   2. Compute per-pixel |Δ| (max over RGB), threshold + dilate.
//!   3. Connected components → blobs (area ≥ MIN_AREA).
//!   4. Per blob: integer sweep over ±SHIFT_RANGE px, find min-SAD shift.
//!      Compute reduction = 1 - dE_after/dE_before. Classify:
//!        shift        → reduction > 0.7
//!        shift+shape  → 0.4 < reduction ≤ 0.7
//!        shape        → reduction ≤ 0.4
//!   5. Always emit segments.json + per-segment {figma,impl,rgg-h/s/v}.png
//!      and whole-image rgg-h/s/v.png.
//!
//! RGG (HSB axis diff visualization):
//!   gray (230) — match. red shade — figma<impl. green shade — figma>impl.
//!   Intensity ∝ |Δ|. Three maps for H/S/V independently.
//!
//! Usage:
//!   pixpec-analyze <figma.png> <chromium.png> --out <dir>

use anyhow::{Context, Result, bail};
use image::ImageReader;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::{env, fs};

const DIFF_THRESH: u8 = 30;
const DIL_ITER: u32 = 2;
const MIN_AREA: u32 = 30;
const PAD: i32 = 8;
const SHIFT_RANGE: i32 = 5;
const SUBPIX_RANGE: f64 = 0.5;
const SUBPIX_STEP: f64 = 0.1;

#[derive(Serialize)]
struct Segment {
    id: u32,
    bbox: [i32; 4],
    area: u32,
    /// Sub-pixel shift in device px from two-stage sweep (integer SHIFT_RANGE
    /// then bilinear refine over SUBPIX_RANGE at SUBPIX_STEP). Positive shift
    /// means b should be sampled at (x+dx, y+dy) to align with a.
    dx: f64,
    dy: f64,
    de_before: f64,
    de_after: f64,
    reduction: f64,
    kind: String,
}

#[derive(Serialize)]
struct Output {
    figma: PathBuf,
    chromium: PathBuf,
    summary: Summary,
    segments: Vec<Segment>,
}

#[derive(Serialize, Default)]
struct Summary {
    total_blobs: usize,
    shift_blobs: usize,
    shift_dx_mean: f64,
    shift_dy_mean: f64,
    shift_dx_std: f64,
    shift_dy_std: f64,
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: {} <figma.png> <chromium.png> [--out <dir>]", args[0]);
        std::process::exit(2);
    }
    let figma_path = PathBuf::from(&args[1]);
    let chrom_path = PathBuf::from(&args[2]);
    let mut out_dir: Option<PathBuf> = None;
    let mut i = 3;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                out_dir = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            x => bail!("unknown arg: {x}"),
        }
    }
    let out_dir = out_dir
        .or_else(|| {
            // Default: alongside chromium PNG, in `analysis/<basename>/`
            let stem = chrom_path.file_stem()?.to_string_lossy().to_string();
            chrom_path.parent().map(|p| p.join("analysis").join(stem))
        })
        .context("could not derive out dir")?;
    fs::create_dir_all(&out_dir)?;

    let f = load_rgb(&figma_path)?;
    let c = load_rgb(&chrom_path)?;
    if f.w != c.w || f.h != c.h {
        bail!(
            "dim mismatch: figma {}x{} vs chrom {}x{}",
            f.w,
            f.h,
            c.w,
            c.h,
        );
    }
    let w = f.w as i32;
    let h = f.h as i32;

    // 1. |Δ| per pixel + threshold + dilate.
    let diff_mask = compute_diff_mask(&f.data, &c.data, w as u32, h as u32);

    // 2. Connected components → blobs.
    let blobs = connected_components(&diff_mask, w as u32, h as u32);

    // 3. Per-blob sweep + classify.
    let mut segments = Vec::new();
    for (id, blob) in blobs.iter().enumerate() {
        if blob.area < MIN_AREA {
            continue;
        }
        let x0 = (blob.x0 - PAD).max(0);
        let y0 = (blob.y0 - PAD).max(0);
        let x1 = (blob.x1 + PAD).min(w);
        let y1 = (blob.y1 + PAD).min(h);
        let cw = x1 - x0;
        let ch = y1 - y0;
        if cw < 4 || ch < 4 {
            continue;
        }
        let fc = crop_gray(&f.data, w, x0, y0, cw, ch);
        let ic = crop_gray(&c.data, w, x0, y0, cw, ch);
        let de_before = sad_subpix(&fc, &ic, cw, ch, 0.0, 0.0);
        // Two-stage sweep: integer ±SHIFT_RANGE, then bilinear sub-pixel
        // refine ±SUBPIX_RANGE at SUBPIX_STEP around the integer winner.
        let (dx, dy, de_after) = sweep_shift_subpix(&fc, &ic, cw, ch);
        let reduction = if de_before > 0.0 {
            1.0 - de_after / de_before
        } else {
            0.0
        };
        let kind = if reduction > 0.7 {
            "shift"
        } else if reduction > 0.4 {
            "shift+shape"
        } else {
            "shape"
        };
        let seg_id = (id + 1) as u32;
        // 4. Per-segment crops.
        let seg_dir = out_dir.join(format!("seg_{seg_id}"));
        fs::create_dir_all(&seg_dir)?;
        save_rgb_crop(&f.data, w, x0, y0, cw, ch, &seg_dir.join("figma.png"))?;
        save_rgb_crop(&c.data, w, x0, y0, cw, ch, &seg_dir.join("impl.png"))?;
        write_rgg_crop(
            &f.data,
            &c.data,
            w,
            x0,
            y0,
            cw,
            ch,
            &seg_dir,
        )?;
        segments.push(Segment {
            id: seg_id,
            bbox: [x0, y0, x1, y1],
            area: blob.area,
            dx,
            dy,
            de_before,
            de_after,
            reduction,
            kind: kind.to_string(),
        });
    }

    // 5. Whole-image RGG.
    write_rgg_whole(&f.data, &c.data, w as u32, h as u32, &out_dir)?;

    // 6. Summary + output.
    let mut shift_dx = Vec::new();
    let mut shift_dy = Vec::new();
    for s in &segments {
        if s.kind == "shift" {
            shift_dx.push(s.dx);
            shift_dy.push(s.dy);
        }
    }
    let summary = Summary {
        total_blobs: segments.len(),
        shift_blobs: shift_dx.len(),
        shift_dx_mean: mean(&shift_dx),
        shift_dy_mean: mean(&shift_dy),
        shift_dx_std: std(&shift_dx),
        shift_dy_std: std(&shift_dy),
    };
    let out = Output {
        figma: figma_path,
        chromium: chrom_path,
        summary,
        segments,
    };
    fs::write(out_dir.join("segments.json"), serde_json::to_string_pretty(&out)?)?;

    // Print TTY summary.
    println!(
        "blobs={} shift={}  dy mean={:.2} std={:.2}  dx mean={:.2} std={:.2}",
        out.summary.total_blobs,
        out.summary.shift_blobs,
        out.summary.shift_dy_mean,
        out.summary.shift_dy_std,
        out.summary.shift_dx_mean,
        out.summary.shift_dx_std,
    );
    println!(
        "{:>3} {:>22} {:>5} {:>6} {:>6} {:>9} {:<11}",
        "id", "bbox", "area", "dx", "dy", "reduction", "kind",
    );
    for s in &out.segments {
        let bbox = format!(
            "({},{},{},{})",
            s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3]
        );
        let dxs = format!("{:+.2}", s.dx);
        let dys = format!("{:+.2}", s.dy);
        println!(
            "{:>3} {:>22} {:>5} {:>6} {:>6} {:>9.2} {:<11}",
            s.id, bbox, s.area, dxs, dys, s.reduction, s.kind,
        );
    }
    println!("→ {}", out_dir.display());

    Ok(())
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().sum::<f64>() / v.len() as f64
}
fn std(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let m = mean(v);
    (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
}

struct Rgb {
    data: Vec<u8>,
    w: u32,
    h: u32,
}

fn load_rgb(path: &Path) -> Result<Rgb> {
    let img = ImageReader::open(path)
        .with_context(|| format!("open {}", path.display()))?
        .decode()
        .with_context(|| format!("decode {}", path.display()))?;
    let (w, h) = (img.width(), img.height());
    let rgba = img.to_rgba8();
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for p in rgba.pixels() {
        let [r, g, b, a] = p.0;
        let af = a as f32 / 255.0;
        let blend = |c: u8| -> u8 {
            (c as f32 * af + 255.0 * (1.0 - af)).clamp(0.0, 255.0) as u8
        };
        rgb.push(blend(r));
        rgb.push(blend(g));
        rgb.push(blend(b));
    }
    Ok(Rgb { data: rgb, w, h })
}

/// Per-pixel max(|R|, |G|, |B|) > THRESH, then dilate.
fn compute_diff_mask(f: &[u8], c: &[u8], w: u32, h: u32) -> Vec<bool> {
    let n = (w * h) as usize;
    let mut mask = vec![false; n];
    for i in 0..n {
        let dr = (f[i * 3] as i16 - c[i * 3] as i16).abs() as u8;
        let dg = (f[i * 3 + 1] as i16 - c[i * 3 + 1] as i16).abs() as u8;
        let db = (f[i * 3 + 2] as i16 - c[i * 3 + 2] as i16).abs() as u8;
        if dr.max(dg).max(db) > DIFF_THRESH {
            mask[i] = true;
        }
    }
    // Dilate (4-connectivity, DIL_ITER iterations).
    for _ in 0..DIL_ITER {
        let mut next = mask.clone();
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                let idx = (y * w as i32 + x) as usize;
                if mask[idx] {
                    continue;
                }
                let neighbors = [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)];
                for (nx, ny) in neighbors {
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    if mask[(ny * w as i32 + nx) as usize] {
                        next[idx] = true;
                        break;
                    }
                }
            }
        }
        mask = next;
    }
    mask
}

struct Blob {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
    area: u32,
}

/// 4-connected components via flood-fill BFS.
fn connected_components(mask: &[bool], w: u32, h: u32) -> Vec<Blob> {
    let mut visited = vec![false; mask.len()];
    let mut blobs = Vec::new();
    let w_i = w as i32;
    let h_i = h as i32;
    for sy in 0..h_i {
        for sx in 0..w_i {
            let idx = (sy * w_i + sx) as usize;
            if !mask[idx] || visited[idx] {
                continue;
            }
            let mut q = vec![(sx, sy)];
            visited[idx] = true;
            let mut x0 = sx;
            let mut y0 = sy;
            let mut x1 = sx;
            let mut y1 = sy;
            let mut area = 0u32;
            while let Some((x, y)) = q.pop() {
                area += 1;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
                for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
                    if nx < 0 || ny < 0 || nx >= w_i || ny >= h_i {
                        continue;
                    }
                    let ni = (ny * w_i + nx) as usize;
                    if mask[ni] && !visited[ni] {
                        visited[ni] = true;
                        q.push((nx, ny));
                    }
                }
            }
            blobs.push(Blob {
                x0,
                y0,
                x1: x1 + 1,
                y1: y1 + 1,
                area,
            });
        }
    }
    blobs
}

/// Crop RGB (3 channels) → grayscale mean (1 channel) f32.
fn crop_gray(rgb: &[u8], src_w: i32, x0: i32, y0: i32, cw: i32, ch: i32) -> Vec<f32> {
    let mut out = Vec::with_capacity((cw * ch) as usize);
    for y in 0..ch {
        for x in 0..cw {
            let i = ((y0 + y) * src_w + (x0 + x)) as usize * 3;
            let g = (rgb[i] as f32 + rgb[i + 1] as f32 + rgb[i + 2] as f32) / 3.0;
            out.push(g);
        }
    }
    out
}

/// Sum of absolute differences between a (cw×ch) and b shifted by integer (dx, dy).
fn sad(a: &[f32], b: &[f32], cw: i32, ch: i32, dx: i32, dy: i32) -> f64 {
    let mut s = 0.0_f64;
    let y_lo = (-dy).max(0);
    let y_hi = ch - dy.max(0);
    let x_lo = (-dx).max(0);
    let x_hi = cw - dx.max(0);
    for y in y_lo..y_hi {
        for x in x_lo..x_hi {
            let ai = (y * cw + x) as usize;
            let bi = ((y + dy) * cw + (x + dx)) as usize;
            s += (a[ai] - b[bi]).abs() as f64;
        }
    }
    s
}

/// SAD with sub-pixel shift via bilinear interpolation. Used to compute
/// dE_after the phase-correlation-determined sub-pixel offset.
fn sad_subpix(a: &[f32], b: &[f32], cw: i32, ch: i32, dx: f64, dy: f64) -> f64 {
    let mut s = 0.0_f64;
    let yi_lo = (-dy.floor() as i32).max(0);
    let yi_hi = ch - (dy.ceil() as i32).max(0);
    let xi_lo = (-dx.floor() as i32).max(0);
    let xi_hi = cw - (dx.ceil() as i32).max(0);
    for y in yi_lo..yi_hi {
        for x in xi_lo..xi_hi {
            let ai = (y * cw + x) as usize;
            let bv = sample_bilinear(b, cw, ch, x as f64 + dx, y as f64 + dy);
            s += (a[ai] - bv).abs() as f64;
        }
    }
    s
}

/// Bilinear sample of `img` at fractional (fx, fy). Out-of-bound → 0.
fn sample_bilinear(img: &[f32], w: i32, h: i32, fx: f64, fy: f64) -> f32 {
    let x0 = fx.floor() as i32;
    let y0 = fy.floor() as i32;
    let x1 = x0 + 1;
    let y1 = y0 + 1;
    let tx = (fx - x0 as f64) as f32;
    let ty = (fy - y0 as f64) as f32;
    let get = |x: i32, y: i32| -> f32 {
        if x < 0 || y < 0 || x >= w || y >= h { 0.0 } else { img[(y * w + x) as usize] }
    };
    let a = get(x0, y0);
    let b = get(x1, y0);
    let c = get(x0, y1);
    let d = get(x1, y1);
    let ab = a + (b - a) * tx;
    let cd = c + (d - c) * tx;
    ab + (cd - ab) * ty
}

/// Two-stage shift refinement: integer ±SHIFT_RANGE first, then bilinear
/// sub-pixel sweep ±SUBPIX_RANGE at SUBPIX_STEP around the integer winner.
/// Returns (dx, dy, dE_min). Sign matches sad_subpix: positive shift means
/// `b` should be sampled at (x+dx, y+dy) to align with `a`.
fn sweep_shift_subpix(a: &[f32], b: &[f32], cw: i32, ch: i32) -> (f64, f64, f64) {
    let (idx, idy, _) = sweep_shift(a, b, cw, ch);
    let mut best = (
        idx as f64,
        idy as f64,
        sad_subpix(a, b, cw, ch, idx as f64, idy as f64),
    );
    let n = (SUBPIX_RANGE / SUBPIX_STEP).round() as i32;
    for dyi in -n..=n {
        for dxi in -n..=n {
            let dx = idx as f64 + dxi as f64 * SUBPIX_STEP;
            let dy = idy as f64 + dyi as f64 * SUBPIX_STEP;
            let s = sad_subpix(a, b, cw, ch, dx, dy);
            if s < best.2 {
                best = (dx, dy, s);
            }
        }
    }
    best
}


/// Integer sweep over (±SHIFT_RANGE)^2 returning best (dx, dy, dE).
fn sweep_shift(a: &[f32], b: &[f32], cw: i32, ch: i32) -> (i32, i32, f64) {
    let mut best = (0i32, 0i32, f64::INFINITY);
    for dy in -SHIFT_RANGE..=SHIFT_RANGE {
        for dx in -SHIFT_RANGE..=SHIFT_RANGE {
            let s = sad(a, b, cw, ch, dx, dy);
            if s < best.2 {
                best = (dx, dy, s);
            }
        }
    }
    best
}

fn save_rgb_crop(rgb: &[u8], src_w: i32, x0: i32, y0: i32, cw: i32, ch: i32, out: &Path) -> Result<()> {
    let mut buf = Vec::with_capacity((cw * ch * 3) as usize);
    for y in 0..ch {
        for x in 0..cw {
            let i = ((y0 + y) * src_w + (x0 + x)) as usize * 3;
            buf.push(rgb[i]);
            buf.push(rgb[i + 1]);
            buf.push(rgb[i + 2]);
        }
    }
    let img = image::RgbImage::from_raw(cw as u32, ch as u32, buf)
        .context("crop buffer size mismatch")?;
    img.save(out)?;
    Ok(())
}

// ============= RGG (HSB axis-diff visualization) =============

const RGG_BASE: u8 = 230;
const RGG_POS: [u8; 3] = [40, 200, 60]; // green: figma > impl
const RGG_NEG: [u8; 3] = [220, 50, 50]; // red:   figma < impl

fn rgb2hsv(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let r = r as f32;
    let g = g as f32;
    let b = b as f32;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let v = max;
    let d = max - min;
    let s = if max == 0.0 { 0.0 } else { d / max * 255.0 };
    let h = if d == 0.0 {
        0.0
    } else if max == r {
        ((g - b) / d).rem_euclid(6.0) * 30.0 // *60/2 to fit 0..179
    } else if max == g {
        ((b - r) / d + 2.0) * 30.0
    } else {
        ((r - g) / d + 4.0) * 30.0
    };
    (h, s, v)
}

fn paint_pixel(out: &mut [u8], delta: f32, scale: f32) {
    let intensity = (delta.abs() / scale).clamp(0.0, 1.0);
    let target = if delta >= 0.0 { RGG_POS } else { RGG_NEG };
    for c in 0..3 {
        let v = RGG_BASE as f32 + (target[c] as f32 - RGG_BASE as f32) * intensity;
        out[c] = v.round().clamp(0.0, 255.0) as u8;
    }
}

fn rgg_axis(figma: &[u8], chrom: &[u8], w: u32, h: u32, axis: u8, scale: f32) -> Vec<u8> {
    let n = (w * h) as usize;
    let mut out = vec![0u8; n * 3];
    for i in 0..n {
        let (fh, fs, fv) = rgb2hsv(figma[i * 3], figma[i * 3 + 1], figma[i * 3 + 2]);
        let (ch, cs, cv) = rgb2hsv(chrom[i * 3], chrom[i * 3 + 1], chrom[i * 3 + 2]);
        let delta = match axis {
            0 => {
                // Hue: circular [0, 180), shortest signed arc → [-90, 90].
                let mut d = fh - ch;
                if d > 90.0 {
                    d -= 180.0;
                } else if d < -90.0 {
                    d += 180.0;
                }
                d
            }
            1 => fs - cs,
            _ => fv - cv,
        };
        paint_pixel(&mut out[i * 3..i * 3 + 3], delta, scale);
    }
    out
}

fn write_rgg_whole(figma: &[u8], chrom: &[u8], w: u32, h: u32, out_dir: &Path) -> Result<()> {
    save_rgg(figma, chrom, w, h, 0, 90.0, &out_dir.join("rgg-h.png"))?;
    save_rgg(figma, chrom, w, h, 1, 255.0, &out_dir.join("rgg-s.png"))?;
    save_rgg(figma, chrom, w, h, 2, 255.0, &out_dir.join("rgg-v.png"))?;
    Ok(())
}

fn write_rgg_crop(
    figma: &[u8],
    chrom: &[u8],
    src_w: i32,
    x0: i32,
    y0: i32,
    cw: i32,
    ch: i32,
    out_dir: &Path,
) -> Result<()> {
    let mut fb = Vec::with_capacity((cw * ch * 3) as usize);
    let mut cb = Vec::with_capacity((cw * ch * 3) as usize);
    for y in 0..ch {
        for x in 0..cw {
            let i = ((y0 + y) * src_w + (x0 + x)) as usize * 3;
            fb.extend_from_slice(&figma[i..i + 3]);
            cb.extend_from_slice(&chrom[i..i + 3]);
        }
    }
    let w = cw as u32;
    let h = ch as u32;
    save_rgg(&fb, &cb, w, h, 0, 90.0, &out_dir.join("rgg-h.png"))?;
    save_rgg(&fb, &cb, w, h, 1, 255.0, &out_dir.join("rgg-s.png"))?;
    save_rgg(&fb, &cb, w, h, 2, 255.0, &out_dir.join("rgg-v.png"))?;
    Ok(())
}

fn save_rgg(figma: &[u8], chrom: &[u8], w: u32, h: u32, axis: u8, scale: f32, out: &Path) -> Result<()> {
    let buf = rgg_axis(figma, chrom, w, h, axis, scale);
    let img = image::RgbImage::from_raw(w, h, buf).context("rgg buffer size mismatch")?;
    img.save(out)?;
    Ok(())
}
