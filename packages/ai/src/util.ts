export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

let counter = 0;
export const newCallId = () => `call_${Date.now().toString(36)}_${(counter++).toString(36)}`;

async function send(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new Error(`Can't reach ${new URL(url).origin}. Is it running, and does it allow this site (CORS)?`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res;
}

/** fetch + JSON with a readable error message (includes the server's error text). */
export async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  return (await (await send(url, body, headers, signal)).json()) as T;
}

/** POST and yield the response body line by line (NDJSON and SSE are both line-based). */
export async function* postLines(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): AsyncGenerator<string> {
  const res = await send(url, body, headers, signal);
  if (!res.body) throw new Error("The AI endpoint returned no stream.");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

/** Parse the `data:` payloads of a server-sent-events stream (ignores comments and `[DONE]`). */
export async function* sseData(lines: AsyncIterable<string>): AsyncGenerator<string> {
  for await (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data && data !== "[DONE]") yield data;
  }
}

export function parseArgs(args: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(args || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
