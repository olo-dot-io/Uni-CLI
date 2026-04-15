/**
 * Fresh-project style verification — attempts to import every public
 * subpath via the src/ tree (no dist resolution). Fast feedback for
 * local development; the dist-backed gate lives in
 * tests/unit/exports.test.ts.
 */

import {
  registerStep,
  getStep,
  listSteps,
} from "../src/engine/step-registry.js";
import {
  runPipeline,
  PipelineError,
  assertSafeRequestUrl,
} from "../src/engine/executor.js";
import {
  createTransportBus,
  getBus,
  buildTransportCtx,
} from "../src/transport/bus.js";
import { HttpTransport } from "../src/transport/adapters/http.js";
import { err, ok, EnvelopeExit, exitCodeFor } from "../src/core/envelope.js";
import * as cdpBrowser from "../src/transport/adapters/cdp-browser.js";
import * as subprocess from "../src/transport/adapters/subprocess.js";
import * as desktopAx from "../src/transport/adapters/desktop-ax.js";
import * as cua from "../src/transport/adapters/cua.js";
import * as cdpClient from "../src/browser/cdp-client.js";
import * as browserPage from "../src/browser/page.js";
import * as daemon from "../src/browser/daemon-client.js";
import * as domHelpers from "../src/browser/dom-helpers.js";
import * as mcpSchema from "../src/mcp/schema.js";
import * as acp from "../src/protocol/acp.js";
import * as skill from "../src/protocol/skill.js";
import * as download from "../src/engine/download.js";
import * as formatter from "../src/output/formatter.js";
import * as registryV1 from "../src/registry.js";
import * as registryV2 from "../src/core/registry.js";
import * as errors from "../src/errors.js";
import type { PipelineStep } from "../src/types.js";

const symbols: Array<[string, unknown]> = [
  ["registerStep", registerStep],
  ["getStep", getStep],
  ["listSteps", listSteps],
  ["runPipeline", runPipeline],
  ["PipelineError", PipelineError],
  ["assertSafeRequestUrl", assertSafeRequestUrl],
  ["createTransportBus", createTransportBus],
  ["getBus", getBus],
  ["buildTransportCtx", buildTransportCtx],
  ["err", err],
  ["ok", ok],
  ["EnvelopeExit", EnvelopeExit],
  ["exitCodeFor", exitCodeFor],
  ["HttpTransport", HttpTransport],
  ["cdpBrowser", cdpBrowser],
  ["subprocess", subprocess],
  ["desktopAx", desktopAx],
  ["cua", cua],
  ["cdpClient", cdpClient],
  ["browserPage", browserPage],
  ["daemon", daemon],
  ["domHelpers", domHelpers],
  ["mcpSchema", mcpSchema],
  ["acp", acp],
  ["skill", skill],
  ["download", download],
  ["formatter", formatter],
  ["registryV1", registryV1],
  ["registryV2", registryV2],
  ["errors", errors],
];

let failures = 0;
for (const [name, value] of symbols) {
  if (value === undefined || value === null) {
    console.error(`  FAIL  ${name} resolved to ${String(value)}`);
    failures++;
  }
}

// Reference the unused type import so TS stays happy without emitting
// a warning in --noUnusedLocals builds.
const _step: PipelineStep | null = null;
void _step;

if (failures > 0) {
  console.error(`\nverify-exports: ${failures} failure(s)`);
  process.exit(1);
}

console.log(
  `verify-exports: OK — ${symbols.length} symbols resolved across 24 subpaths`,
);
