//! Headless Slint renderer for the pixpec PoC.
//!
//! Loads a .slint file via slint-interpreter, drives a software-renderer
//! window at design-w × design-h × scale physical pixels, and writes the
//! framebuffer as PNG. We render directly into an Rgb888 target (custom
//! TargetPixel impl) — the default Rgb565 path quantises each channel to
//! ~5–6 bits, which alone produces ΔE00 ≈ 5–15 over solid areas and was
//! the dominant noise source in the first PoC pass.

use std::env;
use std::path::PathBuf;
use std::rc::Rc;

use image::{Rgb, RgbImage};
use slint::ComponentHandle;
use slint::platform::software_renderer::{
    MinimalSoftwareWindow, PremultipliedRgbaColor, RepaintBufferType, TargetPixel,
};

#[derive(Clone, Copy, Default)]
#[repr(C)]
struct Rgb888 {
    r: u8,
    g: u8,
    b: u8,
}

impl TargetPixel for Rgb888 {
    fn blend(&mut self, color: PremultipliedRgbaColor) {
        // color is premultiplied. Slint's own Rgb565 impl uses:
        //   dst = src + (1 - src.alpha) * dst
        let inv = 255u16 - color.alpha as u16;
        self.r = (color.red as u16 + (self.r as u16 * inv + 127) / 255) as u8;
        self.g = (color.green as u16 + (self.g as u16 * inv + 127) / 255) as u8;
        self.b = (color.blue as u16 + (self.b as u16 * inv + 127) / 255) as u8;
    }
    fn from_rgb(r: u8, g: u8, b: u8) -> Self {
        Rgb888 { r, g, b }
    }
}

struct PocPlatform {
    window: Rc<MinimalSoftwareWindow>,
}

impl slint::platform::Platform for PocPlatform {
    fn create_window_adapter(
        &self,
    ) -> Result<Rc<dyn slint::platform::WindowAdapter>, slint::PlatformError> {
        Ok(self.window.clone())
    }
}

fn usage() -> ! {
    eprintln!("usage: slint-poc-render <input.slint> <output.png> <design-w> <design-h> <scale> [component]");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 6 {
        usage();
    }
    let input = PathBuf::from(&args[1]);
    let output = PathBuf::from(&args[2]);
    let design_w: u32 = args[3].parse().unwrap_or_else(|_| usage());
    let design_h: u32 = args[4].parse().unwrap_or_else(|_| usage());
    let scale: f32 = args[5].parse().unwrap_or_else(|_| usage());
    let component_name = args.get(6).cloned();
    let w = (design_w as f32 * scale).round() as u32;
    let h = (design_h as f32 * scale).round() as u32;

    let window = MinimalSoftwareWindow::new(RepaintBufferType::ReusedBuffer);
    slint::platform::set_platform(Box::new(PocPlatform { window: window.clone() }))
        .expect("set_platform");

    let mut compiler = slint_interpreter::Compiler::default();
    compiler.set_include_paths(vec![input
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf()]);
    let result = spin_on::spin_on(compiler.build_from_path(&input));
    for d in result.diagnostics() {
        eprintln!("[slint] {d}");
    }
    let definition = match component_name {
        Some(n) => result.component(&n),
        None => result.components().next(),
    }
    .expect("no component found in .slint");
    let instance = definition.create().expect("instance create");
    instance.show().expect("show");

    window.dispatch_event(slint::platform::WindowEvent::ScaleFactorChanged {
        scale_factor: scale,
    });
    window.set_size(slint::PhysicalSize::new(w, h));
    window.request_redraw();

    let white = Rgb888 { r: 255, g: 255, b: 255 };
    let mut buffer = vec![white; (w * h) as usize];
    window.draw_if_needed(|renderer| {
        renderer.render(&mut buffer, w as usize);
    });

    let mut img = RgbImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let p = buffer[(y * w + x) as usize];
            img.put_pixel(x, y, Rgb([p.r, p.g, p.b]));
        }
    }
    img.save(&output).expect("save png");
    eprintln!(
        "[slint-poc-render] wrote {} ({}x{})",
        output.display(),
        w,
        h
    );
}
