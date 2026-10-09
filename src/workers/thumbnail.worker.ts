// Decodes and downsizes images off the main thread.

export interface ThumbRequest {
  key: string;
  file: File;
  size: number;
  type?: "image/webp" | "image/jpeg";
}

export type ThumbResponse = { key: string; blob: Blob } | { key: string; error: string };

// The app tsconfig uses the DOM lib; describe just the worker scope we need.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ThumbRequest>) => void) | null;
  postMessage(message: ThumbResponse): void;
};

ctx.onmessage = async (e: MessageEvent<ThumbRequest>) => {
  const { key, file, size, type = "image/webp" } = e.data;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext("2d");
    if (!g) throw new Error("No 2D context");
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    if (type === "image/jpeg") {
      // JPEG has no alpha: paint transparent areas white first.
      g.globalCompositeOperation = "destination-over";
      g.fillStyle = "#fff";
      g.fillRect(0, 0, w, h);
    }
    const blob = await canvas.convertToBlob({ type, quality: 0.8 });
    ctx.postMessage({ key, blob } satisfies ThumbResponse);
  } catch (err) {
    ctx.postMessage({ key, error: err instanceof Error ? err.message : String(err) } satisfies ThumbResponse);
  }
};
