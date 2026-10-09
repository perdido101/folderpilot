import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Text of the first two pages (pdf.js parses in its own worker). */
export async function pdfText(file: Blob, maxChars = 4000): Promise<string> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  try {
    const parts: string[] = [];
    for (let p = 1; p <= Math.min(2, doc.numPages); p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return parts.join("\n").replace(/\s+/g, " ").trim().slice(0, maxChars);
  } finally {
    await doc.destroy();
  }
}
