/**
 * @owner       extension/src/debugger-dispatch.ts
 * @does        Define the controller-owned Chrome debugger command boundary shared by extension feature modules.
 * @needs       no runtime dependency
 * @feeds       chrome-controller.ts, dialog-supervisor.ts, network-capture.ts
 * @breaks      Extension feature modules cannot express whether a debugger command is safe to replay after detach.
 * @invariants  Every dispatched feature command declares replay-on-detach explicitly.
 * @side-effects none (type contract only)
 * @stability   experimental
 * @since       2026-07-15
 */

export type DebuggerCommandDispatch = (
  method: string,
  params: Record<string, unknown>,
  replayOnDetach: boolean,
) => Promise<unknown>;
