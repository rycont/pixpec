import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { CaptureRequest, CaptureResult } from '../types.ts'
import {
  assertSupportedCaptureKind,
  resolveTargetCaseCapturePlan,
  safeCaptureId,
} from '../../capture/resolve.ts'

export async function captureGpuiDestination(request: CaptureRequest): Promise<CaptureResult> {
  assertSupportedCaptureKind(request.kind)
  const plan = await resolveTargetCaseCapturePlan({ target: 'gpui', ids: request.ids })
  const runtime = await prepareGpuiCaptureRuntime(plan.runtimeDir)
  for (const group of plan.groups) {
    for (const item of group.items) {
      const usecase = group.component.variants
        .flatMap((v) => v.usecases ?? [])
        .find((u) => u.figmaId === item.id)
      if (!usecase) throw new Error(`capture dst:gpui cannot find usecase ${item.id}`)
      const variant = group.component.variants.find((v) =>
        (v.usecases ?? []).some((u) => u.figmaId === item.id),
      )
      const main = (variant?.usecases ?? []).find((u) => u.isMainCase) ?? variant?.usecases?.[0]
      if (!main) throw new Error(`capture dst:gpui cannot find generated main case for ${item.id}`)
      const generatedPath = resolve(group.componentDir, 'generated', `${safeCaptureId(main.figmaId)}.rs`)
      if (!existsSync(generatedPath)) {
        throw new Error(
          `capture dst:gpui missing generated source for ${main.figmaId}: ${generatedPath}`,
        )
      }
      const box = usecase.render?.box ?? variant?.render?.box
      const width = Math.max(1, Math.ceil(box?.width ?? group.component.viewport?.width ?? 800))
      const height = Math.max(1, Math.ceil(box?.height ?? group.component.viewport?.height ?? 600))
      const caseDir = resolve(plan.runtimeDir, safeCaptureId(item.id))
      await mkdir(resolve(caseDir, 'src'), { recursive: true })
      await captureGpuiGeneratedWithRuntime({
        runtime,
        caseDir,
        generatedPath,
        width,
        height,
        outputScale: plan.scale ?? 2,
        outPath: item.pngPath,
      })
    }
  }
  return { artifacts: plan.artifacts }
}

export interface GpuiCaptureRuntime {
  runtimeDir: string
  libDir: string
  gpuiPreviewDir: string
  cargoLockPath: string
  fontDir?: string
  xvfbDisplay?: string
  xvfbProcess?: import('node:child_process').ChildProcess
  close?: () => Promise<void>
}

export interface GpuiCapturePool {
  runtimeDir: string
  workers: GpuiCaptureRuntime[]
  capture: (opts: {
    generatedPath: string
    width: number
    height: number
    outputScale: number
    outPath: string
  }) => Promise<void>
  close: () => Promise<void>
}

/**
 * Build a worker pool of independent capture runtimes. Each worker owns its
 * own cargo project rooted at `<runtimeDir>/w<i>/`; cargo's per-project locks
 * stop concurrent builds in the same directory from racing, so true parallel
 * capture requires per-worker dirs. Deps still compile cold once per worker
 * (~30s), which is the price of admission — amortized across hundreds of
 * subsequent ~1s incremental builds it pays for itself by N=2.
 */
export async function prepareGpuiCapturePool(
  runtimeDir: string,
  workerCount: number,
): Promise<GpuiCapturePool> {
  if (workerCount < 1) workerCount = 1
  const workers = await Promise.all(
    Array.from({ length: workerCount }, (_, i) =>
      prepareGpuiCaptureRuntime(resolve(runtimeDir, `w${i}`)),
    ),
  )
  const free: GpuiCaptureRuntime[] = [...workers]
  const waiters: Array<(w: GpuiCaptureRuntime) => void> = []
  const acquire = (): Promise<GpuiCaptureRuntime> =>
    new Promise((resolveAcquire) => {
      const next = free.shift()
      if (next) resolveAcquire(next)
      else waiters.push(resolveAcquire)
    })
  const release = (w: GpuiCaptureRuntime): void => {
    const waiter = waiters.shift()
    if (waiter) waiter(w)
    else free.push(w)
  }
  return {
    runtimeDir,
    workers,
    capture: async (opts) => {
      const w = await acquire()
      try {
        await captureGpuiGeneratedWithRuntime({ runtime: w, ...opts })
      } finally {
        release(w)
      }
    },
    close: async () => {
      for (const w of workers) {
        if (w.close) await w.close()
      }
    },
  }
}

