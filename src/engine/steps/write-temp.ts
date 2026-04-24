import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";

export interface WriteTempConfig {
  filename: string;
  content: string;
}

export function stepWriteTemp(
  ctx: PipelineContext,
  config: WriteTempConfig,
): PipelineContext {
  const td =
    ctx.tempDir ?? join(tmpdir(), `unicli-${randomBytes(6).toString("hex")}`);
  mkdirSync(td, { recursive: true });

  const filename = evalTemplate(config.filename, ctx);
  const content = evalTemplate(config.content, ctx);
  const filePath = join(td, filename);

  writeFileSync(filePath, content, "utf-8");

  const key = filename.replace(/[^a-zA-Z0-9]/g, "_");
  const temp = { ...ctx.temp, [key]: filePath };

  return { ...ctx, temp, tempDir: td };
}

registerStep("write_temp", stepWriteTemp as StepHandler);
