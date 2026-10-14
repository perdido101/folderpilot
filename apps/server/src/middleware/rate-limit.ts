import type { MiddlewareHandler } from "hono";
import type { Redis } from "ioredis";
import { getConnInfo } from "@hono/node-server/conninfo";
import { HTTPException } from "hono/http-exception";

interface Options {
  /** Counter namespace, e.g. "auth" or "api". */
  prefix: string;
  windowSec: number;
  max: number;
}

/** Fixed-window limiter keyed by client IP. Redis when available, in-memory otherwise (single instance). */
export function rateLimit(redis: Redis | null, { prefix, windowSec, max }: Options): MiddlewareHandler {
  const memory = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    let ip = "unknown";
    try {
      ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || getConnInfo(c).remote.address || "unknown";
    } catch {
      /* not running on node-server (tests) */
    }
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const key = `rl:${prefix}:${ip}:${bucket}`;
    let count: number;
    if (redis?.status === "ready") {
      count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec + 1);
    } else {
      const now = Date.now();
      const entry = memory.get(key);
      count = entry && entry.resetAt > now ? ++entry.count : 1;
      if (count === 1) memory.set(key, { count, resetAt: now + windowSec * 1000 });
      if (memory.size > 10_000) for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
    }
    c.header("RateLimit-Limit", String(max));
    c.header("RateLimit-Remaining", String(Math.max(0, max - count)));
    if (count > max) {
      c.header("Retry-After", String(windowSec));
      throw new HTTPException(429, { message: "Too many requests, slow down a little." });
    }
    await next();
  };
}
