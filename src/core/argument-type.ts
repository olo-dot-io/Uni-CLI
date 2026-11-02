/**
 * @owner       src::core::argument-type
 * @does        Maps a declared argument type to its JSON Schema type for every published schema surface.
 * @feeds       argument validation, command contracts, describe, MCP tool schemas, fast-path help and compute contracts.
 * @invariants  Has no imports, so the fast path can load it.
 */
export type JsonSchemaType =
  "string" | "array" | "integer" | "number" | "boolean" | ["string", "integer"];

export function jsonSchemaType(type: string | undefined): JsonSchemaType {
  switch (type) {
    case "str[]":
      return "array";
    case "int":
      return "integer";
    case "float":
      return "number";
    case "str-or-int":
      return ["string", "integer"];
    case "bool":
      return "boolean";
    default:
      return "string";
  }
}
