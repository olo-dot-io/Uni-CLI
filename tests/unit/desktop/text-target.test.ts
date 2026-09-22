import { describe, expect, it } from "vitest";
import { WindowsTextTargetClient } from "../../../src/desktop/text-target.js";
import { StdioSidecarClient } from "../../../src/transport/sidecar.js";

const reference = {
  id: "retained-element",
  generation: "native-generation",
  revision: 3,
};

// REASON: A small owned subprocess exercises the real public client and FIFO transport without Windows UIA.
function clientFor(handler: string): WindowsTextTargetClient {
  return new WindowsTextTargetClient({
    sidecar: new StdioSidecarClient(process.execPath, [
      "-e",
      `
    const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      const reply = data => process.stdout.write(JSON.stringify({id:request.id,kind:request.kind,ok:true,data})+'\\n');
      ${handler}
    });
  `,
    ]),
  });
}

describe("WindowsTextTargetClient public contract", () => {
  it("projects only native references across validation and mutation boundaries", async () => {
    const client = clientFor(
      "reply({kind:request.kind, params:request.params});",
    );
    const lease = {
      ...reference,
      window: { pid: 77 },
      privateConsumerData: "do not send",
    };
    try {
      await expect(client.validate(lease)).resolves.toEqual({
        kind: "uia_text_validate",
        params: { lease: reference },
      });
      await expect(
        client.replace(lease, { start: 2, length: 4 }, "中文🙂"),
      ).resolves.toEqual({
        kind: "uia_text_replace",
        params: { lease: reference, start: 2, length: 4, text: "中文🙂" },
      });
      await expect(client.key(lease, "ctrl_enter")).resolves.toEqual({
        kind: "uia_text_key",
        params: { lease: reference, key: "ctrl_enter" },
      });
      await expect(
        client.recoverAfterExternalPaste(lease, "中文🙂"),
      ).resolves.toEqual({
        kind: "uia_text_recover",
        params: { lease: reference, text: "中文🙂" },
      });
      await expect(client.release(lease)).resolves.toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("keeps context observations and visible-text selectors separate from retained captures", async () => {
    const client = clientFor(
      "reply({kind:request.kind, params:request.params});",
    );
    const target = {
      hwnd: "0x123",
      pid: 77,
      title: "Editor",
      frame: { x: -1920, y: 0, width: 1000, height: 800 },
    };
    try {
      await expect(client.observeContext()).resolves.toEqual({
        kind: "uia_text_context",
        params: {},
      });
      await expect(client.readVisibleText(target)).resolves.toEqual({
        kind: "uia_text_visible",
        params: { target },
      });
      await expect(client.capture()).resolves.toEqual({
        kind: "uia_text_capture",
        params: {},
      });
      await expect(
        client.capture({ retainFocusIdentity: true }),
      ).resolves.toEqual({
        kind: "uia_text_capture",
        params: { retainFocusIdentity: true },
      });
    } finally {
      await client.close();
    }
  });

  it("reports native dispatch before final verification exactly once", async () => {
    const client = clientFor(`
      process.stdout.write(JSON.stringify({id:request.id,kind:request.kind,ok:true,progress:'dispatch_ack'})+'\\n');
      reply({status:'confirmed',dispatched:true,lease:{...request.params.lease,revision:4}});
    `);
    const observed: string[] = [];
    try {
      const result = await client.paste(reference, "中文", {
        onDispatchAck: () => observed.push("dispatch"),
      });
      observed.push(result.status);
      expect(observed).toEqual(["dispatch", "confirmed"]);
      expect(result).toMatchObject({ lease: { revision: 4 } });
    } finally {
      await client.close();
    }
  });

  it.each(["paste", "replace", "key"] as const)(
    "contains %s after dispatch cancellation and retires its generation",
    async (method) => {
      const client = clientFor(`
      if(request.kind === 'uia_text_context') {reply({status:'unavailable',reason:'fresh_generation'});return;}
      process.stdout.write(JSON.stringify({id:request.id,kind:request.kind,ok:true,progress:'dispatch_ack'})+'\\n');
    `);
      const controller = new AbortController();
      const options = {
        signal: controller.signal,
        onDispatchAck: () =>
          controller.abort(new Error("cancel after dispatch")),
      };
      try {
        const result =
          method === "paste"
            ? client.paste(reference, "new", options)
            : method === "replace"
              ? client.replace(
                  reference,
                  { start: 0, length: 1 },
                  "new",
                  options,
                )
              : client.key(reference, "enter", options);
        await expect(result).rejects.toMatchObject({
          name: "OperationOutcomeAmbiguousError",
        });
        await expect(client.observeContext()).resolves.toEqual({
          status: "unavailable",
          reason: "fresh_generation",
        });
      } finally {
        await client.close();
      }
    },
  );
});
