import type { ToolDefinition } from "@anvia/core";
import { z } from "zod";
import type { ZodType } from "zod";

export type { ToolDefinition } from "@anvia/core";

/**
 * Build a provider JSON tool descriptor without constructing a provider,
 * database, MCP, or other execution handle. Runtime factories should reuse
 * the same name/description/input schema so the frozen recipe surface can be
 * compared with the reconstructed Agent surface.
 */
export function createStaticToolDefinition(input: {
  name: string;
  description: string;
  inputSchema: ZodType;
}): ToolDefinition {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(input.inputSchema);
  return {
    name: input.name,
    description: input.description,
    parameters: parameters as ToolDefinition["parameters"],
  };
}
