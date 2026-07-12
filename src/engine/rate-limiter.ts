/**
 * @owner       src::engine::rate-limiter
 * @does        Applies a validated, serialized per-domain token bucket across pipeline executions in one process.
 * @needs       Wall-clock milliseconds with non-negative elapsed clamping and bounded timers.
 * @feeds       registered rate_limit pipeline step
 * @breaks      Empty domains and non-integer RPM outside 1..60000 throw before any timer is scheduled.
 * @invariants  One domain keeps the strictest RPM observed for the process lifetime; queued callers consume distinct tokens in arrival order.
 * @side-effects Retains process-local buckets and may await a timer.
 * @perf        O(1) lookup/refill per acquisition.
 * @concurrency A per-domain promise tail serializes refill, wait, and consumption across concurrent callers.
 * @test        tests/unit/rate-limiter.test.ts, tests/unit/pipeline-loops.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
  rpm: number;
  tail: Promise<void>;
}

const buckets = new Map<string, Bucket>();

export async function waitForToken(domain: string, rpm: number): Promise<void> {
  if (domain.trim().length === 0) {
    throw new RangeError("rate_limit domain must be a non-empty string");
  }
  if (!Number.isInteger(rpm) || rpm < 1 || rpm > 60_000) {
    throw new RangeError("rate_limit rpm must be an integer from 1 to 60000");
  }

  const bucketKey = domain.trim().toLowerCase();
  let bucket = buckets.get(bucketKey);

  if (!bucket) {
    bucket = {
      tokens: rpm,
      lastRefill: Date.now(),
      rpm,
      tail: Promise.resolve(),
    };
    buckets.set(bucketKey, bucket);
  }

  const acquisition = bucket.tail.then(() => acquireToken(bucket, rpm));
  bucket.tail = acquisition;
  await acquisition;
}

async function acquireToken(bucket: Bucket, rpm: number): Promise<void> {
  const now = Date.now();
  const strictestRpm = Math.min(bucket.rpm, rpm);
  if (bucket.rpm !== strictestRpm) {
    bucket.tokens = Math.min(bucket.tokens, strictestRpm);
    bucket.rpm = strictestRpm;
  }

  const elapsed = Math.max(0, now - bucket.lastRefill);
  const tokensToAdd = (elapsed / 60000) * bucket.rpm;
  bucket.tokens = Math.min(bucket.rpm, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }

  const waitMs = ((1 - bucket.tokens) / bucket.rpm) * 60000;
  await new Promise((r) => setTimeout(r, waitMs));
  const resumedAt = Date.now();
  const resumedElapsed = Math.max(0, resumedAt - bucket.lastRefill);
  const resumedTokens = bucket.tokens + (resumedElapsed / 60000) * bucket.rpm;
  bucket.tokens = Math.max(0, Math.min(bucket.rpm, resumedTokens) - 1);
  bucket.lastRefill = resumedAt;
}

export function clearBuckets(): void {
  buckets.clear();
}
