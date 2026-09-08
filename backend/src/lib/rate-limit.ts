// In-memory fixed-window rate limiter.
//
// Foundation limitation (documented in ARCHITECTURE.md): limits are per-process,
// so with N API instances behind a load balancer each instance applies its own
// window. When the deployment grows past a single instance, swap the store in
// this module for Redis-backed counters without changing call sites.
import type { RequestHandler } from "express";
import { HttpError } from "./http.js";

type Bucket = { hits: number[] };

const buckets = new Map<string, Bucket>();

// Memory protection (audit M-10): the map is bounded; when the cap is hit the
// oldest entries are evicted wholesale. An attacker rotating spoofed keys
// cannot grow the map without bound.
const MAX_BUCKETS = 10_000;

function evictIfFull(): void {
  if (buckets.size < MAX_BUCKETS) return;
  // Map preserves insertion order; drop the oldest half.
  const toDrop = Math.ceil(buckets.size / 2);
  let dropped = 0;
  for (const key of buckets.keys()) {
    if (dropped >= toDrop) break;
    buckets.delete(key);
    dropped += 1;
  }
}

export type RateLimitOptions = {
  /** Window size in milliseconds. */
  windowMs: number;
  /** Maximum requests per window per key. */
  max: number;
  /** Key builder; defaults to `${ip}:${path}`. */
  keyFn?: (req: { ip?: string; path: string }) => string;
};

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const { windowMs, max, keyFn } = opts;
  return (req, _res, next) => {
    const key = keyFn ? keyFn(req) : `${req.ip ?? "unknown"}:${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (bucket) {
      bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
    } else {
      if (buckets.size === 0 || !buckets.has(key)) evictIfFull();
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }
    if (bucket.hits.length >= max) {
      next(
        new HttpError(
          429,
          "Too many requests. Try again shortly.",
          "RATE_LIMITED",
        ),
      );
      return;
    }
    bucket.hits.push(now);
    next();
  };
}