export async function prepareGpuiCaptureRuntime(runtimeDir: string): Promise<GpuiCaptureRuntime> {
  const gpuiPreviewDir = await ensurePatchedGpui()
  const runtime: GpuiCaptureRuntime = {
    runtimeDir,
    libDir: await ensureLinkerLibs(),
    gpuiPreviewDir,
    cargoLockPath: resolve(gpuiPreviewDir, 'Cargo.lock'),
    fontDir: await prepareGpuiFontDir(runtimeDir),
  }
  // Lay down a single cargo project at runtimeDir; main.rs is content-stable
  // across cases so cargo's incremental cache only rebuilds the `generated`
  // module + final link as `src/generated.rs` is swapped per case.
  await writeSharedRuntimeProject({
    runtimeDir,
    gpuiPath: resolve(runtime.gpuiPreviewDir, 'vendor/gpui'),
    cargoLockPath: runtime.cargoLockPath,
  })
  return runtime
}

async function startXvfb(): Promise<{ display: string; process: import('node:child_process').ChildProcess } | undefined> {
  if (process.env.PIXPEC_GPUI_DISABLE_XVFB) return undefined
  const { spawn } = await import('node:child_process')
  // Pick a high display number unlikely to collide.
  const display = `:${99 + Math.floor(Math.random() * 100)}`
  // -nolisten tcp avoids opening a TCP port; -screen 0 ... sets the virtual
  // display size large enough for any capture viewport we render into.
  const proc = spawn('Xvfb', [display, '-nolisten', 'tcp', '-screen', '0', '4096x4096x24'], {
    stdio: 'ignore',
    detached: false,
  })
  // Wait until Xvfb has created its socket file (then it is accepting clients).
  const socket = `/tmp/.X11-unix/X${display.slice(1)}`
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (existsSync(socket)) return { display, process: proc }
    await new Promise((r) => setTimeout(r, 25))
  }
  proc.kill('SIGTERM')
  throw new Error(`Xvfb failed to start on display ${display} within 5s`)
}

export async function captureGpuiGeneratedWithRuntime(opts: {
  runtime: GpuiCaptureRuntime
  /** Unused now (kept for caller compatibility) — the shared runtime owns the
   *  cargo project; per-case state is conveyed via env vars. */
  caseDir?: string
  generatedPath: string
  width: number
  height: number
  outputScale: number
  outPath: string
}): Promise<void> {
  // Swap in this case's generated source. Cargo treats this as a change to
  // the `generated` module only — main.rs and all deps stay cached.
  await copyFile(opts.generatedPath, resolve(opts.runtime.runtimeDir, 'src/generated.rs'))
  const env: Record<string, string> = {
    ...sharedCargoEnv(opts.runtime.runtimeDir, opts.runtime.libDir, opts.runtime.fontDir),
    PIXPEC_GPUI_WIDTH: String(opts.width),
    PIXPEC_GPUI_HEIGHT: String(opts.height),
    PIXPEC_GPUI_OUTPUT_SCALE: String(opts.outputScale),
    PIXPEC_GPUI_OUT_PATH: opts.outPath,
    PIXPEC_GPUI_ASSETS_DIR: resolve(opts.generatedPath, '..'),
  }
  // --jobs=1 caps rustc parallelism so the cargo build subprocess stays
   // within the 2 GB working-set target (parallel rustc instances each load
   // the full crate graph; 2-4 of them blow past 4 GB on this codebase).
  const tBuild = Date.now()
  await execFileStrict('cargo', ['build', '--offline', '--jobs', '1'], { cwd: opts.runtime.runtimeDir, env })
  const tRender = Date.now()
  await execFileStrict(
    resolve(opts.runtime.runtimeDir, 'target/debug/pixpec-gpui-capture'),
    [],
    { cwd: opts.runtime.runtimeDir, env },
  )
  const tDone = Date.now()
  if (process.env.PIXPEC_GPUI_TIMING === '1') {
    console.log(`    [gpui:capture] build=${tRender - tBuild}ms render=${tDone - tRender}ms`)
  }
}

