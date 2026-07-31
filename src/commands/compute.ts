/**
 * @owner       src::commands::compute
 * @does        Register CLI computer-control commands, validate scalar options strictly, and execute each command inside one trusted, finalizable browser invocation.
 * @needs       commander, compute capture/action modules, browser invocation context/scope, process-shared transport bus, output envelopes/formatting
 * @feeds       unicli compute CLI surface
 * @breaks      Invalid options, transport failures, and cleanup failures become structured action envelopes; operation and finalization throws remain jointly visible.
 * @invariants  Every top-level compute command owns one CLI turn; integer options reject partial/coerced values; an already-trusted ambient invocation is preserved; explicit app identity is never overwritten by an unrelated saved CDP session; default web actions can acquire only broker-owned targets; success prints only after all owned resources close.
 * @side-effects Operates apps/browsers, persists explicit CDP attachment metadata and refs, writes formatted output, and closes CLI-owned transport resources.
 * @perf        One invocation context allocation per top-level command; transport cost dominates.
 * @concurrency AsyncLocalStorage isolates concurrent callers even though the transport registry is process-shared.
 * @test        tests/unit/commands/compute.test.ts, tests/unit/transport/adapters/cdp-browser.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { Command } from "commander";

import { createBrowserInvocationContext } from "../browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  currentBrowserInvocationScope,
  runBrowserInvocation,
} from "../browser/invocation-scope.js";
import {
  executeComputeAction,
  type ComputeActionExecution,
} from "../compute/action-execution.js";
import { getComputeCommandContract } from "../compute/contracts.js";
import { createPlatformComputeOverlayProvider } from "../compute/platform-overlays.js";
import { getBus } from "../transport/bus.js";
import {
  dispatchComputeRoute,
  prepareComputeRequest,
  routeUnavailableResult,
} from "../transport/compute-dispatch.js";
import { planComputeRoute } from "../transport/routing.js";
import { loadCdpSession, saveCdpSession } from "../transport/cdp-session.js";
import { loadRefStore, saveRefStore } from "../transport/refs.js";
import {
  captureComputeContext,
  readCaptureIncludes,
} from "../compute/capture.js";
import { authorizeComputeOperation } from "../compute/permission.js";
import {
  MAX_COMPUTE_WAIT_TIMEOUT_MS,
  transportForComputeRef,
} from "../compute/wait.js";
import {
  copyReferenceMarkupToClipboard,
  saveComputeCaptureReference,
} from "../compute/capture-reference.js";
import { err, exitCodeFor, ok } from "../core/envelope.js";
import type { ActionResult } from "../transport/types.js";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";

const COMPUTE_VIA_DESCRIPTION =
  "Select one route: native | browser | process | driver | visual; driver and visual are explicit desktop-coordinate capabilities";

export function registerComputeCommand(program: Command): void {
  const compute = program
    .command("compute")
    .description(
      "Operate installed apps through one explicit native, browser, process, driver, or visual provider",
    );

  compute
    .command("apps")
    .description("List running apps")
    .action(async () => {
      await run(program, "compute.apps", "compute_apps", {});
    });

  compute
    .command("windows")
    .description("List app windows")
    .option("--app <name>", "Filter by app")
    .action(async (opts: Record<string, unknown>) => {
      await run(program, "compute.windows", "compute_windows", opts);
    });

  compute
    .command("route <operation>")
    .description("Explain the single provider selected for a compute operation")
    .option(
      "--params <json>",
      'Operation arguments as one JSON object, e.g. \'{"app":"Slack"}\'',
      "{}",
    )
    .option("--via <route>", COMPUTE_VIA_DESCRIPTION)
    .action(
      async (
        operation: string,
        opts: { params: string; via?: string },
      ): Promise<void> => {
        const startedAt = Date.now();
        const parsed = parseComputeRouteParams(opts.params);
        if (!parsed.ok) {
          print(
            program,
            "compute.route",
            startedAt,
            invalidOptionResult(
              "compute_route",
              parsed.reason,
              "pass --params as a JSON object",
              "compute.route",
            ),
          );
          return;
        }
        const contract = getComputeCommandContract(operation);
        if (!contract) {
          print(
            program,
            "compute.route",
            startedAt,
            invalidOptionResult(
              "compute_route",
              `unknown compute operation: ${operation}`,
              "use a command shown by `unicli compute --help`",
              "compute.route",
            ),
          );
          return;
        }
        const params: Record<string, unknown> = {
          ...parsed.value,
          ...(opts.via ? { via: opts.via } : {}),
        };
        const bus = getBus();
        loadPersistedRefs(bus);
        const preparation = prepareComputeRequest(bus, {
          kind: contract.kind,
          params,
        });
        if (preparation.status === "rejected") {
          print(program, "compute.route", startedAt, preparation.result);
          return;
        }
        if (
          contract.kind === "compute_find" ||
          contract.kind === "compute_observe" ||
          contract.kind === "compute_assert"
        ) {
          const localReason =
            contract.kind === "compute_find"
              ? "find queries the latest local ref index"
              : contract.kind === "compute_observe"
                ? "observe ranks the latest local ref index"
                : "assert evaluates the latest local ref generation";
          print(
            program,
            "compute.route",
            startedAt,
            ok({
              schema_version: "compute-route.v1",
              operation,
              status: "selected",
              selection: {
                operator: "local-runtime",
                provider: "unicli-ref-store",
                reason: localReason,
              },
              provider_recovery:
                "a provider failure requires repair or explicit replanning",
            }),
          );
          return;
        }
        if (contract.kind === "compute_capture") {
          const captureIncludes = readCaptureIncludes(
            params.include as string | undefined,
          );
          if (captureIncludes.invalid.length > 0) {
            print(
              program,
              "compute.route",
              startedAt,
              err({
                transport: "local-runtime",
                step: 0,
                action: "compute_capture",
                reason: `invalid capture include parts: ${captureIncludes.invalid.join(", ")}`,
                suggestion: "use snapshot,screenshot, snapshot, or screenshot",
                minimum_capability: "compute.capture",
                exit_code: exitCodeFor("invalid_input"),
              }),
            );
            return;
          }
          const routes = captureIncludes.includes.map((include) =>
            planComputeRoute(
              {
                kind:
                  include === "snapshot"
                    ? "compute_snapshot"
                    : "compute_screenshot",
                params,
              },
              process.platform,
            ),
          );
          const unavailableRoute = routes.find(
            (route) => route.status === "unavailable",
          );
          if (unavailableRoute?.status === "unavailable") {
            print(
              program,
              "compute.route",
              startedAt,
              routeUnavailableResult(unavailableRoute),
            );
            return;
          }
          print(
            program,
            "compute.route",
            startedAt,
            ok({
              schema_version: "compute-route.v1",
              operation,
              status: "composite",
              routes,
              provider_recovery:
                "each capture part selects one provider before execution",
            }),
          );
          return;
        }
        const logicalRequest =
          contract.kind === "compute_wait"
            ? {
                ...preparation.prepared.request,
                kind: "compute_snapshot",
              }
            : preparation.prepared.request;
        const refOwner = preparation.prepared.refMatch
          ? transportForComputeRef(preparation.prepared.refMatch.ref.stable)
          : undefined;
        const route = planComputeRoute(
          logicalRequest,
          process.platform,
          refOwner,
        );
        if (route.status === "unavailable") {
          print(
            program,
            "compute.route",
            startedAt,
            routeUnavailableResult(route),
          );
          return;
        }
        print(
          program,
          "compute.route",
          startedAt,
          ok({
            schema_version: "compute-route.v1",
            operation,
            route,
            provider_recovery:
              "ordinary provider failure does not change the selected route",
          }),
        );
      },
    );

  compute
    .command("snapshot")
    .description("Capture a compact accessibility snapshot")
    .option("--app <name>", "Target app")
    .option("--window-id <id>", "Exact native window id")
    .option("--format <fmt>", "compact | tree | json", "compact")
    .option("--interactive-only", "Only include interactive elements")
    .option("--max-depth <n>", "Maximum tree depth", "64")
    .option("--via <route>", COMPUTE_VIA_DESCRIPTION)
    .action(async (opts: Record<string, unknown>) => {
      const maxDepth = readIntegerOption(opts.maxDepth, 64, 0, 64);
      if (maxDepth === undefined) {
        printInvalidIntegerOption(
          program,
          "compute.snapshot",
          "compute_snapshot",
          "max-depth",
          0,
          64,
        );
        return;
      }
      const snapshotFormat = readSnapshotFormat(
        program,
        opts.format,
        "snapshot",
      );
      if (!snapshotFormat.ok) {
        print(
          program,
          "compute.snapshot",
          Date.now(),
          invalidOptionResult(
            "compute_snapshot",
            `invalid snapshot format: ${snapshotFormat.value}`,
            "use --format compact, tree, or json",
            "compute.snapshot",
          ),
        );
        return;
      }
      await run(program, "compute.snapshot", "compute_snapshot", {
        ...opts,
        format: snapshotFormat.value,
        maxDepth,
      });
    });

  compute
    .command("capture")
    .description("Capture a reusable app context packet")
    .option("--app <name>", "Target app")
    .option("--window-id <id>", "Exact native window id")
    .option("--format <fmt>", "compact | tree | json", "compact")
    .option("--include <parts>", "snapshot,screenshot", "snapshot,screenshot")
    .option("--max-depth <n>", "Maximum snapshot tree depth", "64")
    .option("--screenshot-path <path>", "Optional screenshot output path")
    .option("--save-reference", "Persist an app-shots reference for handoff")
    .option("--copy-reference", "Persist and copy the app-shots reference")
    .option("--reference-root <dir>", "Directory for saved app-shots artifacts")
    .option("--via <route>", COMPUTE_VIA_DESCRIPTION)
    .action(async (opts: Record<string, unknown>) => {
      await runCapture(program, opts);
    });

  compute
    .command("find")
    .description("Find matching elements in the latest snapshot")
    .requiredOption("--role <role>", "button | input | menuitem | ...")
    .option("--name <name>", "Substring match")
    .option("--text <text>", "Match visible/current text value")
    .option("--app <app>", "Target app")
    .option("--window-id <id>", "Exact native window id")
    .option("--first", "Return the first match")
    .action(async (opts: Record<string, unknown>) => {
      await run(program, "compute.find", "compute_find", opts);
    });

  compute
    .command("click <ref>")
    .description("Click an element ref")
    .option("--background", "Avoid focusing the target app")
    .option("--focus", "Focus the target app first")
    .option("--overlay", "Render the system-level virtual cursor HUD")
    .option("--via <route>", COMPUTE_VIA_DESCRIPTION)
    .action(async (ref: string, opts: Record<string, unknown>) => {
      await run(
        program,
        "compute.click",
        "compute_click",
        {
          ref,
          ...normalizeFocusOptions(opts),
        },
        { overlay: opts.overlay === true },
      );
    });

  compute
    .command("point-click <x> <y>")
    .description("Click an absolute desktop point from fresh pixel evidence")
    .option("--button <button>", "left | right | middle", "left")
    .option("--count <n>", "Click count from 1 to 3", "1")
    .option("--session <id>", "Optional Cua Driver session id")
    .option(
      "--observation <ref>",
      "Opaque single-use ref from compute screenshot on the same provider",
    )
    .option("--via <route>", "driver | visual")
    .action(
      async (xValue: string, yValue: string, opts: Record<string, unknown>) => {
        const x = readFiniteNumber(xValue);
        const y = readFiniteNumber(yValue);
        const count = readIntegerOption(opts.count, 1, 1, 3);
        if (x === undefined || y === undefined) {
          printInvalidCoordinate(program, "point-click");
          return;
        }
        if (count === undefined) {
          printInvalidIntegerOption(
            program,
            "compute.point-click",
            "compute_point_click",
            "count",
            1,
            3,
          );
          return;
        }
        await run(program, "compute.point-click", "compute_point_click", {
          x,
          y,
          ...opts,
          count,
        });
      },
    );

  compute
    .command("drag <from-x> <from-y> <to-x> <to-y>")
    .description("Drag between two absolute desktop points")
    .option("--button <button>", "left | right | middle", "left")
    .option("--duration-ms <ms>", "Drag duration from 0 to 10000 ms")
    .option("--modifier <keys...>", "Modifier keys held during the drag")
    .option("--steps <n>", "Interpolation steps from 1 to 200")
    .option("--session <id>", "Optional Cua Driver session id")
    .option(
      "--observation <ref>",
      "Opaque single-use ref from compute screenshot on the same provider",
    )
    .option("--via <route>", "driver | visual")
    .action(
      async (
        fromXValue: string,
        fromYValue: string,
        toXValue: string,
        toYValue: string,
        opts: Record<string, unknown>,
      ) => {
        const fromX = readFiniteNumber(fromXValue);
        const fromY = readFiniteNumber(fromYValue);
        const toX = readFiniteNumber(toXValue);
        const toY = readFiniteNumber(toYValue);
        const durationMs = readOptionalIntegerOption(
          opts.durationMs,
          0,
          10_000,
        );
        const steps = readOptionalIntegerOption(opts.steps, 1, 200);
        if (
          fromX === undefined ||
          fromY === undefined ||
          toX === undefined ||
          toY === undefined
        ) {
          printInvalidCoordinate(program, "drag");
          return;
        }
        if (durationMs === null) {
          printInvalidIntegerOption(
            program,
            "compute.drag",
            "compute_drag",
            "duration-ms",
            0,
            10_000,
          );
          return;
        }
        if (steps === null) {
          printInvalidIntegerOption(
            program,
            "compute.drag",
            "compute_drag",
            "steps",
            1,
            200,
          );
          return;
        }
        await run(program, "compute.drag", "compute_drag", {
          fromX,
          fromY,
          toX,
          toY,
          ...opts,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(steps === undefined ? {} : { steps }),
        });
      },
    );

  compute
    .command("type <ref> <text>")
    .description("Set or type text into an element ref")
    .option("--clear", "Clear field first")
    .option("--focus", "Focus the target app first")
    .option("--overlay", "Render the system-level virtual cursor HUD")
    .option("--via <route>", COMPUTE_VIA_DESCRIPTION)
    .action(
      async (ref: string, text: string, opts: Record<string, unknown>) => {
        await run(
          program,
          "compute.type",
          "compute_type",
          {
            ref,
            text,
            ...normalizeFocusOptions(opts),
          },
          { overlay: opts.overlay === true },
        );
      },
    );

  compute
    .command("text <text>")
    .description("Send text to the current foreground desktop app")
    .option("--session <id>", "Optional Cua Driver session id")
    .option("--via <route>", "driver | visual")
    .action(async (text: string, opts: Record<string, unknown>) => {
      await run(program, "compute.text", "compute_text", { text, ...opts });
    });

  compute
    .command("press <combo>")
    .description("Press a key combo, e.g. cmd+s or ctrl+shift+p")
    .option("--app <app>", "Target app")
    .option("--focus", "Focus the target app first")
    .option("--modifiers <keys...>", "Modifiers for a single press_key")
    .option("--session <id>", "Optional Cua Driver session id")
    .option("--via <route>", COMPUTE_VIA_DESCRIPTION)
    .action(async (combo: string, opts: Record<string, unknown>) => {
      await run(program, "compute.press", "compute_press", {
        combo,
        ...normalizeFocusOptions(opts),
      });
    });

  compute
    .command("scroll <ref>")
    .description("Scroll an element ref")
    .option("--direction <direction>", "up | down | left | right", "down")
    .option("--amount <px>", "Pixels", "300")
    .option("--focus", "Focus the target app first")
    .option("--overlay", "Render the system-level virtual cursor HUD")
    .option("--via <route>", COMPUTE_VIA_DESCRIPTION)
    .action(async (ref: string, opts: Record<string, unknown>) => {
      const normalized = normalizeFocusOptions(opts);
      const amount = readIntegerOption(normalized.amount, 300, 1, 100_000);
      if (amount === undefined) {
        printInvalidIntegerOption(
          program,
          "compute.scroll",
          "compute_scroll",
          "amount",
          1,
          100_000,
        );
        return;
      }
      await run(
        program,
        "compute.scroll",
        "compute_scroll",
        {
          ref,
          ...normalized,
          amount,
        },
        { overlay: opts.overlay === true },
      );
    });

  compute
    .command("point-scroll <x> <y>")
    .description("Scroll at an absolute desktop point through Cua Driver")
    .option("--direction <direction>", "up | down | left | right", "down")
    .option("--amount <count>", "Line or page count from 1 to 50", "3")
    .option("--by <unit>", "line | page", "line")
    .option("--session <id>", "Optional Cua Driver session id")
    .option(
      "--observation <ref>",
      "Opaque single-use ref from compute screenshot on the same provider",
    )
    .option("--via <route>", "driver")
    .action(
      async (xValue: string, yValue: string, opts: Record<string, unknown>) => {
        const x = readFiniteNumber(xValue);
        const y = readFiniteNumber(yValue);
        const amount = readIntegerOption(opts.amount, 3, 1, 50);
        if (x === undefined || y === undefined) {
          printInvalidCoordinate(program, "point-scroll");
          return;
        }
        if (amount === undefined) {
          printInvalidIntegerOption(
            program,
            "compute.point-scroll",
            "compute_point_scroll",
            "amount",
            1,
            50,
          );
          return;
        }
        await run(program, "compute.point-scroll", "compute_point_scroll", {
          x,
          y,
          ...opts,
          amount,
        });
      },
    );

  compute
    .command("launch <app>")
    .description("Launch an app")
    .option("--debug-port <port>", "Electron CDP debug port")
    .option("--via <route>", COMPUTE_VIA_DESCRIPTION)
    .action(async (app: string, opts: Record<string, unknown>) => {
      const debugPort = readOptionalIntegerOption(opts.debugPort, 1, 65_535);
      if (debugPort === null) {
        printInvalidIntegerOption(
          program,
          "compute.launch",
          "compute_launch",
          "debug-port",
          1,
          65_535,
        );
        return;
      }
      await run(program, "compute.launch", "compute_launch", {
        app,
        ...opts,
        ...(debugPort === undefined ? {} : { debugPort }),
      });
    });

  compute
    .command("screenshot [path]")
    .description("Capture a screenshot")
    .option("--app <app>", "Target app")
    .option("--window-id <id>", "Exact native window id")
    .option("--session <id>", "Optional Cua Driver session id")
    .option("--via <route>", COMPUTE_VIA_DESCRIPTION)
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      await run(program, "compute.screenshot", "compute_screenshot", {
        path,
        ...opts,
      });
    });

  compute
    .command("session-start <session>")
    .description("Declare a Cua Driver session and capture policy")
    .option("--capture-scope <scope>", "auto | window | desktop", "auto")
    .option("--cursor-theme-id <id>", "Optional initial cursor theme id")
    .option("--reduced-motion <policy>", "auto | on | off", "auto")
    .action(async (session: string, opts: Record<string, unknown>) => {
      await run(program, "compute.session-start", "compute_session_start", {
        session,
        ...opts,
      });
    });

  compute
    .command("session-state <session>")
    .description("Read a Cua Driver session's effective scope")
    .action(async (session: string) => {
      await run(program, "compute.session-state", "compute_session_state", {
        session,
      });
    });

  compute
    .command("session-escalate <session>")
    .description("Explicitly escalate an auto Cua Driver session to desktop")
    .option(
      "--reason <reason>",
      "ax_tree_pixel_mismatch | background_delivery_failed | foreground_ineffective | no_window_target | other",
    )
    .option("--detail <text>", "Optional non-secret detail, at most 200 chars")
    .action(async (session: string, opts: Record<string, unknown>) => {
      await run(
        program,
        "compute.session-escalate",
        "compute_session_escalate",
        { session, ...opts },
      );
    });

  compute
    .command("session-end <session>")
    .description("End a Cua Driver session and release its resources")
    .action(async (session: string) => {
      await run(program, "compute.session-end", "compute_session_end", {
        session,
      });
    });

  compute
    .command("screen-size")
    .description("Read Cua Driver desktop dimensions and scale factor")
    .option("--session <id>", "Optional Cua Driver session id")
    .action(async (opts: Record<string, unknown>) => {
      await run(program, "compute.screen-size", "compute_screen_size", opts);
    });

  compute
    .command("cursor-position")
    .description("Read the physical pointer position through Cua Driver")
    .option("--session <id>", "Optional Cua Driver session id")
    .action(async (opts: Record<string, unknown>) => {
      await run(
        program,
        "compute.cursor-position",
        "compute_cursor_position",
        opts,
      );
    });

  compute
    .command("move-cursor <x> <y>")
    .description("Move the physical pointer through Cua Driver")
    .option("--session <id>", "Optional Cua Driver session id")
    .option(
      "--observation <ref>",
      "Opaque single-use ref from compute screenshot on the same provider",
    )
    .option("--via <route>", "driver")
    .action(
      async (xValue: string, yValue: string, opts: Record<string, unknown>) => {
        const x = readFiniteNumber(xValue);
        const y = readFiniteNumber(yValue);
        if (x === undefined || y === undefined) {
          printInvalidCoordinate(program, "move-cursor");
          return;
        }
        await run(program, "compute.move-cursor", "compute_move_cursor", {
          x,
          y,
          ...opts,
        });
      },
    );

  compute
    .command("agent-cursor-state <session>")
    .description("Read presentation-only Cua Driver agent cursor state")
    .action(async (session: string) => {
      await run(
        program,
        "compute.agent-cursor-state",
        "compute_agent_cursor_state",
        { session },
      );
    });

  compute
    .command("agent-cursor-enable <session> <enabled>")
    .description("Enable or disable the presentation-only agent cursor")
    .action(async (session: string, enabledValue: string) => {
      const enabled = readBooleanValue(enabledValue);
      if (enabled === undefined) {
        print(
          program,
          "compute.agent-cursor-enable",
          Date.now(),
          invalidOptionResult(
            "compute_agent_cursor_enabled",
            "enabled must be true or false",
            "pass true or false",
            "compute.agent-cursor-enable.invalid_input",
          ),
        );
        return;
      }
      await run(
        program,
        "compute.agent-cursor-enable",
        "compute_agent_cursor_enabled",
        { session, enabled },
      );
    });

  const cursorMotion = compute
    .command("agent-cursor-motion <session>")
    .description("Set presentation-only Cua Driver cursor motion parameters");
  for (const option of [
    "start-handle",
    "end-handle",
    "arc-size",
    "arc-flow",
    "spring",
    "glide-duration-ms",
    "dwell-after-click-ms",
    "idle-hide-ms",
    "turn-radius",
  ]) {
    cursorMotion.option(
      `--${option} <value>`,
      `Set ${option}; pass null or reset to restore the provider default`,
    );
  }
  cursorMotion.action(
    async (session: string, opts: Record<string, unknown>) => {
      const params: Record<string, unknown> = { session };
      for (const [camel, snake] of Object.entries({
        startHandle: "start_handle",
        endHandle: "end_handle",
        arcSize: "arc_size",
        arcFlow: "arc_flow",
        spring: "spring",
        glideDurationMs: "glide_duration_ms",
        dwellAfterClickMs: "dwell_after_click_ms",
        idleHideMs: "idle_hide_ms",
        turnRadius: "turn_radius",
      })) {
        if (opts[camel] === undefined) continue;
        const value = readNullableFiniteNumber(opts[camel]);
        if (value === undefined) {
          print(
            program,
            "compute.agent-cursor-motion",
            Date.now(),
            invalidOptionResult(
              "compute_agent_cursor_motion",
              `${camel} must be a finite number or null`,
              "pass a finite numeric cursor motion value, or null to reset it",
              "compute.agent-cursor-motion.invalid_input",
            ),
          );
          return;
        }
        params[snake] = value;
      }
      await run(
        program,
        "compute.agent-cursor-motion",
        "compute_agent_cursor_motion",
        params,
      );
    },
  );

  compute
    .command("agent-cursor-theme <session> <theme-id>")
    .description("Set the presentation-only Cua Driver cursor theme")
    .option("--reduced-motion <policy>", "auto | on | off", "auto")
    .action(
      async (
        session: string,
        themeId: string,
        opts: Record<string, unknown>,
      ) => {
        await run(
          program,
          "compute.agent-cursor-theme",
          "compute_agent_cursor_theme",
          { session, themeId, ...opts },
        );
      },
    );

  compute
    .command("attach")
    .description("Attach CDP to an Electron app")
    .option("--app <name>", "Bundle id or app name")
    .option("--port <port>", "CDP port")
    .option("--target-id <id>", "Exact CDP renderer target id")
    .option(
      "--confirm-relaunch",
      "Allow relaunching apps that may lose session state",
    )
    .action(async (opts: Record<string, unknown>) => {
      const port = readOptionalIntegerOption(opts.port, 1, 65_535);
      if (port === null) {
        printInvalidIntegerOption(
          program,
          "compute.attach",
          "compute_cdp_attach",
          "port",
          1,
          65_535,
        );
        return;
      }
      await run(program, "compute.attach", "compute_cdp_attach", {
        ...opts,
        ...(port === undefined ? {} : { port }),
      });
    });

  compute
    .command("eval <js>")
    .description("Evaluate JS in the attached CDP renderer")
    .option("--target-id <id>", "Exact CDP renderer target id")
    .action(async (js: string, opts: Record<string, unknown>) => {
      await run(program, "compute.eval", "compute_evaluate", {
        script: js,
        ...opts,
      });
    });

  compute
    .command("wait")
    .description("Wait for a ref, text, or state")
    .option("--ref <ref>", "Element ref")
    .option("--text <text>", "Text to wait for")
    .option("--app <app>", "Target app")
    .option("--window-id <id>", "Exact native window id")
    .option(
      "--state <state>",
      "appear | disappear | focused | enabled | checked",
    )
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--via <route>", COMPUTE_VIA_DESCRIPTION)
    .action(async (opts: Record<string, unknown>) => {
      const { timeout, ...rest } = opts;
      const timeoutMs = readIntegerOption(
        timeout,
        10_000,
        1,
        MAX_COMPUTE_WAIT_TIMEOUT_MS,
      );
      if (timeoutMs === undefined) {
        printInvalidIntegerOption(
          program,
          "compute.wait",
          "compute_wait",
          "timeout",
          1,
          MAX_COMPUTE_WAIT_TIMEOUT_MS,
        );
        return;
      }
      await run(program, "compute.wait", "compute_wait", {
        ...rest,
        timeoutMs,
      });
    });

  compute
    .command("observe <goal>")
    .description("Rank candidate refs for a natural-language goal")
    .option("--app <app>", "Target app")
    .option("--top-k <n>", "Maximum candidate refs", "5")
    .action(async (goal: string, opts: Record<string, unknown>) => {
      const topK = readIntegerOption(opts.topK, 5, 1, 50);
      if (topK === undefined) {
        printInvalidIntegerOption(
          program,
          "compute.observe",
          "compute_observe",
          "top-k",
          1,
          50,
        );
        return;
      }
      await run(program, "compute.observe", "compute_observe", {
        goal,
        ...opts,
        topK,
      });
    });

  compute
    .command("assert")
    .description("Assert text, ref, or state")
    .option("--ref <ref>", "Element ref")
    .option("--text <text>", "Expected text")
    .option("--state <state>", "enabled | focused | checked | visible")
    .action(async (opts: Record<string, unknown>) => {
      await run(program, "compute.assert", "compute_assert", opts);
    });
}

async function run(
  program: Command,
  command: string,
  kind: string,
  params: Record<string, unknown>,
  opts: { overlay?: boolean } = {},
): Promise<void> {
  return runWithComputeExceptionBoundary(program, command, (startedAt) =>
    runInInvocation(program, command, kind, params, opts, startedAt),
  );
}

async function runInInvocation(
  program: Command,
  command: string,
  kind: string,
  params: Record<string, unknown>,
  opts: { overlay?: boolean },
  startedAt: number,
): Promise<void> {
  const signal = currentBrowserInvocationScope()?.signal;
  signal?.throwIfAborted();
  const authorization = await authorizeComputeOperation(
    command.slice("compute.".length),
    params,
    readComputePermissionOptions(program),
  );
  if (!authorization.ok) {
    print(program, command, startedAt, authorization.result);
    return;
  }
  signal?.throwIfAborted();
  const bus = getBus();
  const overlayProvider =
    opts.overlay === true ? createPlatformComputeOverlayProvider() : undefined;
  const execution = await executeWithComputeCleanup(
    bus,
    overlayProvider,
    async () => {
      loadPersistedRefs(bus);
      const dispatchParams = enrichWithPersistedCdpSession(kind, params, bus);
      const result = overlayProvider
        ? resultWithVisualEvidence(
            await executeComputeAction(
              bus,
              {
                kind,
                params: dispatchParams,
                ...(signal ? { signal } : {}),
              },
              {
                tool: command,
                overlayProvider,
                postActionCapture: true,
              },
            ),
          )
        : await dispatchComputeRoute(bus, {
            kind,
            params: dispatchParams,
            ...(signal ? { signal } : {}),
          });
      if (result.ok && kind === "compute_snapshot") {
        saveRefStore(bus.refs);
      }
      if (result.ok && kind === "compute_cdp_attach") {
        persistCdpAttach(result.data);
      }
      return result;
    },
  );
  print(
    program,
    command,
    startedAt,
    withCleanupFailures(command, execution.result, execution.cleanupFailures),
  );
}

async function runCapture(
  program: Command,
  opts: Record<string, unknown>,
): Promise<void> {
  return runWithComputeExceptionBoundary(
    program,
    "compute.capture",
    (startedAt) => runCaptureInInvocation(program, opts, startedAt),
  );
}

async function runCaptureInInvocation(
  program: Command,
  opts: Record<string, unknown>,
  startedAt: number,
): Promise<void> {
  const app = typeof opts.app === "string" ? opts.app : undefined;
  const windowId =
    typeof opts.windowId === "string" && opts.windowId.trim()
      ? opts.windowId.trim()
      : undefined;
  const snapshotFormat = readSnapshotFormat(program, opts.format, "capture");
  if (!snapshotFormat.ok) {
    print(
      program,
      "compute.capture",
      startedAt,
      invalidOptionResult(
        "compute_capture",
        `invalid snapshot format: ${snapshotFormat.value}`,
        "use --format compact, tree, or json",
        "compute.capture",
      ),
    );
    return;
  }
  const maxDepth = readIntegerOption(opts.maxDepth, 64, 0, 64);
  if (maxDepth === undefined) {
    printInvalidIntegerOption(
      program,
      "compute.capture",
      "compute_capture",
      "max-depth",
      0,
      64,
    );
    return;
  }
  const screenshotPath =
    typeof opts.screenshotPath === "string" && opts.screenshotPath
      ? opts.screenshotPath
      : undefined;
  const permissionArguments = {
    ...opts,
    format: snapshotFormat.value,
    maxDepth,
    ...(screenshotPath ? { screenshotPath } : {}),
  };
  const signal = currentBrowserInvocationScope()?.signal;
  signal?.throwIfAborted();
  const authorization = await authorizeComputeOperation(
    "capture",
    permissionArguments,
    readComputePermissionOptions(program),
  );
  if (!authorization.ok) {
    print(program, "compute.capture", startedAt, authorization.result);
    return;
  }
  signal?.throwIfAborted();
  const bus = getBus();
  const execution = await executeWithComputeCleanup(
    bus,
    undefined,
    async () => {
      loadPersistedRefs(bus);
      const result = await captureComputeContext(
        bus,
        {
          ...(app ? { app } : {}),
          ...(windowId ? { windowId } : {}),
          ...(typeof opts.include === "string"
            ? { include: opts.include }
            : {}),
          format: snapshotFormat.value,
          maxDepth,
          ...(screenshotPath ? { screenshotPath } : {}),
          ...(typeof opts.via === "string"
            ? {
                via: opts.via as
                  | "native"
                  | "browser"
                  | "process"
                  | "driver"
                  | "visual",
              }
            : {}),
        },
        {
          onSnapshotSuccess: () => saveRefStore(bus.refs),
          ...(signal ? { signal } : {}),
        },
      );
      const shouldSaveReference =
        opts.saveReference === true || opts.copyReference === true;
      if (!result.ok || !shouldSaveReference) return result;

      const referenceRoot =
        typeof opts.referenceRoot === "string" && opts.referenceRoot
          ? opts.referenceRoot
          : undefined;
      const reference = await saveComputeCaptureReference(result.data, {
        ...(referenceRoot ? { rootDir: referenceRoot } : {}),
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      if (opts.copyReference === true) {
        try {
          await copyReferenceMarkupToClipboard(
            reference.markup,
            signal ? { signal } : {},
          );
        } catch (error) {
          signal?.throwIfAborted();
          return err({
            transport: "subprocess",
            step: 0,
            action: "compute_capture.copy_reference",
            reason: errorMessage(error),
            suggestion:
              "inspect the clipboard command or rerun with --save-reference",
            minimum_capability: "compute.capture.copy-reference",
            exit_code: exitCodeFor("service_unavailable"),
          });
        }
      }
      return {
        ...result,
        data: {
          ...result.data,
          reference: {
            ...reference,
            ...(opts.copyReference === true ? { clipboard: { ok: true } } : {}),
          },
        },
      };
    },
  );
  print(
    program,
    "compute.capture",
    startedAt,
    withCleanupFailures(
      "compute.capture",
      execution.result,
      execution.cleanupFailures,
    ),
  );
}

async function runWithComputeExceptionBoundary(
  program: Command,
  command: string,
  operation: (startedAt: number) => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    await runComputeInvocation(() => operation(startedAt));
  } catch (error) {
    print(program, command, startedAt, computeExceptionResult(command, error));
  }
}

async function runComputeInvocation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (currentBrowserInvocationScope()) return operation();
  const context = createBrowserInvocationContext({ transport: "cli" });
  const scope = createBrowserInvocationScope({ context });
  return runBrowserInvocation(scope, operation);
}

function loadPersistedRefs(bus: ReturnType<typeof getBus>): void {
  const loaded = loadRefStore();
  bus.refs.clear();
  for (const bucket of loaded.buckets()) {
    bus.refs.restore(bucket);
  }
}

function enrichWithPersistedCdpSession(
  kind: string,
  params: Record<string, unknown>,
  bus: ReturnType<typeof getBus>,
): Record<string, unknown> {
  if (!CDP_SESSION_STEPS.has(kind)) return params;
  if (typeof params.port === "number") return params;
  const ref = typeof params.ref === "string" ? params.ref : undefined;
  if (ref) {
    const matches = bus.refs.matches(ref);
    const match = matches.length === 1 ? matches[0] : undefined;
    const stable = match?.ref.stable ?? ref;
    if (!stable || transportForComputeRef(stable) !== "cdp-browser") {
      return params;
    }
    if (match?.ref.cdpEndpoint) {
      return { ...params, ...match.ref.cdpEndpoint };
    }
  }
  const session = loadCdpSession();
  if (!session) return params;
  const requestedApp =
    typeof params.app === "string" && params.app.trim()
      ? params.app.trim()
      : undefined;
  if (
    requestedApp &&
    (!session.app ||
      normalizeAppIdentity(requestedApp) !== normalizeAppIdentity(session.app))
  ) {
    return params;
  }
  return {
    ...params,
    ...(!requestedApp && session.app ? { app: session.app } : {}),
    port: session.port,
    ...(typeof params.targetId === "string" &&
    params.targetId !== session.targetId
      ? {}
      : { webSocketDebuggerUrl: session.webSocketDebuggerUrl }),
    ...(typeof params.targetId === "string"
      ? { targetId: params.targetId }
      : session.targetId
        ? { targetId: session.targetId }
        : {}),
  };
}

function normalizeAppIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function persistCdpAttach(data: unknown): void {
  if (!isRecord(data)) return;
  const port = data.port;
  const webSocketDebuggerUrl = data.webSocketDebuggerUrl;
  const targetId = data.targetId;
  const app = data.app;
  if (
    typeof port !== "number" ||
    !Number.isFinite(port) ||
    typeof webSocketDebuggerUrl !== "string" ||
    !webSocketDebuggerUrl
  ) {
    return;
  }
  saveCdpSession({
    port,
    webSocketDebuggerUrl,
    ...(typeof targetId === "string" && targetId ? { targetId } : {}),
    ...(typeof app === "string" && app ? { app } : {}),
  });
}

interface ComputeCleanupFailure {
  resource: string;
  error: unknown;
}

async function executeWithComputeCleanup<T>(
  bus: ReturnType<typeof getBus>,
  overlayProvider: { close?: () => Promise<void> } | undefined,
  operation: () => Promise<T>,
): Promise<{ result: T; cleanupFailures: ComputeCleanupFailure[] }> {
  let operationFailed = false;
  let operationResult: T | undefined;
  let operationError: unknown;
  try {
    operationResult = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupFailures = await closeComputeResources(bus, overlayProvider);
  if (operationFailed && cleanupFailures.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupFailures.map((failure) => failure.error)],
      "Compute operation and resource cleanup both failed",
    );
  }
  if (operationFailed) throw operationError;
  return { result: operationResult as T, cleanupFailures };
}

async function closeComputeResources(
  bus: ReturnType<typeof getBus>,
  overlayProvider: { close?: () => Promise<void> } | undefined,
): Promise<ComputeCleanupFailure[]> {
  const resources = [
    ...(overlayProvider?.close
      ? [{ resource: "overlay", close: () => overlayProvider.close?.() }]
      : []),
    ...bus.list().map((adapter) => ({
      resource: adapter.kind,
      close: () => adapter.close(),
    })),
  ];
  const outcomes = await Promise.allSettled(
    resources.map((resource) => Promise.resolve().then(resource.close)),
  );
  return outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [{ resource: resources[index]!.resource, error: outcome.reason }]
      : [],
  );
}

function withCleanupFailures<T>(
  command: string,
  result: ActionResult<T>,
  failures: ComputeCleanupFailure[],
): ActionResult<T> {
  if (failures.length === 0) return result;
  const summary = failures
    .map(
      (failure) =>
        `${failure.resource}: ${boundedErrorMessage(failure.error, 240)}`,
    )
    .join("; ");
  if (!result.ok) {
    return {
      ...result,
      error: {
        ...result.error,
        reason: `${result.error.reason}; cleanup also failed: ${summary}`,
        suggestion: `${result.error.suggestion}; inspect the failing compute resource cleanup`,
      },
    };
  }
  return err({
    transport: "subprocess",
    adapter_path: "src/commands/compute.ts",
    step: 0,
    action: `${command}.cleanup`,
    reason: `compute resource cleanup failed: ${summary}`,
    suggestion:
      "run unicli doctor compute, repair the failing transport, and retry",
    minimum_capability: "compute.cleanup.service_unavailable",
    exit_code: exitCodeFor("service_unavailable"),
  });
}

function computeExceptionResult(
  command: string,
  error: unknown,
): ActionResult<never> {
  const typed = findTypedComputeError(error);
  const outcomeAmbiguous = hasBooleanErrorField(error, "outcome_ambiguous");
  return err({
    transport: "subprocess",
    adapter_path: typed?.adapter_path ?? "src/commands/compute.ts",
    step: 0,
    action: command,
    reason: boundedErrorMessage(error, 800),
    suggestion:
      typed?.suggestion ??
      (outcomeAmbiguous
        ? "inspect the target state before deciding whether to retry"
        : "run `unicli doctor compute --json`, repair the reported boundary, and retry"),
    minimum_capability:
      typed?.minimum_capability ??
      (outcomeAmbiguous
        ? "compute.outcome_ambiguous"
        : "compute.internal_error"),
    retryable: typed?.retryable ?? !outcomeAmbiguous,
    exit_code:
      typed?.exit_code ??
      exitCodeFor(outcomeAmbiguous ? "temp_failure" : "service_unavailable"),
  });
}

interface TypedComputeError {
  adapter_path?: string;
  suggestion?: string;
  minimum_capability?: string;
  retryable?: boolean;
  exit_code?: number;
}

function findTypedComputeError(error: unknown): TypedComputeError | undefined {
  if (!isRecord(error)) return undefined;
  const current: TypedComputeError = {
    ...(typeof error.suggestion === "string"
      ? { suggestion: error.suggestion }
      : {}),
    ...(typeof error.minimum_capability === "string"
      ? { minimum_capability: error.minimum_capability }
      : {}),
    ...(typeof error.adapter_path === "string"
      ? { adapter_path: error.adapter_path }
      : {}),
    ...(typeof error.retryable === "boolean"
      ? { retryable: error.retryable }
      : {}),
    ...(typeof error.exit_code === "number" &&
    Number.isSafeInteger(error.exit_code)
      ? { exit_code: error.exit_code }
      : {}),
  };
  if (Object.keys(current).length > 0) return current;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findTypedComputeError(nested);
      if (found) return found;
    }
  }
  return findTypedComputeError(error.cause);
}

function hasBooleanErrorField(error: unknown, field: string): boolean {
  if (!isRecord(error)) return false;
  if (error[field] === true) return true;
  if (
    error instanceof AggregateError &&
    error.errors.some((nested) => hasBooleanErrorField(nested, field))
  ) {
    return true;
  }
  return hasBooleanErrorField(error.cause, field);
}

const CDP_SESSION_STEPS = new Set([
  "compute_evaluate",
  "compute_snapshot",
  "compute_screenshot",
  "compute_click",
  "compute_type",
  "compute_press",
  "compute_scroll",
  "compute_wait",
]);

function print(
  program: Command,
  command: string,
  startedAt: number,
  result: ActionResult<unknown>,
): void {
  const fmt = detectFormat(readRootFormat(program));
  if (result.ok) {
    console.log(
      format(formatData(result.data), undefined, fmt, {
        ...makeCtx(command, startedAt, { surface: "desktop" }),
        effect_verdict: result.effect_verdict,
        recovery_trace: result.recovery_trace,
      }),
    );
    return;
  }

  process.exitCode = result.error.exit_code;
  console.error(
    format(null, undefined, fmt, {
      ...makeCtx(command, startedAt, { surface: "desktop" }),
      effect_verdict: result.effect_verdict,
      recovery_trace: result.recovery_trace,
      error: {
        code: computeEnvelopeErrorCode(result.error.minimum_capability),
        message: result.error.reason,
        adapter_path:
          result.error.adapter_path ??
          computeTransportImplementationPath(result.error.transport),
        step: result.error.step,
        suggestion: result.error.suggestion,
        remedy: result.error.remedy,
        minimum_capability: result.error.minimum_capability,
        exit_code: result.error.exit_code,
        retryable: result.error.retryable,
      },
    }),
  );
}

function computeTransportImplementationPath(transport: string): string {
  switch (transport) {
    case "cua-driver":
      return "src/transport/adapters/cua-driver.ts";
    case "visual":
      return "src/transport/adapters/visual.ts";
    case "cdp-browser":
      return "src/transport/adapters/cdp-browser.ts";
    case "desktop-ax":
      return "src/transport/adapters/desktop-ax.ts";
    case "desktop-uia":
      return "src/transport/adapters/desktop-uia.ts";
    case "desktop-atspi":
      return "src/transport/adapters/desktop-atspi.ts";
    case "http":
      return "src/transport/adapters/http.ts";
    case "subprocess":
      return "src/transport/adapters/subprocess.ts";
    default:
      return "src/transport/compute-dispatch.ts";
  }
}

function formatData(data: unknown): unknown[] | Record<string, unknown> {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return data as Record<string, unknown>;
  return { value: data };
}

function parseComputeRouteParams(
  raw: string,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false, reason: "--params must decode to a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      reason: `invalid --params JSON: ${errorMessage(error)}`,
    };
  }
}

function resultWithVisualEvidence(
  execution: ComputeActionExecution,
): ActionResult<unknown> {
  if (!execution.result.ok) return execution.result;
  return {
    ...execution.result,
    data: {
      ...formatData(execution.result.data),
      visual_timeline: execution.evidence.visual_timeline,
      visual_action: execution.evidence.visual_action,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedErrorMessage(error: unknown, maximum: number): string {
  const normalized = errorMessage(error).replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1)}…`;
}

function invalidOptionResult(
  action: string,
  reason: string,
  suggestion: string,
  minimumCapability: string,
): ActionResult<never> {
  return err({
    transport: "subprocess",
    adapter_path: "src/commands/compute.ts",
    step: 0,
    action,
    reason,
    suggestion,
    minimum_capability: minimumCapability,
    exit_code: exitCodeFor("usage_error"),
  });
}

function readIntegerOption(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number | undefined {
  const text = String(value ?? fallback);
  if (!/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

function readOptionalIntegerOption(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined | null {
  if (value === undefined) return undefined;
  return readIntegerOption(value, minimum, minimum, maximum) ?? null;
}

function readFiniteNumber(value: unknown): number | undefined {
  const text = String(value);
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readNullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null || value === "null" || value === "reset") return null;
  return readFiniteNumber(value);
}

function readBooleanValue(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function printInvalidCoordinate(
  program: Command,
  command: "point-click" | "drag" | "point-scroll" | "move-cursor",
): void {
  print(
    program,
    `compute.${command}`,
    Date.now(),
    invalidOptionResult(
      `compute_${command.replace("-", "_")}`,
      "every coordinate must be a finite number",
      "pass coordinates read directly from fresh provider-owned desktop pixels",
      `compute.${command}.invalid_input`,
    ),
  );
}

function printInvalidIntegerOption(
  program: Command,
  command: string,
  action: string,
  option: string,
  minimum: number,
  maximum: number,
): void {
  print(
    program,
    command,
    Date.now(),
    invalidOptionResult(
      action,
      `${option} must be an integer from ${String(minimum)} to ${String(maximum)}`,
      `pass --${option} <n> from ${String(minimum)} to ${String(maximum)}`,
      `compute.${action}.invalid_input`,
    ),
  );
}

function computeEnvelopeErrorCode(
  minimumCapability: string | undefined,
): string {
  if (minimumCapability === "permission.denied") return "permission_denied";
  if (minimumCapability === "permission.config") return "invalid_input";
  const reasonCode = minimumCapability?.split(".").at(-1);
  if (reasonCode === "invalid_input") return "invalid_input";
  if (reasonCode === "service_unavailable") return "service_unavailable";
  if (reasonCode === "timeout") return "timeout";
  if (
    reasonCode === "target_not_found" ||
    reasonCode === "target_window_not_found" ||
    reasonCode === "no_element"
  ) {
    return "not_found";
  }
  if (
    reasonCode === "target_ambiguous" ||
    reasonCode === "target_window_ambiguous"
  ) {
    return "target_ambiguous";
  }
  if (reasonCode === "state_corrupt") return "state_corrupt";
  if (reasonCode === "stale_ref") return "ref_expired";
  if (reasonCode === "outcome_ambiguous") return "outcome_ambiguous";
  if (reasonCode === "internal_error") return "internal_error";
  if (
    reasonCode === "foreign_ref" ||
    reasonCode === "unresolvable_ref" ||
    reasonCode === "ref_expired"
  ) {
    return reasonCode;
  }
  return "compute_failed";
}

function readComputePermissionOptions(program: Command): {
  profile?: string;
  approved?: boolean;
  rememberApproval?: boolean;
} {
  const opts = program.opts() as {
    permissionProfile?: string;
    yes?: boolean;
    rememberApproval?: boolean;
  };
  return {
    profile: opts.permissionProfile,
    approved: opts.yes === true,
    rememberApproval: opts.rememberApproval === true,
  };
}

function normalizeFocusOptions(
  opts: Record<string, unknown>,
): Record<string, unknown> {
  const { focus, overlay: _overlay, ...rest } = opts;
  return { ...rest, focus: focus === true };
}

function readRootFormat(program: Command): OutputFormat | undefined {
  const args =
    (program as Command & { rawArgs?: readonly string[] }).rawArgs ?? [];
  const commandIndex = args.indexOf("compute");
  const end = commandIndex >= 0 ? commandIndex : args.length;
  for (let i = 0; i < end; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue;
    if (arg === "-f" || arg === "--format") {
      const value = args[i + 1];
      return isOutputFormat(value) ? value : undefined;
    }
    if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      return isOutputFormat(value) ? value : undefined;
    }
  }
  return undefined;
}

function readSnapshotFormat(
  program: Command,
  fallback: unknown,
  subcommand: "snapshot" | "capture",
):
  | { ok: true; value: "compact" | "tree" | "json" }
  | { ok: false; value: string } {
  const args =
    (program as Command & { rawArgs?: readonly string[] }).rawArgs ?? [];
  const subcommandIndex = args.indexOf(subcommand);
  if (subcommandIndex >= 0) {
    for (let i = subcommandIndex + 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--format") {
        const value = args[i + 1];
        return isSnapshotFormat(value)
          ? { ok: true, value }
          : { ok: false, value: String(value ?? "") };
      }
      if (arg.startsWith("--format=")) {
        const value = arg.slice("--format=".length);
        return isSnapshotFormat(value)
          ? { ok: true, value }
          : { ok: false, value };
      }
    }
  }
  if (fallback === undefined) return { ok: true, value: "compact" };
  return isSnapshotFormat(fallback)
    ? { ok: true, value: fallback }
    : { ok: false, value: String(fallback) };
}

function isSnapshotFormat(
  value: unknown,
): value is "compact" | "tree" | "json" {
  return value === "compact" || value === "tree" || value === "json";
}

function isOutputFormat(value: string | undefined): value is OutputFormat {
  return (
    value === "md" ||
    value === "json" ||
    value === "yaml" ||
    value === "csv" ||
    value === "compact" ||
    value === "table"
  );
}
