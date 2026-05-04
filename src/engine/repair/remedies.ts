import type { EnvelopeError, EnvelopeRemedy } from "../../core/envelope.js";

const REMEDIES: Readonly<Record<string, EnvelopeRemedy>> = {
  "desktop-uia.binary_missing": {
    message: "Install the Windows UIA sidecar package for this platform.",
    command: "unicli doctor compute --install",
    doc: "docs/operate/troubleshooting.md#desktop-uiabinary_missing",
  },
  "desktop-uia.startup_failed": {
    message: "Inspect the UIA sidecar startup logs and retry with tracing.",
    command: "UNICLI_TRACE=1 unicli doctor compute",
    doc: "docs/operate/troubleshooting.md#desktop-uiastartup_failed",
  },
  "desktop-uia.permission": {
    message:
      "Run from an elevated terminal or install the sidecar with UIAccess.",
    doc: "docs/operate/troubleshooting.md#desktop-uiapermission",
  },
  "desktop-uia.no_element": {
    message: "The ref is stale; take a fresh compute snapshot and retry.",
    command: "unicli compute snapshot",
    doc: "docs/operate/troubleshooting.md#desktop-uiano_element",
  },
  "desktop-uia.not_invokable": {
    message: "Use set-value or keyboard press for elements without Invoke.",
    doc: "docs/operate/troubleshooting.md#desktop-uianot_invokable",
  },
  "desktop-uia.timeout": {
    message: "Retry the call; the sidecar should restart after a timeout.",
    doc: "docs/operate/troubleshooting.md#desktop-uiatimeout",
  },
  "desktop-uia.sidecar_crashed": {
    message: "Retry once; inspect UIA sidecar startup logs if it repeats.",
    command: "UNICLI_TRACE=1 unicli doctor compute",
    doc: "docs/operate/troubleshooting.md#desktop-uiasidecar_crashed",
  },
  "desktop-atspi.binary_missing": {
    message: "Install the Linux AT-SPI sidecar package for this platform.",
    command: "unicli doctor compute --install",
    doc: "docs/operate/troubleshooting.md#desktop-atspibinary_missing",
  },
  "desktop-atspi.dbus_blocked": {
    message: "Start the user AT-SPI bus daemon.",
    command: "systemctl --user start at-spi-dbus-bus",
    doc: "docs/operate/troubleshooting.md#desktop-atspidbus_blocked",
  },
  "desktop-atspi.no_a11y_attr": {
    message: "Enable accessibility support in the target app and retry.",
    doc: "docs/operate/troubleshooting.md#desktop-atspino_a11y_attr",
  },
  "desktop-atspi.wayland-input": {
    message: "Install a Wayland input helper for fallback key/mouse actions.",
    command: "sudo apt install ydotool",
    doc: "docs/operate/troubleshooting.md#desktop-atspiwayland-input",
  },
  "desktop-atspi.x11-input": {
    message: "Install xdotool for X11 fallback key/mouse actions.",
    command: "sudo apt install xdotool",
    doc: "docs/operate/troubleshooting.md#desktop-atspix11-input",
  },
  "desktop-atspi.no_element": {
    message: "The ref is stale; take a fresh compute snapshot and retry.",
    command: "unicli compute snapshot",
    doc: "docs/operate/troubleshooting.md#desktop-atspino_element",
  },
  "desktop-atspi.sidecar_crashed": {
    message: "Retry once; inspect AT-SPI sidecar startup logs if it repeats.",
    command: "UNICLI_TRACE=1 unicli doctor compute",
    doc: "docs/operate/troubleshooting.md#desktop-atspisidecar_crashed",
  },
  "desktop-ax.permission": {
    message:
      "Grant macOS Accessibility to the app or terminal launching Uni-CLI.",
    deeplink:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    doc: "docs/operate/troubleshooting.md#desktop-axpermission",
  },
  "desktop-ax.screen-recording": {
    message: "Grant macOS Screen Recording for screenshot fallback.",
    deeplink:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    doc: "docs/operate/troubleshooting.md#desktop-axscreen-recording",
  },
  "desktop-ax.binary_missing": {
    message: "Install Xcode command line tools so the AX Swift helper can run.",
    command: "xcode-select --install",
    doc: "docs/operate/troubleshooting.md#desktop-axbinary_missing",
  },
  "cdp-browser.attach_failed": {
    message:
      "Check the CDP port or relaunch the app with remote debugging enabled.",
    doc: "docs/operate/troubleshooting.md#cdp-browserattach_failed",
  },
  "cdp-browser.electron_running_without_debug_port": {
    message: "Launch the Electron app with a remote debugging port.",
    command: "unicli compute launch <app> --debug-port 9229",
    doc: "docs/operate/troubleshooting.md#cdp-browserelectron_running_without_debug_port",
  },
  "cua.no_backend": {
    message: "Configure a CUA backend key for screenshot/VLM fallback.",
    doc: "docs/operate/troubleshooting.md#cuano_backend",
  },
  "compute.compute_find.ref-store": {
    message: "Run a fresh snapshot so refs are available, then retry find.",
    command: "unicli compute snapshot",
    doc: "docs/operate/troubleshooting.md#computecompute_findref-store",
  },
};

