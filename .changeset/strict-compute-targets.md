---
"@zenalexa/unicli": patch
---

Bind compute operations to their original app, CDP endpoint, or ref transport
instead of falling through to an unrelated browser or screen. Forward target
arguments through CDP, UIA, and AT-SPI snapshots, keep incompatible persisted
CDP sessions from replacing explicit apps, bind macOS/Windows/Linux native refs
to exact window IDs and traversal paths, publish empty target tombstones so old
refs cannot revive, and reject unresolved or legacy refs.

Make `compute wait` poll fresh target snapshots for ref, text, and
appear/disappear/focused/enabled/checked state conditions. Unmet conditions now time out, ambiguous unscoped waits return
`invalid_input`, and duration-only Visual/Subprocess waits can no longer report
false condition success.

Serialize compute-ref shard readers with publishers so retention cannot remove
an enumerated record mid-read, and report live lock contention as a typed,
retryable temporary failure. Combined snapshot-and-screenshot capture now derives
one exact window identity from ref provenance, binds every replay step to it,
and fails closed if the window cannot be proved or changes mid-capture.

Reject partially parsed numeric CLI options, publish format-sensitive screenshot
files through extension-preserving atomic staging, and surface transport cleanup
failures instead of printing a false successful result. Align CLI, MCP contract,
help, and operator docs for window targeting, click background mode, observe
app/top-k, assert visibility, and exact CDP target IDs.
