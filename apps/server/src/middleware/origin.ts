import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense for every state-changing request, whatever its content type: if the browser
 * sent an Origin header, it must be one of ours. Non-browser clients (API keys, MCP) send no
 * Origin and authenticate with keys instead of cookies.
 */
export function originGuard(allowed: string[]): MiddlewareHandler {
  const origins = new Set(allowed.map((u) => new URL(u).origin));
  return async (c, next) => {
    if (!SAFE.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin && !origins.has(origin)) throw new HTTPException(403, { message: "Cross-site request blocked." });
      // Old browsers without Origin: fall back to Referer when present.
      const referer = !origin ? c.req.header("referer") : undefined;
      if (referer && !origins.has(new URL(referer).origin)) throw new HTTPException(403, { message: "Cross-site request blocked." });
    }
    await next();
  };
}
