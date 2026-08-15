import {
  ISO_EXAMPLE,
  PROJECT_ID_EXAMPLE,
  profileDtoSchema,
} from "../components.js";
import {
  badRequest,
  bearerOrCookie,
  jsonResponse,
  notFound,
  unauthorized,
} from "../helpers.js";

const exampleProfile = {
  sections: {
    identity: "Prefers to be called Ada.",
    goals: "Wants concise answers with citations.",
  },
  explicitFacts: [
    {
      section: "identity",
      fact: "Prefers to be called Ada.",
      createdAt: ISO_EXAMPLE,
      source: { sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" },
    },
  ],
  updatedAt: ISO_EXAMPLE,
};

export const profilingPaths = {
  "/api/profiling": {
    get: {
      operationId: "getProfilingSettings",
      tags: ["Profiling"],
      summary: "Read user and project profiles",
      description:
        "Personalization settings: the per-user profile plus every project's profile. `null` means nothing has been summarized yet.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Profiles.",
          {
            type: "object",
            required: ["user", "projects"],
            properties: {
              user: { oneOf: [profileDtoSchema, { type: "null" }] },
              projects: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "name", "profile"],
                  properties: {
                    id: { type: "string", format: "uuid" },
                    name: { type: "string" },
                    profile: { oneOf: [profileDtoSchema, { type: "null" }] },
                  },
                },
              },
            },
          },
          {
            empty: {
              summary: "Nothing learned yet",
              value: { user: null, projects: [] },
            },
            populated: {
              summary: "User + one project",
              value: {
                user: exampleProfile,
                projects: [
                  {
                    id: PROJECT_ID_EXAMPLE,
                    name: "Q3 research",
                    profile: exampleProfile,
                  },
                ],
              },
            },
          },
        ),
        "401": unauthorized,
      },
    },
    delete: {
      operationId: "resetUserProfile",
      tags: ["Profiling"],
      summary: "Reset the user-level profile",
      description:
        "Requires `?scope=user`. Clears the user profile and drops any pending summary job. Project profiles are not touched.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "scope",
          in: "query",
          required: true,
          schema: { type: "string", enum: ["user"] },
          example: "user",
        },
      ],
      responses: {
        "200": jsonResponse(
          "Reset.",
          { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          { default: { summary: "Reset", value: { ok: true } } },
        ),
        "400": badRequest({ error: 'scope must be "user"' }),
        "401": unauthorized,
      },
    },
  },
  "/api/profiling/projects/{projectId}": {
    delete: {
      operationId: "resetProjectProfile",
      tags: ["Profiling"],
      summary: "Reset a project profile",
      description:
        "Clears the project-scoped profile and its pending summary job. The project must belong to the user.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "projectId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: PROJECT_ID_EXAMPLE,
        },
      ],
      responses: {
        "200": jsonResponse(
          "Reset.",
          { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          { default: { summary: "Reset", value: { ok: true } } },
        ),
        "401": unauthorized,
        "404": notFound({ error: "Project not found", code: "PROJECT_NOT_FOUND" }),
      },
    },
  },
};
