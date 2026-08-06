import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import {
  ProjectConfirmRequiredError,
  ProjectNotFoundError,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  openProject,
  updateProject,
} from "./service.js";

function parseConfirm(value: unknown): boolean {
  if (value === true || value === "true" || value === "1") return true;
  return false;
}

export const projectsRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const user = c.get("user");
    const page = await listProjects({
      userId: user.id,
      query: c.req.query("q") ?? undefined,
      cursor: c.req.query("cursor") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
      sort: c.req.query("sort") ?? undefined,
    });
    return c.json(page);
  })
  .post("/", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const name = typeof body?.name === "string" ? body.name : "";
    if (!name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }

    try {
      const project = await createProject({
        userId: user.id,
        name,
        description:
          typeof body?.description === "string" ? body.description : null,
      });
      return c.json(project, 201);
    } catch (error) {
      if (error instanceof Error && error.message.includes("name")) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  })
  .get("/:id", async (c) => {
    const user = c.get("user");
    try {
      const project = await getProject(user.id, c.req.param("id"));
      return c.json(project);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      throw error;
    }
  })
  .post("/:id/open", async (c) => {
    const user = c.get("user");
    try {
      const project = await openProject(user.id, c.req.param("id"));
      return c.json(project);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      throw error;
    }
  })
  .patch("/:id", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    try {
      const project = await updateProject({
        userId: user.id,
        projectId: c.req.param("id"),
        name: typeof body?.name === "string" ? body.name : undefined,
        description:
          body && "description" in body
            ? typeof body.description === "string"
              ? body.description
              : body.description === null
                ? null
                : undefined
            : undefined,
      });
      return c.json(project);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      if (error instanceof Error && error.message.includes("name")) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  })
  .delete("/:id", async (c) => {
    const user = c.get("user");
    const confirmQuery = c.req.query("confirm");
    let confirmBody = false;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      confirmBody = parseConfirm(body?.confirm);
    } catch {
      // DELETE may have empty body
    }
    const confirm = parseConfirm(confirmQuery) || confirmBody;

    try {
      const result = await deleteProject({
        userId: user.id,
        projectId: c.req.param("id"),
        confirm,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      if (error instanceof ProjectConfirmRequiredError) {
        return c.json({ error: error.message, code: error.code }, 400);
      }
      throw error;
    }
  });
