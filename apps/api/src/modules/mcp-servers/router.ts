import { Hono } from "hono";
import z from "zod";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { prisma } from "../../utils/prisma.js";
import {
  McpInputError,
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  setMcpCredentials,
  setMcpReview,
  setMcpServerEnabled,
  updateMcpServer,
} from "./service.js";
import { testMcpConnection } from "./test-connection.js";

const mcpBodySchema = z
  .object({
    name: z.string().max(70),
    url: z.string().max(520),
    authType: z.enum(["none", "bearer"]),
    token: z.string().max(2048).optional(),
    allowedTools: z.array(z.string().max(128)).max(64).optional(),
    tools: z
      .array(
        z
          .object({
            name: z.string().max(128),
            description: z.string().max(2000),
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
        // v1 stores the token server-side only (see credentialsRef); at-rest
        // encryption moves with the gateway-broker milestone. Never echoed.
        await setMcpCredentials(prisma, user.id, created.id, token);
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
      const { credentialsRef: _dropped, ...rest } = (row ?? created) as Record<string, unknown>;
      return c.json(rest, 201);
    } catch (error) {
      if (error instanceof McpInputError) {
        return c.json({ error: error.message, issues: error.issues }, 400);
      }
      throw error;
    }
  })
  .post("/test", async (c) => {
    const parsed = mcpBodySchema
      .pick({ url: true, authType: true, token: true })
      .safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid test body" });
    }
    return c.json(await testMcpConnection(parsed.data));
  })
  .get("/:id", async (c) => {
    const user = c.get("user");
    const row = (await prisma.userMcpServer.findFirst({
      where: { id: c.req.param("id"), userId: user.id },
    })) as Record<string, unknown> | null;
    if (!row) return c.json(notFound(), 404);
    const { credentialsRef: _dropped, ...rest } = row;
    return c.json(rest);
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
      const { credentialsRef: _dropped, ...rest } = row;
      return c.json(rest);
    } catch (error) {
      if (error instanceof McpInputError) {
        const status = error.message === "MCP server not found" ? 404 : 400;
        return c.json(
          status === 404 ? notFound() : { error: error.message, issues: error.issues },
          status,
        );
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
      const { credentialsRef: _dropped, ...rest } = updated;
      return c.json(rest);
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
