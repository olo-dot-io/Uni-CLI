import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ManagedBrowserRuntimeStatus,
  ManagedBrowserTarget,
  ManagedBrowserTargetRequest,
  ManagedBrowserProvider,
} from "../../src/browser/managed-browser.js";
import type { BrowserPage } from "../../src/browser/page.js";
import { BrowserRuntimeBroker } from "../../src/browser/runtime-broker.js";
import type { BrowserBrokerStatus } from "../../src/browser/runtime-protocol.js";
import {
  BrowserRuntimeBrokerClient,
  BrowserRuntimeBrokerServer,
} from "../../src/browser/runtime-transport.js";

export class InMemoryBrowserRuntimeHarness {
  readonly runtimeRoot = mkdtempSync(
    join(tmpdir(), "unicli-browser-in-memory-"),
  );
  readonly provider = new InMemoryManagedProvider(this.runtimeRoot);
  readonly broker = new BrowserRuntimeBroker({
    runtimeId: randomUUID(),
    // REASON: Chromium is external; this provider keeps broker ownership, IPC, sessions, queues, and page command routing real.
    provider: this.provider as unknown as ManagedBrowserProvider,
  });
  readonly server = new BrowserRuntimeBrokerServer({
    runtimeRoot: this.runtimeRoot,
    runtimeId: this.broker.runtimeId,
    handler: (request) => this.broker.dispatch(request),
  });
  readonly client = new BrowserRuntimeBrokerClient({
    runtimeRoot: this.runtimeRoot,
  });
  private serverRunning = false;
  private brokerClosed = false;

  async start(): Promise<void> {
    await this.server.start();
    this.serverRunning = true;
  }

  async status(): Promise<BrowserBrokerStatus> {
    return this.client.requestOrThrow({
      id: randomUUID(),
      action: "broker.status",
    });
  }

  async stopControlPlane(): Promise<void> {
    if (this.serverRunning) {
      await this.server.stop();
      this.serverRunning = false;
    }
    if (!this.brokerClosed) {
      await this.broker.close();
      this.brokerClosed = true;
    }
  }

  async cleanup(): Promise<void> {
    try {
      await this.stopControlPlane();
    } finally {
      rmSync(this.runtimeRoot, { recursive: true, force: true });
    }
  }
}

export class InMemoryManagedProvider {
  readonly pages: InMemoryPage[] = [];
  readonly evaluationResults = new Map<string, unknown>();
  evaluationResolver?: (expression: string) => unknown;
  acquireCount = 0;
  releaseCount = 0;
  releaseAttemptCount = 0;
  releaseFailuresRemaining = 0;
  private partitionId: string | null = null;

  constructor(private readonly runtimeRoot: string) {}

  async acquireTarget(
    request: ManagedBrowserTargetRequest,
  ): Promise<ManagedBrowserTarget> {
    this.acquireCount++;
    this.partitionId ??= request.profile_partition_id;
    if (this.partitionId !== request.profile_partition_id) {
      throw new Error("This fixture supports one shared profile runtime");
    }
    const page = new InMemoryPage(
      `target-${String(this.acquireCount)}`,
      this.evaluationResults,
      (expression) => this.evaluationResolver?.(expression),
    );
    this.pages.push(page);
    return {
      target_id: page.targetId,
      page: page as unknown as BrowserPage,
      runtime: this.status()[0]!,
    };
  }

  getPage(targetId: string): BrowserPage {
    const page = this.pages.find(
      (candidate) => candidate.targetId === targetId,
    );
    if (!page) throw new Error(`Unknown in-memory target: ${targetId}`);
    return page as unknown as BrowserPage;
  }

  async releaseTarget(targetId: string): Promise<void> {
    this.releaseAttemptCount++;
    if (this.releaseFailuresRemaining > 0) {
      this.releaseFailuresRemaining--;
      throw new Error(`Injected target release failure: ${targetId}`);
    }
    const page = this.pages.find(
      (candidate) => candidate.targetId === targetId,
    );
    if (!page || page.closed) return;
    this.releaseCount++;
    await page.close();
  }

