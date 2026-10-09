import { describe, expect, it } from "vitest";
import { extOf, kindOf, shouldSkip } from "./file-kinds";

describe("shouldSkip", () => {
  it.each([".DS_Store", ".folderpilot-trash", ".git", "desktop.ini", "Thumbs.db", "$RECYCLE.BIN", "System Volume Information", "~$ntract.docx"])(
    "skips %s",
    (name) => expect(shouldSkip(name)).toBe(true),
  );

  it.each(["Invoice 1001.pdf", "Photos", "IMG_1234.jpg", "Στιγμιότυπο οθόνης.png", "New folder (2)"])("keeps %s", (name) =>
    expect(shouldSkip(name)).toBe(false),
  );
});

describe("extOf / kindOf", () => {
  it("lowercases extensions and handles dotless names", () => {
    expect(extOf("Capture.PNG")).toBe("png");
    expect(extOf("Makefile")).toBe("");
    expect(extOf("archive.tar.gz")).toBe("gz");
  });

  it("maps extensions to kinds", () => {
    expect(kindOf("jpeg")).toBe("image");
    expect(kindOf("pdf")).toBe("document");
    expect(kindOf("csv")).toBe("spreadsheet");
    expect(kindOf("zip")).toBe("archive");
    expect(kindOf("xyz")).toBe("other");
  });
});
