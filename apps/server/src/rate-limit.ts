export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
  readonly remaining: number;
}

interface WindowRecord {
  count: number;
  resetAtMs: number;
}

/**
 * A bounded fixed-window limiter. Scopes must be finite server-controlled strings; stale
 * buckets are removed during room cleanup so attacker-controlled IP keys cannot accumulate.
 */
export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, WindowRecord>();

  public consume(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number,
  ): RateLimitDecision {
    const bucketKey = `${scope}\u0000${key}`;
    let record = this.#windows.get(bucketKey);
    if (record === undefined || nowMs >= record.resetAtMs) {
      record = { count: 0, resetAtMs: nowMs + windowMs };
      this.#windows.set(bucketKey, record);
    }
    if (record.count >= limit) {
      return {
        allowed: false,
        retryAfterMs: Math.max(1, record.resetAtMs - nowMs),
        remaining: 0,
      };
    }
    record.count += 1;
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: Math.max(0, limit - record.count),
    };
  }

  public prune(nowMs: number): void {
    for (const [key, record] of this.#windows) {
      if (nowMs >= record.resetAtMs) {
        this.#windows.delete(key);
      }
    }
  }

  public clear(): void {
    this.#windows.clear();
  }
}
