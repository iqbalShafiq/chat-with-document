import { Hono } from "hono";
import z from "zod";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { prisma } from "../../utils/prisma.js";
import {
  SkillInputError,
  createSkill,
  deleteSkill,
  listSkills,
  setSkillEnabled,
  updateSkill,
} from "./service.js";

const skillBodySchema = z
  .object({
    name: z.string().max(70),
    description: z.string().max(1100),
    bodyMd: z.string().max(17000),
  })
  .strict();

function notFound() {
  return { error: "Skill not found", code: "SKILL_NOT_FOUND" };
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
    error: "A skill with this name already exists",
    issues: [{ path: "name", message: "A skill with this name already exists" }],
  };
}

export const skillsRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const user = c.get("user");
    return c.json(await listSkills(prisma, user.id));
  })
  .post("/", async (c) => {
    const user = c.get("user");
    const parsed = skillBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid skill", code: "INVALID_SKILL" }, 400);
    }
    try {
      return c.json(await createSkill(prisma, user.id, parsed.data), 201);
    } catch (error) {
      if (error instanceof SkillInputError) {
        return c.json(
          { error: error.message, issues: error.issues },
          400,
        );
      }
      if (isUniqueViolation(error)) {
        return c.json(duplicateName(), 400);
      }
      throw error;
    }
  })
  .get("/:id", async (c) => {
    const user = c.get("user");
    const row = await prisma.userSkill.findFirst({
      where: { id: c.req.param("id"), userId: user.id },
    });
    if (!row) return c.json(notFound(), 404);
    return c.json(row);
  })
  .put("/:id", async (c) => {
    const user = c.get("user");
    const parsed = skillBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid skill", code: "INVALID_SKILL" }, 400);
    }
    try {
      return c.json(
        await updateSkill(prisma, user.id, c.req.param("id"), parsed.data, {
          markReviewed: true,
        }),
      );
    } catch (error) {
      if (error instanceof SkillInputError) {
        const status = error.message === "Skill not found" ? 404 : 400;
        return c.json(
          status === 404
            ? notFound()
            : { error: error.message, issues: error.issues },
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
      return c.json({ error: "Invalid body", code: "INVALID_SKILL" }, 400);
    }
    try {
      return c.json(
        await setSkillEnabled(prisma, user.id, c.req.param("id"), parsed.data.isEnabled),
      );
    } catch (error) {
      if (error instanceof SkillInputError) {
        const status = error.message === "Skill not found" ? 404 : 400;
        return c.json(
          status === 404
            ? notFound()
            : { error: error.message, issues: error.issues },
          status,
        );
      }
      throw error;
    }
  })
  .delete("/:id", async (c) => {
    const user = c.get("user");
    try {
      await deleteSkill(prisma, user.id, c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof SkillInputError) {
        return c.json(notFound(), 404);
      }
      throw error;
    }
  });
