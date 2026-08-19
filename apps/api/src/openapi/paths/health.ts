import { jsonResponse } from "../helpers.js";

export const healthPaths = {
  "/health": {
    get: {
      operationId: "getHealth",
      tags: ["Health"],
      summary: "Liveness check",
      description:
        "Unauthenticated ping so load balancers and mobile clients can confirm the API process is up. Does not check Postgres, Redis, or R2.",
      security: [],
      responses: {
        "200": jsonResponse(
          "API process is running.",
          {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean", const: true } },
          },
          { default: { summary: "Healthy", value: { ok: true } } },
        ),
      },
    },
  },
};
