import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "..", "src", "adapters");

interface OfficeAdapter {
  site: string;
  name: string;
  description: string;
  type: string;
  strategy?: string;
  binary?: string;
  detect?: string;
  args?: Record<string, unknown>;
  pipeline: Array<Record<string, unknown>>;
  columns?: string[];
  capabilities?: string[];
  minimum_capability?: string;
  trust?: string;
  confidentiality?: string;
  quarantine?: boolean;
  schema_version?: string;
}

interface ExecStep {
  command?: string;
  args?: string[];
  parse?: string;
  timeout?: number;
  env?: Record<string, string>;
}

const COMMANDS = [
  { site: "word", name: "status", env: [], app: "Microsoft Word" },
  { site: "word", name: "list", env: [], app: "Microsoft Word" },
  { site: "word", name: "read", env: [], app: "Microsoft Word" },
  {
    site: "word",
    name: "insert-text",
    env: ["UNICLI_TEXT"],
    app: "Microsoft Word",
  },
  {
    site: "word",
    name: "set-font",
    env: ["UNICLI_FONT", "UNICLI_SIZE", "UNICLI_TEXT"],
    app: "Microsoft Word",
  },
  {
    site: "word",
    name: "insert-link",
    env: ["UNICLI_URL", "UNICLI_TEXT"],
    app: "Microsoft Word",
  },
  {
    site: "word",
    name: "insert-image",
    env: ["UNICLI_IMAGE_PATH"],
    app: "Microsoft Word",
  },
  { site: "excel", name: "status", env: [], app: "Microsoft Excel" },
  { site: "excel", name: "list", env: [], app: "Microsoft Excel" },
  { site: "excel", name: "read", env: ["UNICLI_CELL"], app: "Microsoft Excel" },
  {
    site: "excel",
    name: "set-cell",
    env: ["UNICLI_CELL", "UNICLI_VALUE"],
    app: "Microsoft Excel",
  },
  {
    site: "excel",
    name: "set-font",
    env: ["UNICLI_FONT", "UNICLI_SIZE", "UNICLI_CELL"],
    app: "Microsoft Excel",
  },
  {
    site: "excel",
    name: "insert-link",
    env: ["UNICLI_URL", "UNICLI_TEXT", "UNICLI_CELL"],
    app: "Microsoft Excel",
  },
  {
    site: "excel",
    name: "insert-image",
    env: ["UNICLI_IMAGE_PATH", "UNICLI_CELL"],
    app: "Microsoft Excel",
  },
  { site: "powerpoint", name: "status", env: [], app: "Microsoft PowerPoint" },
  { site: "powerpoint", name: "list", env: [], app: "Microsoft PowerPoint" },
  { site: "powerpoint", name: "slides", env: [], app: "Microsoft PowerPoint" },
  {
    site: "powerpoint",
    name: "add-slide",
    env: ["UNICLI_TITLE", "UNICLI_BODY"],
    app: "Microsoft PowerPoint",
  },
  {
    site: "powerpoint",
    name: "set-font",
    env: ["UNICLI_FONT", "UNICLI_SIZE", "UNICLI_TEXT"],
    app: "Microsoft PowerPoint",
  },
  {
    site: "powerpoint",
    name: "insert-link",
    env: ["UNICLI_URL", "UNICLI_TEXT"],
    app: "Microsoft PowerPoint",
  },
  {
    site: "powerpoint",
    name: "insert-image",
    env: ["UNICLI_IMAGE_PATH"],
    app: "Microsoft PowerPoint",
  },
] as const;

const STATUS_COMMANDS = new Set([
  "word/status",
  "excel/status",
  "powerpoint/status",
]);

function loadAdapter(site: string, name: string): OfficeAdapter {
  const raw = readFileSync(join(ADAPTERS_DIR, site, `${name}.yaml`), "utf-8");
  return yaml.load(raw) as OfficeAdapter;
}

function execStep(adapter: OfficeAdapter): ExecStep {
  expect(adapter.pipeline).toHaveLength(1);
  const step = adapter.pipeline[0].exec as ExecStep | undefined;
  expect(step, `${adapter.site}/${adapter.name} must use exec`).toBeTruthy();
  return step!;
}

function joinedScript(step: ExecStep): string {
  return (step.args ?? []).join("\n");
}

