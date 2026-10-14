import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, parseKey } from "./crypto";

const key = randomBytes(32);

describe("AES-256-GCM secrets", () => {
  it("round-trips and uses a fresh IV every time", () => {
    const a = encrypt("ya29.refresh-token", key);
    const b = encrypt("ya29.refresh-token", key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe("ya29.refresh-token");
  });

  it("detects tampering and wrong keys", () => {
    const payload = encrypt("secret", key);
    const parts = payload.split(":");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 1;
    expect(() => decrypt([parts[0], parts[1], parts[2], ct.toString("base64")].join(":"), key)).toThrow();
    expect(() => decrypt(payload, randomBytes(32))).toThrow();
  });

  it("binds ciphertext to its context (AAD), e.g. the space id", () => {
    const payload = encrypt("token", key, "space:1");
    expect(decrypt(payload, key, "space:1")).toBe("token");
    expect(() => decrypt(payload, key, "space:2")).toThrow();
  });

  it("accepts hex or base64 keys of exactly 32 bytes", () => {
    expect(parseKey(key.toString("hex"))).toEqual(key);
    expect(parseKey(key.toString("base64"))).toEqual(key);
    expect(() => parseKey("short")).toThrow(/32 bytes/);
  });
});
