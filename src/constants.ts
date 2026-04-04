/**
 * Single source of truth for version and project constants.
 *
 * All version references in code MUST import from here.
 * package.json is the canonical source — this file reads it at build time.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string; name: string };

/** Semantic version from package.json (e.g. "0.201.0") */
export const VERSION = pkg.version;

/** Short version for User-Agent headers (e.g. "0.201") */
export const VERSION_SHORT = VERSION.split(".").slice(0, 2).join(".");

/** User-Agent string for HTTP requests */
export const USER_AGENT = `Uni-CLI/${VERSION_SHORT}`;

/** Package name */
export const NAME = pkg.name;
