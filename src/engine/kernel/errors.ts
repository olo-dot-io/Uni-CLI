/**
 * @owner Uni-CLI Kernel
 * @does Defines kernel-specific error classes shared by stage modules.
 * @needs Command lookup keys.
 * @feeds Kernel stage resolution and legacy invoke exports.
 * @breaks Missing compiled command cache entries.
 */

export class KernelLookupError extends Error {
  constructor(key: string) {
    super(
      `KernelLookupError: compiled command not found: ${key}. ` +
        "Loader must call compileAll() before execute() — call primeKernelCache() from discovery/loader.ts.",
    );
    this.name = "KernelLookupError";
  }
}
