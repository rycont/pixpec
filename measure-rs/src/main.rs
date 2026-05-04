//! pixpec-measure — raw HSB-Euclidean dE between two PNG dirs.
//!
//! Compares figma/<name>.png ↔ chromium/<name>.png pair-wise (matching basenames).
//! No alignment, no warp — assumes equal-size PNGs (verified upstream). Emits
//! results.json {case, dE_hsb, dH, dS, dV, artifacts} in the input dir.
//!
//! HSB convention matches OpenCV: H∈[0,179], S∈[0,255], V∈[0,255]. Hue is
//! circular (180° wrap) and weighted by min(saturation) so grayscale text
//! contributes 0 to ΔH (only saturated-pixel hue mismatches count).
//!
//! Usage:
//!   pixpec-measure <component_dir>
//!     where component_dir contains figma/, chromium/

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
    #[serde(rename = "dE_hsb")]
    de_hsb: f64,
    #[serde(rename = "dH")]
    d_h: f64,
    #[serde(rename = "dS")]
    d_s: f64,
    #[serde(rename = "dV")]
    d_v: f64,
    /// Sum of CIE76 ΔE per pixel — perceptually uniform color difference.
    /// Per-pixel ΔE = sqrt(ΔL² + Δa² + Δb²). 인지 임계값 ≈ 2.3/pixel.
    #[serde(rename = "dE_lab")]
    de_lab: f64,
    /// Mean ΔE per pixel = de_lab / pixel_count. Sanity-check value.
    #[serde(rename = "dE_lab_mean")]
    de_lab_mean: f64,
    /// Pixel count (for averaging downstream).
    #[serde(rename = "n_px")]
    n_px: usize,
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
    if args.len() != 2 {
        eprintln!("usage: {} <component_dir>", args[0]);
        std::process::exit(2);
    }
    let base = PathBuf::from(&args[1]);
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
            let m = measure(&f, &c).with_context(|| format!("measure {name}"))?;
            Ok(Record {
                case: (*name).clone(),
                de_hsb: m.combined,
                d_h: m.dh,
                d_s: m.ds,
                d_v: m.dv,
                de_lab: m.de_lab,
                de_lab_mean: if m.n_px > 0 { m.de_lab / m.n_px as f64 } else { 0.0 },
                n_px: m.n_px,
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

    let mut hsb: Vec<f64> = records.iter().map(|r| r.de_hsb).collect();
    let mut lab: Vec<f64> = records.iter().map(|r| r.de_lab).collect();
    let mut lab_mean: Vec<f64> = records.iter().map(|r| r.de_lab_mean).collect();
    hsb.sort_by(|a, b| a.partial_cmp(b).unwrap());
    lab.sort_by(|a, b| a.partial_cmp(b).unwrap());
    lab_mean.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = |v: &[f64]| (v[v.len() / 2], v[v.len() - 1], v.iter().sum::<f64>() / v.len() as f64);
    let (h_med, h_max, h_mean) = m(&hsb);
    let (l_med, l_max, l_mean) = m(&lab);
    let (lm_med, lm_max, lm_mean) = m(&lab_mean);
    eprintln!(
        "measured {} in {:.2}s ({:.1}/s)",
        records.len(), elapsed, records.len() as f64 / elapsed,
    );
    eprintln!(
        "  HSB:        median={:.1} mean={:.1} max={:.1}",
        h_med, h_mean, h_max,
    );
    eprintln!(
        "  Lab ΔE76:   median={:.1} mean={:.1} max={:.1}  (sum per case)",
        l_med, l_mean, l_max,
    );
    eprintln!(
        "  Lab mean/px: median={:.3} mean={:.3} max={:.3}  (perceptual: <1 invisible, >2.3 noticeable)",
        lm_med, lm_mean, lm_max,
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

struct Result4 {
    dh: f64,
    ds: f64,
    dv: f64,
    combined: f64,
    de_lab: f64,
    n_px: usize,
}

fn measure(figma: &Path, chrom: &Path) -> Result<Result4> {
    let f = load_rgb(figma)?;
    let c = load_rgb(chrom)?;
    if f.w != c.w || f.h != c.h {
        bail!(
            "dim mismatch: figma {}x{} vs chrom {}x{}",
            f.w,
            f.h,
            c.w,
            c.h
        );
    }
    let f_hsv = rgb_to_hsv(&f.data);
    let c_hsv = rgb_to_hsv(&c.data);
    let f_lab = rgb_to_lab(&f.data);
    let c_lab = rgb_to_lab(&c.data);
    let mut dh = 0.0_f64;
    let mut ds = 0.0_f64;
    let mut dv = 0.0_f64;
    let mut comb = 0.0_f64;
    let mut de_lab_sum = 0.0_f64;
    let n = (f.w * f.h) as usize;
    for i in 0..n {
        // HSV — kept for backward compat with existing models.
        let bh = f_hsv[i * 3] as i32;
        let bs = f_hsv[i * 3 + 1] as i32;
        let bv = f_hsv[i * 3 + 2] as i32;
        let ih = c_hsv[i * 3] as i32;
        let is_ = c_hsv[i * 3 + 1] as i32;
        let iv = c_hsv[i * 3 + 2] as i32;
        let mut dhv = (bh - ih).abs();
        if dhv > 90 {
            dhv = 180 - dhv;
        }
        let dhn = dhv as f64 / 180.0;
        let dsn = (bs - is_).abs() as f64 / 255.0;
        let dvn = (bv - iv).abs() as f64 / 255.0;
        let sat_min = bs.min(is_) as f64 / 255.0;
        let dhw = dhn * sat_min;
        dh += dhw;
        ds += dsn;
        dv += dvn;
        comb += (dhw * dhw + dsn * dsn + dvn * dvn).sqrt();

        // Lab CIE76 ΔE — perceptually uniform.
        let dl = f_lab[i * 3] - c_lab[i * 3];
        let da = f_lab[i * 3 + 1] - c_lab[i * 3 + 1];
        let db = f_lab[i * 3 + 2] - c_lab[i * 3 + 2];
        de_lab_sum += ((dl * dl + da * da + db * db).sqrt()) as f64;
    }
    Ok(Result4 {
        dh,
        ds,
        dv,
        combined: comb,
        de_lab: de_lab_sum,
        n_px: n,
    })
}

/// sRGB(0..255) → CIE Lab (D65 white). Returns flat `[L, a, b, L, a, b, ...]`
/// as f32 (per-pixel triple, NOT byte). L ∈ [0, 100], a/b ∈ ~[-128, 127].
fn rgb_to_lab(rgb: &[u8]) -> Vec<f32> {
    let n = rgb.len() / 3;
    let mut out = vec![0.0_f32; n * 3];
    // D65 reference white
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
        // sRGB D65 → XYZ matrix (× 100 since linear ∈ [0,1] gives XYZ relative to white)
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
            let v = c as f32 * af + 255.0 * (1.0 - af);
            v.clamp(0.0, 255.0) as u8
        };
        rgb.push(blend(r));
        rgb.push(blend(g));
        rgb.push(blend(b));
    }
    Ok(Rgb { data: rgb, w, h })
}

/// RGB → HSV using OpenCV's 8-bit convention (H∈[0,179], S∈[0,255], V∈[0,255]).
fn rgb_to_hsv(rgb: &[u8]) -> Vec<u8> {
    let n = rgb.len() / 3;
    let mut out = vec![0u8; n * 3];
    for i in 0..n {
        let r = rgb[i * 3] as f32;
        let g = rgb[i * 3 + 1] as f32;
        let b = rgb[i * 3 + 2] as f32;
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let delta = max - min;
        let v = max;
        let s = if max > 0.0 { delta / max * 255.0 } else { 0.0 };
        let mut h = if delta == 0.0 {
            0.0
        } else if max == r {
            60.0 * rem_euclid_f32((g - b) / delta, 6.0)
        } else if max == g {
            60.0 * ((b - r) / delta + 2.0)
        } else {
            60.0 * ((r - g) / delta + 4.0)
        };
        if h < 0.0 {
            h += 360.0;
        }
        out[i * 3] = (h / 2.0).round() as u8;
        out[i * 3 + 1] = s.round().clamp(0.0, 255.0) as u8;
        out[i * 3 + 2] = v.round().clamp(0.0, 255.0) as u8;
    }
    out
}

fn rem_euclid_f32(a: f32, m: f32) -> f32 {
    let r = a % m;
    if r < 0.0 { r + m } else { r }
}
