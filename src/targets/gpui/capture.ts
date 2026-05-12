import { existsSync } from 'node:fs'
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
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
  const libDir = await ensureLinkerLibs()
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
      await writeRuntimeProject({
        caseDir,
        generatedPath,
        width,
        height,
      })
      await execFileStrict('cargo', ['build'], {
        cwd: caseDir,
        env: { ...process.env, LIBRARY_PATH: libDir },
      })
      await captureOneWindow({
        cwd: caseDir,
        libDir,
        width,
        height,
        outPath: item.pngPath,
      })
    }
  }
  return { artifacts: plan.artifacts }
}

async function writeRuntimeProject(opts: {
  caseDir: string
  generatedPath: string
  width: number
  height: number
}): Promise<void> {
  await writeFile(
    resolve(opts.caseDir, 'Cargo.toml'),
    `[package]
name = "pixpec-gpui-capture"
version = "0.1.0"
edition = "2021"

[dependencies]
gpui = "0.2.2"
`,
  )
  await writeFile(
    resolve(opts.caseDir, 'src/main.rs'),
    `use gpui::{
    div, px, size, App, Application, Bounds, Context, IntoElement, Render, Window,
    WindowBackgroundAppearance, WindowBounds, WindowOptions,
};
use gpui::prelude::*;

#[path = ${JSON.stringify(opts.generatedPath)}]
mod generated;

struct CaptureRoot;

impl Render for CaptureRoot {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(${float(opts.width)}))
            .h(px(${float(opts.height)}))
            .overflow_hidden()
            .child(generated::Generated)
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(${float(opts.width)}), px(${float(opts.height)})), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_background: WindowBackgroundAppearance::Transparent,
                focus: true,
                show: true,
                is_resizable: false,
                app_id: Some("pixpec-gpui-capture".to_string()),
                ..Default::default()
            },
            |_, cx| cx.new(|_| CaptureRoot),
        )
        .unwrap();
        cx.activate(true);
    });
}
`,
  )
}

async function captureOneWindow(opts: {
  cwd: string
  libDir: string
  width: number
  height: number
  outPath: string
}): Promise<void> {
  const before = await listXWindows()
  const child = spawn(['./target/debug/pixpec-gpui-capture'][0]!, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      LIBRARY_PATH: opts.libDir,
      WAYLAND_DISPLAY: undefined,
      XDG_SESSION_TYPE: 'x11',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  try {
    await sleep(1_500)
    const after = await listXWindows()
    const beforeIds = new Set(before.map((w) => w.id))
    const win = after.find(
      (w) => !beforeIds.has(w.id) && w.width === opts.width && w.height === opts.height,
    ) ?? after.find((w) => w.width === opts.width && w.height === opts.height)
    if (!win) {
      throw new Error(
        `capture dst:gpui cannot find X11 window ${opts.width}x${opts.height}. stderr: ${stderr}`,
      )
    }
    const xwdPath = resolve(opts.cwd, 'capture.xwd')
    await execFileStrict('xwd', ['-silent', '-id', win.id, '-out', xwdPath], { cwd: opts.cwd })
    await xwdToPng(xwdPath, opts.outPath)
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
}

interface XWindow {
  id: string
  width: number
  height: number
}

async function listXWindows(): Promise<XWindow[]> {
  const out = await execFileStrict('xwininfo', ['-root', '-tree'])
  const windows: XWindow[] = []
  const re = /^\s*(0x[0-9a-f]+)\s+.*?(\d+)x(\d+)[+-]/i
  for (const line of out.split('\n')) {
    const m = re.exec(line)
    if (!m) continue
    const width = Number(m[2])
    const height = Number(m[3])
    if (width <= 1 || height <= 1) continue
    windows.push({ id: m[1]!, width, height })
  }
  return windows
}

async function xwdToPng(xwdPath: string, pngPath: string): Promise<void> {
  const sharp = (await import('sharp')).default
  const buf = await readFile(xwdPath)
  const u32 = (offset: number) => buf.readUInt32BE(offset)
  const headerSize = u32(0)
  const width = u32(16)
  const height = u32(20)
  const bitsPerPixel = u32(44)
  const bytesPerLine = u32(48)
  const ncolors = u32(76)
  if (bitsPerPixel !== 32) {
    throw new Error(`capture dst:gpui unsupported XWD bits_per_pixel=${bitsPerPixel}`)
  }
  const pixelOffset = headerSize + ncolors * 12
  const raw = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = buf.readUInt32LE(pixelOffset + y * bytesPerLine + x * 4)
      const out = (y * width + x) * 4
      raw[out] = (pixel >> 16) & 0xff
      raw[out + 1] = (pixel >> 8) & 0xff
      raw[out + 2] = pixel & 0xff
      raw[out + 3] = 0xff
    }
  }
  await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(pngPath)
}

async function ensureLinkerLibs(): Promise<string> {
  const dir = '/tmp/pixpec-gpui-libs'
  await mkdir(dir, { recursive: true })
  await forceSymlink('/lib/x86_64-linux-gnu/libxcb.so.1', resolve(dir, 'libxcb.so'))
  await forceSymlink('/lib/x86_64-linux-gnu/libxkbcommon.so.0', resolve(dir, 'libxkbcommon.so'))
  await forceSymlink(
    '/lib/x86_64-linux-gnu/libxkbcommon-x11.so.0',
    resolve(dir, 'libxkbcommon-x11.so'),
  )
  return dir
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function float(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${+value.toFixed(6)}`
}
