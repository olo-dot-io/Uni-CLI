---
name: bgclick-rev
description: Reverse-engineer a macOS GUI automation app's background-click path and produce a Swift reproduction. Use only when the user provides a target .app and explicitly asks for IDA-backed background-click reverse engineering. Requires IDA Pro with IDA MCP attached.
---

# Background-Click Reverse Engineering

Use this skill only for research on a user-provided macOS `.app`. If IDA Pro or IDA MCP is unavailable, stop early and explain the blocker. Do not modify Uni-CLI source code from this skill; write research artifacts and reproduction code only after the binary evidence is gathered.

## Outputs

Create a research bundle under `<workspace>/research/`:

- `SHARED-CONTEXT.md` with target paths, bundle IDs, signing status, IDA MCP instance mapping, and priors to verify.
- `findings/<phase-or-question>.md` for call-site maps and open questions.
- `sub_<addr>-<label>.md` for every decompiled function used as evidence.
- `frame-map.md` for Swift async task-frame offsets.
- `FINAL-REPORT.md` with behavior spec, evidence table, reproduction diff, and VM test plan.

If asked to build a reproduction, add:

- `Sources/<Module>/BackgroundClicker.swift`
- `EchoApp/main.swift`
- `impl-research.md` with empirical VM runs.

## Priors To Verify

Treat these as hypotheses until confirmed in the target binary:

- Events are posted with `CGEvent.postToPid(_:)`.
- The synthetic event starts as `NSEvent.mouseEvent(...)`, then uses `event.cgEvent`.
- Explicit integer fields are `3` button, `7` subtype value `3`, `91` window under pointer, and `92` window that can handle the event.
- Screen location is set, read back, translated by the target window origin, and written with `CGEventSetWindowLocation` resolved by `dlsym`.
- Background targets receive `CGEventFlags.maskCommand` (`0x00100000`), not the non-coalesced flag.
- `CGWindowID` comes from `CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID)` filtered by owner PID.
- Do not double-write fields already populated by `NSEvent.cgEvent`.
- The click path should not activate the target app through AppKit, AX frontmost setters, or SLS/CGS private activation APIs.

## Workflow

1. Triage the `.app`: locate main executable and helper apps, record `codesign -d --entitlements -`, `nm -u`, and relevant Mach-O paths.
2. Confirm IDA MCP instances and map each instance to a binary in `SHARED-CONTEXT.md`.
3. Audit service binary call sites upward from `CGWindowListCopyWindowInfo`, `CGWindowListCreateDescriptionFromArray`, AX APIs, screen-capture APIs, `dlsym`, and `dlopen`.
4. Identify the dispatch function that logs or formats the click dispatch message, then trace the Swift async continuation chain into the synthesizer.
5. For each decompiled function used, write `research/sub_<addr>-<label>.md` with a one-line verdict, trimmed evidence, frame writes, and Swift equivalent.
6. Resolve dyld-hash wrappers to concrete CoreGraphics symbols. Verify with `dlsym` on a comparable macOS host when possible.
7. Produce `findings/cgevent-fields.md` mapping every explicit `setIntegerValueField` write to SDK constants and source expressions.
8. Hunt open questions independently. Each finding file starts with a one-sentence verdict and includes evidence addresses.
9. Build `BackgroundClicker.swift` only from verified behavior. Use public AppKit/CoreGraphics APIs plus `dlsym` for `CGEventSetWindowLocation`.
10. Validate in a VM with an EchoApp counter window. Record window number, screen point, window-local point, activation state, and pass/fail in `impl-research.md`.

## Guardrails

- Keep all reverse-engineered evidence in `research/`; do not paste large decompiler output into chat.
- Mark unknowns as open questions instead of guessing.
- Never label `0x100000` as non-coalesced; it is the Command flag.
- Activation selectors found elsewhere in the binary are not evidence unless they are on the verified click path.
