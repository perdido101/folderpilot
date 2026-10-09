/**
 * Generates a deliberately messy test folder for FolderPilot.
 *
 *   npm run sample                 -> ./sample-messy
 *   npm run sample -- D:\Test\Mess -> custom location
 *   npm run sample -- --force      -> regenerate (only deletes folders this script created)
 *
 * Contents (~650 files, deterministic): photos (incl. burst near-duplicates, blurry, dark, tiny),
 * desktop + phone screenshots, PDFs, DOCX, CSV, notes, zips, exact duplicates ("(1)", "- Copy"),
 * Greek file names, deep "New folder" nesting, empty folders, and hidden/system files the indexer must skip.
 * All files are valid so later phases (EXIF, pdf.js, mammoth, hashing) can read them.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import jpeg from "jpeg-js";
import JSZip from "jszip";

const MARKER = ".folderpilot-sample";

// ---------- deterministic randomness ----------
let seed = 20251009;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function randomDate(fromYear = 2019, toYear = 2025): Date {
  const from = Date.UTC(fromYear, 0, 1);
  const to = Date.UTC(toYear, 11, 31);
  return new Date(from + rand() * (to - from));
}

// ---------- output helpers ----------
let root = "";
let fileCount = 0;
const written: string[] = [];

/** Writes a file; on a name collision appends " (2)", " (3)"… like Windows does. Returns the path used. */
function write(wanted: string, data: Buffer | string, date = randomDate()): string {
  let rel = wanted;
  const ext = path.posix.extname(wanted);
  for (let n = 2; fs.existsSync(path.join(root, rel)); n++) rel = `${wanted.slice(0, wanted.length - ext.length)} (${n})${ext}`;
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  fs.utimesSync(full, date, date);
  fileCount++;
  written.push(rel);
  return rel;
}

function copy(fromRel: string, toRel: string) {
  const data = fs.readFileSync(path.join(root, fromRel));
  const { mtime } = fs.statSync(path.join(root, fromRel));
  write(toRel, data, mtime);
}

// ---------- raster images ----------
type RGB = [number, number, number];

class Raster {
  readonly data: Uint8Array;
  private readonly px: Uint32Array; // RGBA view for fast fills (little-endian: 0xAABBGGRR)
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
    this.px = new Uint32Array(this.data.buffer);
  }
  set(x: number, y: number, r: number, g: number, b: number) {
    const o = (y * this.width + x) * 4;
    this.data[o] = r;
    this.data[o + 1] = g;
    this.data[o + 2] = b;
    this.data[o + 3] = 255;
  }
  rect(x0: number, y0: number, w: number, h: number, [r, g, b]: RGB) {
    const color = (0xff << 24) | (b << 16) | (g << 8) | r;
    const xStart = Math.max(0, x0);
    const xEnd = Math.min(this.width, x0 + w);
    for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y++) {
      this.px.fill(color, y * this.width + xStart, y * this.width + xEnd);
    }
  }
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

interface PhotoOpts {
  seed: number;
  width: number;
  height: number;
  shift?: number; // near-duplicate: small camera movement
  brightness?: number; // 1 = normal, 0.15 = dark
  blur?: boolean;
}

