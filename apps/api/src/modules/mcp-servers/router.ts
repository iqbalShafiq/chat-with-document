import { Hono } from "hono";
import z from "zod";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { prisma } from "../../utils/prisma.js";
import {
  MCP_TOOL_DESCRIPTION_MAX,
  McpInputError,
  createMcpServer,
  deleteMcpServer,
  getMcpCredentials,
  getMcpHeaders,
  listMcpServers,
  setMcpCredentials,
  setMcpHeaders,
  setMcpReview,
  setMcpServerEnabled,
  updateMcpServer,
} from "./service.js";
import { testMcpConnection } from "./test-connection.js";

const mcpHeaderSchema = z
  .object({
    name: z.string().max(128),
    value: z.string().max(2048),
  })
  .strict();

const mcpBodySchema = z
  .object({
    name: z.string().max(70),
    url: z.string().max(520),
    authType: z.enum(["none", "bearer"]),
    token: z.string().max(2048).optional(),
    headers: z.array(mcpHeaderSchema).max(16).optional(),
    allowedTools: z.array(z.string().max(128)).max(64).optional(),
    tools: z
      .array(
        z
          .object({
            name: z.string().max(128),
            description: z.string().max(MCP_TOOL_DESCRIPTION_MAX),
            parameters: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
  })
  .strict();

function notFound() {
  return { error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function duplicateName() {
  return {
    error: "An MCP server with this name already exists",
    issues: [{ path: "name", message: "An MCP server with this name already exists" }],
  };
}

/**
 * Public DTO: secrets stay server-side; only presence flags cross the wire
 * so the UI can show "stored" placeholders and clear actions.
 */
function toMcpDto(row: Record<string, unknown>) {
  const { credentialsRef: _credentials, headersRef: _headers, ...rest } = row;
  return {
    ...rest,
    hasCredentials: typeof _credentials === "string" && _credentials.length > 0,
    hasHeaders: typeof _headers === "string" && _headers.length > 0,
  };
}

export const mcpServersRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const user = c.get("user");
    return c.json(await listMcpServers(prisma, user.id));
  })
  .post("/", async (c) => {
    const user = c.get("user");
    const parsed = mcpBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid MCP server", code: "INVALID_MCP_SERVER" }, 400);
    }
    try {
      const created = (await createMcpServer(prisma, user.id, parsed.data)) as {
        id: string;
      };
      const token = parsed.data.token?.trim();
      if (parsed.data.authType === "bearer" && token) {
        await setMcpCredentials(prisma, user.id, created.id, token);
      }
      if (parsed.data.headers !== undefined) {
        await setMcpHeaders(prisma, user.id, created.id, parsed.data.headers);
      }
      if (parsed.data.allowedTools !== undefined || parsed.data.tools !== undefined) {
        await setMcpReview(prisma, user.id, created.id, {
          allowedTools: parsed.data.allowedTools ?? [],
          tools: parsed.data.tools ?? [],
        });
      }
      const row = await prisma.userMcpServer.findFirst({
        where: { id: created.id, userId: user.id },
      });
      if (!row) return c.json(notFound(), 404);
      return c.json(toMcpDto(row as Record<string, unknown>), 201);
    } catch (error) {
      if (error instanceof McpInputError) {
        return c.json({ error: error.message, issues: error.issues }, 400);
      }
      if (isUniqueViolation(error)) {
        return c.json(duplicateName(), 400);
      }
      throw error;
    }
  })
  .post("/test", async (c) => {
    // Dedicated non-strict schema: callers may include editor fields
    // (e.g. name) that the test itself does not need.
    const parsed = z
      .object({
        url: z.string().max(520),
        authType: z.enum(["none", "bearer"]),
        token: z.string().max(2048).optional(),
        headers: z
          .array(
            z.object({ name: z.string().max(128), value: z.string().max(2048) }).strict(),
          )
          .max(16)
          .optional(),
        serverId: z.string().max(256).optional(),
      })
      .safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid test body" });
    }
    const user = c.get("user");
    let token = parsed.data.token?.trim() || undefined;
    let headers = parsed.data.headers ?? [];
    // Editing an existing server reuses its stored secrets unless the editor
    // supplies fresh ones — the browser never sees stored values.
    if (parsed.data.serverId && (!token || headers.length === 0)) {
      const owned = await prisma.userMcpServer.findFirst({
        where: { id: parsed.data.serverId, userId: user.id },
        select: { id: true },
      });
      if (!owned) return c.json({ ok: false, error: "MCP server not found" });
      token ??= (await getMcpCredentials(prisma, user.id, owned.id)) ?? undefined;
      if (headers.length === 0) headers = await getMcpHeaders(prisma, user.id, owned.id);
    }
    return c.json(await testMcpConnection({ ...parsed.data, token, headers }));
  })
  .get("/:id", async (c) => {
    const user = c.get("user");
    const row = (await prisma.userMcpServer.findFirst({
      where: { id: c.req.param("id"), userId: user.id },
    })) as Record<string, unknown> | null;
    if (!row) return c.json(notFound(), 404);
    return c.json(toMcpDto(row));
  })
  .put("/:id", async (c) => {
    const user = c.get("user");
    const parsed = mcpBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid MCP server", code: "INVALID_MCP_SERVER" }, 400);
    }
    try {
      await updateMcpServer(
        prisma,
        user.id,
        c.req.param("id"),
        parsed.data,
      );
      const token = parsed.data.token?.trim();
      if (parsed.data.authType === "bearer" && token) {
        await setMcpCredentials(prisma, user.id, c.req.param("id"), token);
      } else if (parsed.data.authType === "none") {
        // Never retain a stale secret after switching away from bearer auth.
        await setMcpCredentials(prisma, user.id, c.req.param("id"), "");
      }
      if (parsed.data.headers !== undefined) {
        await setMcpHeaders(prisma, user.id, c.req.param("id"), parsed.data.headers);
      }
      if (parsed.data.allowedTools !== undefined || parsed.data.tools !== undefined) {
        await setMcpReview(prisma, user.id, c.req.param("id"), {
          allowedTools: parsed.data.allowedTools ?? [],
          tools: parsed.data.tools ?? [],
        });
      }
      const row = (await prisma.userMcpServer.findFirst({
        where: { id: c.req.param("id"), userId: user.id },
      })) as Record<string, unknown> | null;
      if (!row) return c.json(notFound(), 404);
      return c.json(toMcpDto(row));
    } catch (error) {
      if (error instanceof McpInputError) {
        const status = error.message === "MCP server not found" ? 404 : 400;
        return c.json(
          status === 404 ? notFound() : { error: error.message, issues: error.issues },
          status,
        );
      }
      if (isUniqueViolation(error)) {
        return c.json(duplicateName(), 400);
      }
      throw error;
    }
  })
  .patch("/:id/enabled", async (c) => {
    const user = c.get("user");
    const parsed = z.object({ isEnabled: z.boolean() }).safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "INVALID_MCP_SERVER" }, 400);
    }
    try {
      const updated = (await setMcpServerEnabled(
        prisma,
        user.id,
        c.req.param("id"),
        parsed.data.isEnabled,
      )) as Record<string, unknown>;
      return c.json(toMcpDto(updated));
    } catch (error) {
      if (error instanceof McpInputError) {
        return c.json(notFound(), 404);
      }
      throw error;
    }
  })
  .delete("/:id", async (c) => {
    const user = c.get("user");
    try {
      await deleteMcpServer(prisma, user.id, c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof McpInputError) {
        return c.json(notFound(), 404);
      }
      throw error;
    }
  });
