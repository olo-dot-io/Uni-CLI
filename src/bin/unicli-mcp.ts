#!/usr/bin/env node

/**
 * @owner   src/bin/unicli-mcp.ts
 * @does    One-liner npm bin that boots the Uni-CLI MCP server (stdio).
 * @needs   cached update check and ../mcp/server.js
 * @feeds   npm bin -> `npx -y @zenalexa/unicli-mcp` (Claude Desktop, Cursor, etc.)
 * @breaks  Server start failure propagates as exit 1; no fallback transport.
 */

import { checkForUpdates } from "../engine/update-check.js";

checkForUpdates();
await import("../mcp/server.js");
