import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ChromeBrowserProvider } from "../../src/browser/chrome-provider.js";
import { BrowserRuntimeBroker } from "../../src/browser/runtime-broker.js";
import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_PRODUCT,
  CHROME_NATIVE_PROTOCOL,
  CHROME_NATIVE_PROTOCOL_VERSION,
  chromeTargetId,
  type ChromeNativeHello,
  type ChromeNativeResult,
  type ChromeNativeTarget,
} from "../../src/browser/chrome-native-protocol.js";

const BROWSER_SESSION_ID = "018f4f68-6f5b-7b01-8c02-123456789abc";

describe("ChromeBrowserProvider", () => {
  it("holds cold Chrome work until a parked native host registers", async () => {
    const provider = new ChromeBrowserProvider({ hostWaitTimeoutMs: 250 });
    const hostId = randomUUID();
    const listing = provider.listTabs();
    expect(provider.status().connected).toBe(false);

    provider.registerHost(hostId, hello());
    const command = await provider.poll(hostId);
    expect(command).toMatchObject({ action: "tabs.list" });
    provider.deliver(hostId, success(command!.request_id, []));

    await expect(listing).resolves.toEqual([]);
    provider.close();
  });

  it("dispatches bounded provider-wide content search without allocating a target", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const searching = provider.searchContent({
      query: "release notes",
      include_history: true,
      max_results: 2,
      max_tabs: 3,
      max_chars_per_tab: 4_096,
    });

    const command = await provider.poll(hostId);
    expect(command).toMatchObject({
      action: "content.search",
      search: {
        query: "release notes",
        include_history: true,
        max_results: 2,
        max_tabs: 3,
        max_chars_per_tab: 4_096,
      },
    });
    provider.deliver(
      hostId,
      success(command!.request_id, {
        query: "release notes",
        result_count: 1,
        eligible_open_tabs: 1,
        scanned_open_tabs: 1,
        matched_open_tabs: 1,
        failed_open_tabs: 0,
        scanned_history_items: 2,
        matched_history_items: 1,
        ui_state_unchanged: true,
        truncated: false,
        limits: {
          max_results: 2,
          max_tabs: 3,
          max_chars_per_tab: 4_096,
          tab_concurrency: 4,
          max_frames_per_tab: 32,
        },
        results: [
          {
            sources: ["open_tab", "history"],
            url: "https://example.com/releases",
            title: "Release notes",
            score: 12,
            match_fields: ["title", "content"],
            snippets: ["Latest release notes"],
            tab_id: 41,
            window_id: 7,
            active: false,
            last_visit_time: 123,
            visit_count: 2,
          },
        ],
        failures: [],
      }),
    );

    await expect(searching).resolves.toMatchObject({
      query: "release notes",
      result_count: 1,
      ui_state_unchanged: true,
    });
    expect(provider.status().target_count).toBe(0);
    provider.close();
  });

  it("rejects malformed content-search output instead of trusting the extension", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const searching = provider.searchContent({ query: "bounded" });
    const command = await provider.poll(hostId);
    provider.deliver(
      hostId,
      success(command!.request_id, {
        query: "bounded",
        result_count: 101,
        results: [],
      }),
    );

    await expect(searching).rejects.toMatchObject({
      code: "chrome_provider_protocol_invalid",
    });
    provider.close();
  });

  it("cancels cold Chrome work without admitting a later command", async () => {
    const provider = new ChromeBrowserProvider({ hostWaitTimeoutMs: 250 });
    const controller = new AbortController();
    const cancellation = new Error("cancel cold Chrome wait");
    const acquiring = provider.acquireTarget("background", controller.signal);
    controller.abort(cancellation);

    await expect(acquiring).rejects.toMatchObject({ cause: cancellation });
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    expect(provider.status().queued_commands).toBe(0);
    provider.close();
  });

  it("delivers a host-only shutdown sentinel without forwarding browser work", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const shuttingDown = provider.shutdownHost();
    const command = await provider.poll(hostId);
    expect(command).toMatchObject({ action: "host.shutdown" });
    provider.deliver(hostId, success(command!.request_id));

    await expect(shuttingDown).resolves.toBe(true);
    provider.close();
  });

  it("correlates allocation, page mutation, and owned-target close through one registered host", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());

    const acquiring = provider.acquireTarget("background");
    const allocate = await provider.poll(hostId);
    expect(allocate).toMatchObject({
      action: "target.allocate",
      visibility: "background",
    });
    provider.deliver(
      hostId,
      success(allocate!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 42),
        tab_id: 42,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    const target = await acquiring;

    const reading = provider.execute(target.target_id, "background", {
      method: "title",
    });
    const read = await provider.poll(hostId);
    expect(read).toMatchObject({
      action: "page.command",
      target_id: target.target_id,
      tab_id: 42,
      command: { method: "title" },
    });
    provider.deliver(hostId, success(read!.request_id, "Example"));
    await expect(reading).resolves.toBe("Example");

    const releasing = provider.releaseTarget(target.target_id);
    const finalize = await provider.poll(hostId);
    expect(finalize).toMatchObject({
      action: "target.finalize",
      disposition: "close",
    });
    provider.deliver(hostId, success(finalize!.request_id));
    await releasing;
    expect(provider.status()).toMatchObject({
      connected: true,
      target_count: 0,
      queued_commands: 0,
      in_flight_commands: 0,
    });
    provider.close();
  });

  it("releases a claimed user tab without closing it", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const claiming = provider.claimTarget(81, "background");
    const claim = await provider.poll(hostId);
    provider.deliver(
      hostId,
      success(claim!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 81),
        tab_id: 81,
        window_id: 9,
        owned: false,
        visibility: "background",
      }),
    );
    const target = await claiming;

    const releasing = provider.releaseTarget(target.target_id);
    const finalize = await provider.poll(hostId);
    expect(finalize).toMatchObject({
      action: "target.finalize",
      disposition: "release",
    });
    provider.deliver(hostId, success(finalize!.request_id));
    await releasing;
    provider.close();
  });

  it("preserves exact extension refusal envelopes", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const acquiring = provider.acquireTarget("background");
    const command = await provider.poll(hostId);
    provider.deliver(hostId, {
      type: "result",
      request_id: command!.request_id,
      ok: false,
      error: {
        code: "background_unavailable",
        message: "Chrome has no existing normal window",
        suggestion: "Open Chrome explicitly or use the hidden provider.",
        retryable: false,
      },
    });

    await expect(acquiring).rejects.toMatchObject({
      code: "background_unavailable",
      message: "Chrome has no existing normal window",
      retryable: false,
    });
    provider.close();
  });

  it("preserves an extension-declared ambiguous mutation outcome", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const acquiring = provider.acquireTarget("background");
    const allocation = await provider.poll(hostId);
    provider.deliver(
      hostId,
      success(allocation!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 44),
        tab_id: 44,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    const target = await acquiring;
    const executing = provider.execute(target.target_id, "background", {
      method: "evaluate",
      expression: "window.submit()",
    });
    const command = await provider.poll(hostId);
    provider.deliver(hostId, {
      type: "result",
      request_id: command!.request_id,
      ok: false,
      error: {
        code: "chrome_command_failed",
        message: "Debugger detached after dispatch",
        suggestion: "Inspect the page before continuing.",
        retryable: false,
        outcome_ambiguous: true,
      },
    });

    await expect(executing).rejects.toMatchObject({
      code: "chrome_command_failed",
      outcome_ambiguous: true,
      retryable: false,
    });
    provider.close();
  });

  it("rejects competing live hosts and all in-flight work on disconnect", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    expect(() =>
      provider.registerHost(
        randomUUID(),
        hello("018f4f68-6f5b-7b01-8c02-abcdefabcdef"),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "chrome_provider_conflict" }),
    );
    const acquiring = provider.acquireTarget("background");
    const rejected = expect(acquiring).rejects.toMatchObject({
      code: "chrome_provider_disconnected",
    });
    await provider.poll(hostId);
    provider.disconnectHost(hostId);
    await rejected;
    expect(provider.status().connected).toBe(false);
    provider.close();
  });

  it("lets a same-browser native host reconnect supersede a lost in-flight host", async () => {
    const provider = new ChromeBrowserProvider();
    const oldHostId = randomUUID();
    const newHostId = randomUUID();
    provider.registerHost(oldHostId, hello());
    const acquiring = provider.acquireTarget("background");
    const rejected = expect(acquiring).rejects.toMatchObject({
      code: "chrome_provider_disconnected",
    });
    await provider.poll(oldHostId);
    provider.registerHost(newHostId, hello());
    await rejected;
    expect(provider.status()).toMatchObject({
      connected: true,
      host_instance_id: newHostId,
      in_flight_commands: 0,
    });
    provider.close();
  });

  it("expires a host that stops polling and permits a clean replacement", () => {
    let now = 100;
    const provider = new ChromeBrowserProvider({
      now: () => now,
      hostTtlMs: 10,
    });
    provider.registerHost(randomUUID(), hello());
    now = 111;
    expect(provider.status().connected).toBe(false);
    expect(() => provider.registerHost(randomUUID(), hello())).not.toThrow();
    provider.close();
  });

  it("uses native-host heartbeats rather than in-flight work as liveness evidence", async () => {
    let now = 100;
    const provider = new ChromeBrowserProvider({
      now: () => now,
      hostTtlMs: 10,
    });
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const acquiring = provider.acquireTarget("background");
    const command = await provider.poll(hostId);
    now = 105;
    provider.heartbeat(hostId);
    now = 110;
    expect(provider.status().connected).toBe(true);
    provider.deliver(
      hostId,
      success(command!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 91),
        tab_id: 91,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    await acquiring;
    now = 121;
    expect(provider.status().connected).toBe(false);
    provider.close();
  });

  it("removes a canceled queued allocation before the native host can poll it", async () => {
    const provider = new ChromeBrowserProvider({ pollTimeoutMs: 5 });
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const first = provider.acquireTarget("background");
    const firstCommand = await provider.poll(hostId);
    const controller = new AbortController();
    const cancellation = new Error("cancel queued Chrome allocation");
    const queued = provider.acquireTarget("background", controller.signal);

    controller.abort(cancellation);

    await expect(queued).rejects.toMatchObject({ cause: cancellation });
    expect(provider.status().queued_commands).toBe(0);
    provider.deliver(
      hostId,
      success(firstCommand!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 96),
        tab_id: 96,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    const target = await first;
    await expect(provider.poll(hostId)).resolves.toBeNull();
    const releasing = provider.releaseTarget(target.target_id);
    const finalize = await provider.poll(hostId);
    provider.deliver(hostId, success(finalize!.request_id));
    await releasing;
    provider.close();
  });

  it("closes a late owned allocation after its dispatched consumer is canceled", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const controller = new AbortController();
    const cancellation = new Error("cancel dispatched Chrome allocation");
    const acquiring = provider.acquireTarget("background", controller.signal);
    const allocation = await provider.poll(hostId);

    controller.abort(cancellation);
    await expect(acquiring).rejects.toMatchObject({ cause: cancellation });
    provider.deliver(
      hostId,
      success(allocation!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 97),
        tab_id: 97,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );

    const compensation = await provider.poll(hostId);
    expect(compensation).toMatchObject({
      action: "target.finalize",
      tab_id: 97,
      disposition: "close",
    });
    provider.deliver(hostId, success(compensation!.request_id));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(provider.status()).toMatchObject({
      connected: true,
      target_count: 0,
      reconciling_target_count: 0,
      in_flight_commands: 0,
    });
    provider.close();
  });

  it("releases a late claimed tab after its dispatched consumer is canceled", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const controller = new AbortController();
    const cancellation = new Error("cancel dispatched Chrome claim");
    const claiming = provider.claimTarget(98, "background", controller.signal);
    const claim = await provider.poll(hostId);

    controller.abort(cancellation);
    await expect(claiming).rejects.toMatchObject({ cause: cancellation });
    provider.deliver(
      hostId,
      success(claim!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 98),
        tab_id: 98,
        window_id: 7,
        owned: false,
        visibility: "background",
      }),
    );

    const compensation = await provider.poll(hostId);
    expect(compensation).toMatchObject({
      action: "target.finalize",
      tab_id: 98,
      disposition: "release",
    });
    provider.deliver(hostId, success(compensation!.request_id));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(provider.status()).toMatchObject({
      connected: true,
      target_count: 0,
      reconciling_target_count: 0,
      in_flight_commands: 0,
    });
    provider.close();
  });

  it("retires a timed-out host generation and reconciles its late allocation from the replacement hello", async () => {
    const provider = new ChromeBrowserProvider({ commandTimeoutMs: 5 });
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const acquiring = provider.acquireTarget("background");
    const allocation = await provider.poll(hostId);

    await expect(acquiring).rejects.toMatchObject({
      code: "chrome_provider_timeout",
      outcome_ambiguous: true,
    });
    expect(provider.status()).toMatchObject({
      connected: false,
      in_flight_commands: 0,
    });
    expect(() =>
      provider.deliver(
        hostId,
        success(allocation!.request_id, {
          target_id: chromeTargetId(BROWSER_SESSION_ID, 99),
          tab_id: 99,
          window_id: 7,
          owned: true,
          visibility: "background",
        }),
      ),
    ).toThrow(/not registered/);

    const replacementHostId = randomUUID();
    provider.registerHost(
      replacementHostId,
      hello(BROWSER_SESSION_ID, [
        {
          target_id: chromeTargetId(BROWSER_SESSION_ID, 99),
          tab_id: 99,
          window_id: 7,
          owned: true,
          visibility: "background",
        },
      ]),
    );
    const compensation = await provider.poll(replacementHostId);
    expect(compensation).toMatchObject({
      action: "target.finalize",
      tab_id: 99,
      disposition: "close",
    });
    provider.deliver(replacementHostId, success(compensation!.request_id));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(provider.status()).toMatchObject({
      connected: true,
      target_count: 0,
      in_flight_commands: 0,
    });
    provider.close();
  });

  it("invalidates a timed-out Chrome mutation and reconciles only through a replacement host inventory", async () => {
    const provider = new ChromeBrowserProvider({ commandTimeoutMs: 5 });
    const broker = new BrowserRuntimeBroker({ chromeProvider: provider });
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const context = {
      agent_session_id: "ambiguous-timeout-agent",
      turn_id: "ambiguous-timeout-turn",
      transport: "cli" as const,
    };
    try {
      await expectBrokerOk(broker, {
        id: randomUUID(),
        action: "session.start",
        context,
      });
      const acquiring = broker.dispatch({
        id: randomUUID(),
        action: "target.command",
        context,
        provider: "chrome",
        visibility: "background",
        profile_partition_id: "ambiguous-timeout-profile",
        command: { method: "title" },
      });
      const allocation = await provider.poll(hostId);
      const firstTargetId = chromeTargetId(BROWSER_SESSION_ID, 45);
      provider.deliver(
        hostId,
        success(allocation!.request_id, {
          target_id: firstTargetId,
          tab_id: 45,
          window_id: 7,
          owned: true,
          visibility: "background",
        }),
      );
      const initialRead = await provider.poll(hostId);
      provider.deliver(hostId, success(initialRead!.request_id, "Initial"));
      await expect(acquiring).resolves.toMatchObject({ ok: true });

      const mutating = broker.dispatch({
        id: randomUUID(),
        action: "target.command",
        context,
        target_id: firstTargetId,
        provider: "chrome",
        visibility: "background",
        profile_partition_id: "ambiguous-timeout-profile",
        command: { method: "evaluate", expression: "window.submit()" },
      });
      const timedOutCommand = await provider.poll(hostId);
      expect(timedOutCommand).toMatchObject({ action: "page.command" });

      await expect(mutating).resolves.toMatchObject({
        ok: false,
        error: {
          code: "browser_command_outcome_ambiguous",
          retryable: false,
        },
      });
      expect(broker.status().sessions.target_leases).toEqual([]);

      expect(() =>
        provider.deliver(hostId, success(timedOutCommand!.request_id)),
      ).toThrow(/not registered/);
      const replacementHostId = randomUUID();
      provider.registerHost(
        replacementHostId,
        hello(BROWSER_SESSION_ID, [
          {
            target_id: firstTargetId,
            tab_id: 45,
            window_id: 7,
            owned: true,
            visibility: "background",
          },
        ]),
      );
      const compensation = await provider.poll(replacementHostId);
      expect(compensation).toMatchObject({
        action: "target.finalize",
        target_id: firstTargetId,
        disposition: "close",
      });
      provider.deliver(replacementHostId, success(compensation!.request_id));
      await new Promise<void>((resolve) => setImmediate(resolve));

      await expect(
        broker.dispatch({
          id: randomUUID(),
          action: "target.command",
          context,
          target_id: firstTargetId,
          provider: "chrome",
          visibility: "background",
          profile_partition_id: "ambiguous-timeout-profile",
          command: { method: "title" },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "browser_target_discarded" },
      });
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  it("rejects a target whose logical id does not match its Chrome tab", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const acquiring = provider.acquireTarget("background");
    const command = await provider.poll(hostId);
    provider.deliver(
      hostId,
      success(command!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 92),
        tab_id: 93,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    await expect(acquiring).rejects.toMatchObject({
      code: "chrome_provider_protocol_invalid",
    });
    provider.close();
  });

  it("invalidates old-browser targets from the new session's authoritative inventory", async () => {
    const provider = new ChromeBrowserProvider();
    const firstHostId = randomUUID();
    provider.registerHost(firstHostId, hello());
    const acquiring = provider.acquireTarget("background");
    const command = await provider.poll(firstHostId);
    provider.deliver(
      firstHostId,
      success(command!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 94),
        tab_id: 94,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    const target = await acquiring;
    provider.disconnectHost(firstHostId);
    provider.registerHost(
      randomUUID(),
      hello("018f4f68-6f5b-7b01-8c02-abcdefabcdef"),
    );
    expect(provider.status()).toMatchObject({
      target_count: 0,
      stale_target_count: 0,
    });
    await provider.releaseTarget(target.target_id);
    expect(provider.status()).toMatchObject({
      target_count: 0,
      stale_target_count: 0,
      queued_commands: 0,
    });
    provider.close();
  });

  it("finalizes an extension-ledger target that has no broker lease after broker restart", async () => {
    const provider = new ChromeBrowserProvider();
    const hostId = randomUUID();
    const orphan: ChromeNativeTarget = {
      target_id: chromeTargetId(BROWSER_SESSION_ID, 95),
      tab_id: 95,
      window_id: 7,
      owned: true,
      visibility: "background",
    };

    const registration = provider.registerHost(
      hostId,
      hello(BROWSER_SESSION_ID, [orphan]),
    );
    expect(registration).toEqual({
      lost_target_ids: [],
      orphan_target_ids: [orphan.target_id],
    });
    const finalize = await provider.poll(hostId);
    expect(finalize).toMatchObject({
      action: "target.finalize",
      target_id: orphan.target_id,
      disposition: "close",
    });
    provider.deliver(hostId, success(finalize!.request_id));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(provider.status()).toMatchObject({
      target_count: 0,
      reconciling_target_count: 0,
      reconciliation_error_count: 0,
    });
    provider.close();
  });

  it("linearizes an orphan retry before claiming the same Chrome tab", async () => {
    let now = 0;
    const provider = new ChromeBrowserProvider({
      now: () => now,
      pollTimeoutMs: 25,
    });
    const broker = new BrowserRuntimeBroker({ chromeProvider: provider });
    const hostId = randomUUID();
    const orphan: ChromeNativeTarget = {
      target_id: chromeTargetId(BROWSER_SESSION_ID, 95),
      tab_id: 95,
      window_id: 7,
      owned: false,
      visibility: "background",
    };
    provider.registerHost(hostId, hello(BROWSER_SESSION_ID, [orphan]));
    const orphanFinalize = await provider.poll(hostId);
    expect(orphanFinalize).toMatchObject({
      action: "target.finalize",
      target_id: orphan.target_id,
      disposition: "release",
    });
    const context = {
      agent_session_id: "chrome-orphan-claim-agent",
      turn_id: "chrome-orphan-claim-turn",
      transport: "cli" as const,
    };
    await expectBrokerOk(broker, {
      id: randomUUID(),
      action: "session.start",
      context,
    });
    const claiming = broker.dispatch({
      id: randomUUID(),
      action: "chrome.target.claim",
      context,
      tab_id: orphan.tab_id,
      visibility: "background",
      profile_partition_id: "chrome-profile",
    });
    expect(provider.status().queued_commands).toBe(0);
    provider.deliver(hostId, {
      type: "result",
      request_id: orphanFinalize!.request_id,
      ok: false,
      error: {
        code: "transient_finalize_failure",
        message: "Injected orphan cleanup failure",
        suggestion: "Retry orphan cleanup.",
        retryable: true,
      },
    });

    const claim = await provider.poll(hostId);
    expect(claim).toMatchObject({ action: "target.claim", tab_id: 95 });
    provider.deliver(hostId, success(claim!.request_id, orphan));
    await expect(claiming).resolves.toMatchObject({
      ok: true,
      data: { target_id: orphan.target_id },
    });

    now = 5_001;
    const execution = broker.dispatch({
      id: randomUUID(),
      action: "target.command",
      context,
      target_id: orphan.target_id,
      provider: "chrome",
      visibility: "background",
      profile_partition_id: "chrome-profile",
      command: { method: "title" },
    });
    const pageCommand = await provider.poll(hostId);
    expect(pageCommand).toMatchObject({
      action: "page.command",
      target_id: orphan.target_id,
    });
    provider.deliver(hostId, success(pageCommand!.request_id, "Claimed tab"));
    await expect(execution).resolves.toMatchObject({
      ok: true,
      data: { data: "Claimed tab", target_id: orphan.target_id },
    });
    expect(provider.status()).toMatchObject({
      target_count: 1,
      reconciling_target_count: 0,
      reconciliation_error_count: 1,
    });

    const ending = broker.dispatch({
      id: randomUUID(),
      action: "session.end",
      agent_session_id: context.agent_session_id,
    });
    const finalRelease = await provider.poll(hostId);
    expect(finalRelease).toMatchObject({
      action: "target.finalize",
      target_id: orphan.target_id,
      disposition: "release",
    });
    provider.deliver(hostId, success(finalRelease!.request_id));
    await expect(ending).resolves.toMatchObject({ ok: true });
    await broker.close();
  });

  it("replaces a user-closed task tab once for an implicit broker command", async () => {
    const provider = new ChromeBrowserProvider();
    const broker = new BrowserRuntimeBroker({ chromeProvider: provider });
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const context = {
      agent_session_id: "chrome-replacement-agent",
      turn_id: "chrome-replacement-turn",
      transport: "cli" as const,
    };
    await expectBrokerOk(broker, {
      id: randomUUID(),
      action: "session.start",
      context,
    });

    const execution = broker.dispatch({
      id: randomUUID(),
      action: "target.command",
      context,
      provider: "chrome",
      visibility: "background",
      profile_partition_id: "chrome-profile",
      command: { method: "title" },
    });
    const firstAllocate = await provider.poll(hostId);
    provider.deliver(
      hostId,
      success(firstAllocate!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 42),
        tab_id: 42,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    const missingRead = await provider.poll(hostId);
    provider.deliver(hostId, {
      type: "result",
      request_id: missingRead!.request_id,
      ok: false,
      error: {
        code: "chrome_target_not_found",
        message: "The user closed tab 42",
        suggestion: "Allocate another task tab.",
        retryable: true,
      },
    });
    const replacementAllocate = await provider.poll(hostId);
    expect(replacementAllocate).toMatchObject({ action: "target.allocate" });
    provider.deliver(
      hostId,
      success(replacementAllocate!.request_id, {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 43),
        tab_id: 43,
        window_id: 7,
        owned: true,
        visibility: "background",
      }),
    );
    const replacementRead = await provider.poll(hostId);
    expect(replacementRead).toMatchObject({
      action: "page.command",
      tab_id: 43,
    });
    provider.deliver(
      hostId,
      success(replacementRead!.request_id, "Replacement title"),
    );

    await expect(execution).resolves.toMatchObject({
      ok: true,
      data: {
        target_id: chromeTargetId(BROWSER_SESSION_ID, 43),
        provider: "chrome",
        visibility: "background",
        owned: true,
        tab_id: 43,
        window_id: 7,
        data: "Replacement title",
      },
    });
    expect(broker.status().sessions.target_leases).toEqual([
      expect.objectContaining({
        target_id: chromeTargetId(BROWSER_SESSION_ID, 43),
        owner_session_id: context.agent_session_id,
      }),
    ]);

    const ending = broker.dispatch({
      id: randomUUID(),
      action: "session.end",
      agent_session_id: context.agent_session_id,
    });
    const finalize = await provider.poll(hostId);
    provider.deliver(hostId, success(finalize!.request_id));
    await expect(ending).resolves.toMatchObject({ ok: true });
    await broker.close();
  });

  it.each([
    {
      name: "unusable read",
      command: { method: "title" as const },
      extensionError: {
        code: "background_postcondition_failed",
        message: "Background target escaped its UI postcondition",
        suggestion: "Acquire a fresh target.",
        retryable: false,
        target_unusable: true,
      },
      expectedCode: "browser_target_unusable",
    },
    {
      name: "ambiguous mutation",
      command: {
        method: "evaluate" as const,
        expression: "window.submit()",
      },
      extensionError: {
        code: "chrome_command_failed",
        message: "Debugger detached after dispatch",
        suggestion: "Inspect the external effect.",
        retryable: false,
        outcome_ambiguous: true,
      },
      expectedCode: "browser_command_outcome_ambiguous",
    },
  ])(
    "invalidates a failed Chrome replacement after a $name",
    async ({ command, extensionError, expectedCode }) => {
      const provider = new ChromeBrowserProvider();
      const broker = new BrowserRuntimeBroker({ chromeProvider: provider });
      const hostId = randomUUID();
      provider.registerHost(hostId, hello());
      const context = {
        agent_session_id: `chrome-replacement-${expectedCode}`,
        turn_id: "chrome-replacement-failure-turn",
        transport: "cli" as const,
      };
      await expectBrokerOk(broker, {
        id: randomUUID(),
        action: "session.start",
        context,
      });
      const replacement = await beginChromeReplacement(
        provider,
        broker,
        hostId,
        context,
        command,
      );
      provider.deliver(hostId, {
        type: "result",
        request_id: replacement.command.request_id,
        ok: false,
        error: extensionError,
      });

      await expect(replacement.execution).resolves.toMatchObject({
        ok: false,
        error: { code: expectedCode },
      });
      expect(broker.status().sessions).toMatchObject({
        target_leases: [],
        quarantined_target_ids: [],
      });
      expect(provider.status()).toMatchObject({
        target_count: 0,
        reconciling_target_count: 1,
      });

      const finalize = await provider.poll(hostId);
      expect(finalize).toMatchObject({
        action: "target.finalize",
        target_id: replacement.targetId,
      });
      provider.deliver(hostId, success(finalize!.request_id));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(provider.status()).toMatchObject({
        target_count: 0,
        reconciling_target_count: 0,
      });
      await broker.close();
    },
  );

  it("invalidates a Chrome replacement canceled after mutation dispatch", async () => {
    const provider = new ChromeBrowserProvider();
    const broker = new BrowserRuntimeBroker({ chromeProvider: provider });
    const hostId = randomUUID();
    provider.registerHost(hostId, hello());
    const context = {
      agent_session_id: "chrome-replacement-cancel-agent",
      turn_id: "chrome-replacement-cancel-turn",
      transport: "cli" as const,
    };
    await expectBrokerOk(broker, {
      id: randomUUID(),
      action: "session.start",
      context,
    });
    const controller = new AbortController();
    const replacement = await beginChromeReplacement(
      provider,
      broker,
      hostId,
      context,
      { method: "evaluate", expression: "window.submit()" },
      controller.signal,
    );
    controller.abort(new Error("replacement consumer disconnected"));

    await expect(replacement.execution).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_command_canceled", retryable: false },
    });
    expect(broker.status().sessions).toMatchObject({
      target_leases: [],
      quarantined_target_ids: [],
    });
    expect(provider.status()).toMatchObject({
      target_count: 0,
      reconciling_target_count: 1,
    });

    provider.deliver(
      hostId,
      success(replacement.command.request_id, "possibly applied"),
    );
    const finalize = await provider.poll(hostId);
    expect(finalize).toMatchObject({
      action: "target.finalize",
      target_id: replacement.targetId,
    });
    provider.deliver(hostId, success(finalize!.request_id));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(provider.status()).toMatchObject({
      target_count: 0,
      reconciling_target_count: 0,
    });
    await broker.close();
  });
});

