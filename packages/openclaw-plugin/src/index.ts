import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// --- OpenClaw Plugin API types (defined locally to avoid hard dep) ---

interface PluginApi {
  registerTool(
    name: string,
    config: {
      description: string;
      inputSchema: Record<string, unknown>;
      handler: (args: Record<string, unknown>) => Promise<unknown>;
    },
  ): void;
}

interface PluginContext {
  api: PluginApi;
}

type PluginEntry = (context: PluginContext) => void;

// --- Helpers ---

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
const VALID_TYPES = new Set(["web-api", "desktop", "browser", "bridge", "service"]);
const EXEC_TIMEOUT = 30_000;

function validateName(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    throw new Error(
      `Invalid ${label}: must match /^[a-zA-Z0-9_-]+$/, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

async function run(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync("unicli", args, {
    timeout: EXEC_TIMEOUT,
    encoding: "utf-8",
  });
  return JSON.parse(stdout);
}

// --- Plugin entry ---

const plugin: PluginEntry = ({ api }) => {
  // Tool 1: unicli_run — execute any Uni-CLI command
  api.registerTool("unicli_run", {
    description:
      "Execute a Uni-CLI command. 200 sites, 969 commands. Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        site: {
          type: "string",
          description: "Site name (e.g. twitter, bilibili, hackernews)",
        },
        command: {
          type: "string",
          description: "Command name (e.g. search, hot, top)",
        },
        args: {
          type: "object",
          description: "Command arguments as key-value pairs",
          additionalProperties: true,
        },
        limit: {
          type: "integer",
          description: "Max results (default 20)",
        },
      },
      required: ["site", "command"],
    },
    handler: async (params) => {
      const site = validateName(params.site, "site");
      const command = validateName(params.command, "command");
      const rawArgs = (params.args as Record<string, string> | undefined) ?? {};
      const limit = params.limit as number | undefined;

      const cliArgs = [site, command, "--json"];
      if (limit != null) {
        cliArgs.push("--limit", String(limit));
      }
      for (const [k, v] of Object.entries(rawArgs)) {
        cliArgs.push(`--${k}`, String(v));
      }

      return run(cliArgs);
    },
  });

  // Tool 2: unicli_list — list available sites and commands
  api.registerTool("unicli_list", {
    description:
      "List available Uni-CLI sites and commands. Filter by site or adapter type.",
    inputSchema: {
      type: "object",
      properties: {
        site: {
          type: "string",
          description: "Filter to a specific site (e.g. twitter)",
        },
        type: {
          type: "string",
          enum: ["web-api", "desktop", "browser", "bridge", "service"],
          description: "Filter by adapter type",
        },
      },
    },
    handler: async (params) => {
      const cliArgs = ["list", "--json"];
      if (typeof params.site === "string" && params.site) {
        cliArgs.push("--site", validateName(params.site, "site"));
      }
      if (typeof params.type === "string" && params.type) {
        if (!VALID_TYPES.has(params.type)) {
          throw new Error(`Invalid type: must be one of ${[...VALID_TYPES].join(", ")}`);
        }
        cliArgs.push("--type", params.type);
      }
      return run(cliArgs);
    },
  });

  // Tool 3: unicli_discover — auto-discover capabilities for a URL
  api.registerTool("unicli_discover", {
    description:
      "Auto-discover API endpoints and capabilities for any URL. Useful for building new adapters.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Target URL to discover (e.g. https://example.com)",
        },
        goal: {
          type: "string",
          description:
            "What you want to achieve (e.g. 'get trending posts')",
        },
      },
      required: ["url"],
    },
    handler: async (params) => {
      const url = params.url as string;
      if (typeof url !== "string" || !url.startsWith("http")) {
        throw new Error(`Invalid url: must start with http(s), got ${JSON.stringify(url)}`);
      }

      const cliArgs = ["generate", url, "--json"];
      if (typeof params.goal === "string" && params.goal) {
        cliArgs.push("--goal", params.goal);
      }
      return run(cliArgs);
    },
  });
};

export default plugin;
