/**
 * Control-flow step handlers (re-export shim) — kept for backward compat
 * with code expecting `handleSet`, `handleIf`, etc. Real bodies live in
 * per-step files now.
 */

export { stepSet as handleSet } from "./set.js";
export { stepAppend as handleAppend } from "./append.js";
export { stepIf as handleIf } from "./if.js";
export { stepEach as handleEach, type EachConfig } from "./each.js";
export { stepParallel as handleParallel } from "./parallel.js";
export { stepAssert as handleAssert, type AssertConfig } from "./assert.js";
