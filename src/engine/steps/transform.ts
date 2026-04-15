/**
 * Transform step handlers (re-export shim) — kept for backward compat
 * with code expecting `handleSelect`, `handleMap`, etc. Real bodies live
 * in per-step files now.
 */

export { stepSelect as handleSelect } from "./select.js";
export { stepMap as handleMap } from "./map.js";
export { stepFilter as handleFilter } from "./filter.js";
export { stepSort as handleSort, type SortConfig } from "./sort.js";
export { stepLimit as handleLimit } from "./limit.js";
