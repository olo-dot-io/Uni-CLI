/**
 * Desktop / subprocess step handlers (re-export shim) — kept for backward
 * compat. Real bodies live in `exec.ts` and `write-temp.ts`.
 */

export { stepExec as handleExec, type ExecConfig } from "./exec.js";
export {
  stepWriteTemp as handleWriteTemp,
  type WriteTempConfig,
} from "./write-temp.js";
