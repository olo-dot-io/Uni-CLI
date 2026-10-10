import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, resolve, sep } from "node:path";

export function findExecutable(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const windows = process.platform === "win32";
  const extensions =
    windows && !extname(binary)
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  const directories =
    binary.includes(sep) || (windows && binary.includes("/"))
      ? [""]
      : [
          ...new Set(
            (env.PATH ?? env.Path ?? "/usr/bin:/bin").split(delimiter),
          ),
        ];
  for (const directory of directories) {
    for (const extension of extensions) {
      const executable = resolve(directory, `${binary}${extension}`);
      try {
        if (!statSync(executable, { throwIfNoEntry: false })?.isFile()) {
          continue;
        }
        accessSync(executable, constants.X_OK);
        return executable;
      } catch {
        // Unusable PATH entries do not shadow a later executable.
      }
    }
  }
  return undefined;
}