const COMPUTE_NO_TRANSPORT: EnvelopeRemedy = {
  message: "Run the compute doctor to identify the blocked transport.",
  command: "unicli doctor compute",
  doc: "docs/operate/troubleshooting.md#computestepno-transport-available",
};

const COMPUTE_EDGE_REMEDIES: Readonly<Record<string, EnvelopeRemedy>> = {
  element_off_screen: {
    message: "Scroll the element into view or take a fresh snapshot.",
    command: "unicli compute snapshot",
    doc: "docs/operate/troubleshooting.md#computestepelement_off_screen",
  },
  window_minimized: {
    message: "Restore or focus the target window before retrying.",
    doc: "docs/operate/troubleshooting.md#computestepwindow_minimized",
  },
  element_disabled: {
    message: "Wait for the element to become enabled, then retry.",
    command: "unicli compute wait --state enabled",
    doc: "docs/operate/troubleshooting.md#computestepelement_disabled",
  },
  ref_expired: {
    message: "The ref expired; take a fresh snapshot and retry.",
    command: "unicli compute snapshot",
    doc: "docs/operate/troubleshooting.md#computestepref_expired",
  },
  sidecar_crashed: {
    message: "Retry once; the sidecar should restart before the next call.",
    command: "UNICLI_TRACE=1 unicli doctor compute",
    doc: "docs/operate/troubleshooting.md#computestepsidecar_crashed",
  },
  sidecar_busy: {
    message: "Retry after the current sidecar call completes.",
    doc: "docs/operate/troubleshooting.md#computestepsidecar_busy",
  },
  app_ambiguous: {
    message:
      "Disambiguate the target by bundle id, process name, pid, or window id.",
    command: "unicli compute windows --app <name>",
    doc: "docs/operate/troubleshooting.md#computestepapp_ambiguous",
  },
  focus_required: {
    message:
      "Retry with explicit focus only if background control is impossible.",
    doc: "docs/operate/troubleshooting.md#computestepfocus_required",
  },
};

export function lookupRemedy(
  minimumCapability: string | undefined,
): EnvelopeRemedy | undefined {
  if (!minimumCapability) return undefined;
  if (minimumCapability in REMEDIES) return REMEDIES[minimumCapability];
  if (
    minimumCapability.startsWith("compute.") &&
    minimumCapability.endsWith(".no-transport-available")
  ) {
    return COMPUTE_NO_TRANSPORT;
  }
  const edgeKey = minimumCapability.split(".").at(-1);
  if (
    minimumCapability.startsWith("compute.") &&
    edgeKey &&
    edgeKey in COMPUTE_EDGE_REMEDIES
  ) {
    return COMPUTE_EDGE_REMEDIES[edgeKey];
  }
  return undefined;
}

export function enrichErrorWithRemedy(error: EnvelopeError): EnvelopeError {
  if (error.remedy) return error;
  const remedy = lookupRemedy(error.minimum_capability);
  return remedy ? { ...error, remedy } : error;
}