async function beginChromeReplacement(
  provider: ChromeBrowserProvider,
  broker: BrowserRuntimeBroker,
  hostId: string,
  context: {
    agent_session_id: string;
    turn_id: string;
    transport: "cli";
  },
  command: { method: "title" } | { method: "evaluate"; expression: string },
  signal?: AbortSignal,
) {
  const execution = broker.dispatch(
    {
      id: randomUUID(),
      action: "target.command",
      context,
      provider: "chrome",
      visibility: "background",
      profile_partition_id: "chrome-profile",
      command,
    },
    signal,
  );
  const firstAllocate = await provider.poll(hostId);
  provider.deliver(
    hostId,
    success(firstAllocate!.request_id, {
      target_id: chromeTargetId(BROWSER_SESSION_ID, 42),
      tab_id: 42,
      window_id: 7,
      owned: true,
      visibility: "background",
    }),
  );
  const missingCommand = await provider.poll(hostId);
  provider.deliver(hostId, {
    type: "result",
    request_id: missingCommand!.request_id,
    ok: false,
    error: {
      code: "chrome_target_not_found",
      message: "The user closed tab 42",
      suggestion: "Allocate another task tab.",
      retryable: true,
    },
  });
  const replacementAllocate = await provider.poll(hostId);
  const targetId = chromeTargetId(BROWSER_SESSION_ID, 43);
  provider.deliver(
    hostId,
    success(replacementAllocate!.request_id, {
      target_id: targetId,
      tab_id: 43,
      window_id: 7,
      owned: true,
      visibility: "background",
    }),
  );
  const replacementCommand = await provider.poll(hostId);
  if (!replacementCommand)
    throw new Error("Replacement command was not queued");
  return { execution, command: replacementCommand, targetId };
}

function hello(
  browserSessionId = BROWSER_SESSION_ID,
  targets: ChromeNativeTarget[] = [],
): ChromeNativeHello {
  return {
    type: "hello",
    product: CHROME_NATIVE_PRODUCT,
    protocol: CHROME_NATIVE_PROTOCOL,
    version: CHROME_NATIVE_PROTOCOL_VERSION,
    extension_id: CHROME_EXTENSION_ID,
    extension_version: "1.0.0-test",
    browser_session_id: browserSessionId,
    targets,
  };
}

async function expectBrokerOk(
  broker: BrowserRuntimeBroker,
  request: Parameters<BrowserRuntimeBroker["dispatch"]>[0],
): Promise<unknown> {
  const response = await broker.dispatch(request);
  if (!response.ok) throw new Error(response.error?.message);
  return response.data;
}

function success(requestId: string, data?: unknown): ChromeNativeResult {
  return {
    type: "result",
    request_id: requestId,
    ok: true,
    ...(data === undefined ? {} : { data }),
  };
}
