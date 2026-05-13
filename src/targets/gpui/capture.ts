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
}

export async function prepareGpuiCaptureRuntime(runtimeDir: string): Promise<GpuiCaptureRuntime> {
  const gpuiPreviewDir = await ensurePatchedGpui()
  return {
    runtimeDir,
    libDir: await ensureLinkerLibs(),
    gpuiPreviewDir,
    cargoLockPath: resolve(gpuiPreviewDir, 'Cargo.lock'),
    fontDir: await prepareGpuiFontDir(runtimeDir),
  }
}

export async function captureGpuiGeneratedWithRuntime(opts: {
  runtime: GpuiCaptureRuntime
  caseDir: string
  generatedPath: string
  width: number
  height: number
  outputScale: number
  outPath: string
}): Promise<void> {
  await mkdir(resolve(opts.caseDir, 'src'), { recursive: true })
  await writeRuntimeProject({
    caseDir: opts.caseDir,
    generatedPath: opts.generatedPath,
    gpuiPath: resolve(opts.runtime.gpuiPreviewDir, 'vendor/gpui'),
    cargoLockPath: opts.runtime.cargoLockPath,
    width: opts.width,
    height: opts.height,
    outputScale: opts.outputScale,
    outPath: opts.outPath,
  })
  await execFileStrict('cargo', ['build'], {
    cwd: opts.caseDir,
    env: sharedCargoEnv(opts.runtime.runtimeDir, opts.runtime.libDir),
  })
  await execFileStrict(resolve(opts.runtime.runtimeDir, 'target/debug/pixpec-gpui-capture'), [], {
    cwd: opts.caseDir,
    env: sharedCargoEnv(opts.runtime.runtimeDir, opts.runtime.libDir, opts.runtime.fontDir),
  })
}

async function writeRuntimeProject(opts: {
  caseDir: string
  generatedPath: string
  gpuiPath: string
  cargoLockPath: string
  width: number
  height: number
  outputScale: number
  outPath: string
}): Promise<void> {
  await writeFile(
    resolve(opts.caseDir, 'Cargo.toml'),
    `[package]
name = "pixpec-gpui-capture"
version = "0.1.0"
edition = "2021"

[dependencies]
anyhow = "1.0"
gpui = { path = ${JSON.stringify(opts.gpuiPath)} }
image = { version = "0.25.9", default-features = false, features = ["png"] }
`,
  )
  await copyFile(opts.cargoLockPath, resolve(opts.caseDir, 'Cargo.lock'))
  const generatedHash = createHash('sha1')
    .update(await readFile(opts.generatedPath))
    .digest('hex')
  await writeFile(
    resolve(opts.caseDir, 'src/main.rs'),
    `// generated source hash: ${generatedHash}
use anyhow::Result;
use gpui::{
    px, point, size, App, Application, AssetSource, Bounds, SharedString, WindowBounds,
    WindowKind, WindowOptions,
};
use gpui::prelude::*;
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[path = ${JSON.stringify(opts.generatedPath)}]
mod generated;

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

fn main() {
    let generated_dir = PathBuf::from(${JSON.stringify(opts.generatedPath)})
        .parent()
        .expect("generated source path has parent directory")
        .to_path_buf();

    Application::new().with_assets(CaptureAssets { base: generated_dir }).run(|cx: &mut App| {
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
            size(
                px(${float(opts.width)} * ${float(opts.outputScale)}),
                px(${float(opts.height)} * ${float(opts.outputScale)}),
            ),
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
            cx.background_executor().timer(Duration::from_millis(750)).await;
            let result = handle.update(cx, |_view, window, _cx| {
                let Some((width, height, mut bgra)) = window.capture_frame() else {
                    anyhow::bail!("GPUI capture_frame returned None");
                };
                let target_width = (${float(opts.width)}_f32 * ${float(opts.outputScale)}_f32).round().max(1.0) as u32;
                let target_height = (${float(opts.height)}_f32 * ${float(opts.outputScale)}_f32).round().max(1.0) as u32;
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
                image.save(Path::new(${JSON.stringify(opts.outPath)}))?;
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

fn collect_font_files(dir: &Path, out: &mut Vec<Cow<'static, [u8]>>) {
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
  await symlink(target, path)
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
