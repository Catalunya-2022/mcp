import type { HttpBindings } from "@hono/node-server";
import type { Context, MiddlewareHandler } from "hono";

export type RateLimitOptions = {
  /** Window length in milliseconds. */
  windowMs?: number;
  /** Requests allowed per client per window. */
  limit?: number;
};

type Bucket = { count: number; resetAt: number };

/** Sweep expired buckets once the map grows past this many clients. */
const SWEEP_THRESHOLD = 10_000;

/**
 * Hard bound on tracked clients. A flood of distinct spoofed IPs fills the map
 * with live buckets the expiry sweep cannot reclaim; past this size the oldest
 * half is evicted (resetting those clients' budgets) so memory stays bounded.
 */
const MAX_CLIENTS = 20_000;

/**
 * Identify the client. Nginx fronts this server and appends the peer address
 * as the last X-Forwarded-For entry, so the rightmost token is the trustworthy
 * one (earlier tokens are client-controlled). Falls back to the connection
 * for direct access in development and tests.
 */
function clientKey(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",");
    const last = parts[parts.length - 1].trim();
    if (last) {
      return last;
    }
  }
  const bindings = c.env as Partial<HttpBindings> | undefined;
  return bindings?.incoming?.socket?.remoteAddress ?? "unknown";
}

/**
 * Minimal fixed-window per-client rate limiter with draft-7 RateLimit headers.
 * Runs before any body handling, so over-limit requests cost no parsing. The
 * headers are set after next() so they also reach Responses returned directly
 * by handlers (the MCP endpoint), which bypass headers set earlier.
 */
export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const { windowMs = 60_000, limit = 120 } = options;
  const buckets = new Map<string, Bucket>();
  let lastSweepAt = 0;

  return async (c, next) => {
    if (c.req.method === "OPTIONS") {
      await next();
      return;
    }

    const now = Date.now();

    // At most one expiry sweep per window: a full-map scan on every request
    // would make the sweep itself the hot path under a many-client flood.
    if (buckets.size > SWEEP_THRESHOLD && now - lastSweepAt >= windowMs) {
      lastSweepAt = now;
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(key);
        }
      }
    }
    if (buckets.size >= MAX_CLIENTS) {
      for (const key of buckets.keys()) {
        buckets.delete(key);
        if (buckets.size <= MAX_CLIENTS / 2) {
          break;
        }
      }
    }

    const key = clientKey(c);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, limit - bucket.count);
    const resetSeconds = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
    const setRateLimitHeaders = () => {
      c.header("RateLimit", `limit=${limit}, remaining=${remaining}, reset=${resetSeconds}`);
      c.header("RateLimit-Policy", `${limit};w=${Math.round(windowMs / 1000)}`);
    };

    if (bucket.count > limit) {
      setRateLimitHeaders();
      c.header("Retry-After", String(resetSeconds));
      return c.json({ error: "Too many requests" }, 429);
    }

    await next();
    setRateLimitHeaders();
  };
}
