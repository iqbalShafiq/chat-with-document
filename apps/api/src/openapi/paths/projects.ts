import {
  ISO_EXAMPLE,
  PROJECT_ID_EXAMPLE,
  exampleProject,
  projectSchema,
} from "../components.js";
import {
  badRequest,
  bearerOrCookie,
  jsonResponse,
  jsonSchema,
  notFound,
  unauthorized,
} from "../helpers.js";

const projectPageSchema = {
  type: "object",
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: projectSchema },
    nextCursor: { type: ["string", "null"] },
  },
};

export const projectsPaths = {
  "/api/projects": {
    get: {
      operationId: "listProjects",
      tags: ["Projects"],
      summary: "List projects",
      description:
        "Projects owned by the current user. `sort` is `updatedAt` (default), `lastOpenedAt`, or `name`. Cursor format `{iso}|{projectId}` (not emitted for `sort=name`). Default `limit` 30, max 50.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "q",
          in: "query",
          schema: { type: "string" },
          example: "research",
        },
        {
          name: "cursor",
          in: "query",
          schema: { type: "string" },
          example: `${ISO_EXAMPLE}|${PROJECT_ID_EXAMPLE}`,
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 50 },
          example: 30,
        },
        {
          name: "sort",
          in: "query",
          schema: { type: "string", enum: ["updatedAt", "lastOpenedAt", "name"] },
          example: "updatedAt",
        },
      ],
      responses: {
        "200": jsonResponse("A page of projects.", projectPageSchema, {
          default: {
            summary: "One project",
            value: { items: [exampleProject], nextCursor: null },
          },
        }),
        "401": unauthorized,
      },
    },
    post: {
      operationId: "createProject",
      tags: ["Projects"],
      summary: "Create a project",
      description: "`name` is required (1–120 chars). `description` is optional (max 2000).",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 120 },
              description: { type: ["string", "null"], maxLength: 2000 },
            },
          },
          {
            default: {
              summary: "New project",
              value: {
                name: "Q3 research",
                description: "Papers for the quarterly review",
              },
            },
          },
        ),
      },
      responses: {
        "201": jsonResponse("Created.", projectSchema, {
          default: {
            summary: "Created",
            value: { ...exampleProject, documentCount: 0, chatCount: 0, lastOpenedAt: null },
          },
        }),
        "400": badRequest({ error: "name is required" }),
        "401": unauthorized,
      },
    },
  },
  "/api/projects/{id}": {
    get: {
      operationId: "getProject",
      tags: ["Projects"],
      summary: "Get a project",
      description: "Returns 404 when the project is missing or owned by someone else.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: PROJECT_ID_EXAMPLE,
        },
      ],
      responses: {
        "200": jsonResponse("Project detail.", projectSchema, {
          default: { summary: "Found", value: exampleProject },
        }),
        "401": unauthorized,
        "404": notFound({ error: "Project not found", code: "PROJECT_NOT_FOUND" }),
      },
    },
    patch: {
      operationId: "updateProject",
      tags: ["Projects"],
      summary: "Update a project",
      description:
        "Partial update. Omit a field to leave it unchanged. Send `description: null` to clear it.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: PROJECT_ID_EXAMPLE,
        },
      ],
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 120 },
              description: { type: ["string", "null"], maxLength: 2000 },
            },
          },
          {
            rename: {
              summary: "Rename only",
              value: { name: "Q3 research (archive)" },
            },
            clearDescription: {
              summary: "Clear description",
              value: { description: null },
            },
          },
        ),
      },
      responses: {
        "200": jsonResponse("Updated.", projectSchema, {
          default: {
            summary: "Renamed",
            value: { ...exampleProject, name: "Q3 research (archive)" },
          },
        }),
        "400": badRequest({ error: "name must be at most 120 characters" }),
        "401": unauthorized,
        "404": notFound({ error: "Project not found", code: "PROJECT_NOT_FOUND" }),
      },
    },
    delete: {
      operationId: "deleteProject",
      tags: ["Projects"],
      summary: "Permanently delete a project",
      description:
        "Cascade-deletes the project, its chats, and its documents. Requires `?confirm=true` or `{ \"confirm\": true }`.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: PROJECT_ID_EXAMPLE,
        },
        {
          name: "confirm",
          in: "query",
          schema: { type: "string", enum: ["true", "1"] },
          example: "true",
        },
      ],
      requestBody: {
        required: false,
        content: jsonSchema(
          {
            type: "object",
            properties: { confirm: { type: "boolean" } },
          },
          { default: { summary: "Confirm in body", value: { confirm: true } } },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Deleted.",
          {
            type: "object",
            required: ["deleted", "documentCount", "chatCount"],
            properties: {
              deleted: { type: "boolean", const: true },
              documentCount: { type: "integer" },
              chatCount: { type: "integer" },
            },
          },
          {
            default: {
              summary: "Deleted with cascade counts",
              value: { deleted: true, documentCount: 4, chatCount: 2 },
            },
          },
        ),
        "400": badRequest({
          error: "Cascade delete requires confirm=true",
          code: "CONFIRM_REQUIRED",
        }),
        "401": unauthorized,
        "404": notFound({ error: "Project not found", code: "PROJECT_NOT_FOUND" }),
      },
    },
  },
  "/api/projects/{id}/open": {
    post: {
      operationId: "openProject",
      tags: ["Projects"],
      summary: "Mark a project as opened",
      description: "Touches `lastOpenedAt` so the project sorts to the top of `sort=lastOpenedAt`.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: PROJECT_ID_EXAMPLE,
        },
      ],
      responses: {
        "200": jsonResponse("Updated project.", projectSchema, {
          default: { summary: "Opened", value: exampleProject },
        }),
        "401": unauthorized,
        "404": notFound({ error: "Project not found", code: "PROJECT_NOT_FOUND" }),
      },
    },
  },
};
