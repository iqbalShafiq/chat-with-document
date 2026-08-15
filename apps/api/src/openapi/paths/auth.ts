import {
  badRequest,
  jsonResponse,
  jsonSchema,
  unauthorized,
} from "../helpers.js";
import {
  exampleUser,
  sessionRowSchema,
  userSchema,
} from "../components.js";

const credentialsBody = {
  type: "object",
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 8 },
    name: { type: "string", description: "Required on sign-up." },
    rememberMe: { type: "boolean" },
  },
};

const signInSuccess = {
  user: exampleUser,
  token: "better-auth.session-token-value",
};

export const authPaths = {
  "/api/auth/sign-up/email": {
    post: {
      operationId: "signUpEmail",
      tags: ["Auth"],
      summary: "Register with email and password",
      description:
        "Creates a user and starts a session (`autoSignIn`). The web platform stores the HTTP-only cookie. Mobile and extra-repo clients should read the `set-auth-token` response header and send it back as `Authorization: Bearer <token>`.\n\nPassword minimum length is 8.",
      security: [],
      requestBody: {
        required: true,
        content: jsonSchema(credentialsBody, {
          default: {
            summary: "New account",
            value: {
              email: "ada@example.com",
              password: "correct-horse-battery",
              name: "Ada Lovelace",
            },
          },
        }),
      },
      responses: {
        "200": {
          ...jsonResponse(
            "Account created. Session cookie is set; `set-auth-token` holds the Bearer token.",
            {
              type: "object",
              properties: {
                user: userSchema,
                token: { type: "string" },
              },
            },
            { default: { summary: "Signed up", value: signInSuccess } },
          ),
          headers: {
            "set-auth-token": {
              description:
                "Copy this value into `Authorization: Bearer <token>` for extra-repo / mobile clients.",
              schema: { type: "string" },
              example: "better-auth.session-token-value",
            },
          },
        },
        "400": badRequest({ error: "User already exists" }),
        "422": badRequest({ error: "Password too short" }),
      },
    },
  },
  "/api/auth/sign-in/email": {
    post: {
      operationId: "signInEmail",
      tags: ["Auth"],
      summary: "Sign in with email and password",
      description:
        "Starts a session. Browser clients keep the `Set-Cookie` value with `credentials: include`. Native clients copy `set-auth-token` into secure storage and send `Authorization: Bearer <token>` on every later request.\n\nRequests from a browser must send an `Origin` that is listed in `TRUSTED_ORIGINS` (plus `PLATFORM_ORIGIN` and this API origin).",
      security: [],
      requestBody: {
        required: true,
        content: jsonSchema(credentialsBody, {
          default: {
            summary: "Existing account",
            value: {
              email: "ada@example.com",
              password: "correct-horse-battery",
            },
          },
        }),
      },
      responses: {
        "200": {
          ...jsonResponse(
            "Signed in. Cookie + `set-auth-token` header are set.",
            {
              type: "object",
              properties: {
                user: userSchema,
                token: { type: "string" },
              },
            },
            { default: { summary: "Signed in", value: signInSuccess } },
          ),
          headers: {
            "set-auth-token": {
              description:
                "Copy this value into `Authorization: Bearer <token>` for extra-repo / mobile clients.",
              schema: { type: "string" },
              example: "better-auth.session-token-value",
            },
          },
        },
        "401": jsonResponse(
          "Email or password is wrong.",
          { type: "object", properties: { message: { type: "string" } } },
          {
            invalid: {
              summary: "Bad credentials",
              value: { message: "Invalid email or password" },
            },
          },
        ),
      },
    },
  },
  "/api/auth/sign-out": {
    post: {
      operationId: "signOut",
      tags: ["Auth"],
      summary: "End the current session",
      description:
        "Invalidates the cookie session and/or the Bearer token presented on the request. After this call the token must not be reused.",
      requestBody: {
        required: false,
        content: jsonSchema(
          { type: "object", additionalProperties: true },
          { empty: { summary: "No body", value: {} } },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Session cleared.",
          { type: "object", additionalProperties: true },
          { default: { summary: "Signed out", value: { success: true } } },
        ),
        "401": unauthorized,
      },
    },
  },
  "/api/auth/get-session": {
    get: {
      operationId: "getSession",
      tags: ["Auth"],
      summary: "Read the current session",
      description:
        "Returns the signed-in user and session, or `null` when no valid cookie / Bearer token is present. Use this as the first call after app launch to restore auth state.",
      responses: {
        "200": jsonResponse(
          "Current session, or `null` when signed out.",
          {
            oneOf: [
              {
                type: "object",
                required: ["session", "user"],
                properties: {
                  session: sessionRowSchema,
                  user: userSchema,
                },
              },
              { type: "null" },
            ],
          },
          {
            signedIn: {
              summary: "Active session",
              value: {
                session: {
                  id: "sess_01",
                  userId: exampleUser.id,
                  token: "better-auth.session-token-value",
                  expiresAt: "2026-08-22T10:15:30.000Z",
                  createdAt: "2026-08-15T10:15:30.000Z",
                  updatedAt: "2026-08-15T10:15:30.000Z",
                  ipAddress: "203.0.113.10",
                  userAgent: "AssignmentMobile/1.0",
                },
                user: exampleUser,
              },
            },
            signedOut: { summary: "No session", value: null },
          },
        ),
      },
    },
  },
};