async function writeFileIfChanged(path: string, content: string): Promise<void> {
  try {
    const current = await readFile(path, 'utf8')
    if (current === content) return
  } catch {}
  await writeFile(path, content)
}

async function writeSharedRuntimeProject(opts: {
  runtimeDir: string
  gpuiPath: string
  cargoLockPath: string
}): Promise<void> {
  await mkdir(resolve(opts.runtimeDir, 'src'), { recursive: true })
  await writeFileIfChanged(
    resolve(opts.runtimeDir, 'Cargo.toml'),
    `[package]
name = "pixpec-gpui-capture"
version = "0.1.0"
edition = "2021"

[dependencies]
anyhow = "1.0"
gpui = { path = ${JSON.stringify(opts.gpuiPath)} }
image = { version = "0.25.9", default-features = false, features = ["png"] }

# Linker is the long pole of every incremental rebuild. Stripping debug info
# from the dev profile cuts the linker step from ~700ms to ~250ms on this
# project — we never debug the capture binary, we just run it and read its
# framebuffer dump.
[profile.dev]
debug = 0
strip = "debuginfo"
`,
  )
  await copyFile(opts.cargoLockPath, resolve(opts.runtimeDir, 'Cargo.lock'))
  // Ensure src/generated.rs exists so a fresh `cargo check` after prepare can
  // succeed even before the first case is captured. Real content is filled in
  // per case via copyFile in captureGpuiGeneratedWithRuntime.
  const generatedRs = resolve(opts.runtimeDir, 'src/generated.rs')
  if (!existsSync(generatedRs)) {
    await writeFile(
      generatedRs,
      `use gpui::{div, Context, IntoElement, Render, Window};
use gpui::prelude::*;
pub struct Generated;
impl Render for Generated {
    fn render(&mut self, _w: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement { div() }
}
`,
    )
  }
  await writeFileIfChanged(
    resolve(opts.runtimeDir, 'src/main.rs'),
    `use anyhow::Result;
use gpui::{
    canvas, px, point, size, App, Application, AssetSource, Bounds, Hsla, IntoElement, Path,
    PathBuilder, Pixels, Point, SharedString, Styled, WindowBounds, WindowKind, WindowOptions,
};
use gpui::prelude::*;
use std::borrow::Cow;
use std::fs;
use std::path::{Path as StdPath, PathBuf};
use std::time::Duration;

mod generated;

// --- pixpec squircle support --------------------------------------------------
// Port of figma-squircle's getPathParamsForCorner + corner drawing to Rust so
// the runtime can paint Figma's continuous-curvature corners (cornerSmoothing > 0)
// using GPUI's PathBuilder. Codegen routes nodes with cornerSmoothing > 0 to
// pixpec_squircle_bg() which fills the parent with the squircle silhouette.

#[derive(Copy, Clone)]
struct PixpecSquircleParams {
    a: f32, b: f32, c: f32, d: f32, p: f32, arc_section_length: f32, corner_radius: f32,
}

fn pixpec_squircle_params(corner_radius: f32, smoothing: f32, budget: f32) -> PixpecSquircleParams {
    let mut smoothing = smoothing;
    let mut p = (1.0 + smoothing) * corner_radius;
    let max_smoothing = if corner_radius > 0.0 { (budget / corner_radius - 1.0).max(0.0) } else { 0.0 };
    if p > budget && corner_radius > 0.0 {
        // preserve = true path from figma-squircle: clamp parameters so the
        // smoothing stays representable when the side budget is tight.
        let arc_measure = 90.0_f32 * (1.0 - smoothing);
        let arc_section_length = (arc_measure / 2.0).to_radians().sin() * corner_radius * 2.0_f32.sqrt();
        let angle_alpha = (90.0_f32 - arc_measure) / 2.0;
        let p3_to_p4 = corner_radius * (angle_alpha / 2.0).to_radians().tan();
        let angle_beta = 45.0_f32 * smoothing;
        let c = p3_to_p4 * angle_beta.to_radians().cos();
        let d = c * angle_beta.to_radians().tan();
        let p1_to_p3_max = budget - d - arc_section_length - c;
        let min_a = p1_to_p3_max / 6.0;
        let max_b = p1_to_p3_max - min_a;
        let mut b = (p - arc_section_length - c - d) / 3.0;
        b = b.min(max_b);
        let a = p1_to_p3_max - b;
        p = p.min(budget);
        return PixpecSquircleParams { a, b, c, d, p, arc_section_length, corner_radius };
    }
    smoothing = smoothing.min(max_smoothing).max(0.0);
    let arc_measure = 90.0_f32 * (1.0 - smoothing);
    let arc_section_length = (arc_measure / 2.0).to_radians().sin() * corner_radius * 2.0_f32.sqrt();
    let angle_alpha = (90.0_f32 - arc_measure) / 2.0;
    let p3_to_p4 = corner_radius * (angle_alpha / 2.0).to_radians().tan();
    let angle_beta = 45.0_f32 * smoothing;
    let c = p3_to_p4 * angle_beta.to_radians().cos();
    let d = c * angle_beta.to_radians().tan();
    let b = (p - arc_section_length - c - d) / 3.0;
    let a = 2.0 * b;
    PixpecSquircleParams { a, b, c, d, p, arc_section_length, corner_radius }
}

fn pixpec_squircle_path(width: f32, height: f32, corner_radius: f32, smoothing: f32, origin: Point<Pixels>) -> Path<Pixels> {
    let budget = (width.min(height)) / 2.0;
    let r = corner_radius.min(budget).max(0.0);
    let params = pixpec_squircle_params(r, smoothing.max(0.0), budget);
    let p = params.p;
    let asl = params.arc_section_length;
    let a = params.a;
    let bb = params.b;
    let cc = params.c;
    let dd = params.d;
    let rr = params.corner_radius;
    let ox: f32 = origin.x.into();
    let oy: f32 = origin.y.into();
    let mk = |x: f32, y: f32| point(px(ox + x), px(oy + y));

    let mut path = PathBuilder::fill();
    // M (width - p) 0
    let mut x = width - p;
    let mut y = 0.0_f32;
    path.move_to(mk(x, y));
    // top-right: cubic, arc, cubic
    path.cubic_bezier_to(mk(x + a + bb + cc, y + dd), mk(x + a, y), mk(x + a + bb, y));
    x += a + bb + cc; y += dd;
    path.arc_to(point(px(rr), px(rr)), px(0.0), false, true, mk(x + asl, y + asl));
    x += asl; y += asl;
    path.cubic_bezier_to(mk(x + dd, y + a + bb + cc), mk(x + dd, y + a), mk(x + dd, y + a + bb));
    y += a + bb + cc;
    // L width (height - p)
    path.line_to(mk(width, height - p));
    x = width; y = height - p;
    // bottom-right: cubic, arc, cubic
    path.cubic_bezier_to(mk(x - dd, y + a + bb + cc), mk(x, y + a), mk(x, y + a + bb));
    x -= dd; y += a + bb + cc;
    path.arc_to(point(px(rr), px(rr)), px(0.0), false, true, mk(x - asl, y + asl));
    x -= asl; y += asl;
    path.cubic_bezier_to(mk(x - a - bb - cc, y + dd), mk(x - cc, y + dd), mk(x - bb - cc, y + dd));
    x -= a + bb + cc;
    // L p height
    path.line_to(mk(p, height));
    x = p; y = height;
    // bottom-left
    path.cubic_bezier_to(mk(x - a - bb - cc, y - dd), mk(x - a, y), mk(x - a - bb, y));
    x -= a + bb + cc; y -= dd;
    path.arc_to(point(px(rr), px(rr)), px(0.0), false, true, mk(x - asl, y - asl));
    x -= asl; y -= asl;
    path.cubic_bezier_to(mk(x - dd, y - a - bb - cc), mk(x - dd, y - a), mk(x - dd, y - a - bb));
    y -= a + bb + cc;
    // L 0 p
    path.line_to(mk(0.0, p));
    x = 0.0; y = p;
    // top-left
    path.cubic_bezier_to(mk(x + dd, y - a - bb - cc), mk(x, y - a), mk(x, y - a - bb));
    x += dd; y -= a + bb + cc;
    path.arc_to(point(px(rr), px(rr)), px(0.0), false, true, mk(x + asl, y - asl));
    x += asl; y -= asl;
    path.cubic_bezier_to(mk(x + a + bb + cc, y - dd), mk(x + cc, y - dd), mk(x + bb + cc, y - dd));
    path.close();
    path.build().expect("squircle path build")
}

pub fn pixpec_squircle_bg(corner_radius: f32, smoothing: f32, color: impl Into<Hsla>) -> impl IntoElement {
    let hsla = color.into();
    canvas(
        |_bounds, _window, _cx| {},
        move |bounds: Bounds<Pixels>, _state, window, _cx| {
            let path = pixpec_squircle_path(
                bounds.size.width.into(),
                bounds.size.height.into(),
                corner_radius,
                smoothing,
                bounds.origin,
            );
            window.paint_path(path, hsla);
        },
    )
    .absolute()
    .left(px(0.0))
    .top(px(0.0))
    .size_full()
}

struct CaptureAssets {
    base: PathBuf,
}

impl AssetSource for CaptureAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        fs::read(self.base.join(path))
            .map(|data| Some(Cow::Owned(data)))
            .map_err(Into::into)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        fs::read_dir(self.base.join(path))
            .map(|entries| {
                entries
                    .filter_map(|entry| {
                        entry
                            .ok()
                            .and_then(|entry| entry.file_name().into_string().ok())
                            .map(SharedString::from)
                    })
                    .collect()
            })
            .map_err(Into::into)
    }
}

fn env_f32(name: &str) -> f32 {
    std::env::var(name)
        .unwrap_or_else(|_| panic!("missing env var {}", name))
        .parse()
        .unwrap_or_else(|_| panic!("env var {} is not a valid f32", name))
}

fn env_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("missing env var {}", name)))
}

fn main() {
    let viewport_w: f32 = env_f32("PIXPEC_GPUI_WIDTH");
    let viewport_h: f32 = env_f32("PIXPEC_GPUI_HEIGHT");
    let output_scale: f32 = env_f32("PIXPEC_GPUI_OUTPUT_SCALE");
    let out_path: PathBuf = env_path("PIXPEC_GPUI_OUT_PATH");
    let assets_dir: PathBuf = env_path("PIXPEC_GPUI_ASSETS_DIR");

    Application::new().with_assets(CaptureAssets { base: assets_dir }).run(move |cx: &mut App| {
        if let Some(font_dir) = std::env::var_os("PIXPEC_GPUI_FONT_DIR").map(PathBuf::from) {
            let mut fonts = Vec::new();
            collect_font_files(&font_dir, &mut fonts);
            if !fonts.is_empty() {
                cx.text_system().add_fonts(fonts).ok();
            }
        }

        let hide_window = std::env::var_os("PIXPEC_GPUI_SHOW_WINDOW").is_none();
        let origin = if hide_window {
            point(px(-100000.0), px(-100000.0))
        } else {
            point(px(0.0), px(0.0))
        };
        let bounds = Bounds::new(
            origin,
            size(px(viewport_w * output_scale), px(viewport_h * output_scale)),
        );
        let handle = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                focus: false,
                show: true,
                kind: WindowKind::PopUp,
                is_resizable: false,
                app_id: Some("pixpec-gpui-capture".to_string()),
                ..Default::default()
            },
            |_, cx| cx.new(|_| generated::Generated),
        )
        .unwrap();

        cx.spawn(async move |cx| {
            cx.background_executor().timer(Duration::from_millis(50)).await;
            let result = handle.update(cx, |_view, window, _cx| {
                let Some((width, height, mut bgra)) = window.capture_frame() else {
                    anyhow::bail!("GPUI capture_frame returned None");
                };
                let target_width = (viewport_w * output_scale).round().max(1.0) as u32;
                let target_height = (viewport_h * output_scale).round().max(1.0) as u32;
                let frame_scale_x = width as f32 / target_width as f32;
                let frame_scale_y = height as f32 / target_height as f32;
                let can_resample = width >= target_width &&
                    height >= target_height &&
                    (frame_scale_x - frame_scale_y).abs() < 0.02;
                if (width != target_width || height != target_height) &&
                    !(width >= target_width && height >= target_height) &&
                    !can_resample {
                    anyhow::bail!(
                        "GPUI capture_frame returned {}x{}, expected {}x{}. The platform window was likely clamped; lower the capture scale or use tiled/offscreen rendering.",
                        width,
                        height,
                        target_width,
                        target_height,
                    );
                }
                for pixel in bgra.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                    let alpha = pixel[3] as u16;
                    if alpha > 0 && alpha < 255 {
                        pixel[0] = ((pixel[0] as u16 * 255 + alpha / 2) / alpha).min(255) as u8;
                        pixel[1] = ((pixel[1] as u16 * 255 + alpha / 2) / alpha).min(255) as u8;
                        pixel[2] = ((pixel[2] as u16 * 255 + alpha / 2) / alpha).min(255) as u8;
                    }
                }
                let image = image::RgbaImage::from_raw(width, height, bgra)
                    .ok_or_else(|| anyhow::anyhow!("invalid GPUI frame buffer dimensions"))?;
                let image = if width == target_width && height == target_height {
                    image
                } else {
                    image::imageops::resize(
                        &image,
                        target_width,
                        target_height,
                        image::imageops::FilterType::Lanczos3,
                    )
                };
                image.save(out_path.as_path())?;
                Ok::<_, anyhow::Error>(())
            });
            let result = result
                .map_err(anyhow::Error::from)
                .and_then(|inner| inner);
            if let Err(error) = result {
                eprintln!("{:#}", error);
                std::process::exit(1);
            }
            cx.update(|cx| cx.quit())?;
            Ok::<_, anyhow::Error>(())
        })
        .detach();
    });
}

fn collect_font_files(dir: &StdPath, out: &mut Vec<Cow<'static, [u8]>>) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_font_files(&path, out);
            continue;
        }
        let Some(ext) = path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase()) else {
            continue;
        };
        if matches!(ext.as_str(), "ttf" | "otf") {
            if let Ok(bytes) = fs::read(path) {
                out.push(Cow::Owned(bytes));
            }
        }
    }
}
`,
  )
}

