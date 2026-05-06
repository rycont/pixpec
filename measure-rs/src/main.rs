//! pixpec-measure — pairwise CIEDE2000 (ΔE00) between two PNG dirs.
//!
//! Compares figma/<name>.png ↔ chromium/<name>.png (matching basenames).
//! No alignment, no warp — assumes equal-size PNGs (verified upstream). Emits
//! results.json {case, dE00, dE00_mean, n_px, artifacts} in the input dir.
//!
//! ΔE00 (Sharma 2005) is the canonical perceptual color-difference metric.
//! JNT (just-noticeable threshold) ≈ 1.0/pixel for trained observers.
//!
//! Usage:
//!   pixpec-measure <component_dir> [--downsample <N>]
//!     where component_dir contains figma/, chromium/
//!
//! Default: --downsample 8. Both PNGs are box-filtered 8→1 before measuring.
//! Pixpec renders at 8x supersample by default (scale=8 in pixpec.toml); the
//! 8→1 box average cancels per-rasterizer AA noise so dE00 reflects the
//! perceived 1x output, not Skia-vs-figma sub-pixel disagreements.
//!
//! Pass --downsample 1 to compare PNGs at their stored resolution (debugging,
//! or non-supersampled fixtures).

use anyhow::{Context, Result, bail};
use image::ImageReader;
use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;
use std::{env, fs};

#[derive(Serialize)]
struct Record {
    case: String,
    /// Sum of CIEDE2000 ΔE per pixel.
    #[serde(rename = "dE00")]
    de00: f64,
    /// Max per-pixel ΔE00 — the canonical regression check. Ensures no single
    /// pixel exceeds threshold. (Mean per-pixel is misleading: edge errors
    /// average out across uniform regions.)
    #[serde(rename = "dE00_max")]
    de00_max: f64,
    #[serde(rename = "n_px")]
    n_px: usize,
    /// Largest connected blob of pixels with ΔE00 > 1.9 (8-connectivity). Distinguishes
    /// structural diff (a 30+ px blob from a misplaced icon) from anti-alias noise
    /// (isolated pixels). Used by `breakdown` to pass small renderer differences
    /// while catching layout/style regressions.
    blob_max_size: usize,
    /// Bounding box of the largest blob in downsampled output pixels, [x0,y0,x1,y1).
    blob_max_bbox: Option<[usize; 4]>,
    artifacts: Artifacts,
}

