/**
 * Idle timeout manager for the browser daemon.
 * Auto-exits the daemon process when no CLI requests arrive
 * and no extension is connected within the timeout period.
 */

export class IdleManager {
  lastCliRequestTime = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private extensionConnected = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
  ) {
    this.scheduleCheck();
  }

  /** Call when a CLI request arrives to reset the idle timer. */
  onCliRequest(): void {
    this.lastCliRequestTime = Date.now();
  }

  /** Track extension connection state. */
  setExtensionConnected(connected: boolean): void {
    this.extensionConnected = connected;
  }

  /** Clean up timer. */
  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleCheck(): void {
    const interval = Math.min(60_000, Math.max(10_000, this.timeoutMs / 4));
    this.timer = setTimeout(() => {
      const elapsed = Date.now() - this.lastCliRequestTime;
      if (elapsed >= this.timeoutMs && !this.extensionConnected) {
        this.onIdle();
      } else {
        this.scheduleCheck();
      }
    }, interval);
    // Don't keep process alive just for the timer
    this.timer.unref();
  }
}