async function ensurePatchedGpui(): Promise<string> {
  const fromEnv = process.env.PIXPEC_GPUI_PREVIEW_DIR
  if (fromEnv && existsSync(resolve(fromEnv, 'vendor/gpui'))) {
    await ensureHiddenWindowPatch(resolve(fromEnv, 'vendor/gpui'))
    return fromEnv
  }

  const dir = resolve(reusableWorkdir(), 'pixpec-gpui-preview')
  if (!existsSync(resolve(dir, 'vendor/gpui'))) {
    await rm(dir, { recursive: true, force: true })
    await execFileStrict('git', [
      'clone',
      '--depth',
      '1',
      'https://github.com/Wally869/gpui-preview',
      dir,
    ])
  }
  await ensureHiddenWindowPatch(resolve(dir, 'vendor/gpui'))
  return dir
}

async function ensureHiddenWindowPatch(gpuiDir: string): Promise<void> {
  const windowPath = resolve(gpuiDir, 'src/window.rs')
  const source = await readFile(windowPath, 'utf8')
  if (source.includes('if show {\n            platform_window.map_window().unwrap();\n        }')) return
  const next = source.replace(
    '        platform_window.map_window().unwrap();\n',
    '        if show {\n            platform_window.map_window().unwrap();\n        }\n',
  )
  if (next === source) {
    throw new Error(`GPUI hidden-window patch failed: ${windowPath}`)
  }
  await writeFile(windowPath, next)
}

