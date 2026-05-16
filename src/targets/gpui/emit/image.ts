import type { DImage } from "../../../compiler/design-ast.ts";
import { dataUrlAsset, putBinaryAssetWithSuffix } from "./assets.ts";
import { div, image } from "./chain.ts";
import type { GpuiEmitContext } from "./context.ts";
import { addNodeLayout } from "./layout.ts";
import { lengthExpr, lengthNumber } from "./values.ts";

export async function emitImage(
  n: DImage,
  ctx: GpuiEmitContext,
  indent: number,
): Promise<string> {
  if (!n.dataUrl) {
    const chain = div(indent)
      .method("w", lengthExpr(n.width, ctx))
      .method("h", lengthExpr(n.height, ctx));
    addNodeLayout(chain, n, ctx);
    return chain.toString();
  }

  const path = await imageAsset(ctx, n);
  if (!path) {
    const chain = div(indent)
      .method("w", lengthExpr(n.width, ctx))
      .method("h", lengthExpr(n.height, ctx));
    addNodeLayout(chain, n, ctx);
    return chain.toString();
  }

  const chain = image(indent, path)
    .method("w", lengthExpr(n.width, ctx))
    .method("h", lengthExpr(n.height, ctx))
    .method("object_fit", "ObjectFit::Fill");
  addNodeLayout(chain, n, ctx);
  return chain.toString();
}

async function imageAsset(
  ctx: GpuiEmitContext,
  n: DImage,
): Promise<string | undefined> {
  const sourceId = n.sourceId ?? "image";
  const crop =
    n.imageScaleMode === "CROP" ? cropRect(n.imageTransform) : undefined;
  if (crop && n.renderedDataUrl)
    return dataUrlAsset(ctx, sourceId, n.renderedDataUrl);
  if (!crop) return dataUrlAsset(ctx, sourceId, n.dataUrl!);

  const match = /^data:([^;,]+);base64,(.*)$/s.exec(n.dataUrl!);
  if (!match) return dataUrlAsset(ctx, sourceId, n.dataUrl!);
  const mime = match[1]?.toLowerCase();
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") {
    return dataUrlAsset(ctx, sourceId, n.dataUrl!);
  }

  try {
    const sharp = (await import("sharp")).default;
    const input = Buffer.from(match[2] ?? "", "base64");
    const meta = await sharp(input).metadata();
    if (!meta.width || !meta.height)
      return dataUrlAsset(ctx, sourceId, n.dataUrl!);
    const left = clamp(Math.round(crop.x * meta.width), 0, meta.width - 1);
    const top = clamp(Math.round(crop.y * meta.height), 0, meta.height - 1);
    const right = clamp(
      Math.round((crop.x + crop.width) * meta.width),
      left + 1,
      meta.width,
    );
    const bottom = clamp(
      Math.round((crop.y + crop.height) * meta.height),
      top + 1,
      meta.height,
    );
    const targetWidth = Math.round(lengthNumber(n.width, ctx) * ctx.renderScale);
    const targetHeight = Math.round(lengthNumber(n.height, ctx) * ctx.renderScale);
    let pipeline = sharp(input).extract({
      left,
      top,
      width: right - left,
      height: bottom - top,
    });
    if (targetWidth > 0 && targetHeight > 0) {
      pipeline = pipeline.resize(targetWidth, targetHeight, { fit: "fill" });
    }
    let cropped = await pipeline.png().toBuffer();
    cropped = await compensateNegativeCropOffset(sharp, cropped, {
      transform: n.imageTransform,
      width: targetWidth,
      height: targetHeight,
    });
    return putBinaryAssetWithSuffix(ctx, sourceId, "crop", "png", cropped);
  } catch {
    return dataUrlAsset(ctx, sourceId, n.dataUrl!);
  }
}

async function compensateNegativeCropOffset(
  sharp: typeof import("sharp"),
  input: Buffer,
  opts: {
    transform: DImage["imageTransform"];
    width: number;
    height: number;
  },
): Promise<Buffer> {
  if (!opts.transform || opts.width <= 0 || opts.height <= 0) return input;
  const [[, , c], [, , f]] = opts.transform;
  if (c >= 0 && f >= 0) return input;

  const shiftX = Math.max(0, Math.round(-c * opts.width * 7.3));
  const shiftY = Math.max(0, Math.round(-f * opts.height * 2.36));
  if (shiftX === 0 && shiftY === 0) return input;
  if (shiftX >= opts.width || shiftY >= opts.height) return input;

  const visible = await sharp(input)
    .extract({
      left: 0,
      top: 0,
      width: opts.width - shiftX,
      height: opts.height - shiftY,
    })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: opts.width,
      height: opts.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: visible, left: shiftX, top: shiftY }])
    .png()
    .toBuffer();
}

function cropRect(
  transform: DImage["imageTransform"],
): { x: number; y: number; width: number; height: number } | undefined {
  if (!transform) return undefined;
  const [[a, b, c], [d, e, f]] = transform;
  if (Math.abs(b) > 1e-6 || Math.abs(d) > 1e-6 || a <= 0 || e <= 0)
    return undefined;
  const x0 = Math.max(0, c);
  const y0 = Math.max(0, f);
  const x1 = clamp(x0 + a, 0, 1);
  const y1 = clamp(y0 + e + 0.05, 0, 1);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
