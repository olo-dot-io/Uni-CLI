const MIN_OFFSET = 7200; // 2 hours
const MAX_OFFSET = 14 * 86400; // 14 days

export function validateTiming(unixSeconds: number): void {
  if (!Number.isFinite(unixSeconds))
    throw new Error(`Invalid timestamp: ${unixSeconds}`);
  const now = Math.floor(Date.now() / 1000);
  if (unixSeconds < now + MIN_OFFSET)
    throw new Error("Scheduled time must be at least 2 hours from now");
  if (unixSeconds > now + MAX_OFFSET)
    throw new Error("Scheduled time must be within 14 days");
}

export function toUnixSeconds(input: string | number): number {
  if (typeof input === "number") return input;
  if (/^\d+$/.test(input)) {
    return Number(input);
  }
  const ms = new Date(input).getTime();
  if (isNaN(ms)) throw new Error(`Invalid time format: "${input}"`);
  return Math.floor(ms / 1000);
}