#[derive(Serialize)]
struct Artifacts {
    figma: PathBuf,
    #[serde(rename = "impl")]
    impl_: PathBuf,
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    let mut base_arg: Option<String> = None;
    let mut downsample: u32 = 8;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--downsample" => {
                i += 1;
                downsample = args.get(i)
                    .and_then(|s| s.parse().ok())
                    .filter(|&n: &u32| n >= 1)
                    .ok_or_else(|| anyhow::anyhow!("--downsample requires positive integer"))?;
            }
            other => {
                if base_arg.is_some() { bail!("unexpected arg: {}", other); }
                base_arg = Some(other.to_string());
            }
        }
        i += 1;
    }
    let base = PathBuf::from(base_arg.ok_or_else(|| anyhow::anyhow!(
        "usage: pixpec-measure <component_dir> [--downsample <N>]"
    ))?);
    let figma_dir = base.join("figma");
    let chrom_dir = base.join("chromium");
    if !figma_dir.is_dir() {
        bail!("missing {}", figma_dir.display());
    }
    if !chrom_dir.is_dir() {
        bail!("missing {}", chrom_dir.display());
    }

    let figma_set = list_pngs(&figma_dir)?;
    let chrom_set = list_pngs(&chrom_dir)?;
    let mut common: Vec<&String> = figma_set.iter().filter(|n| chrom_set.contains(*n)).collect();
    common.sort();
    eprintln!(
        "figma={} chromium={} paired={}",
        figma_set.len(),
        chrom_set.len(),
        common.len(),
    );
    if common.is_empty() {
        bail!("no paired PNGs");
    }

    let t0 = Instant::now();
    let records: Vec<Record> = common
        .par_iter()
        .map(|name| -> Result<Record> {
            let f = figma_dir.join(format!("{name}.png"));
            let c = chrom_dir.join(format!("{name}.png"));
            let m = measure(&f, &c, downsample).with_context(|| format!("measure {name}"))?;
            Ok(Record {
                case: (*name).clone(),
                de00: m.de00,
                de00_max: m.de00_max,
                n_px: m.n_px,
                blob_max_size: m.blob_max_size,
                blob_max_bbox: m.blob_max_bbox,
                artifacts: Artifacts {
                    figma: f,
                    impl_: c,
                },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let elapsed = t0.elapsed().as_secs_f64();

    let out = base.join("results.json");
    fs::write(&out, serde_json::to_string_pretty(&records)?)?;

    let mut e00: Vec<f64> = records.iter().map(|r| r.de00).collect();
    let mut e00_max: Vec<f64> = records.iter().map(|r| r.de00_max).collect();
    e00.sort_by(|a, b| a.partial_cmp(b).unwrap());
    e00_max.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = |v: &[f64]| (v[v.len() / 2], v[v.len() - 1], v.iter().sum::<f64>() / v.len() as f64);
    let (e_med, e_max, e_mean) = m(&e00);
    let (mx_med, mx_max, mx_mean) = m(&e00_max);
    eprintln!(
        "measured {} in {:.2}s ({:.1}/s)",
        records.len(), elapsed, records.len() as f64 / elapsed,
    );
    eprintln!(
        "  ΔE00:        median={:.1} mean={:.1} max={:.1}  (sum per case)",
        e_med, e_mean, e_max,
    );
    eprintln!(
        "  ΔE00 max/px:  median={:.2} mean={:.2} max={:.2}  (worst pixel — regression check)",
        mx_med, mx_mean, mx_max,
    );
    eprintln!("→ {}", out.display());
    Ok(())
}

fn list_pngs(dir: &Path) -> Result<std::collections::HashSet<String>> {
    let mut out = std::collections::HashSet::new();
    for e in fs::read_dir(dir)? {
        let e = e?;
        let n = e.file_name().to_string_lossy().to_string();
        if let Some(s) = n.strip_suffix(".png") {
            out.insert(s.to_string());
        }
    }
    Ok(out)
}

struct Measurement {
    de00: f64,
    de00_max: f64,
    n_px: usize,
    blob_max_size: usize,
    blob_max_bbox: Option<[usize; 4]>,
}

fn measure(figma: &Path, chrom: &Path, downsample: u32) -> Result<Measurement> {
    // Composite alpha against white FIRST, then box-filter. Compose-then-avg
    // is the perceptually-meaningful pipeline: each input pixel's contribution
    // to its output cell equals what a viewer would see at that location.
    let fa = load_rgba(figma)?;
    let ca = load_rgba(chrom)?;
    if fa.w != ca.w || fa.h != ca.h {
        bail!("dim mismatch: figma {}x{} vs chrom {}x{}", fa.w, fa.h, ca.w, ca.h);
    }
    if downsample > 1 && (fa.w % downsample != 0 || fa.h % downsample != 0) {
        bail!(
            "downsample {} does not divide image {}x{}",
            downsample, fa.w, fa.h
        );
    }
    let f = composite_and_downsample(&fa, downsample);
    let c = composite_and_downsample(&ca, downsample);
    let f_lab = rgb_to_lab(&f.data);
    let c_lab = rgb_to_lab(&c.data);
    let w = f.w as usize;
    let h = f.h as usize;
    let n = w * h;
    let mut de00_sum = 0.0_f64;
    let mut de00_max = 0.0_f64;
    // Per-pixel ΔE00 array (kept for blob analysis below — small at 1x scale).
    let mut de = vec![0.0_f32; n];
    for i in 0..n {
        let l1 = f_lab[i * 3] as f64;
        let a1 = f_lab[i * 3 + 1] as f64;
        let b1 = f_lab[i * 3 + 2] as f64;
        let l2 = c_lab[i * 3] as f64;
        let a2 = c_lab[i * 3 + 1] as f64;
        let b2 = c_lab[i * 3 + 2] as f64;
        let d = ciede2000(l1, a1, b1, l2, a2, b2);
        de00_sum += d;
        if d > de00_max { de00_max = d; }
        de[i] = d as f32;
    }
    // Largest connected blob of pixels with ΔE00 > BLOB_THRESHOLD. 8-connectivity
    // (diagonal neighbors count). Used by the breakdown harness to distinguish
    // structural mismatches (clustered residual) from anti-alias noise (isolated
    // pixels). A high `de00_max` from one stray pixel is rendering noise; the
    // same `de00_max` clustered into a 9+ pixel blob is a real layout/style bug.
    // Blob threshold hardcoded at 1.9: any pixel ΔE00 > 1.9 contributes to
    // blob membership. Above the JNT (1.0); avoids text/svg edge AA noise
    // contributing to blobs. See breakdown-verify default --max-blob 16.
    let blob_threshold: f32 = 1.9;
    let mut visited = vec![false; n];
    let mut max_blob = 0usize;
    let mut max_blob_bbox: Option<[usize; 4]> = None;
    let mut stack = Vec::with_capacity(n);
    for start in 0..n {
        if visited[start] || de[start] <= blob_threshold { continue; }
        stack.clear();
        stack.push(start);
        visited[start] = true;
        let mut count = 0usize;
        let mut x0 = usize::MAX;
        let mut y0 = usize::MAX;
        let mut x1 = 0usize;
        let mut y1 = 0usize;
        while let Some(idx) = stack.pop() {
            count += 1;
            let x = (idx % w) as i32;
            let y = (idx / w) as i32;
            let ux = x as usize;
            let uy = y as usize;
            x0 = x0.min(ux);
            y0 = y0.min(uy);
            x1 = x1.max(ux + 1);
            y1 = y1.max(uy + 1);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    if dx == 0 && dy == 0 { continue; }
                    let nx = x + dx; let ny = y + dy;
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 { continue; }
                    let ni = ny as usize * w + nx as usize;
                    if visited[ni] || de[ni] <= blob_threshold { continue; }
                    visited[ni] = true;
                    stack.push(ni);
                }
            }
        }
        if count > max_blob {
            max_blob = count;
            max_blob_bbox = Some([x0, y0, x1, y1]);
        }
    }
    Ok(Measurement { de00: de00_sum, de00_max, n_px: n, blob_max_size: max_blob, blob_max_bbox: max_blob_bbox })
}

/// CIEDE2000 (ΔE00) — Sharma 2005 implementation. Inputs in CIE Lab (D65).
/// kL = kC = kH = 1 (default).
fn ciede2000(l1: f64, a1: f64, b1: f64, l2: f64, a2: f64, b2: f64) -> f64 {
    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let c_bar = 0.5 * (c1 + c2);
    let c_bar7 = c_bar.powi(7);
    let g = 0.5 * (1.0 - (c_bar7 / (c_bar7 + 25f64.powi(7))).sqrt());
    let a1p = (1.0 + g) * a1;
    let a2p = (1.0 + g) * a2;
    let c1p = (a1p * a1p + b1 * b1).sqrt();
    let c2p = (a2p * a2p + b2 * b2).sqrt();
    let h1p = atan2_deg(b1, a1p);
    let h2p = atan2_deg(b2, a2p);
    let dlp = l2 - l1;
    let dcp = c2p - c1p;
    let dhp_raw = if c1p * c2p == 0.0 { 0.0 } else {
        let d = h2p - h1p;
        if d > 180.0 { d - 360.0 } else if d < -180.0 { d + 360.0 } else { d }
    };
    let dhp = 2.0 * (c1p * c2p).sqrt() * (dhp_raw.to_radians() / 2.0).sin();
    let l_bar_p = 0.5 * (l1 + l2);
    let c_bar_p = 0.5 * (c1p + c2p);
    let h_bar_p = if c1p * c2p == 0.0 { h1p + h2p } else {
        let d = (h1p - h2p).abs();
        if d <= 180.0 { 0.5 * (h1p + h2p) }
        else if h1p + h2p < 360.0 { 0.5 * (h1p + h2p + 360.0) }
        else { 0.5 * (h1p + h2p - 360.0) }
    };
    let t = 1.0
        - 0.17 * (h_bar_p - 30.0).to_radians().cos()
        + 0.24 * (2.0 * h_bar_p).to_radians().cos()
        + 0.32 * (3.0 * h_bar_p + 6.0).to_radians().cos()
        - 0.20 * (4.0 * h_bar_p - 63.0).to_radians().cos();
    let dtheta = 30.0 * (-((h_bar_p - 275.0) / 25.0).powi(2)).exp();
    let c_bar_p7 = c_bar_p.powi(7);
    let rc = 2.0 * (c_bar_p7 / (c_bar_p7 + 25f64.powi(7))).sqrt();
    let sl = 1.0 + (0.015 * (l_bar_p - 50.0).powi(2)) / (20.0 + (l_bar_p - 50.0).powi(2)).sqrt();
    let sc = 1.0 + 0.045 * c_bar_p;
    let sh = 1.0 + 0.015 * c_bar_p * t;
    let rt = -(2.0 * dtheta).to_radians().sin() * rc;
    let term_l = dlp / sl;
    let term_c = dcp / sc;
    let term_h = dhp / sh;
    (term_l * term_l + term_c * term_c + term_h * term_h + rt * term_c * term_h).max(0.0).sqrt()
}

fn atan2_deg(y: f64, x: f64) -> f64 {
    let r = y.atan2(x).to_degrees();
    if r < 0.0 { r + 360.0 } else { r }
}

/// sRGB(0..255) → CIE Lab (D65 white).
fn rgb_to_lab(rgb: &[u8]) -> Vec<f32> {
    let n = rgb.len() / 3;
    let mut out = vec![0.0_f32; n * 3];
    const XN: f32 = 95.047;
    const YN: f32 = 100.000;
    const ZN: f32 = 108.883;

    fn srgb_to_linear(c: u8) -> f32 {
        let v = c as f32 / 255.0;
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    }
    fn f_lab(t: f32) -> f32 {
        const D: f32 = 6.0 / 29.0;
        if t > D * D * D { t.powf(1.0 / 3.0) } else { t / (3.0 * D * D) + 4.0 / 29.0 }
    }

    for i in 0..n {
        let r = srgb_to_linear(rgb[i * 3]);
        let g = srgb_to_linear(rgb[i * 3 + 1]);
        let b = srgb_to_linear(rgb[i * 3 + 2]);
        let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) * 100.0;
        let y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) * 100.0;
        let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) * 100.0;
        let fx = f_lab(x / XN);
        let fy = f_lab(y / YN);
        let fz = f_lab(z / ZN);
        out[i * 3] = 116.0 * fy - 16.0;
        out[i * 3 + 1] = 500.0 * (fx - fy);
        out[i * 3 + 2] = 200.0 * (fy - fz);
    }
    out
}

