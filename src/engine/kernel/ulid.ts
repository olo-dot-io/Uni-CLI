/**
 * ULID generator — 26-char Crockford Base32, time-sortable AND strictly
 * monotonic within the same millisecond.
 *
 * Spec: https://github.com/ulid/spec#monotonicity
 *
 * Layout: 48 bits of ms timestamp (10 chars) + 80 bits of randomness (16 chars).
 * When two ULIDs are generated in the same ms, the random component of the
 * second is the first + 1 (BigInt increment). An 80-bit overflow (never seen
 * in practice — ~10^24 events/ms) spins until the clock advances.
 *
 * Dependency-free: uses only node:crypto randomBytes.
 */

import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_80_BIT = (1n << 80n) - 1n;

let lastMs = -1;
let lastRand = 0n;

function encodeTime(ms: number): string {
  const chars: string[] = [];
  let t = ms;
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[t % 32];
    t = Math.floor(t / 32);
  }
  return chars.join("");
}

function encodeRand(rand: bigint): string {
  const chars: string[] = [];
  let acc = rand;
  for (let i = 15; i >= 0; i--) {
    chars[i] = CROCKFORD[Number(acc & 31n)];
    acc >>= 5n;
  }
  return chars.join("");
}

function freshRand(): bigint {
  const bytes = randomBytes(10);
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return acc;
}

/**
 * Generate a strictly monotonic 26-char ULID. Two calls in the same ms sort
 * lexicographically in call order.
 */
export function newULID(): string {
  let now = Date.now();
  let rand: bigint;

  if (now === lastMs) {
    rand = lastRand + 1n;
    // 80-bit overflow — spin until the clock advances. In practice
    // unreachable (10^24 events/ms), but the spec requires handling it.
    while (rand > MAX_80_BIT) {
      const spun = Date.now();
      if (spun > lastMs) {
        now = spun;
        rand = freshRand();
        break;
      }
    }
  } else {
    rand = freshRand();
  }

  lastMs = now;
  lastRand = rand;
  return encodeTime(now) + encodeRand(rand);
}

/** Test hook — reset module state so successive test runs are independent. */
export function _resetULIDForTests(): void {
  lastMs = -1;
  lastRand = 0n;
}
