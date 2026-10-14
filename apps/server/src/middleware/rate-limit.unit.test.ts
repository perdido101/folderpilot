import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { rateLimit } from "./rate-limit";

describe("rateLimit (in-memory fallback)", () => {
  it("allows up to max requests per window, then answers 429 with Retry-After", async () => {
    const app = new Hono();
    app.use("*", rateLimit(null, { prefix: "t", windowSec: 60, max: 3 }));
    app.get("/", (c) => c.text("ok"));
    app.onError((err, c) => (err instanceof HTTPException ? c.text(err.message, err.status) : c.text("x", 500)));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await app.request("/", { headers: { "x-forwarded-for": "1.2.3.4" } })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const other = await app.request("/", { headers: { "x-forwarded-for": "5.6.7.8" } });
    expect(other.status).toBe(200);
    expect((await app.request("/", { headers: { "x-forwarded-for": "1.2.3.4" } })).headers.get("Retry-After")).toBe("60");
  });
});
