import {
  badRequest,
  bearerOrCookie,
  jsonResponse,
  notFound,
  unauthorized,
} from "../helpers.js";

const skillDto = {
  type: "object",
  required: ["id", "name", "description", "isEnabled", "status", "version"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    isEnabled: { type: "boolean" },
    status: { type: "string" },
    version: { type: "integer" },
  },
};

const skillExample = {
  default: {
    summary: "Example skill",
    value: {
      id: "cuid123",
      name: "release-notes",
      description: "Draft customer-facing release notes",
      isEnabled: true,
      status: "active",
      version: 1,
    },
  },
};

export const skillsPaths = {
  "/api/skills": {
    get: {
      operationId: "listSkills",
      tags: ["Skills"],
      summary: "List the user's skills",
      description: "All skills owned by the signed-in user, newest first.",      security: bearerOrCookie,
      responses: {
        "200": jsonResponse("Skills.", { type: "array", items: skillDto }, { default: { summary: "Skills", value: [] } }),
        "401": unauthorized,
      },
    },
    post: {
      operationId: "createSkill",
      tags: ["Skills"],
      summary: "Create a skill from markdown",
      description: "Validates name, description, and SKILL.md frontmatter, then stores the skill as active.",      security: bearerOrCookie,
      responses: {
        "201": jsonResponse("Created skill.", skillDto, skillExample),
        "400": badRequest({ error: "Invalid skill" }),
        "401": unauthorized,
      },
    },
  },
  "/api/skills/{id}": {
    get: {
      operationId: "getSkill",
      tags: ["Skills"],
      summary: "Read one skill",
      description: "A single owned skill including its SKILL.md body.",      security: bearerOrCookie,
      responses: {
        "200": jsonResponse("Skill.", skillDto, skillExample),
        "401": unauthorized,
        "404": notFound({ error: "Skill not found", code: "SKILL_NOT_FOUND" }),
      },
    },
    put: {
      operationId: "updateSkill",
      tags: ["Skills"],
      summary: "Replace a skill",
      description: "Re-validates the markdown, bumps the version, and clears any previous issues.",      security: bearerOrCookie,
      responses: {
        "200": jsonResponse("Updated skill.", skillDto, skillExample),
        "400": badRequest({ error: "Invalid skill" }),
        "401": unauthorized,
        "404": notFound({ error: "Skill not found", code: "SKILL_NOT_FOUND" }),
      },
    },
    delete: {
      operationId: "deleteSkill",
      tags: ["Skills"],
      summary: "Delete a skill",
      description: "Permanently removes the skill; later runs no longer see it.",      security: bearerOrCookie,
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
        "404": notFound({ error: "Skill not found", code: "SKILL_NOT_FOUND" }),
      },
    },
  },
  "/api/skills/{id}/enabled": {
    patch: {
      operationId: "setSkillEnabled",
      tags: ["Skills"],
      summary: "Toggle a skill's global default",
      description: "Flips isEnabled, the per-user default that per-chat selection starts from.",      security: bearerOrCookie,
      responses: {
        "200": jsonResponse("Updated skill.", skillDto, skillExample),
        "400": badRequest({ error: "Invalid body" }),
        "401": unauthorized,
        "404": notFound({ error: "Skill not found", code: "SKILL_NOT_FOUND" }),
      },
    },
  },
};