async function ensureLinkerLibs(): Promise<string> {
  const dir = resolve(reusableWorkdir(), 'pixpec-gpui-libs')
  await mkdir(dir, { recursive: true })
  await forceSymlink('/lib/x86_64-linux-gnu/libxcb.so.1', resolve(dir, 'libxcb.so'))
  await forceSymlink('/lib/x86_64-linux-gnu/libxkbcommon.so.0', resolve(dir, 'libxkbcommon.so'))
  await forceSymlink(
    '/lib/x86_64-linux-gnu/libxkbcommon-x11.so.0',
    resolve(dir, 'libxkbcommon-x11.so'),
  )
  return dir
}

function reusableWorkdir(): string {
  const explicit = process.env.PIXPEC_WORKDIR || process.env.PIXPEC_CACHE_DIR
  if (explicit) return explicit
  const current = process.cwd()
  const pixpecWorkdir = '/home/rycont/dev/pixpec-workdir'
  if (current === pixpecWorkdir || current.startsWith(`${pixpecWorkdir}/`)) return pixpecWorkdir
  return resolve(current, '..')
}

async function prepareGpuiFontDir(runtimeDir: string): Promise<string | undefined> {
  const source = process.env.PIXPEC_GPUI_FONT_DIR
  if (!source) return undefined
  if (!existsSync(source)) return source

  const files = await collectFontPaths(source)
  if (files.length === 0) return source

  const dir = resolve(runtimeDir, 'gpui-fonts')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  for (const file of files) {
    const hash = createHash('sha1').update(file).digest('hex').slice(0, 10)
    const ext = file.split('.').pop() ?? 'ttf'
    const base = file
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, '')
      .replace(/[^A-Za-z0-9._-]/g, '_') ?? 'font'
    let instantiated = false

    if (ext.toLowerCase() === 'ttf' && (await hasSfntTable(file, 'fvar'))) {
      for (const weight of GPUI_STATIC_FONT_WEIGHTS) {
        const out = resolve(dir, `${base}-${hash}-wght-${weight}.ttf`)
        try {
          await execFileStrict(fonttoolsBin(), [
            'varLib.instancer',
            file,
            `wght=${weight}`,
            '--output',
            out,
          ])
          instantiated = true
        } catch {
          await rm(out, { force: true }).catch(() => undefined)
        }
      }
    }

    if (!instantiated) {
      await copyFile(file, resolve(dir, `${base}-${hash}.${ext}`))
    }
  }

  return dir
}

