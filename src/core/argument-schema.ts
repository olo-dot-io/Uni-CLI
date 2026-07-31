/**
 * @owner src/core/argument-schema.ts
 * @does Project one argument contract into JSON Schema, examples, and one strict pre-dispatch validator.
 * @needs ajv 2020-12 and ajv-formats
 * @feeds adapter kernel compilation and compute routing
 * @breaks Contract drift here changes validation across CLI, MCP, ACP, and compute entry points.
 * @invariants Unknown keys and malformed values fail before substrate acquisition; schema and validator are built from the same fields.
 * @side-effects Lazily allocates one process-wide AJV instance.
 * @perf O(argument count) compilation once per command, O(input keys) validation per invocation.
 * @concurrency Compiled validators are immutable after construction.
 * @test tests/unit/kernel-stage-parity.test.ts and tests/unit/compute-contracts.test.ts
 * @stability stable
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export interface ArgumentDefinition {
  readonly name: string;
  readonly type?:
    | "str"
    | "str[]"
    | "int"
    | "float"
    | "nullable-float"
    | "str-or-int"
    | "bool";
  readonly default?: unknown;
  readonly required?: boolean;
  readonly choices?: readonly string[];
  readonly description?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly "x-unicli-kind"?: string;
  readonly "x-unicli-accepts"?: readonly string[];
  readonly "x-unicli-uri-origins"?: readonly string[];
  readonly "x-unicli-uri-path-pattern"?: string;
}

export interface ArgumentValidationError {
  instancePath?: string;
  keyword?: string;
  message?: string;
  params?: Record<string, unknown>;
}

export interface CompiledArgumentSchema {
  jsonSchema: Record<string, unknown>;
  validate: (
    input: unknown,
  ) => { ok: true } | { ok: false; errors: readonly ArgumentValidationError[] };
}

type AjvValidateFn = {
  (data: unknown): boolean;
  errors?: ArgumentValidationError[] | null;
};

type AjvCtor = new (opts: {
  strict: boolean;
  allErrors: boolean;
  validateFormats: boolean;
  allowUnionTypes: boolean;
}) => {
  compile(schema: unknown): AjvValidateFn;
};

let ajvSingleton: InstanceType<AjvCtor> | undefined;

function getAjv(): InstanceType<AjvCtor> {
  if (ajvSingleton) return ajvSingleton;
  const Ctor = ((Ajv2020 as unknown as { default?: unknown }).default ??
    Ajv2020) as AjvCtor;
  const addFormatsFn = ((addFormats as unknown as { default?: unknown })
    .default ?? addFormats) as (
    ajv: unknown,
    opts?: { mode?: "fast" | "full" },
  ) => void;
  ajvSingleton = new Ctor({
    strict: true,
    allErrors: false,
    validateFormats: true,
    allowUnionTypes: true,
  });
  addFormatsFn(ajvSingleton, { mode: "full" });
  return ajvSingleton;
}

function jsonSchemaType(type: ArgumentDefinition["type"]): string | string[] {
  switch (type) {
    case "str[]":
      return "array";
    case "int":
      return "integer";
    case "float":
      return "number";
    case "nullable-float":
      return ["number", "null"];
    case "str-or-int":
      return ["string", "integer"];
    case "bool":
      return "boolean";
    default:
      return "string";
  }
}

export function buildArgumentJsonSchema(
  args: readonly ArgumentDefinition[],
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const arg of args) {
    const property: Record<string, unknown> = {
      type: jsonSchemaType(arg.type),
    };
    if (arg.type === "str[]") property.items = { type: "string" };
    if (arg.description) property.description = arg.description;
    if (arg.default !== undefined) property.default = arg.default;
    if (arg.choices && arg.choices.length > 0) {
      property.enum = [...arg.choices];
    }
    if (arg.format) property.format = arg.format;
    if (arg.minLength !== undefined) property.minLength = arg.minLength;
    if (arg.maxLength !== undefined) property.maxLength = arg.maxLength;
    if (arg.minimum !== undefined) property.minimum = arg.minimum;
    if (arg.maximum !== undefined) property.maximum = arg.maximum;
    if (arg.pattern !== undefined) property.pattern = arg.pattern;

    const extension: Record<string, unknown> = {};
    if (arg["x-unicli-kind"]) extension.kind = arg["x-unicli-kind"];
    if (arg["x-unicli-accepts"]) {
      extension.accepts = [...arg["x-unicli-accepts"]];
    }
    if (arg["x-unicli-uri-origins"]) {
      extension.uriOrigins = [...arg["x-unicli-uri-origins"]];
    }
    if (arg["x-unicli-uri-path-pattern"]) {
      extension.uriPathPattern = arg["x-unicli-uri-path-pattern"];
    }
    if (Object.keys(extension).length > 0) {
      property["x-unicli"] = extension;
    }

    properties[arg.name] = property;
    if (arg.required) required.push(arg.name);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function buildArgumentExample(
  args: readonly ArgumentDefinition[],
): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const arg of args) {
    if (arg.default !== undefined) {
      example[arg.name] = arg.default;
      continue;
    }
    if (arg.choices && arg.choices.length > 0) {
      example[arg.name] = arg.choices[0];
      continue;
    }
    switch (arg.type) {
      case "str[]":
        example[arg.name] = ["value"];
        break;
      case "int":
        example[arg.name] = 10;
        break;
      case "float":
      case "nullable-float":
        example[arg.name] = 0.5;
        break;
      case "bool":
        example[arg.name] = false;
        break;
      default:
        example[arg.name] = `<${arg.name}>`;
    }
  }
  return example;
}

export function compileArgumentSchema(
  args: readonly ArgumentDefinition[],
): CompiledArgumentSchema {
  const jsonSchema = buildArgumentJsonSchema(args);
  const validatorSchema = JSON.parse(JSON.stringify(jsonSchema)) as Record<
    string,
    unknown
  >;
  const properties = validatorSchema.properties as Record<
    string,
    Record<string, unknown>
  >;
  for (const property of Object.values(properties)) {
    delete property["x-unicli"];
  }
  const validator = getAjv().compile(validatorSchema);
  return {
    jsonSchema,
    validate(input: unknown) {
      if (validator(input)) return { ok: true };
      return {
        ok: false,
        errors: validator.errors ?? [],
      };
    },
  };
}
