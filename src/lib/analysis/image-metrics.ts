/** Pure image math shared by the analysis worker and tests. Inputs are grayscale 0–255 arrays. */

export function toGray(rgba: ArrayLike<number>, pixels: number): Float32Array {
  const gray = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) gray[i] = 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
  return gray;
}

/**
 * dHash: compare each pixel with its right neighbour on a 9×8 grayscale image → 64 bits,
 * returned as 16 hex chars. Robust to resizing and recompression.
 */
export function dhash(gray9x8: ArrayLike<number>): string {
  let hex = "";
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let col = 0; col < 8; col++) {
      const left = gray9x8[row * 9 + col]!;
      const right = gray9x8[row * 9 + col + 1]!;
      byte = (byte << 1) | (left > right ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 16; i += 8) d += popcount32((Number.parseInt(a.slice(i, i + 8), 16) ^ Number.parseInt(b.slice(i, i + 8), 16)) >>> 0);
  return d;
}

/** Variance of the 4-neighbour Laplacian: low = few edges = blurry. */
export function laplacianVariance(gray: ArrayLike<number>, w: number, h: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = gray[i - w]! + gray[i + w]! + gray[i - 1]! + gray[i + 1]! - 4 * gray[i]!;
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Sharpness that doesn't punish dark or low-contrast photos: the Laplacian variance after
 * stretching the image to a standard contrast (std-dev 50). Flat images (std < 4) count as sharp
 * — there is nothing to be blurry about.
 */
export function sharpness(gray: ArrayLike<number>, w: number, h: number): number {
  const n = gray.length;
  if (!n) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += gray[i]!;
    sumSq += gray[i]! * gray[i]!;
  }
  const std = Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2));
  if (std < 4) return 1000;
  return laplacianVariance(gray, w, h) * (50 / std) ** 2;
}

export function meanBrightness(gray: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i]!;
  return gray.length ? sum / gray.length : 0;
}

const SCREENSHOT_NAME = /screenshot|screen shot|scrnli|^capture|snip|στιγμιότυπο|bildschirmfoto|captura|schermata/i;
const SCREEN_RATIOS = [16 / 9, 16 / 10, 4 / 3, 3 / 2, 19.5 / 9, 20 / 9, 21 / 9, 2.16, 2.17];

/** Filename patterns, or a lossless image with a common screen aspect ratio and no camera EXIF. */
export function isScreenshot(f: { name: string; ext: string; width?: number; height?: number; exif?: Record<string, string | number> }): boolean {
  if (SCREENSHOT_NAME.test(f.name)) return true;
  const hasCamera = Boolean(f.exif?.Make || f.exif?.Model);
  if (hasCamera || !f.width || !f.height) return false;
  if (!["png", "webp", "bmp"].includes(f.ext)) return false;
  const long = Math.max(f.width, f.height);
  const short = Math.min(f.width, f.height);
  if (long < 720) return false;
  const ratio = long / short;
  return SCREEN_RATIOS.some((r) => Math.abs(ratio - r) < 0.02);
}
