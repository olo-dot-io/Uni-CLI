import {
  acquireKernelFileLock,
  KernelFileLockError,
} from "../../src/browser/kernel-file-lock.js";

const mode = process.argv[2];
const path = process.argv[3];
if ((mode !== "hold" && mode !== "once") || !path) {
  throw new Error("Kernel lock helper requires hold|once and a lock path");
}

try {
  const lock = acquireKernelFileLock(path);
  process.stdout.write(
    `${JSON.stringify({ status: "acquired", pid: process.pid })}\n`,
  );
  if (mode === "once") {
    lock.release();
    process.exit(0);
  }
  process.on("SIGTERM", () => {
    lock.release();
    process.exit(0);
  });
  setInterval(() => undefined, 1_000);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      status: "failed",
      code: error instanceof KernelFileLockError ? error.code : "unexpected",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}
