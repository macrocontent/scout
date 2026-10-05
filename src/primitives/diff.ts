import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export type DiffRegion = { x: number; y: number; width: number; height: number };

export type PixelDiffResult = {
  width: number;
  height: number;
  diff_pixels: number;
  total_pixels: number;
  diff_ratio: number;
  pass: boolean;
  tolerance: number;
  diff_png_base64: string | null;
};

function decodePng(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

/**
 * Compare two PNG buffers. Client supplies reference; Scout captures current.
 * Raw pixel metrics only — no visual "score" productization.
 */
export function comparePngScreenshots(options: {
  referencePng: Buffer;
  currentPng: Buffer;
  /** Max allowed differing pixel ratio (0–1). Default 0.01 (1%). */
  tolerance?: number;
  region?: DiffRegion;
  includeDiffImage?: boolean;
}): PixelDiffResult {
  const ref = decodePng(options.referencePng);
  const cur = decodePng(options.currentPng);
  const width = Math.min(ref.width, cur.width);
  const height = Math.min(ref.height, cur.height);
  const tolerance = options.tolerance ?? 0.01;

  const region = options.region ?? { x: 0, y: 0, width, height };
  const rx = Math.max(0, Math.min(region.x, width - 1));
  const ry = Math.max(0, Math.min(region.y, height - 1));
  const rw = Math.max(1, Math.min(region.width, width - rx));
  const rh = Math.max(1, Math.min(region.height, height - ry));

  const refCrop = new PNG({ width: rw, height: rh });
  const curCrop = new PNG({ width: rw, height: rh });
  PNG.bitblt(ref, refCrop, rx, ry, rw, rh, 0, 0);
  PNG.bitblt(cur, curCrop, rx, ry, rw, rh, 0, 0);

  const diff = new PNG({ width: rw, height: rh });
  const diffPixels = pixelmatch(refCrop.data, curCrop.data, diff.data, rw, rh, {
    threshold: 0.1,
    includeAA: true,
  });
  const total = rw * rh;
  const diffRatio = total > 0 ? diffPixels / total : 0;

  return {
    width: rw,
    height: rh,
    diff_pixels: diffPixels,
    total_pixels: total,
    diff_ratio: diffRatio,
    pass: diffRatio <= tolerance,
    tolerance,
    diff_png_base64: options.includeDiffImage !== false
      ? PNG.sync.write(diff).toString('base64')
      : null,
  };
}
