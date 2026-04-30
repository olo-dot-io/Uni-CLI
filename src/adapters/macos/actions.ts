/**
 * Stable macOS Shortcuts/App Intent discovery entry points.
 *
 * The concrete `shortcut-*` and `app-action-*` commands are runtime-discovered
 * from the current Mac. These two commands are committed static adapters so
 * docs, manifests, and agents have a reproducible entry point everywhere.
 */

import { cli, Strategy } from "../../registry.js";
import {
  listMacosAppActions,
  runMacosAutomationSmoke,
} from "../../discovery/macos-dynamic.js";

cli({
  site: "macos",
  name: "app-actions",
  description:
    "List real-time Shortcuts app actions and App Intents exposed by installed macOS apps",
  strategy: Strategy.PUBLIC,
  target_surface: "desktop",
  adapter_path: "src/adapters/macos/actions.ts",
  args: [
    {
      name: "app",
      type: "str",
      description: "Filter by app or bundle display name, e.g. WhatsApp",
    },
    {
      name: "query",
      type: "str",
      description: "Filter by action name, description, or identifier",
    },
    {
      name: "limit",
      type: "int",
      default: 200,
      description: "Maximum actions to return",
    },
  ],
  columns: ["app", "name", "id", "kind", "description"],
  func: async (_page, kwargs) => listMacosAppActions(kwargs),
});

cli({
  site: "macos",
  name: "automation-smoke",
  description:
    "Probe macOS automation reproducibility across Shortcuts CLI, Shortcuts ToolKit API, and AX/System Events",
  strategy: Strategy.PUBLIC,
  target_surface: "desktop",
  adapter_path: "src/adapters/macos/actions.ts",
  args: [
    {
      name: "apps",
      type: "str",
      description:
        "Comma-separated app names to summarize, default: Finder,Safari,Mail,Messages,Reminders,Notes,WhatsApp",
    },
  ],
  columns: ["layers", "apps"],
  func: async (_page, kwargs) => runMacosAutomationSmoke(kwargs),
});
