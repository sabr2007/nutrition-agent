import 'server-only';
import { HttpError } from '@/lib/http';

// Simple sliding-window limiter per key, per server instance. Protects paid LLM endpoints
// from runaway clients/loops; Fluid Compute reuses instances, so this is effective enough
// for a single-user app (a shared store like Upstash would be the multi-user upgrade).
const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    throw new HttpError(429, 'Слишком много запросов подряд — подожди минуту', 'rate_limited');
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
}
