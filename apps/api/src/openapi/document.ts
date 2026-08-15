import { getApiOrigin } from "../lib/origins.js";
import { openApiComponents } from "./components.js";
import { authPaths } from "./paths/auth.js";
import { chatPaths } from "./paths/chat.js";
import { documentsPaths } from "./paths/documents.js";
import { healthPaths } from "./paths/health.js";
import { imagesPaths } from "./paths/images.js";
import { modelsPaths } from "./paths/models.js";
import { profilingPaths } from "./paths/profiling.js";
import { projectsPaths } from "./paths/projects.js";
import { usagePaths } from "./paths/usage.js";

export const OPENAPI_SPEC_VERSION = "1.1.0";

const INFO_DESCRIPTION = `
REST API for **Chat with Document**. The same endpoints power the web platform
and are intended for extra-repo clients (mobile, scripts, other frontends).

## Authentication

Two equivalent schemes (send **one**):

1. **Bearer token (recommended for mobile / extra-repo)**
   - Sign in or sign up.
   - Read the \`set-auth-token\` response header.
   - Store it in secure storage (Keychain / EncryptedSharedPreferences).
   - Send \`Authorization: Bearer <token>\` on every request.
2. **Cookie session (web platform)**
   - Same sign-in/sign-up endpoints set an HTTP-only cookie
     (\`better-auth.session_token\`).
   - Call with \`credentials: "include"\`.

Protected routes return \`401 { "error": "Unauthorized", "code": "UNAUTHORIZED" }\`
when neither scheme is present.

## CORS and trusted origins

Browser clients must send an \`Origin\` listed in:

- \`PLATFORM_ORIGIN\` (the web app, default \`http://localhost:3000\`)
- this API's own origin (so Scalar "Try it" works)
- extra comma-separated origins in \`TRUSTED_ORIGINS\`
  (e.g. \`http://localhost:8081,myapp://\`)

Native mobile HTTP clients typically send **no** Origin — CORS does not apply
to them. They should use the Bearer token.

## Streaming

\`POST /api/chat\` returns **JSON Lines** (\`application/x-ndjson\`). Each line
is one Anvia event (text deltas, tool calls, approvals, finish). Resume a
dropped stream with \`{ sessionId, resume: { streamId, after } }\`.

## Ownership

Every resource is scoped to the signed-in user. Documents, chats, images, and
projects are not shared.
`.trim();

export type OpenApiDocument = {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: typeof openApiComponents;
};

export function buildOpenApiDocument(input?: {
  serverUrl?: string;
}): OpenApiDocument {
  const serverUrl = (input?.serverUrl ?? getApiOrigin()).replace(/\/+$/, "");

  return {
    openapi: "3.1.0",
    info: {
      title: "Chat with Document API",
      version: OPENAPI_SPEC_VERSION,
      description: INFO_DESCRIPTION,
    },
    servers: [
      { url: serverUrl, description: "This environment" },
      { url: "http://localhost:3001", description: "Local development" },
    ],
    tags: [
      { name: "Health", description: "Process liveness." },
      {
        name: "Auth",
        description: "Better Auth email/password. Cookie + Bearer token.",
      },
      { name: "Chat", description: "Sessions, streaming runs, approvals, snippets." },
      { name: "Documents", description: "Upload, library, attach, preview, delete." },
      { name: "Images", description: "Generated and uploaded images + session pins." },
      { name: "Models", description: "Text and image model catalog." },
      { name: "Projects", description: "Project CRUD and last-opened." },
      { name: "Profiling", description: "User / project personalization profiles." },
      { name: "Usage", description: "Token and storage aggregates." },
    ],
    paths: {
      ...healthPaths,
      ...authPaths,
      ...chatPaths,
      ...documentsPaths,
      ...imagesPaths,
      ...modelsPaths,
      ...projectsPaths,
      ...profilingPaths,
      ...usagePaths,
    },
    components: openApiComponents,
  };
}