const GPUI_STATIC_FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]

function fonttoolsBin(): string {
  return process.env.PIXPEC_FONTTOOLS_BIN || 'fonttools'
}

async function collectFontPaths(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = resolve(dir, entry)
    const info = await stat(path).catch(() => undefined)
    if (!info) continue
    if (info.isDirectory()) files.push(...(await collectFontPaths(path)))
    else if (/\.(ttf|otf)$/i.test(entry)) files.push(path)
  }
  return files
}

async function hasSfntTable(path: string, tag: string): Promise<boolean> {
  const bytes = await readFile(path)
  if (bytes.length < 12) return false
  const tableCount = bytes.readUInt16BE(4)
  for (let i = 0; i < tableCount; i++) {
    const offset = 12 + i * 16
    if (offset + 4 > bytes.length) return false
    if (bytes.toString('ascii', offset, offset + 4) === tag) return true
  }
  return false
}

function sharedCargoEnv(
  runtimeDir: string,
  libDir: string,
  fontDir?: string,
): NodeJS.ProcessEnv {
  const hideWindow = process.env.PIXPEC_GPUI_SHOW_WINDOW !== '1'
  return {
    ...process.env,
    CARGO_TARGET_DIR: resolve(runtimeDir, 'target'),
    LIBRARY_PATH: libDir,
    ...(hideWindow ? { WAYLAND_DISPLAY: '' } : {}),
    ...(fontDir ? { PIXPEC_GPUI_FONT_DIR: fontDir } : {}),
  }
}

async function forceSymlink(target: string, path: string): Promise<void> {
  await unlink(path).catch(() => undefined)
  // Parallel workers can race on the same library path; tolerate EEXIST when
  // another worker won the create.
  await symlink(target, path).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  })
}

function execFileStrict(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${file} ${args.join(' ')} exited ${code}\n${stderr}`))
    })
  })
}

function float(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${+value.toFixed(6)}`
}
