import { stepFetch } from "../../engine/steps/fetch.js";
import { cli, Strategy } from "../../registry.js";
import type { AdapterArg } from "../../types.js";

const API_BASE = "https://openrouter.ai/api/v1";
const SORTS = [
  "most-popular",
  "newest",
  "top-weekly",
  "pricing-low-to-high",
  "pricing-high-to-low",
  "context-high-to-low",
  "throughput-high-to-low",
  "latency-low-to-high",
  "intelligence-high-to-low",
  "coding-high-to-low",
  "agentic-high-to-low",
  "design-arena-elo-high-to-low",
];

interface Model {
  id: string;
  name?: string;
  canonical_slug?: string;
  context_length?: number;
  created?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

function invalidInput(message: string): Error {
  return Object.assign(new Error(message), {
    code: "invalid_input",
    suggestion:
      "Use the arguments listed by unicli describe openrouter models.",
    retryable: false,
  });
}

function requireInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw invalidInput(`${name} must be an integer in [${min}, ${max}].`);
  }
  return number;
}

async function fetchModels(
  path: string,
  command: string,
  fresh: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const result = await stepFetch(
    {
      data: null,
      args: {},
      vars: {},
      site: "openrouter",
      command,
      signal,
      canMutate: false,
    },
    {
      url: `${API_BASE}${path}`,
      // Public endpoint freshness bounds match OpenRouter's Cache-Control max-age.
      cache: fresh === true ? 0 : command === "model" ? 300 : 120,
    },
    0,
  );
  if (!result.data || typeof result.data !== "object") {
    throw Object.assign(
      new Error("OpenRouter returned an invalid model response."),
      { code: "upstream_error" },
    );
  }
  return result.data as Record<string, unknown>;
}

function summaryRow(model: Model): Record<string, unknown> {
  if (!model || typeof model.id !== "string" || !model.id) {
    throw Object.assign(
      new Error("OpenRouter returned a model without its identifier."),
      { code: "upstream_error" },
    );
  }
  return {
    id: model.id,
    name: model.name,
    canonical_slug: model.canonical_slug,
    context_length: model.context_length,
    pricing_prompt: model.pricing?.prompt,
    pricing_completion: model.pricing?.completion,
    pricing_unit: "USD/token",
    created: model.created,
    input_modalities: model.architecture?.input_modalities,
    output_modalities: model.architecture?.output_modalities,
    supported_parameters: model.supported_parameters,
    url: `https://openrouter.ai/${model.id}`,
  };
}

const freshArg: AdapterArg = {
  name: "fresh",
  type: "bool",
  default: false,
  description: "Bypass the local public-model response cache",
};

for (const name of ["models", "search"] as const) {
  const defaultLimit = name === "models" ? 30 : 20;
  cli({
    site: "openrouter",
    name,
    description:
      name === "models"
        ? "List available AI models on OpenRouter"
        : "Search OpenRouter AI models",
    domain: "openrouter.ai",
    strategy: Strategy.PUBLIC,
    operation_family: name === "search" ? "search" : "list",
    operation_effect: "read",
    execution_operator: "structured-api",
    args: [
      {
        name: "query",
        type: "str",
        positional: name === "search",
        description: "Search by model name or provider/model slug",
      },
      {
        name: "limit",
        type: "int",
        default: defaultLimit,
        minimum: 1,
        maximum: 1000,
        description: "Maximum models per page",
      },
      {
        name: "offset",
        type: "int",
        default: 0,
        minimum: 0,
        description: "Number of matching models to skip",
      },
      {
        name: "sort",
        type: "str",
        choices: SORTS,
        description:
          "Server-side model ordering; omission preserves the upstream order",
      },
      freshArg,
    ],
    columns: [
      "id",
      "name",
      "context_length",
      "pricing_prompt",
      "pricing_completion",
      "url",
    ],
    capabilities: ["http.fetch"],
    ...(name === "search"
      ? {
          retrieval: {
            operation: "discover" as const,
            result_kind: "model" as const,
            source_class: "hosted-artifact" as const,
            arguments: { query: "query", limit: "limit" },
          },
        }
      : {}),
    func: async (_page, kwargs, context) => {
      const limit = requireInteger(
        kwargs.limit,
        defaultLimit,
        1,
        1000,
        "limit",
      );
      const offset = requireInteger(
        kwargs.offset,
        0,
        0,
        Number.MAX_SAFE_INTEGER,
        "offset",
      );
      const sort = String(kwargs.sort ?? "").trim();
      if (sort && !SORTS.includes(sort))
        throw invalidInput(`Unsupported model sort ${sort}.`);
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      const query = String(kwargs.query ?? "").trim();
      if (query) params.set("q", query);
      if (sort) params.set("sort", sort);
      const body = await fetchModels(
        `/models?${params}`,
        name,
        kwargs.fresh,
        context.signal,
      );
      if (!Array.isArray(body.data)) {
        throw Object.assign(
          new Error("OpenRouter response is missing its model list."),
          { code: "upstream_error" },
        );
      }
      const models = body.data as Model[];
      const links = body.links as { next?: unknown } | undefined;
      const nextOffset =
        typeof links?.next === "string" ? offset + models.length : null;
      return models.map((model, index) => ({
        ...summaryRow(model),
        ...(name === "search"
          ? {
              context: String(model.context_length ?? ""),
              prompt_price: model.pricing?.prompt ?? "",
              completion_price: model.pricing?.completion ?? "",
            }
          : { context_length: String(model.context_length ?? "") }),
        rank: offset + index + 1,
        total_count: body.total_count,
        next_offset: nextOffset,
      }));
    },
  });
}

cli({
  site: "openrouter",
  name: "model",
  description: "Get full metadata for an OpenRouter model or model alias",
  domain: "openrouter.ai",
  strategy: Strategy.PUBLIC,
  operation_family: "get",
  operation_effect: "read",
  execution_operator: "structured-api",
  args: [
    {
      name: "id",
      type: "str",
      positional: true,
      required: true,
      description: "Provider/model slug, including an optional variant suffix",
    },
    freshArg,
  ],
  columns: [
    "id",
    "name",
    "description",
    "context_length",
    "pricing",
    "supported_parameters",
    "url",
  ],
  capabilities: ["http.fetch"],
  func: async (_page, kwargs, context) => {
    const id = String(kwargs.id ?? "").trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:+-]+$/.test(id)) {
      throw invalidInput(
        "Model id must use provider/model syntax, such as openai/gpt-5.",
      );
    }
    const body = await fetchModels(
      `/model/${id.split("/").map(encodeURIComponent).join("/")}`,
      "model",
      kwargs.fresh,
      context.signal,
    );
    if (
      !body.data ||
      typeof body.data !== "object" ||
      typeof (body.data as Model).id !== "string"
    ) {
      throw Object.assign(
        new Error("OpenRouter response is missing its model."),
        { code: "upstream_error" },
      );
    }
    return [{ ...body.data, ...summaryRow(body.data as Model) }];
  },
});
