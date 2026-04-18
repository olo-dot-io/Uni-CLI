/**
 * Invocation Kernel — backward-compat re-export surface.
 *
 * v0.213.3 R2 split this file into `src/engine/kernel/{types,ulid,compile,execute}.ts`
 * so each concern owns its own 100-220 LOC module. This file exists solely
 * to keep the historic `src/engine/invoke.js` import path stable for any
 * external callers (tests, third-party scripts, downstream plugins).
 *
 * New code should import from `./kernel/{types,ulid,compile,execute}.js`
 * directly; the re-export is a compatibility shim, not a recommended path.
 */

export type {
  Invocation,
  CompiledCommand,
  InvocationResult,
  AjvValidateFn,
} from "./kernel/types.js";

export { newULID, _resetULIDForTests } from "./kernel/ulid.js";

export {
  compileAll,
  getCompiled,
  compileCommand,
  _resetCompiledCacheForTests,
} from "./kernel/compile.js";

export { buildInvocation, execute } from "./kernel/execute.js";
