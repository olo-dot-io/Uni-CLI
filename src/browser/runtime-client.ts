/**
 * @owner       src/browser/runtime-client.ts
 * @does        Expose the supported plugin API for broker-backed browser invocation, pages, lifecycle probes, and typed runtime errors.
 * @needs       src/browser bridge/invocation-context/invocation-scope/runtime-launch/runtime-protocol/runtime-transport
 * @feeds       package export `@zenalexa/unicli/browser/runtime` and third-party plugins
 * @breaks      Typed invocation, launch, transport, provider, and broker errors propagate without legacy browser transport or direct-CDP fallback.
 * @invariants  BrowserBridge is broker-only; lifecycle probes preserve provider laziness; public transport clients authenticate through owner-only descriptors.
 * @side-effects Re-exported operations may start the broker or selected provider only when explicitly invoked.
 * @perf        Re-export facade adds no runtime work.
 * @concurrency Invocation scopes are async-local; target mutation serialization remains broker-owned.
 * @test        scripts/verify-exports.ts, tests/unit/exports.test.ts, tests/integration/browser-runtime-autostart.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

export {
  BrowserBridge,
  BrowserBrokerPage,
  BridgeConnectionError,
} from "./bridge.js";
export type {
  BrowserBridgeConnectOptions,
  BrowserNetworkCaptureEntry,
} from "./bridge.js";
export {
  BrowserInvocationContextError,
  createBrowserInvocationContext,
} from "./invocation-context.js";
export type {
  BrowserInvocationContext,
  BrowserInvocationContextInput,
  BrowserInvocationTransport,
} from "./invocation-context.js";
export {
  BrowserInvocationScopeError,
  createBrowserInvocationScope,
  currentBrowserInvocationScope,
  runBrowserInvocation,
} from "./invocation-scope.js";
export type {
  BrowserInvocationScope,
  BrowserInvocationScopeInput,
  BrowserProvider,
} from "./invocation-scope.js";
export {
  BrowserRuntimeLaunchError,
  ensureBrowserRuntimeBroker,
  probeBrowserRuntimeBroker,
} from "./runtime-launch.js";
export type {
  BrowserRuntimeConnection,
  BrowserRuntimeLaunchOptions,
} from "./runtime-launch.js";
export {
  BrokerTransportError,
  BrowserBrokerClientError,
  BrowserRuntimeBrokerClient,
} from "./runtime-transport.js";
export type {
  BrowserAgentPresenceResult,
  BrowserBrokerError,
  BrowserBrokerRequest,
  BrowserBrokerResponse,
  BrowserBrokerStatus,
  BrowserPageCommand,
  BrowserTargetCommandResult,
} from "./runtime-protocol.js";
export type {
  ChromeContentSearchFailure,
  ChromeContentSearchMatch,
  ChromeContentSearchQuery,
  ChromeContentSearchResult,
  ChromeContentSearchSource,
  ChromeNativeTab,
  ChromeNativeTarget,
} from "./chrome-native-protocol.js";
