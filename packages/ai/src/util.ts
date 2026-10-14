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

/** fetch + JSON with a readable error message (includes the server's error text). */
export async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  } catch {
    throw new Error(`Can't reach ${new URL(url).origin}. Is it running, and does it allow this site (CORS)?`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}
