import {
  badRequest,
  bearerOrCookie,
  jsonResponse,
  notFound,
  unauthorized,
} from "../helpers.js";

const mcpDto = {
  type: "object",
  required: ["id", "name", "url", "authType", "isEnabled", "status"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    url: { type: "string" },
    authType: { type: "string" },
    isEnabled: { type: "boolean" },
    status: { type: "string" },
  },
};

const mcpExample = {
  default: {
    summary: "Example MCP server",
    value: {
      id: "cuid123",
      name: "docs",
      url: "https://mcp.example.com/mcp",
      authType: "none",
      isEnabled: true,
      status: "ok",
    },
  },
};

const testResultSchema = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    tools: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
};

export const mcpServersPaths = {
  "/api/mcp-servers": {
    get: {
      operationId: "listMcpServers",
      tags: ["McpServers"],
      summary: "List the user's MCP servers",
      description: "All MCP servers owned by the signed-in user, newest first. Credentials are never included.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse("MCP servers.", { type: "array", items: mcpDto }, { default: { summary: "Servers", value: [] } }),
        "401": unauthorized,
      },
    },
    post: {
      operationId: "createMcpServer",
      tags: ["McpServers"],
      summary: "Register an MCP server",
      description: "Validates the https URL without opening a connection, then stores the server as untested.",
      security: bearerOrCookie,
      responses: {
        "201": jsonResponse("Created server.", mcpDto, mcpExample),
        "400": badRequest({ error: "Invalid MCP server" }),
        "401": unauthorized,
      },
    },
  },
  "/api/mcp-servers/test": {
    post: {
      operationId: "testMcpConnection",
      tags: ["McpServers"],
      summary: "Test an MCP connection without saving",
      description: "Opens a 15s StreamableHTTP connection, lists tools, closes, and reports. Nothing is persisted.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Test result.",
          testResultSchema,
          { default: { summary: "Reachable", value: { ok: true, tools: [] } } },
        ),
        "401": unauthorized,
      },
    },
  },
  "/api/mcp-servers/{id}": {
    get: {
      operationId: "getMcpServer",
      tags: ["McpServers"],
      summary: "Read one MCP server",
      description: "A single owned server. Credentials are never included.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse("Server.", mcpDto, mcpExample),
        "401": unauthorized,
        "404": notFound({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" }),
      },
    },
    put: {
      operationId: "updateMcpServer",
      tags: ["McpServers"],
      summary: "Replace an MCP server",
      description: "Re-validates the URL and resets status to untested.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse("Updated server.", mcpDto, mcpExample),
        "400": badRequest({ error: "Invalid MCP server" }),
        "401": unauthorized,
        "404": notFound({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" }),
      },
    },
    delete: {
      operationId: "deleteMcpServer",
      tags: ["McpServers"],
      summary: "Delete an MCP server",
      description: "Permanently removes the server; later runs no longer see it.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Deleted.",
          {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          { default: { summary: "Deleted", value: { ok: true } } },
        ),
        "401": unauthorized,
        "404": notFound({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" }),
      },
    },
  },
  "/api/mcp-servers/{id}/enabled": {
    patch: {
      operationId: "setMcpServerEnabled",
      tags: ["McpServers"],
      summary: "Toggle an MCP server's global default",
      description: "Flips isEnabled, the per-user default that per-chat selection starts from.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse("Updated server.", mcpDto, mcpExample),
        "400": badRequest({ error: "Invalid body" }),
        "401": unauthorized,
        "404": notFound({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" }),
      },
    },
  },
};