struct Rgb {
    data: Vec<u8>,
    w: u32,
    h: u32,
}

struct Rgba {
    data: Vec<u8>,
    w: u32,
    h: u32,
}

fn load_rgba(path: &Path) -> Result<Rgba> {
    let img = ImageReader::open(path)
        .with_context(|| format!("open {}", path.display()))?
        .decode()
        .with_context(|| format!("decode {}", path.display()))?;
    let (w, h) = (img.width(), img.height());
    let rgba = img.to_rgba8();
    Ok(Rgba { data: rgba.into_raw(), w, h })
}

/// Composite-and-box-filter in one pass. Each input pixel is composited
/// against white in f32, then averaged within an f×f cell, with a single
/// round-to-u8 at the end. Avoids the double-rounding that compose-then-
/// box-then-round causes (~0.2 dE00 on tight comparisons). With f=1 this
/// degenerates to plain composite_white.
fn composite_and_downsample(src: &Rgba, f: u32) -> Rgb {
    if f > 1 {
        assert!(src.w % f == 0 && src.h % f == 0);
    }
    let nw = src.w / f.max(1);
    let nh = src.h / f.max(1);
    let f2 = (f.max(1) * f.max(1)) as f32;
    let mut out = vec![0u8; (nw * nh * 3) as usize];
    for oy in 0..nh {
        for ox in 0..nw {
            let mut s = [0f32; 3];
            for dy in 0..f.max(1) {
                for dx in 0..f.max(1) {
                    let sx = ox * f.max(1) + dx;
                    let sy = oy * f.max(1) + dy;
                    let i = ((sy * src.w + sx) * 4) as usize;
                    let af = src.data[i + 3] as f32 / 255.0;
                    let one_m = 1.0 - af;
                    s[0] += src.data[i] as f32 * af + 255.0 * one_m;
                    s[1] += src.data[i + 1] as f32 * af + 255.0 * one_m;
                    s[2] += src.data[i + 2] as f32 * af + 255.0 * one_m;
                }
            }
            let oi = ((oy * nw + ox) * 3) as usize;
            for c in 0..3 {
                out[oi + c] = (s[c] / f2).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Rgb { data: out, w: nw, h: nh }
}