describe("Microsoft Office desktop adapters", () => {
  for (const command of COMMANDS) {
    const key = `${command.site}/${command.name}`;

    describe(key, () => {
      const adapter = loadAdapter(command.site, command.name);
      const step = execStep(adapter);
      const script = joinedScript(step);

      it("declares the expected adapter contract", () => {
        expect(adapter.site).toBe(command.site);
        expect(adapter.name).toBe(command.name);
        expect(adapter.type).toBe("desktop");
        expect(adapter.strategy).toBe("public");
        expect(adapter.binary).toBe("osascript");
        expect(adapter.detect).toBe("test $(uname) = Darwin");
        expect(adapter.capabilities).toEqual(["subprocess.exec"]);
        expect(adapter.minimum_capability).toBe("subprocess.exec");
        expect(adapter.trust).toBe("user");
        expect(adapter.confidentiality).toBe("private");
        expect(adapter.quarantine).toBe(false);
        expect(adapter.schema_version).toBe("v2");
      });

      it("runs osascript with bounded JSON output", () => {
        expect(step.command).toBe("osascript");
        expect(step.parse).toBe("json");
        expect(typeof step.timeout).toBe("number");
        expect(step.timeout).toBeGreaterThan(0);
        expect(step.timeout).toBeLessThanOrEqual(30000);
        expect(script).toContain(command.app);
        expect(adapter.columns?.length).toBeGreaterThan(0);
      });

      it("keeps user input out of AppleScript literals", () => {
        for (const envName of command.env) {
          expect(step.env?.[envName]).toBeTruthy();
          expect(script).toContain(`system attribute "${envName}"`);
        }
      });

      if (STATUS_COMMANDS.has(key)) {
        it("status avoids Office document enumeration", () => {
          expect(step.args).toContain("JavaScript");
          expect(script).toContain(".running()");
          expect(script).not.toMatch(/documents|workbooks|presentations/i);
        });
      }

      if (key === "word/insert-text") {
        it("inserts at a range instead of rewriting the document body", () => {
          expect(script).toContain("create range d start endPos end endPos");
          expect(script).toContain(
            "set content of insertionRange to insertText",
          );
          expect(script).not.toContain("set content of text object of d");
          expect(script).not.toContain(
            "insert text insertText at insertionRange",
          );
        });
      }

      if (key === "powerpoint/add-slide") {
        it("creates slides through the presentation object", () => {
          expect(script).toContain(
            "make new slide at end of p with properties",
          );
          expect(script).not.toContain("make new slide at end of slides of p");
        });

        it("does not report success when placeholder writes fail", () => {
          expect(script).toContain("wroteTitle");
          expect(script).toContain("wroteBody");
          expect(script).toContain("repeat with i from 1 to count shapes");
          expect(script).toContain("set shp to shape i of newSlide");
          expect(script).toContain(
            'error "PowerPoint created slide without a writable title placeholder"',
          );
          expect(script).not.toMatch(
            /try\s+set content of text range of text frame of shape/s,
          );
        });
      }

      if (key === "powerpoint/slides") {
        it("enumerates shapes by index to avoid PowerPoint object specifier stalls", () => {
          expect(script).toContain("repeat with j from 1 to count shapes of s");
          expect(script).toContain("set shp to shape j of s");
          expect(script).not.toContain("repeat with shp in shapes of s");
        });
      }

      if (key.endsWith("/set-font")) {
        it("applies font through Office font objects", () => {
          expect(script).toContain('system attribute "UNICLI_FONT"');
          expect(script).toContain('system attribute "UNICLI_SIZE"');
          expect(script).toMatch(/font object|font of tr/);
        });
      }

      if (key === "word/set-font") {
        it("does not let East Asian font assignment block the main font", () => {
          expect(script).toMatch(
            /try\s+set east asian name of f to fontName\s+end try/,
          );
        });
      }

      if (key.endsWith("/insert-image")) {
        it("inserts local images without remote links", () => {
          expect(script).toContain('system attribute "UNICLI_IMAGE_PATH"');
          expect(script).toContain("quoted form of imagePath");
          expect(script).not.toContain("http://");
          expect(script).not.toContain("https://");
        });
      }

      if (key === "excel/insert-image") {
        it("uses Excel worksheet background instead of unverifiable clipboard paste", () => {
          expect(script).toContain(
            "set background picture sh picture file name imagePath",
          );
          expect(script).not.toContain("paste worksheet");
        });
      }

      if (key.endsWith("/insert-link")) {
        it("creates document-native links without fetching the URL", () => {
          expect(script).toContain('system attribute "UNICLI_URL"');
          expect(script).not.toContain("curl");
          expect(script).not.toContain("fetch");
        });
      }

      if (key === "word/insert-link") {
        it("can set the hyperlink display text", () => {
          expect(script).toContain('system attribute "UNICLI_TEXT"');
          expect(script).toContain("set content of result range of linkField");
        });
      }
    });
  }
});
