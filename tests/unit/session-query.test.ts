import { describe, expect, it } from "vitest";

import {
  createRunEventSequence,
  createRunStartedEvent,
  createRuntimePermissionDeniedEvent,
  type RunTraceMetadata,
} from "../../src/engine/session/events.js";
import { summarizeRunEvents } from "../../src/engine/session/query.js";

const metadata: RunTraceMetadata = {
  run_id: "run-query-01",
  trace_id: "01HXTRACEQUERY00000000000",
  command: "demo.fetch",
  site: "demo",
  cmd: "fetch",
  adapter_path: "src/adapters/demo/fetch.yaml",
  permission_profile: "locked",
  transport_surface: "cli",
  target_surface: "web",
  args_hash: "sha256:query",
  pipeline_steps: 1,
};

describe("session run summaries", () => {
  it("omits runtime permission deny summaries with no public fields", () => {
    const sequence = createRunEventSequence();
    const events = [
      createRunStartedEvent(metadata, sequence),
      createRuntimePermissionDeniedEvent(
        metadata,
        sequence,
        {
          adapter_path: metadata.adapter_path,
        },
        {
          resources: {
            urls: ["https://blocked.example/secret?token=hidden"],
          },
        },
      ),
    ];

    const summary = summarizeRunEvents(events);

    expect(summary).not.toHaveProperty("runtime_permission_denied");
    expect(JSON.stringify(summary)).not.toContain("blocked.example");
  });
});
