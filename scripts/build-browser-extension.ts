import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

import { CHROME_EXTENSION_ID } from "../src/browser/chrome-native-protocol.js";

const repositoryRoot = join(import.meta.dirname, "..");
const extensionRoot = join(repositoryRoot, "extension");
const manifest = JSON.parse(
  readFileSync(join(extensionRoot, "manifest.json"), "utf8"),
) as { key?: string; background?: { service_worker?: string } };
if (!manifest.key) throw new Error("Chrome extension manifest key is missing");
const derivedId = createHash("sha256")
  .update(Buffer.from(manifest.key, "base64"))
  .digest()
  .subarray(0, 16)
  .toString("hex")
  .replace(/[0-9a-f]/g, (nibble) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)),
  );
if (derivedId !== CHROME_EXTENSION_ID) {
  throw new Error(
    `Chrome extension key derives ${derivedId}, expected ${CHROME_EXTENSION_ID}`,
  );
}
if (manifest.background?.service_worker !== "dist/background.js") {
  throw new Error("Chrome extension service worker must be dist/background.js");
}

const outputDirectory = join(extensionRoot, "dist");
rmSync(outputDirectory, { recursive: true, force: true });
await build({
  entryPoints: [join(extensionRoot, "src", "background.ts")],
  outfile: join(outputDirectory, "background.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
