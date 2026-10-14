// Local analysis, off the main thread, using the shared analyzer (@folderpilot/analysis) with a browser image decoder.
// PDF text is extracted on the main thread by pdf.js, which runs its own worker.
import { analyzeFile, type AnalysisResult, type DecodedImage } from "@folderpilot/analysis";

export interface AnalyzeRequest {
  id: number;
  file: File;
  ext: string;
  kind: string;
}

export type AnalyzeResult = Omit<AnalysisResult, "warnings"> & { id: number; error?: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: AnalyzeResult): void;
};

/** createImageBitmap + OffscreenCanvas; grayscale with the same weights as toGray(). */
async function decodeImage(data: Blob): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(data);
  return {
    width: bitmap.width,
    height: bitmap.height,
    async grayAt(w, h) {
      const canvas = new OffscreenCanvas(w, h);
      const g = canvas.getContext("2d", { willReadFrequently: true });
      if (!g) throw new Error("No 2D context");
      g.imageSmoothingQuality = "high";
      g.drawImage(bitmap, 0, 0, w, h);
      const rgba = g.getImageData(0, 0, w, h).data;
      const out = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) out[i] = 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
      return out;
    },
    close: () => bitmap.close(),
  };
}

ctx.onmessage = async (e: MessageEvent<AnalyzeRequest>) => {
  const { id, file, ext, kind } = e.data;
  try {
    const { warnings: _warnings, ...result } = await analyzeFile({ data: file, ext, kind }, { decodeImage });
    ctx.postMessage({ id, ...result });
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
