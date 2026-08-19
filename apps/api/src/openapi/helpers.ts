export type JsonSchema = Record<string, unknown>;

export type MediaExample = {
  summary?: string;
  description?: string;
  value: unknown;
};

export function jsonSchema(
  schema: JsonSchema,
  examples: Record<string, MediaExample>,
) {
  return {
    "application/json": {
      schema,
      examples,
    },
  };
}

export function jsonResponse(
  description: string,
  schema: JsonSchema,
  examples: Record<string, MediaExample>,
) {
  return {
    description,
    content: jsonSchema(schema, examples),
  };
}

export function textResponse(
  description: string,
  mediaType: string,
  example: string,
) {
  return {
    description,
    content: {
      [mediaType]: {
        schema: { type: "string" },
        examples: {
          default: { value: example },
        },
      },
    },
  };
}

export const unauthorized = jsonResponse(
  "Missing or invalid session (cookie or Bearer token).",
  {
    type: "object",
    required: ["error", "code"],
    properties: {
      error: { type: "string" },
      code: { type: "string" },
    },
  },
  {
    missing: {
      summary: "No credentials",
      value: { error: "Unauthorized", code: "UNAUTHORIZED" },
    },
  },
);

export const forbidden = jsonResponse(
  "Authenticated but not allowed to access this resource.",
  {
    type: "object",
    required: ["error", "code"],
    properties: {
      error: { type: "string" },
      code: { type: "string" },
    },
  },
  {
    forbidden: {
      summary: "Wrong owner",
      value: { error: "forbidden", code: "FORBIDDEN" },
    },
  },
);

export const notFound = (example: { error: string; code?: string }) =>
  jsonResponse(
    "Resource not found or not owned by the current user.",
    {
      type: "object",
      required: ["error"],
      properties: {
        error: { type: "string" },
        code: { type: "string" },
      },
    },
    {
      missing: { summary: "Not found", value: example },
    },
  );

export const badRequest = (example: { error: string; code?: string }) =>
  jsonResponse(
    "The request is missing a required field or failed validation.",
    {
      type: "object",
      required: ["error"],
      properties: {
        error: { type: "string" },
        code: { type: "string" },
      },
    },
    {
      invalid: { summary: "Validation error", value: example },
    },
  );

export const conflict = (example: { error: string; code: string }) =>
  jsonResponse(
    "The request conflicts with the current resource state.",
    {
      type: "object",
      required: ["error", "code"],
      properties: {
        error: { type: "string" },
        code: { type: "string" },
      },
    },
    {
      conflict: { summary: "Conflict", value: example },
    },
  );

export const bearerOrCookie = [{ bearerAuth: [] }, { cookieAuth: [] }];
