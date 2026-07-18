import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildIdentityDocument,
  computeWorktreeSourceIdentity,
} from "../src/runtime/source-identity.js";

const outputPath = resolve(process.cwd(), "dist", "build-identity.json");
const identity = buildIdentityDocument(
  computeWorktreeSourceIdentity(process.cwd()),
);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(identity, null, 2)}\n`, {
  encoding: "utf-8",
  mode: 0o600,
});