/** A procedural "landscape photo": sky gradient, sun, layered hills, some noise. */
function photo({ seed: s, width, height, shift = 0, brightness = 1, blur = false }: PhotoOpts): Raster {
  const saved = seed;
  seed = s;
  const sky: RGB = [int(90, 160), int(140, 200), int(200, 255)];
  const horizon: RGB = [int(230, 255), int(180, 230), int(140, 200)];
  const sun = { x: rand() * width, y: rand() * height * 0.4, r: int(20, 60) * (width / 1024) };
  const hills = Array.from({ length: 3 }, (_, i) => ({
    base: height * (0.55 + i * 0.12),
    amp: height * (0.04 + rand() * 0.06),
    freq: 1 + rand() * 4,
    phase: rand() * 6.28,
    color: [int(30, 90), int(90 + i * 20, 150 + i * 20), int(30, 80)] as RGB,
  }));
  seed = saved;

  // Blurry photos are rendered small and upscaled, which removes fine detail.
  const factor = blur ? 8 : 1;
  const w = Math.ceil(width / factor);
  const h = Math.ceil(height / factor);
  const small = new Raster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x * factor + shift;
      const py = y * factor + shift / 2;
      const t = py / height;
      let r = sky[0] + (horizon[0] - sky[0]) * t;
      let g = sky[1] + (horizon[1] - sky[1]) * t;
      let b = sky[2] + (horizon[2] - sky[2]) * t;
      if (Math.hypot(px - sun.x, py - sun.y) < sun.r) [r, g, b] = [255, 240, 200];
      for (const hill of hills) {
        if (py > hill.base + Math.sin((px / width) * hill.freq * 6.28 + hill.phase) * hill.amp) [r, g, b] = hill.color;
      }
      const noise = blur ? 0 : (rand() - 0.5) * 18;
      small.set(x, y, clamp((r + noise) * brightness), clamp((g + noise) * brightness), clamp((b + noise) * brightness));
    }
  }
  if (!blur) return small;

  const out = new Raster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(w - 1, x / factor);
      const sy = Math.min(h - 1, y / factor);
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const d = small.data;
      const o00 = (y0 * w + x0) * 4, o10 = (y0 * w + x1) * 4, o01 = (y1 * w + x0) * 4, o11 = (y1 * w + x1) * 4;
      const lerp = (ch: number) =>
        clamp((d[o00 + ch]! * (1 - fx) + d[o10 + ch]! * fx) * (1 - fy) + (d[o01 + ch]! * (1 - fx) + d[o11 + ch]! * fx) * fy);
      out.set(x, y, lerp(0), lerp(1), lerp(2));
    }
  }
  return out;
}

/** A fake app window / phone screen: title bar, sidebar, rows of "text". */
function screenshot(width: number, height: number, dark: boolean, phone: boolean): Raster {
  const img = new Raster(width, height);
  const bg: RGB = dark ? [30, 32, 36] : [248, 248, 246];
  const panel: RGB = dark ? [44, 47, 52] : [236, 235, 231];
  const text: RGB = dark ? [200, 203, 208] : [60, 64, 70];
  const accent: RGB = pick<RGB>([[15, 118, 110], [37, 99, 235], [220, 38, 38], [124, 58, 237]]);
  img.rect(0, 0, width, height, bg);
  const bar = phone ? Math.round(height * 0.04) : 36;
  img.rect(0, 0, width, bar, panel);
  if (phone) {
    img.rect(0, bar, width, Math.round(height * 0.07), accent);
  } else {
    img.rect(0, bar, Math.round(width * 0.18), height - bar, panel);
    for (let i = 0; i < 8; i++) img.rect(20, bar + 30 + i * 36, Math.round(width * 0.12), 12, text);
  }
  const left = phone ? 40 : Math.round(width * 0.22);
  const lineH = phone ? 70 : 28;
  for (let y = bar + (phone ? 220 : 60); y < height - 40; y += lineH) {
    const len = int(Math.round((width - left) * 0.3), Math.round((width - left) * 0.85));
    img.rect(left, y, len, phone ? 22 : 10, rand() < 0.08 ? accent : text);
  }
  return img;
}

function encodeJpeg(img: Raster, quality = 85): Buffer {
  return Buffer.from(jpeg.encode({ data: img.data, width: img.width, height: img.height }, quality).data);
}

