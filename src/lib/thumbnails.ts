import type { FileRecord } from "./db";
import { canThumbnail } from "./file-kinds";
import { getFile } from "./file-access-cache";
import type { ThumbRequest, ThumbResponse } from "@/workers/thumbnail.worker";

const THUMB_SIZE = 320;
const MAX_IN_FLIGHT = 4;

const cache = new Map<string, Promise<string | null>>();
const waiting = new Map<string, (blob: Blob | null) => void>();
let worker: Worker | null = null;
let inFlight = 0;
const queue: (() => void)[] = [];

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/thumbnail.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<ThumbResponse>) => {
      const resolve = waiting.get(e.data.key);
      waiting.delete(e.data.key);
      resolve?.("blob" in e.data ? e.data.blob : null);
    };
  }
  return worker;
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => queue.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    queue.shift()?.();
  }
}

async function render(file: FileRecord): Promise<string | null> {
  const blob = await getFile(file);
  if (!blob) return null;
  if (file.ext === "svg") return URL.createObjectURL(blob);
  const key = `${file.id}:${file.mtime}`;
  const thumb = await new Promise<Blob | null>((resolve) => {
    waiting.set(key, resolve);
    getWorker().postMessage({ key, file: blob, size: THUMB_SIZE } satisfies ThumbRequest);
  });
  return thumb ? URL.createObjectURL(thumb) : null;
}

/** Returns an object URL for a small thumbnail, or null if the file can't be previewed. Cached per session. */
export function getThumbnail(file: FileRecord): Promise<string | null> {
  if (!canThumbnail(file.ext)) return Promise.resolve(null);
  const key = `${file.id}:${file.mtime}`;
  let p = cache.get(key);
  if (!p) {
    p = withSlot(() => render(file))
      .catch(() => null)
      .then((url) => {
        // Don't remember failures: access may be granted later (e.g. after "Allow access").
        if (!url) cache.delete(key);
        return url;
      });
    cache.set(key, p);
  }
  return p;
}