  status(): ManagedBrowserRuntimeStatus[] {
    if (!this.partitionId) return [];
    return [
      {
        runtime_id: "in-memory-runtime",
        provider: "managed",
        profile_partition_id: this.partitionId,
        profile_source: "ephemeral",
        browser_pid: process.pid,
        broker_pid: process.pid,
        cdp_port: 0,
        user_data_dir: this.runtimeRoot,
        visibility: "hidden",
        target_count: this.pages.filter((page) => !page.closed).length,
        recovered: false,
      },
    ];
  }

  async close(): Promise<void> {
    await Promise.all(this.pages.map((page) => page.close()));
  }
}

export class InMemoryPage {
  readonly visibility = "hidden";
  readonly navigations: Array<{
    url: string;
    options?: { settleMs?: number; waitUntil?: string };
  }> = [];
  readonly evaluations: string[] = [];
  readonly clicks: string[] = [];
  readonly typed: Array<{ selector: string; text: string }> = [];
  readonly presses: Array<{ key: string; modifiers?: string[] }> = [];
  readonly scrolls: string[] = [];
  readonly uploads: Array<{ selector: string; files: string[] }> = [];
  readonly cdpCalls: Array<{
    method: string;
    params?: Record<string, unknown>;
  }> = [];
  networkCaptureEntries: Array<{
    url: string;
    method: string;
    status: number;
    contentType: string;
    size: number;
    timestamp?: number;
    responseBody?: string;
    remoteIPAddress?: string;
    remotePort?: number;
  }> = [];
  networkCaptureStartCount = 0;
  closed = false;
  private currentUrl = "about:blank";

  constructor(
    readonly targetId: string,
    private readonly evaluationResults = new Map<string, unknown>(),
    private readonly evaluationResolver?: (expression: string) => unknown,
  ) {}

  async goto(
    url: string,
    options?: { settleMs?: number; waitUntil?: string },
  ): Promise<void> {
    this.navigations.push({ url, ...(options ? { options } : {}) });
    this.currentUrl = url;
  }

  async evaluate(expression: string): Promise<unknown> {
    this.evaluations.push(expression);
    if (this.evaluationResults.has(expression)) {
      return this.evaluationResults.get(expression);
    }
    const resolved = this.evaluationResolver?.(expression);
    if (resolved !== undefined) return resolved;
    if (expression === "history.back()") return undefined;
    if (expression.includes("const INTERACTIVE =")) {
      return "[1]<button>Continue</button>";
    }
    if (expression.includes("window.__unicli_ref_identity")) return 1;
    if (
      expression.includes("var data = window[") &&
      expression.includes("JSON.stringify(data)")
    ) {
      return "[]";
    }
    if (expression.includes("window.scrollBy(0, window.innerHeight)")) {
      return true;
    }
    return null;
  }

  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
  }
  async type(selector: string, text: string): Promise<void> {
    this.typed.push({ selector, text });
  }
  async press(key: string, modifiers?: string[]): Promise<void> {
    this.presses.push({ key, ...(modifiers ? { modifiers } : {}) });
  }
  async insertText(): Promise<void> {}
  async scroll(direction: string): Promise<void> {
    this.scrolls.push(direction);
  }
  async setFileInput(selector: string, files: string[]): Promise<void> {
    this.uploads.push({ selector, files: [...files] });
  }
  async startNetworkCapture(): Promise<boolean> {
    this.networkCaptureStartCount++;
    return true;
  }
  async readNetworkCapture() {
    return structuredClone(this.networkCaptureEntries);
  }
  async cookies(): Promise<Record<string, string>> {
    return { sid: "fixture" };
  }
  async title(): Promise<string> {
    return this.currentUrl === "about:blank" ? "Blank" : "Example fixture";
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async snapshot(): Promise<string> {
    return "[1]<button>Continue</button>";
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from("fixture-image");
  }
  async sendCDP(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, never>> {
    this.cdpCalls.push({ method, ...(params ? { params } : {}) });
    return {};
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}