// Minimal PNG encoder (RGBA, no filtering).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(img: Raster): Buffer {
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(img.data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- documents ----------
/** A small but valid PDF with one page of text (Helvetica, ASCII only). */
function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
  const stream = ["BT", "/F1 12 Tf", "14 TL", "72 760 Td", ...lines.map((l) => `(${esc(l)}) '`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(p)}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function makeZip(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** One second of quiet 8 kHz mono WAV. */
function makeWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) buf[44 + i] = 128 + Math.round(Math.sin(i / 8) * 20 * Math.exp(-i / rate));
  return buf;
}

// ---------- content vocab ----------
const CLIENTS = ["Alpha Ltd", "Beta SA", "Gamma & Co", "Delta Logistics", "Epsilon Bakery", "Zeta Legal"] as const;
const PEOPLE = ["Maria Papadopoulou", "John Smith", "Eleni Georgiou", "Nikos Ioannou", "Anna Becker", "George Brown"] as const;
const PLACES = ["Athens", "Thessaloniki", "Crete", "Berlin", "London", "Naxos"] as const;

function invoiceLines(client: string, no: number, date: Date): string[] {
  const items = Array.from({ length: int(2, 5) }, () => {
    const qty = int(1, 10);
    const price = int(20, 900);
    return { desc: pick(["Consulting hours", "Bookkeeping", "Tax filing", "Design work", "Hosting", "Legal review"]), qty, price };
  });
  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  return [
    `INVOICE #${no}`,
    `Date: ${date.toISOString().slice(0, 10)}`,
    `Bill to: ${client}`,
    "",
    ...items.map((i) => `${i.desc}  x${i.qty}  EUR ${i.price}.00`),
    "",
    `Subtotal: EUR ${total}.00`,
    `VAT 24%: EUR ${(total * 0.24).toFixed(2)}`,
    `Total: EUR ${(total * 1.24).toFixed(2)}`,
  ];
}

// ---------- generators ----------
async function makePhotos() {
  const sizes: [number, number][] = [[960, 720], [720, 960], [960, 640]];
  for (let i = 0; i < 95; i++) {
    const date = randomDate(2021, 2025);
    const [w, h] = pick(sizes);
    const name = pick([
      `IMG_${int(1000, 9999)}.jpg`,
      `IMG_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(int(8, 22))}${pad(int(0, 59))}${pad(int(0, 59))}.jpg`,
      `DSC0${int(1000, 9999)}.JPG`,
      `${pick(PLACES)} ${date.getUTCFullYear()} ${int(1, 99)}.jpg`,
      `PXL_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${int(100000, 999999)}.jpg`,
      `WhatsApp Image ${date.toISOString().slice(0, 10)} at ${pad(int(8, 22))}.${pad(int(0, 59))}.${pad(int(0, 59))}.jpeg`,
    ]);
    const folder = pick([
      `Photos/${date.getUTCFullYear()}`,
      `Photos/${date.getUTCFullYear()}/${pick(PLACES)} trip`,
      "Photos/Phone backup",
      "Desktop dump",
      "Downloads",
      "Office party",
    ]);
    write(`${folder}/${name}`, encodeJpeg(photo({ seed: 1000 + i, width: w, height: h }), int(70, 92)), date);
  }

  // Burst shots: near-duplicates (tiny camera shift + different JPEG quality).
  for (let burst = 0; burst < 6; burst++) {
    const date = randomDate(2023, 2025);
    const base = int(1000, 9000);
    for (let k = 0; k < 4; k++) {
      const img = photo({ seed: 5000 + burst, width: 960, height: 720, shift: k * 3 });
      write(`Photos/Burst/IMG_${base + k}.jpg`, encodeJpeg(img, 80 + k * 3), new Date(date.getTime() + k * 400));
    }
  }

  for (let i = 0; i < 15; i++) {
    write(`Photos/Phone backup/IMG_blurry_${int(1000, 9999)}.jpg`, encodeJpeg(photo({ seed: 7000 + i, width: 960, height: 720, blur: true })));
  }
  for (let i = 0; i < 10; i++) {
    write(`Photos/Phone backup/IMG_${int(1000, 9999)}.jpg`, encodeJpeg(photo({ seed: 8000 + i, width: 960, height: 720, brightness: 0.12 })));
  }
  for (let i = 0; i < 12; i++) {
    write(`${pick(["Downloads", "Desktop dump", "Misc"])}/thumb_${int(100, 999)}.jpg`, encodeJpeg(photo({ seed: 9000 + i, width: 160, height: 120 })));
  }
}

function makeScreenshots() {
  for (let i = 0; i < 70; i++) {
    const date = randomDate(2022, 2025);
    const phone = rand() < 0.35;
    const [w, h] = phone ? pick<[number, number]>([[1170, 2532], [1080, 2400]]) : pick<[number, number]>([[1920, 1080], [1366, 768], [2560, 1440], [1440, 900]]);
    const time = `${pad(int(8, 22))}.${pad(int(0, 59))}.${pad(int(0, 59))}`;
    const ymd = date.toISOString().slice(0, 10);
    const name = phone
      ? pick([`Screenshot_${ymd.replace(/-/g, "")}-${time.replace(/\./g, "")}.png`, `IMG_${int(1000, 9999)}.PNG`])
      : pick([
          `Screenshot ${ymd} ${time.replace(/\./g, "")}.png`,
          `Screenshot ${ymd} at ${time}.png`,
          `Screenshot (${int(1, 400)}).png`,
          `Capture${rand() < 0.5 ? "" : ` (${int(1, 30)})`}.PNG`,
          `image (${int(1, 60)}).png`,
          `Στιγμιότυπο οθόνης ${ymd} ${time.replace(/\./g, "")}.png`,
        ]);
    const folder = pick(["Desktop dump", "Desktop dump", "Pictures/Screenshots", "Downloads", "Misc/New folder"]);
    write(`${folder}/${name}`, encodePng(screenshot(w, h, rand() < 0.4, phone)), date);
  }
}

async function makeClientDocs() {
  let invoiceNo = 1000;
  for (const client of CLIENTS) {
    const base = `Clients/${client}`;
    for (let i = 0; i < int(6, 10); i++) {
      const date = randomDate(2022, 2025);
      const no = invoiceNo++;
      const name = pick([`Invoice ${no}.pdf`, `INV-${no}_${client.split(" ")[0]}.pdf`, `Τιμολόγιο ${no}.pdf`, `invoice_${date.toISOString().slice(0, 7)}.pdf`]);
      write(`${base}/${pick(["Invoices", "", "Invoices/old"])}/${name}`.replace("//", "/"), makePdf(invoiceLines(client, no, date)), date);
    }
    const ndaDate = randomDate(2023, 2025);
    write(
      `${base}/NDA ${client}${rand() < 0.5 ? " - signed" : ""}.pdf`,
      makePdf([
        "MUTUAL NON-DISCLOSURE AGREEMENT",
        `Between ${client} and Our Office`,
        `Effective date: ${ndaDate.toISOString().slice(0, 10)}`,
        "Both parties agree to keep confidential information private.",
        `Signed: ${pick(PEOPLE)}`,
      ]),
      ndaDate,
    );
    for (let i = 0; i < int(3, 6); i++) {
      const date = randomDate(2021, 2025);
      const title = pick(["Service Agreement", "Contract", "Proposal", "Meeting notes", "Engagement letter", "Σύμβαση"]);
      const name = pick([`${title} ${client}.docx`, `${title} v${int(1, 4)}.docx`, `${title} FINAL.docx`, `${title} FINAL (2).docx`, `${title}_draft.docx`]);
      write(
        `${base}/${name}`,
        await makeDocx([`${title} — ${client}`, `Prepared by ${pick(PEOPLE)} on ${date.toISOString().slice(0, 10)}.`, "Scope of work, fees and terms as discussed.", `Fee: EUR ${int(500, 20000)}`]),
        date,
      );
    }
  }
}

async function makeOfficeClutter() {
  for (let i = 0; i < 35; i++) {
    const date = randomDate();
    const kind = pick(["receipt", "statement", "scan", "ticket", "manual"]);
    const name =
      kind === "scan"
        ? `scan${pad(int(1, 999), 4)}.pdf`
        : kind === "receipt"
          ? `Receipt_${date.toISOString().slice(0, 10)}.pdf`
          : kind === "statement"
            ? `Bank statement ${date.toISOString().slice(0, 7)}.pdf`
            : kind === "ticket"
              ? `e-ticket ${pick(PLACES)}.pdf`
              : `${pick(["Printer", "Router", "Coffee machine", "Scanner"])} manual.pdf`;
    write(`${pick(["Downloads", "Scans", "Accounting", "Misc", "Old stuff - DO NOT DELETE"])}/${name}`, makePdf([kind.toUpperCase(), `Date: ${date.toISOString().slice(0, 10)}`, `Reference ${int(100000, 999999)}`]), date);
  }

  for (let i = 0; i < 25; i++) {
    const title = pick(["Letter", "CV", "Report", "Minutes", "Policy", "Offer", "Αίτηση", "Notes"]);
    write(
      `${pick(["Documents", "Documents/Drafts", "Downloads", "Old stuff - DO NOT DELETE", "Misc/New folder/New folder (2)"])}/${title} ${pick(PEOPLE).split(" ")[0]}${rand() < 0.3 ? " (1)" : ""}.docx`,
      await makeDocx([title, `Written by ${pick(PEOPLE)}.`, "Lorem ipsum dolor sit amet, consectetur adipiscing elit."]),
    );
  }

  for (let i = 0; i < 30; i++) {
    const date = randomDate(2021, 2025);
    const rows = ["date,description,amount,vat"];
    for (let r = 0; r < int(10, 60); r++) rows.push(`${randomDate(2021, 2025).toISOString().slice(0, 10)},${pick(["Office supplies", "Rent", "Fuel", "Software", "Client lunch"])},${int(5, 2500)}.${pad(int(0, 99))},24`);
    write(`${pick(["Accounting", "Accounting/Exports", "Downloads"])}/${pick(["expenses", "export", "ledger", "bank_export", "payroll"])}_${date.toISOString().slice(0, 7)}.csv`, rows.join("\n"), date);
  }

  const noteNames = ["todo.txt", "notes.txt", "passwords_NOT.txt", "meeting.md", "ideas.md", "readme.txt", "New Text Document.txt", "New Text Document (2).txt", "σημειώσεις.txt", "call log.txt"];
  for (let i = 0; i < 45; i++) {
    const lines = Array.from({ length: int(3, 20) }, () => `- ${pick(["Call", "Email", "Send invoice to", "Follow up with", "Meet"])} ${pick(PEOPLE)} re ${pick(CLIENTS)}`);
    write(`${pick(["Desktop dump", "Documents", "Misc", "Misc/New folder", "Clients", "Old stuff - DO NOT DELETE/2019"])}/${i < noteNames.length ? noteNames[i]! : `note ${i}.txt`}`, lines.join("\n"));
  }

  for (let i = 0; i < 15; i++) {
    write(`${pick(["Misc", "Downloads", "Misc/logs"])}/${pick(["config", "export", "app", "sync", "backup"])}_${i}.${pick(["json", "log", "xml"])}`, JSON.stringify({ id: i, generated: randomDate().toISOString(), items: Array.from({ length: int(1, 6) }, () => int(1, 1000)) }, null, 2));
  }

  for (let i = 0; i < 10; i++) {
    write(
      `${pick(["Downloads", "Old stuff - DO NOT DELETE", "Clients/Alpha Ltd"])}/${pick(["archive", "photos", "backup", "project files", "export"])}_${i}.zip`,
      await makeZip({ "readme.txt": "Archived files", "data.csv": "a,b\n1,2\n" }),
    );
  }

  for (let i = 0; i < 6; i++) write(`Misc/Voice memos/Recording ${int(1, 99)}.wav`, makeWav(1));
}

/** Exact duplicates with the names Windows/browsers typically produce. */
function makeDuplicates() {
  const candidates = written.filter((p) => !p.startsWith("."));
  const done = new Set<string>();
  let made = 0;
  while (made < 70) {
    const src = pick(candidates);
    if (done.has(src)) continue;
    done.add(src);
    const dir = path.posix.dirname(src);
    const ext = path.posix.extname(src);
    const base = path.posix.basename(src, ext);
    const target = pick([
      `${dir}/${base} (1)${ext}`,
      `${dir}/${base} - Copy${ext}`,
      `${dir}/${base} - Αντίγραφο${ext}`,
      `Downloads/${base}${ext}`,
      `Backup/${src}`,
      `Desktop dump/${base} (2)${ext}`,
    ]);
    if (fs.existsSync(path.join(root, target))) continue;
    copy(src, target);
    made++;
  }
}

/** Files the indexer must skip. */
function makeHiddenAndSystem() {
  write(".DS_Store", Buffer.alloc(64));
  write("desktop.ini", "[.ShellClassInfo]\nIconResource=C:\\Windows\\System32\\imageres.dll,-3\n");
  write("Photos/Thumbs.db", Buffer.alloc(128));
  write("Photos/2024/.DS_Store", Buffer.alloc(64));
  write("Clients/Alpha Ltd/~$ntract Alpha Ltd.docx", Buffer.alloc(162));
  write(".hidden-folder/secret.txt", "should not be indexed");
  write(".folderpilot-trash/old-invoice.pdf", makePdf(["Trashed file, must not be indexed"]));
  write("$RECYCLE.BIN/deleted.txt", "should not be indexed");
  fs.mkdirSync(path.join(root, "Empty folder"), { recursive: true });
  fs.mkdirSync(path.join(root, "Misc/New folder/New folder (2)/New folder (3)"), { recursive: true });
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  root = path.resolve(args.find((a) => !a.startsWith("--")) ?? "sample-messy");

  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    if (!force) {
      console.error(`"${root}" already exists and is not empty. Re-run with --force to regenerate it.`);
      process.exit(1);
    }
    if (!fs.existsSync(path.join(root, MARKER))) {
      console.error(`Refusing to delete "${root}": it wasn't created by this script (no ${MARKER} marker).`);
      process.exit(1);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.mkdirSync(root, { recursive: true });

  const started = Date.now();
  console.log(`Generating messy sample folder in ${root} …`);
  await makePhotos();
  makeScreenshots();
  await makeClientDocs();
  await makeOfficeClutter();
  makeDuplicates();
  makeHiddenAndSystem();
  fs.writeFileSync(path.join(root, MARKER), "Created by scripts/make-sample-folder.ts — safe to delete.\n");

  const hidden = 8;
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${fileCount} files (${fileCount - hidden} should be indexed, ${hidden} hidden/system to skip).`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
