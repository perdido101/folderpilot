import { describe, expect, it } from "vitest";
import type { FileRecord } from "../db";
import { DEFAULT_SETTINGS } from "../settings";
import { computeFlags, exactGroups, nearGroups, pickBest } from "./duplicates";
import { dhash, hammingHex, isScreenshot, laplacianVariance, meanBrightness, sharpness } from "./image-metrics";

let nextId = 1;
function file(p: Partial<FileRecord>): FileRecord {
  return { id: nextId++, rootId: 1, path: p.name ?? "f", name: "f", ext: "jpg", kind: "image", size: 100, mtime: 1000, status: "indexed", flags: [], tags: [], analyzedLocally: true, ...p };
}

describe("dHash", () => {
  const gradient = Array.from({ length: 72 }, (_, i) => (i % 9) * 20); // brighter to the right
  it("encodes 64 bits as 16 hex chars", () => {
    expect(dhash(gradient)).toBe("0000000000000000");
    expect(dhash(gradient.map((v) => 200 - v))).toBe("ffffffffffffffff");
  });
  it("is stable under small brightness changes", () => {
    const noisy = gradient.map((v, i) => v + (i % 3));
    expect(hammingHex(dhash(gradient), dhash(noisy))).toBe(0);
  });
  it("hamming distance counts differing bits", () => {
    expect(hammingHex("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingHex("00000000000000f0", "0000000000000000")).toBe(4);
    expect(hammingHex("8000000000000001", "0000000000000000")).toBe(2);
  });
});

describe("blur and brightness", () => {
  it("sharp edges have higher Laplacian variance than flat images", () => {
    const w = 20;
    const checker = Array.from({ length: w * w }, (_, i) => ((i % w) + Math.floor(i / w)) % 2 ? 255 : 0);
    const flat = Array.from({ length: w * w }, () => 128);
    expect(laplacianVariance(checker, w, w)).toBeGreaterThan(1000);
    expect(laplacianVariance(flat, w, w)).toBe(0);
  });
  it("mean brightness", () => expect(meanBrightness([0, 100, 200])).toBe(100));
  it("sharpness is contrast-normalized: a dark copy of a sharp image stays sharp", () => {
    const w = 20;
    const img = Array.from({ length: w * w }, (_, i) => ((i % w) + Math.floor(i / w)) % 2 ? 200 : 40);
    const dark = img.map((v) => v * 0.12);
    expect(sharpness(dark, w, w)).toBeCloseTo(sharpness(img, w, w), 5);
    expect(laplacianVariance(dark, w, w)).toBeLessThan(laplacianVariance(img, w, w) / 10);
    expect(sharpness(Array.from({ length: w * w }, () => 90), w, w)).toBe(1000);
  });
});

describe("screenshot heuristic", () => {
  it.each([
    [{ name: "Screenshot 2024-01-01 at 10.00.00.png", ext: "png" }, true],
    [{ name: "Στιγμιότυπο οθόνης 2024.png", ext: "png" }, true],
    [{ name: "IMG_1234.PNG", ext: "png", width: 1170, height: 2532 }, true],
    [{ name: "export.png", ext: "png", width: 1920, height: 1080 }, true],
    [{ name: "photo.jpg", ext: "jpg", width: 1920, height: 1080 }, false],
    [{ name: "photo.png", ext: "png", width: 1920, height: 1080, exif: { Make: "Canon" } }, false],
    [{ name: "logo.png", ext: "png", width: 512, height: 512 }, false],
  ])("%o → %s", (f, expected) => expect(isScreenshot(f)).toBe(expected));
});

describe("duplicate grouping", () => {
  it("groups exact copies by SHA-256 and keeps the oldest clean original", () => {
    const a = file({ name: "Report.pdf", path: "Docs/Report.pdf", sha256: "x", mtime: 500 });
    const b = file({ name: "Report (1).pdf", path: "Downloads/Report (1).pdf", sha256: "x", mtime: 500 });
    const c = file({ name: "Report - Copy.pdf", path: "Backup/Report - Copy.pdf", sha256: "x", mtime: 900 });
    const d = file({ name: "Other.pdf", sha256: "y" });
    const groups = exactGroups([a, b, c, d]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keep).toBe(a);
    expect(groups[0]!.others.map((f) => f.name).sort()).toEqual(["Report (1).pdf", "Report - Copy.pdf"]);
  });

  it("ignores empty and trashed files", () => {
    const groups = exactGroups([file({ sha256: "z", size: 0 }), file({ sha256: "z", size: 0 }), file({ sha256: "q", status: "trashed" }), file({ sha256: "q" })]);
    expect(groups).toEqual([]);
  });

  it("treats copies made within a minute as equally old, so the clean name wins", () => {
    const copy = file({ name: "Report (2).pdf", mtime: 60_000_000 });
    const orig = file({ name: "Report.pdf", mtime: 60_000_900 });
    expect(pickBest([copy, orig])).toBe(orig);
  });

  it("prefers the highest resolution, then the sharpest", () => {
    const small = file({ width: 800, height: 600, blurScore: 900 });
    const big = file({ width: 1600, height: 1200, blurScore: 100 });
    expect(pickBest([small, big])).toBe(big);
    const soft = file({ width: 800, height: 600, blurScore: 50 });
    const sharp = file({ width: 800, height: 600, blurScore: 500 });
    expect(pickBest([soft, sharp])).toBe(sharp);
  });

  it("groups near-duplicates within the Hamming threshold (transitively)", () => {
    const a = file({ dhash: "0000000000000000" });
    const b = file({ dhash: "000000000000000f" }); // 4 bits from a
    const c = file({ dhash: "00000000000000ff" }); // 4 bits from b, 8 from a
    const far = file({ dhash: "ffffffff00000000" });
    const groups = nearGroups([a, b, c, far], 6);
    expect(groups).toHaveLength(1);
    expect([groups[0]!.keep, ...groups[0]!.others]).toHaveLength(3);
    expect(nearGroups([a, b, c, far], 3)).toEqual([]);
  });

  it("ignores screenshots and images with a different aspect ratio", () => {
    const a = file({ dhash: "0000000000000000", width: 800, height: 600 });
    const portrait = file({ dhash: "0000000000000001", width: 600, height: 900 });
    const shot1 = file({ name: "Screenshot 1.png", ext: "png", dhash: "0000000000000000" });
    const shot2 = file({ name: "Screenshot 2.png", ext: "png", dhash: "0000000000000000" });
    expect(nearGroups([a, portrait, shot1, shot2], 6)).toEqual([]);
  });

  it("does not report exact copies again as near-duplicates", () => {
    const a = file({ dhash: "0000000000000000", sha256: "s" });
    const b = file({ dhash: "0000000000000000", sha256: "s" });
    expect(nearGroups([a, b], 6)).toEqual([]);
  });
});

describe("computeFlags", () => {
  const t = DEFAULT_SETTINGS.thresholds;
  it("flags copies, blurry, dark, tiny and screenshots but keeps suggested_delete", () => {
    const orig = file({ sha256: "d", width: 1000, height: 800, blurScore: 500, brightness: 120 });
    const copy = file({ name: "x (1).jpg", sha256: "d", width: 1000, height: 800, blurScore: 500, brightness: 120, flags: ["suggested_delete"] });
    const blurry = file({ width: 1000, height: 800, blurScore: 5, brightness: 120 });
    const dark = file({ width: 1000, height: 800, blurScore: 500, brightness: 10 });
    const tiny = file({ width: 160, height: 120, blurScore: 500, brightness: 120 });
    const shot = file({ name: "Screenshot (3).png", ext: "png", width: 1920, height: 1080, blurScore: 5, brightness: 240 });
    const flags = computeFlags([orig, copy, blurry, dark, tiny, shot], t);
    expect(flags.get(orig.id)).toEqual([]);
    expect(flags.get(copy.id)).toEqual(["suggested_delete", "duplicate"]);
    expect(flags.get(blurry.id)).toEqual(["blurry"]);
    expect(flags.get(dark.id)).toEqual(["dark"]);
    expect(flags.get(tiny.id)).toEqual(["tiny"]);
    expect(flags.get(shot.id)).toEqual(["screenshot"]);
  });
});
