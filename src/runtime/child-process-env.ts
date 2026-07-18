/**
 * @owner       src::runtime::child-process-env
 * @does        Builds a mixed-version-compatible environment for Uni-CLI subprocesses observed by their parent.
 * @needs       Node process environment contract
 * @feeds       MCP explore, research verification, and hub verification subprocesses
 * @breaks      Omitting either opt-out lets current or legacy children duplicate parent-owned local usage evidence.
 * @invariants  Both UNICLI_NO_LOG and UNICLI_NO_LEDGER equal 1; every unrelated parent variable is preserved.
 * @side-effects none
 * @perf        O(parent environment keys) copy per subprocess launch.
 * @concurrency Pure and reentrant.
 * @test        tests/unit/child-process-env.test.ts and tests/unit/mcp/explore-permission.test.ts
 * @stability   internal
 * @since       2026-07-18
 */

export function localLoggingDisabledChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    UNICLI_NO_LOG: "1",
    UNICLI_NO_LEDGER: "1",
  };
}
