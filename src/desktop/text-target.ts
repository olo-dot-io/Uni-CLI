/**
 * @owner src/desktop/text-target.ts
 * @does Retain and verify focused Windows text targets through the bundled UIA sidecar.
 * @needs Native UIA text leases, sidecar FIFO and process-contained cancellation.
 * @feeds Desktop applications that stage their own clipboard and require target-bound delivery.
 */
import {
  StdioSidecarClient,
  type SidecarCallOptions,
  type SidecarClient,
} from "../transport/sidecar.js";
import { resolveSidecarBinary } from "../transport/sidecar-binary.js";

export {
  OperationOutcomeAmbiguousError,
  isOperationOutcomeAmbiguousError,
} from "../transport/contained-process.js";

export interface TextTargetReference {
  readonly id: string;
  readonly generation: string;
  readonly revision: number;
}

export interface TextTargetWindow {
  readonly hwnd: string;
  readonly pid: number;
  readonly title: string;
  readonly appName: string;
  /** Physical desktop pixels, including negative multi-monitor origins. */
  readonly frame?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface TextTargetText {
  readonly value: string;
  /** UTF-16 offsets in value. UIA character units are not UTF-16 offsets. */
  readonly selectionStart: number;
  readonly selectionLength: number;
  /** Missing means the provider cannot report composition; zero means inactive. */
  readonly compositionLength?: number;
}

export type TextTargetLease = TextTargetReference & {
  readonly window: TextTargetWindow;
  readonly followUpKeyEligible: boolean;
} & (
    | { readonly textSnapshot: "complete"; readonly text: TextTargetText }
    | { readonly textSnapshot: "identity_only"; readonly text?: never }
  );

export interface TextContextSnapshot {
  readonly id: string;
  /** Time since Windows boot in nanoseconds, with millisecond clock resolution. */
  readonly observedAtNanoseconds: string;
  readonly completedAtNanoseconds: string;
  readonly coherence: "stable" | "frontmost_changed";
  readonly window: TextTargetWindow;
  readonly textStatus: string;
  readonly text?: TextTargetText & { readonly writable: boolean | null };
}

export type TextContextResult =
  | {
      readonly status: "ok";
      readonly snapshot: TextContextSnapshot;
      /** Present only when retention was requested, from this same native observation. */
      readonly retainedTarget?: TextTargetCaptureResult;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export interface VisibleTextTarget {
  readonly hwnd?: string;
  readonly pid?: number;
  readonly title?: string;
  readonly frame?: TextTargetWindow["frame"];
}

export type VisibleTextResult =
  | {
      readonly status: "ok";
      readonly snapshot: {
        readonly id: string;
        readonly window: TextTargetWindow;
        readonly text: string;
        readonly truncated: boolean;
        readonly visitedNodeCount: number;
      };
    }
  | { readonly status: "unavailable"; readonly reason: string };

export type TextTargetCaptureResult =
  | { readonly status: "ok"; readonly lease: TextTargetLease }
  | {
      readonly status: "unavailable";
      readonly reason: string;
      readonly window?: TextTargetLease["window"];
    };

export type TextTargetPasteResult =
  | {
      readonly status: "confirmed";
      readonly dispatched: true;
      readonly lease: TextTargetLease;
    }
  | {
      readonly status: "rejected_before_dispatch";
      readonly dispatched: false;
      readonly reason: string;
    }
  | {
      readonly status: "delivered_unverified" | "effect_unknown";
      readonly dispatched: true;
      readonly reason: string;
    };

export interface TextTargetCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface TextTargetPasteOptions extends TextTargetCallOptions {
  readonly onDispatchAck?: () => void;
}

export interface WindowsTextTargetClientOptions {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  /** Inject the same contained sidecar contract when embedding another process owner. */
  readonly sidecar?: SidecarClient;
}

/** One client owns its leases until release, close, or native process retirement. */
export class WindowsTextTargetClient {
  private readonly sidecar: SidecarClient;

  constructor(options: WindowsTextTargetClientOptions = {}) {
    this.sidecar =
      options.sidecar ??
      new StdioSidecarClient(
        options.command ??
          resolveSidecarBinary("unicli-uia", { env: options.env }).command,
        [],
        {
          env: options.env,
          requestTimeoutMs: options.requestTimeoutMs,
          maxFrameBytes: 2_097_152,
        },
      );
  }

  capture(
    options: TextTargetCallOptions & {
      readonly retainFocusIdentity?: boolean;
    } = {},
  ): Promise<TextTargetCaptureResult> {
    const { retainFocusIdentity, ...callOptions } = options;
    return this.sidecar.call(
      "uia_text_capture",
      retainFocusIdentity === undefined ? {} : { retainFocusIdentity },
      callOptions,
    );
  }

  /** Observe without retaining by default; requested retention shares this native observation. */
  observeContext(
    options: TextTargetCallOptions & {
      readonly retainTextTarget?: boolean;
      readonly retainFocusIdentity?: boolean;
    } = {},
  ): Promise<TextContextResult> {
    const { retainTextTarget, retainFocusIdentity, ...callOptions } = options;
    return this.sidecar.call(
      "uia_text_context",
      {
        ...(retainTextTarget === undefined ? {} : { retainTextTarget }),
        ...(retainFocusIdentity === undefined ? {} : { retainFocusIdentity }),
      },
      callOptions,
    );
  }

  readVisibleText(
    target: VisibleTextTarget = {},
    options: TextTargetCallOptions = {},
  ): Promise<VisibleTextResult> {
    return this.sidecar.call("uia_text_visible", { target }, options);
  }

  validate(
    lease: TextTargetReference,
    options: TextTargetCallOptions = {},
  ): Promise<TextTargetCaptureResult> {
    return this.sidecar.call(
      "uia_text_validate",
      { lease: reference(lease) },
      options,
    );
  }

  /** Reacquire readable state after the caller's external paste, without sending input. */
  recoverAfterExternalPaste(
    lease: TextTargetReference,
    text: string,
    options: TextTargetCallOptions = {},
  ): Promise<TextTargetCaptureResult> {
    return this.sidecar.call(
      "uia_text_recover",
      { lease: reference(lease), text },
      options,
    );
  }

  /** The caller owns clipboard staging and restoration for the entire call. */
  paste(
    lease: TextTargetReference,
    text: string,
    options: TextTargetPasteOptions = {},
  ): Promise<TextTargetPasteResult> {
    const callOptions: SidecarCallOptions = {
      ...options,
      cancellationDelivery: "outcome-ambiguous",
    };
    return this.sidecar.call(
      "uia_text_paste",
      { lease: reference(lease), text },
      callOptions,
    );
  }

  /** Replace a UTF-16 range in the retained document using native text input. */
  replace(
    lease: TextTargetReference,
    range: { readonly start: number; readonly length: number },
    text: string,
    options: TextTargetPasteOptions = {},
  ): Promise<TextTargetPasteResult> {
    return this.sidecar.call(
      "uia_text_replace",
      { lease: reference(lease), ...range, text },
      { ...options, cancellationDelivery: "outcome-ambiguous" },
    );
  }

  /** Dispatch a target-bound key and consume the lease. Application effects are unverified. */
  key(
    lease: TextTargetReference,
    key: "enter" | "shift_enter" | "ctrl_enter",
    options: TextTargetPasteOptions = {},
  ): Promise<Exclude<TextTargetPasteResult, { status: "confirmed" }>> {
    return this.sidecar.call(
      "uia_text_key",
      { lease: reference(lease), key },
      { ...options, cancellationDelivery: "outcome-ambiguous" },
    );
  }

  async release(
    lease: TextTargetReference,
    options: TextTargetCallOptions = {},
  ): Promise<void> {
    await this.sidecar.call(
      "uia_text_release",
      { lease: reference(lease) },
      options,
    );
  }

  close(): Promise<void> {
    return this.sidecar.close();
  }
}

function reference(lease: TextTargetReference): TextTargetReference {
  return {
    id: lease.id,
    generation: lease.generation,
    revision: lease.revision,
  };
}
