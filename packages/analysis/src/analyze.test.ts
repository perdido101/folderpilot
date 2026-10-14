import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import JSZip from "jszip";
import { analyzeFile, sha256, type DecodedImage } from "./analyze";
import { hammingHex, isScreenshot } from "./image-metrics";

/** A decoder for tests: jpeg-js + nearest-neighbour resize (the app uses OffscreenCanvas or sharp). */
async function decodeJpeg(data: Blob): Promise<DecodedImage> {
  const img = jpeg.decode(new Uint8Array(await data.arrayBuffer()), { useTArray: true });
  return {
    width: img.width,
    height: img.height,
    async grayAt(w, h) {
      const out = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (Math.floor((y * img.height) / h) * img.width + Math.floor((x * img.width) / w)) * 4;
          out[y * w + x] = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
        }
      return out;
    },
  };
}

function makeJpeg(w: number, h: number, pixel: (x: number, y: number) => number): Blob {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = pixel(x, y);
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return new Blob([new Uint8Array(jpeg.encode({ data, width: w, height: h }, 90).data)], { type: "image/jpeg" });
}

async function makeDocx(text: string): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return new Blob([new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }))]);
}

describe("analyzeFile", () => {
  it("hashes, and measures a sharp image vs a flat dark one", async () => {
    const checker = makeJpeg(64, 48, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 230 : 20);
    const r = await analyzeFile({ data: checker, ext: "jpg", kind: "image" }, { decodeImage: decodeJpeg });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r).toMatchObject({ width: 64, height: 48 });
    expect(r.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.blurScore!).toBeGreaterThan(200);

    const dark = await analyzeFile({ data: makeJpeg(40, 40, (x) => 10 + (x % 3)), ext: "jpg", kind: "image" }, { decodeImage: decodeJpeg });
    expect(dark.brightness!).toBeLessThan(20);
    expect(r.warnings).toEqual([]);
  });

  it("gives near-identical dHashes for a re-encoded copy", async () => {
    // The same picture at two sizes (coordinates are relative to the image).
    const draw = (w: number, h: number) => (x: number, y: number) => Math.round(128 + 100 * Math.sin((x / w) * 9) * Math.cos((y / h) * 7));
    const a = await analyzeFile({ data: makeJpeg(120, 90, draw(120, 90)), ext: "jpg", kind: "image" }, { decodeImage: decodeJpeg });
    const b = await analyzeFile({ data: makeJpeg(60, 45, draw(60, 45)), ext: "jpg", kind: "image" }, { decodeImage: decodeJpeg });
    expect(a.sha256).not.toBe(b.sha256);
    expect(hammingHex(a.dhash!, b.dhash!)).toBeLessThanOrEqual(6);
  });

  it("extracts text from TXT and DOCX, and PDF through the injected reader", async () => {
    const txt = await analyzeFile({ data: new Blob(["Invoice   1001\n\nAlpha Ltd"]), ext: "txt", kind: "document" });
    expect(txt.textExcerpt).toBe("Invoice 1001 Alpha Ltd");

    const docx = await analyzeFile({ data: await makeDocx("Non-disclosure agreement with Alpha"), ext: "docx", kind: "document" });
    expect(docx.textExcerpt).toBe("Non-disclosure agreement with Alpha");

    const pdf = await analyzeFile({ data: new Blob(["%PDF-1.4"]), ext: "pdf", kind: "document" }, { pdfText: async () => "Bank   statement March" });
    expect(pdf.textExcerpt).toBe("Bank statement March");
  });

  it("never throws for broken content: it reports a warning and keeps the hash", async () => {
    const r = await analyzeFile({ data: new Blob(["not really a jpeg"]), ext: "jpg", kind: "image" }, { decodeImage: decodeJpeg });
    expect(r.sha256).toBeDefined();
    expect(r.width).toBeUndefined();
    expect(r.warnings.some((w) => w.startsWith("image"))).toBe(true);
    const docx = await analyzeFile({ data: new Blob(["broken zip"]), ext: "docx", kind: "document" });
    expect(docx.warnings.some((w) => w.startsWith("docx"))).toBe(true);
  });

  it("hashes huge files partially and marks the hash", async () => {
    const chunk = new Uint8Array(1024).fill(7);
    const big = new Blob(Array.from({ length: 300 * 1024 }, () => chunk)); // 300 MB without copying
    const h = await sha256(big);
    expect(h).toMatch(/^p:[0-9a-f]{64}$/);
  });
});

describe("isScreenshot", () => {
  it("uses names, screen ratios and the absence of camera EXIF", () => {
    expect(isScreenshot({ name: "Screenshot 2024-01-02.png", ext: "png" })).toBe(true);
    expect(isScreenshot({ name: "img.png", ext: "png", width: 1920, height: 1080 })).toBe(true);
    expect(isScreenshot({ name: "img.png", ext: "png", width: 1920, height: 1080, exif: { Make: "Canon" } })).toBe(false);
    expect(isScreenshot({ name: "photo.jpg", ext: "jpg", width: 4000, height: 3000 })).toBe(false);
  });
});
