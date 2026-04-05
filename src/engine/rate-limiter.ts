/**
 * Token bucket rate limiter — per-domain request throttling.
 * Shared across pipeline executions within the same process.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
  rpm: number;
}

const buckets = new Map<string, Bucket>();

export async function waitForToken(domain: string, rpm: number): Promise<void> {
  const now = Date.now();
  let bucket = buckets.get(domain);

  if (!bucket) {
    bucket = { tokens: rpm, lastRefill: now, rpm };
    buckets.set(domain, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = (elapsed / 60000) * bucket.rpm;
  bucket.tokens = Math.min(bucket.rpm, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }

  // Wait for next token
  const waitMs = ((1 - bucket.tokens) / bucket.rpm) * 60000;
  await new Promise((r) => setTimeout(r, waitMs));
  bucket.tokens = 0;
  bucket.lastRefill = Date.now();
}

export function clearBuckets(): void {
  buckets.clear();
}
