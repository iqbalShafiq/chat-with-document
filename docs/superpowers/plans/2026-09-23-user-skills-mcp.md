# User Skills + Self-serve MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users add markdown Skills (write or upload) and connect their own MCP servers from the composer plus-menu, and the per-user agent picks both up on every run.

**Architecture:** App owns persistence, ownership, validation entry, recipe snapshots, and MCP lifecycle; Anvia native `skills` (`loadSkills` over a materialized per-user dir) and per-run `McpClient` (streamableHttp-only, reviewed subset, always closed) do the runtime work. UI extends `FeaturesPopover` with two rows + a new reusable `CountBadge`; CRUD lives in two `DialogShell` modals.

**Tech Stack:** pnpm monorepo · `@anvia/core 1.5.0` (`loadSkills`, `skill.local`, `SkillValidationError`) · `@anvia/mcp 1.1.3` (`McpClient`) · Hono + Prisma 7 + Postgres · React 19 + Tailwind 4 · Vitest 4 · zod 4 · Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-09-23-user-skills-mcp-design.md`

## Global Constraints

- Work on branch `feat/user-skills-mcp` (created in Task 1 from `main`); never commit this feature to `feat/static-site-builder`.
- `@anvia/core` stays `1.5.0`, `@anvia/mcp` stays `1.1.3`; no dependency upgrades in this plan.
- Caps: ≤20 active skills per user, ≤5 MCP servers per user, ≤20 `skillIds` / ≤5 `mcpServerIds` per request.
- Bounds: skill name ≤64 chars (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), description 1..1024 chars, `bodyMd` 1..16000 chars, MCP URL ≤512 chars.
- MCP transport v1 is `streamableHttp` over public `https:` only; `stdio` is forbidden; `http:`, localhost, loopback, RFC1918, link-local, `.local`/`.localhost`/`.internal` hostnames are rejected before any network call.
- MCP test/connect timeout is 15s (`AbortSignal.timeout(15_000)`); every `McpClient` is closed in a `finally`.
- Recipe `CHAT_AGENT_RECIPE_VERSION` becomes `3`; every snapshot array/string uses the bounded helpers in `run-recipe.ts`.
- Browser never receives credentials, raw reasoning, or sensitive tool args; MCP test errors returned to the browser are bounded strings.
- Before editing any file under `apps/platform/`, check `apps/platform/AGENTS.md` intent-skills; run the matching guidance command only if a task touches router/devtools code (these tasks do not — composer/dialog/hook work needs none).
- Every task ends green: `tsc --noEmit` for touched packages, `vitest run` for touched suites, no eslint errors on touched files, one commit per task.

## Review Focus

- Skill `name` field differs from frontmatter `name:` inside `bodyMd` → server rejects with a field error naming both; the agent never sees a mismatched skill.
- MCP URL is `http:` or a private/local hostname → rejected pre-network with a message saying https-public-only; no socket is opened.
- Two user MCP servers expose the same tool name → per-server `tools: { prefix }` keeps `Agent` construction from throwing.
- Per-chat selection references a deleted/disabled skill or server → server drops it, the run proceeds with the remainder, and the client refreshes its list.
- A v2 recipe is replayed after deploy → the version gate rejects it with a readable error instead of silently running without user enhancements.

---

### Task 1: Branch + Prisma models + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (append two models)
- Create: `apps/api/prisma/migrations/<timestamp>-user-skills-mcp/migration.sql` (generated)
- Test: none (migration correctness is verified by commands below)

**Interfaces:**
- Consumes: existing `User` id (`String @id @default(cuid())`).
- Produces: `UserSkill`, `UserMcpServer` tables for Tasks 2–7 (`userId` scope key, `@@unique([userId, name])`).

- [ ] **Step 1: Create the branch**

```bash
git fetch origin
git checkout -b feat/user-skills-mcp origin/main
git status --short --branch
```

- [ ] **Step 2: Append the models to `apps/api/prisma/schema.prisma`**

```prisma
model UserSkill {
  id          String   @id @default(cuid())
  userId      String
  name        String
  description String
  bodyMd      String   @db.Text
  isEnabled   Boolean  @default(true)
  status      String   @default("active")
  issuesJson  Json?
  version     Int      @default(1)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([userId, name])
  @@index([userId, updatedAt])
  @@map("user_skill")
}

model UserMcpServer {
  id              String    @id @default(cuid())
  userId          String
  name            String
  url             String
  authType        String    @default("none")
  credentialsRef  String    @default("")
  allowedToolsJson Json     @default("[]")
  /// Last successful test-connection tool definitions (frozen into the recipe, CONTEXT7_TOOL_DEFINITIONS pattern).
  isEnabled       Boolean   @default(true)
  status          String    @default("untested")
  lastCheckedAt   DateTime?
  lastError       String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([userId, name])
  @@index([userId, updatedAt])
  @@map("user_mcp_server")
}
```

- [ ] **Step 3: Generate and apply the migration (needs local Postgres from `docker compose up -d`)**

```bash
pnpm --filter @anreal/api with-env prisma migrate dev --name user-skills-mcp
```

Expected: `Your database is now in sync with your schema.`

- [ ] **Step 4: Verify generate + typecheck**

```bash
pnpm --filter @anreal/api db:generate
pnpm --filter @anreal/api exec tsc --noEmit
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/generated
git commit -m "feat(skills-mcp): user skill and mcp server tables"
```

---

### Task 2: Skills validation + service + unit tests

**Files:**
- Create: `apps/api/src/modules/skills/validation.ts`
- Create: `apps/api/src/modules/skills/service.ts`
- Test: `apps/api/src/modules/skills/service.test.ts`

**Interfaces:**
- Consumes: `SkillsDb` (narrow prisma surface, fake in tests — same pattern as `images/service.test.ts:37-50`).
- Produces: `validateSkillInput`, `SkillInputError`, `listSkills`, `createSkill`, `updateSkill`, `deleteSkill`, `setSkillEnabled`, `materializeUserSkills` for Tasks 3, 6, 7.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { SkillInputError, createSkill, validateSkillInput } from "./service.js";

function setup() {
  return {
    db: {
      userSkill: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), create: vi.fn(async (a: { data: unknown }) => a.data), update: vi.fn(), delete: vi.fn(), count: vi.fn(async () => 0) },
    },
  };
}

describe("validateSkillInput", () => {
  it("rejects a name with uppercase and reports the field", () => {
    const result = validateSkillInput({ name: "My Skill", description: "d", bodyMd: "---\nname: x\ndescription: d\n---\nbody" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("name");
  });
});

describe("createSkill", () => {
  it("throws SkillInputError on invalid input without touching the db", async () => {
    const { db } = setup();
    await expect(createSkill(db, "u1", { name: "Bad Name", description: "d", bodyMd: "---\nname: x\ndescription: d\n---\nb" })).rejects.toBeInstanceOf(SkillInputError);
    expect(db.userSkill.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/skills/service.test.ts`
Expected: FAIL with "Cannot find module './service.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_BODY_MAX = 16000;
export const MAX_ACTIVE_SKILLS = 20;

export type SkillIssue = { path: "name" | "description" | "bodyMd"; message: string };
export class SkillInputError extends Error {
  readonly issues: SkillIssue[];
  constructor(issues: SkillIssue[]) { super(issues[0]?.message ?? "Invalid skill"); this.name = "SkillInputError"; this.issues = issues; }
}

export function validateSkillInput(input: { name: string; description: string; bodyMd: string }) {
  const issues: SkillIssue[] = [];
  const name = input.name.trim();
  if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX) issues.push({ path: "name", message: "Name must be lowercase letters, numbers, and hyphens (max 64), e.g. release-notes" });
  const description = input.description.trim();
  if (description.length === 0 || description.length > SKILL_DESCRIPTION_MAX) issues.push({ path: "description", message: "Description must be 1-1024 characters and say when to use the skill" });
  const bodyMd = input.bodyMd.trim();
  if (bodyMd.length === 0 || bodyMd.length > SKILL_BODY_MAX) {
    issues.push({ path: "bodyMd", message: "SKILL.md must be 1-16000 characters" });
  } else {
    const frontmatter = extractFrontmatter(bodyMd);
    if (!frontmatter) issues.push({ path: "bodyMd", message: "SKILL.md must start with a YAML frontmatter block between --- lines" });
    else {
      const fmName = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
      const fmDescription = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
      if (fmName !== name) issues.push({ path: "bodyMd", message: `Frontmatter name: must equal the skill name ("${name}")` });
      if (fmDescription !== description) issues.push({ path: "bodyMd", message: "Frontmatter description: must equal the description field" });
    }
  }
  if (issues.length > 0) return { ok: false as const, issues };
  return { ok: true as const, value: { name, description, bodyMd } };
}

function extractFrontmatter(bodyMd: string): string | null {
  const lines = bodyMd.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return null;
  return lines.slice(1, end).join("\n");
}

export type SkillsDb = {
  userSkill: {
    findMany(args: unknown): Promise<unknown[]>;
    findFirst(args: unknown): Promise<unknown | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    count(args: unknown): Promise<number>;
  };
};

export async function listSkills(db: SkillsDb, userId: string) {
  return db.userSkill.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
}

export async function createSkill(db: SkillsDb, userId: string, input: { name: string; description: string; bodyMd: string }) {
  const validated = validateSkillInput(input);
  if (!validated.ok) throw new SkillInputError(validated.issues);
  const activeCount = await db.userSkill.count({ where: { userId, isEnabled: true, status: "active" } });
  if (activeCount >= MAX_ACTIVE_SKILLS) throw new SkillInputError([{ path: "name", message: `Skill limit reached (${MAX_ACTIVE_SKILLS} active)` }]);
  return db.userSkill.create({ data: { userId, ...validated.value, isEnabled: true, status: "active", version: 1 } });
}

export async function updateSkill(db: SkillsDb, userId: string, id: string, input: { name: string; description: string; bodyMd: string }) {
  const existing = await db.userSkill.findFirst({ where: { id, userId } });
  if (!existing) throw new SkillInputError([{ path: "name", message: "Skill not found" }]);
  const validated = validateSkillInput(input);
  if (!validated.ok) throw new SkillInputError(validated.issues);
  const current = existing as { version?: unknown };
  const version = typeof current.version === "number" ? current.version + 1 : 1;
  return db.userSkill.update({ where: { id }, data: { ...validated.value, status: "active", issuesJson: null, version } });
}

export async function deleteSkill(db: SkillsDb, userId: string, id: string) {
  const existing = await db.userSkill.findFirst({ where: { id, userId } });
  if (!existing) throw new SkillInputError([{ path: "name", message: "Skill not found" }]);
  return db.userSkill.delete({ where: { id } });
}

export async function setSkillEnabled(db: SkillsDb, userId: string, id: string, isEnabled: boolean) {
  const existing = await db.userSkill.findFirst({ where: { id, userId } });
  if (!existing) throw new SkillInputError([{ path: "name", message: "Skill not found" }]);
  return db.userSkill.update({ where: { id }, data: { isEnabled } });
}

/** Writes each enabled+active skill as <rootDir>/<id>/SKILL.md for `loadSkills(skill.local(rootDir))`. Returns written dirs. */
export async function materializeUserSkills(db: SkillsDb, userId: string, rootDir: string): Promise<string[]> {
  const rows = (await db.userSkill.findMany({ where: { userId, isEnabled: true, status: "active" } })) as { id: string; name: string; description: string; bodyMd: string }[];
  const dirs: string[] = [];
  for (const row of rows) {
    const dir = resolve(rootDir, row.id);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, "SKILL.md"), `${row.bodyMd.trim()}\n`, "utf8");
    dirs.push(dir);
  }
  return dirs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/skills/service.test.ts`
Expected: PASS (extend the file with frontmatter-mismatch, cap, update-version, materialize-tmpdir cases before this run).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/skills/validation.ts apps/api/src/modules/skills/service.ts apps/api/src/modules/skills/service.test.ts
git commit -m "feat(skills): validation and service with ownership checks"
```

Note: keep `validation.ts` as a thin re-export of the pure validators if you split the file; the test imports from `./service.js` either way.

---

### Task 3: Skills router + OpenAPI + mount

**Files:**
- Create: `apps/api/src/modules/skills/router.ts`
- Create: `apps/api/src/openapi/paths/skills.ts`
- Modify: `apps/api/src/app.ts:20-28` (mount), OpenAPI document registration (mirror `paths/chat.ts:1330` pattern — read `openapi/register.ts` first)
- Test: `apps/api/src/modules/skills/router.test.ts` (Hono `app.request` with `vi.mock` on the service module)

**Interfaces:**
- Consumes: Task 2 service fns; `requireUser` from `../auth/middleware.js` (pattern `profiling/router.ts:1-8`).
- Produces: `GET/POST /api/skills`, `GET/PUT/DELETE /api/skills/:id`; 404 `{ error: "Skill not found", code: "SKILL_NOT_FOUND" }` for foreign ids.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { skillsRouter } from "./router.js";
import { SkillInputError } from "./service.js";

vi.mock("./service.js", () => ({
  SkillInputError: class SkillInputError extends Error { issues = [{ path: "name", message: "bad" }]; },
  listSkills: vi.fn(async () => []),
  createSkill: vi.fn(async () => { throw new (class extends Error { issues = [{ path: "name", message: "bad" }]; })(); }),
}));

describe("skillsRouter", () => {
  it("lists skills for the authenticated user", async () => {
    const response = await skillsRouter.request("/", { headers: { "x-test-user": "u1" } });
    expect(response.status).toBe(200);
  });
});
```

Auth mocking: read `modules/auth/middleware.ts` `requireUser` first; if it needs a real session, mock that module instead with `c.set("user", { id: "u1" })`. Adjust the header trick to whatever the middleware test seam is — the assertion (`200` + JSON array) stays.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/skills/router.test.ts`
Expected: FAIL with "Cannot find module './router.js'".

- [ ] **Step 3: Write minimal implementation** — full CRUD router: `GET /` → `listSkills`; `POST /` → zod body `{ name: z.string().max(70), description: z.string().max(1100), bodyMd: z.string().max(17000) }` (loose transport bounds; strict rules live in Task 2), catch `SkillInputError` → `400 { error, issues }`; `GET/PUT/DELETE /:id` → service (service throws not-found → map to `404 { error: "Skill not found", code: "SKILL_NOT_FOUND" }`). Mount: `app.ts` add `.route("/api/skills", skillsRouter)`. OpenAPI: add `paths/skills.ts` mirroring `paths/chat.ts` response helpers + register where other paths register.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm --filter @anreal/api exec vitest run src/modules/skills/
pnpm --filter @anreal/api exec tsc --noEmit
```

Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/skills/router.ts apps/api/src/modules/skills/router.test.ts apps/api/src/openapi/paths/skills.ts apps/api/src/app.ts apps/api/src/openapi/
git commit -m "feat(skills): crud router with ownership checks and openapi"
```

---

### Task 4: MCP service (URL validation + CRUD) + unit tests

**Files:**
- Create: `apps/api/src/modules/mcp-servers/validation.ts`
- Create: `apps/api/src/modules/mcp-servers/service.ts`
- Test: `apps/api/src/modules/mcp-servers/service.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `validateMcpUrl`, `McpInputError`, `listMcpServers`, `createMcpServer`, `updateMcpServer`, `deleteMcpServer`, `setMcpServerEnabled`, `MAX_USER_MCP_SERVERS = 5` for Tasks 5–7.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { validateMcpUrl } from "./service.js";

describe("validateMcpUrl", () => {
  it("accepts a public https URL", () => {
    expect(validateMcpUrl("https://mcp.example.com/mcp")).toBeNull();
  });
  it("rejects http before any network call", () => {
    expect(validateMcpUrl("http://mcp.example.com/mcp")).toContain("https");
  });
  it("rejects loopback and private hosts", () => {
    expect(validateMcpUrl("https://127.0.0.1/mcp")).not.toBeNull();
    expect(validateMcpUrl("https://192.168.1.10/mcp")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/mcp-servers/service.test.ts`
Expected: FAIL with "Cannot find module './service.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
export const MAX_USER_MCP_SERVERS = 5;
export const MCP_URL_MAX = 512;

const BLOCKED_HOST_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|\[?::1\]?)$/i;

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Returns null when valid, otherwise a user-facing reason. Pure — no network. */
export function validateMcpUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0 || url.length > MCP_URL_MAX) return "URL must be 1-512 characters";
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "URL is not a valid absolute URL"; }
  if (parsed.protocol !== "https:") return "MCP URL must use public https (http and private hosts are blocked)";
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOST_RE.test(host) || isPrivateIpv4(host)) return "MCP URL must be a public host (local and private addresses are blocked)";
  return null;
}
```

Plus `McpInputError` and CRUD (`listMcpServers`, `createMcpServer`, `updateMcpServer`, `deleteMcpServer`, `setMcpServerEnabled`) mirroring Task 2 with `authType: "none" | "bearer"`, `credentialsRef` written only by the server (never echoed back — list/get strip it), `allowedToolsJson` default `[]`, `toolsJson` default `[]` (last test-connection definitions; written only from a successful test/save), cap check `MAX_USER_MCP_SERVERS`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/mcp-servers/service.test.ts`
Expected: PASS (include CRUD-with-fakeDb + credentialsRef-stripped cases before this run).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/mcp-servers/validation.ts apps/api/src/modules/mcp-servers/service.ts apps/api/src/modules/mcp-servers/service.test.ts
git commit -m "feat(mcp): url validation and server crud service"
```

---

### Task 5: MCP test-connection endpoint + unit tests

**Files:**
- Create: `apps/api/src/modules/mcp-servers/test-connection.ts`
- Modify: `apps/api/src/modules/mcp-servers/router.ts` (CRUD + `POST /test`), `apps/api/src/app.ts` (mount `/api/mcp-servers`), OpenAPI paths
- Test: `apps/api/src/modules/mcp-servers/test-connection.test.ts`

**Interfaces:**
- Consumes: Task 4 `validateMcpUrl`; `McpClient` from `@anvia/mcp` (mocked in tests); `CONTEXT7_TOOL_DEFINITIONS`-style `{ name, description }` shaping.
- Produces: `testMcpConnection` + `POST /api/mcp-servers/test` for the platform Test button (Task 12).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { testMcpConnection } from "./test-connection.js";

vi.mock("@anvia/mcp", () => {
  class FakeClient {
    static lastArgs: unknown;
    close = vi.fn(async () => {});
    constructor(args: unknown) { FakeClient.lastArgs = args; }
    async connect() {
      return { name: "fake", tools: [{ name: "search_docs", definition: () => ({ description: "Search docs" }) }] };
    }
  }
  return { McpClient: FakeClient };
});

describe("testMcpConnection", () => {
  it("returns the tool list and always closes the client", async () => {
    const result = await testMcpConnection({ url: "https://mcp.example.com/mcp", authType: "none" });
    expect(result).toEqual({ ok: true, tools: [{ name: "search_docs", description: "Search docs", parameters: {} }] });
  });
  it("rejects http without constructing a client", async () => {
    const result = await testMcpConnection({ url: "http://mcp.example.com/mcp", authType: "none" });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/mcp-servers/test-connection.test.ts`
Expected: FAIL with "Cannot find module './test-connection.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
import { McpClient } from "@anvia/mcp";
import { validateMcpUrl } from "./service.js";

export type McpTestTool = { name: string; description: string; parameters: Record<string, unknown> };
export type McpTestResult = { ok: true; tools: McpTestTool[] } | { ok: false; error: string };

const TEST_TIMEOUT_MS = 15_000;

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Connection failed";
  const clean = message.replace(/https?:\/\/[^\s]+/g, "[url]").slice(0, 300);
  return `MCP test failed: ${clean}`;
}

export async function testMcpConnection(input: { url: string; authType: "none" | "bearer"; token?: string }): Promise<McpTestResult> {
  const urlError = validateMcpUrl(input.url);
  if (urlError) return { ok: false, error: urlError };
  const token = input.token?.trim();
  if (input.authType === "bearer" && !token) return { ok: false, error: "Bearer token is required for bearer auth" };
  const client = new McpClient({
    name: "mcp-test",
    transport: {
      type: "streamableHttp",
      url: input.url.trim(),
      ssrfProtection: "strict",
      ...(input.authType === "bearer" ? { headers: { authorization: `Bearer ${token}` } } : {}),
    },
    versionNegotiation: { mode: "auto" },
  });
  try {
    const server = await Promise.race([
      client.connect(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Timed out after 15s — the server did not answer")), TEST_TIMEOUT_MS)),
    ]);
    if (!server) return { ok: false, error: "Server unreachable — the MCP server did not answer" };
    return { ok: true, tools: server.tools.map((tool) => { const def = tool.definition(""); return { name: tool.name, description: def.description ?? "", parameters: (def.parameters ?? {}) as Record<string, unknown> }; }) };
  } catch (error) {
    return { ok: false, error: boundedError(error) };
  } finally {
    await client.close().catch(() => {});
  }
}
```

Router: CRUD mirroring Task 3 (404 `MCP_SERVER_NOT_FOUND` for foreign ids, credentials never echoed) + `POST /test` with zod body `{ url: z.string().max(520), authType: z.enum(["none", "bearer"]), token: z.string().max(2048).optional() }` → `200` test result (never persisted).

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm --filter @anreal/api exec vitest run src/modules/mcp-servers/
pnpm --filter @anreal/api exec tsc --noEmit
```

Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/mcp-servers/
git commit -m "feat(mcp): test-connection endpoint and server crud router"
```

---

### Task 6: Recipe v3 + request metadata + server-side resolve

**Files:**
- Modify: `apps/api/src/modules/chat/run-recipe.ts` (version 3 + snapshot schemas), `apps/api/src/modules/chat/client-request.ts:40` (add `skillIds`/`mcpServerIds`), `apps/api/src/modules/chat/router.ts:939` (resolve + embed)
- Create: `apps/api/src/modules/chat/user-enhancements.ts` (ownership-checked resolve)
- Test: `apps/api/src/modules/chat/user-enhancements.test.ts` (+ extend `run-recipe.test.ts` version cases)

**Interfaces:**
- Consumes: Task 2/4 tables via injected db; `chatAgentRecipeSchema` bounded helpers.
- Produces: `resolveUserEnhancements(db, userId, { skillIds, mcpServerIds }) → { userSkills, userMcp }` snapshots for Task 7; v3 recipe type.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { resolveUserEnhancements } from "./user-enhancements.js";

function setup() {
  return {
    db: {
      userSkill: { findMany: vi.fn(async () => [{ id: "s1", userId: "u1", name: "brief", description: "d", bodyMd: "---\nname: brief\ndescription: d\n---\nb", isEnabled: true, status: "active" }]) },
      userMcpServer: { findMany: vi.fn(async () => []) },
    },
  };
}

describe("resolveUserEnhancements", () => {
  it("snapshots owned, enabled skills and drops unknown ids", async () => {
    const { db } = setup();
    const result = await resolveUserEnhancements(db, "u1", { skillIds: ["s1", "ghost"], mcpServerIds: [] });
    expect(result.userSkills.map((s) => s.id)).toEqual(["s1"]);
    expect(result.droppedSkillIds).toEqual(["ghost"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/chat/user-enhancements.test.ts`
Expected: FAIL with "Cannot find module './user-enhancements.js'".

- [ ] **Step 3: Write minimal implementation** — `resolveUserEnhancements` loads owned+enabled+active rows only, intersects with requested ids (cap 20/5 — extras dropped and reported in `droppedSkillIds`/`droppedMcpServerIds`), shapes snapshots `{ id, name, description, bodyMd }` / `{ id, name, url, allowedTools, toolDefinitions }` where `toolDefinitions` is the stored `toolsJson` filtered to `allowedTools` (frozen contract for the worker, never live discovery). Recipe: `version: z.literal(3)`, add `userSkills`/`userMcp` arrays with the file's `bounded` helpers (skill body `≤16000`, tool defs reuse `staticToolDefinitionSchema`, arrays `≤20`/`≤5`), keep the v2→v3 gate where the router/worker validates `recipe.version` (find the existing gate first — mirror its error style). `client-request.ts`: add `skillIds: z.array(z.string().max(256)).max(20).default([])`, `mcpServerIds: z.array(z.string().max(256)).max(5).default([])`. Router: replace the `features` construction at `router.ts:939` area to also embed `userSkills`/`userMcp` from the resolver.

- [ ] **Step 4: Run tests + typecheck (fix old v2 fixtures the gate now rejects)**

```bash
pnpm --filter @anreal/api exec vitest run src/modules/chat/user-enhancements.test.ts src/modules/chat/run-recipe.test.ts src/modules/chat/client-request.test.ts
pnpm --filter @anreal/api exec tsc --noEmit
```

Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chat/user-enhancements.ts apps/api/src/modules/chat/user-enhancements.test.ts apps/api/src/modules/chat/run-recipe.ts apps/api/src/modules/chat/client-request.ts apps/api/src/modules/chat/router.ts
git commit -m "feat(chat): recipe v3 with user skills and mcp snapshots"
```

---

### Task 7: Agent skills passthrough + run wiring + worker MCP lifecycle

**Files:**
- Modify: `packages/agent/src/agent.ts:39-53,93-106` (add `skills?`), `apps/api/src/modules/chat/build-run-input.ts` (resolve → materialize → `loadSkills` → `skills`; per-run `McpClient` + reviewed subset + prefix), worker run path (close MCP clients in `finally` — read `run-worker.ts` first)
- Test: `packages/agent/src/agent-enhancements.test.ts` + extend `apps/api/src/modules/chat/anvia-v1-regression.test.ts` ordering cases

**Interfaces:**
- Consumes: Task 6 snapshots; `loadSkills`, `skill` from `@anvia/core/skills`; `materializeUserSkills` (Task 2); `McpClient` from `@anvia/mcp`.
- Produces: live `skills` + `mcpServers` on every chat run for Task 13 to exercise.

- [ ] **Step 1: Read the seams (no code yet)**

Read `packages/agent/src/agent.test.ts` (how `Agent` is constructed in tests), `apps/api/src/modules/chat/run-worker.ts` (where the agent runs and where a `finally` cleanup belongs), and `packages/agent/node_modules/@anvia/core/dist/skills/types.d.ts` (collection type name). Note the exact lines.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createAgent } from "./agent.js";
import { BASE_INSTRUCTIONS } from "./prompts/base-instructions.js";

describe("createAgent user enhancements", () => {
  it("forwards skills to the native agent", () => {
    const skills = [{ name: "brief" }] as never;
    const agent = createAgent({ agentId: "test", skills: skills as never });
    expect((agent as unknown as { skills?: unknown }).skills).toBe(skills);
  });
  it("keeps base instructions when no skills are passed", () => {
    const agent = createAgent({ agentId: "test" });
    expect(agent.instructions).toContain(BASE_INSTRUCTIONS);
  });
});
```

Run: `pnpm --filter @anreal/agent exec vitest run src/agent-enhancements.test.ts` — Expected: FAIL with "skills does not exist in type".

- [ ] **Step 3: Write minimal implementation** — `agent.ts`: add `skills?: Awaited<ReturnType<typeof loadSkills>>` to `CreateAgentOptions` (import type from `@anvia/core/skills`) + `...(opts.skills ? { skills: opts.skills } : {})` in the constructor args. `build-run-input.ts`: from recipe snapshots — materialize skills to `os.tmpdir()/anreal-skills/<runId>` → `await loadSkills(skill.local(dir))` → `additionalSkills`; for each `userMcp` entry → `new McpClient({ name, tools: { prefix: '<slug>_' }, transport: { type: "streamableHttp", url, ssrfProtection: "strict", headers? }, versionNegotiation: { mode: "auto" } })` → `connect()` with 15s race → intersect live `server.tools` with the recipe's frozen `toolDefinitions` by name (worker fails closed with the readable run error when the intersection is empty — same style as the frozen-context7 throw at `build-run-input.ts:1053`) → register `{ name, tools: reviewed }`; collect clients for cleanup. Fail-closed: any MCP connect failure throws the readable run error (never a silent degraded run). Worker: close all per-run clients + remove temp dir in `finally`.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm --filter @anreal/agent exec vitest run src/agent-enhancements.test.ts src/agent.test.ts
pnpm --filter @anreal/api exec vitest run src/modules/chat/
pnpm --filter @anreal/agent exec tsc --noEmit
pnpm --filter @anreal/api exec tsc --noEmit
```

Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/agent.ts packages/agent/src/agent-enhancements.test.ts apps/api/src/modules/chat/build-run-input.ts apps/api/src/modules/chat/run-worker.ts
git commit -m "feat(chat): wire user skills and per-run mcp into agent runs"
```

---

### Task 8: Capabilities extension + OpenAPI

**Files:**
- Modify: capabilities route (find via `getChatCapabilities` in `openapi/paths/chat.ts:1330` + its handler), `apps/api/src/openapi/paths/chat.ts`
- Test: extend the capabilities handler test (or add `capabilities-enhancements.test.ts` asserting `{ userSkillsCount, userMcpCount }` with a fake db)

**Interfaces:**
- Consumes: Task 2/4 list fns.
- Produces: `{ userSkillsCount: number; userMcpCount: number }` (counts only — no URLs/credentials) for Task 9.

- [ ] **Step 1: Write the failing test** asserting the two new fields equal the fake-db counts and that no `url`/`credentialsRef` key appears in the payload.
- [ ] **Step 2: Run test to verify it fails** (`vitest run` on the new test file).
- [ ] **Step 3: Write minimal implementation** (handler counts owned rows; OpenAPI properties `userSkillsCount`, `userMcpCount` with descriptions).
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** (`git commit -m "feat(chat): expose user skill and mcp counts in capabilities"`).

---

### Task 9: Platform API client + hooks + selection storage

**Files:**
- Modify: `apps/platform/src/lib/api.ts` (append fns — mirror `getProfiling` at `api.ts:1016` for `apiFetch` + error shape)
- Create: `apps/platform/src/hooks/use-user-skills.ts`, `apps/platform/src/hooks/use-user-mcp-servers.ts` (mirror `hooks/use-profile.ts:10-44` active-gated load + mutation + reload)
- Create: `apps/platform/src/lib/chat/user-enhancement-selection.ts`
- Test: `apps/platform/src/lib/chat/user-enhancement-selection.test.ts` (pure) + `apps/platform/src/lib/api-user-enhancements.test.ts` (mocked `globalThis.fetch`)

**Interfaces:**
- Consumes: Tasks 3, 5, 8 endpoints.
- Produces: `listSkills/createSkill/updateSkill/deleteSkill/setSkillEnabled`, `listMcpServers/.../testMcpConnection`, `useUserSkills(active)`, `useUserMcpServers(active)`, `loadIdSelection/saveIdSelection` for Tasks 11–12.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { loadIdSelection, saveIdSelection } from "./user-enhancement-selection";

describe("id selection storage", () => {
  it("round-trips ids and drops blanks", () => {
    saveIdSelection("anreal.test.selection", ["s1", " ", "s2"]);
    expect(loadIdSelection("anreal.test.selection")).toEqual(["s1", "s2"]);
  });
  it("intersects a saved selection with the catalog", async () => {
    const { intersectWithCatalog } = await import("./user-enhancement-selection");
    expect(intersectWithCatalog(["s1", "gone"], ["s1"])).toEqual(["s1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/platform exec vitest run src/lib/chat/user-enhancement-selection.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write minimal implementation** — storage helpers guard `JSON.parse` (corrupt → `[]`), cap 20/5 on save; `intersectWithCatalog(ids: string[], catalogIds: string[]): string[]` keeps request order, drops unknowns (used by Task 11 for catalog hydration); api fns use `apiFetch` + `credentials: "include"` and throw `ApiAuthError`-compatible errors mirroring `getProfiling`; hooks expose `{ data, loading, error, reload, saving, remove }` matching the `useProfilePersonalization` shape (`data/loading/error/resetting` style).

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm --filter @anreal/platform exec vitest run src/lib/chat/user-enhancement-selection.test.ts src/lib/api-user-enhancements.test.ts
pnpm --filter @anreal/platform exec tsc --noEmit
```

Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/lib/api.ts apps/platform/src/hooks/use-user-skills.ts apps/platform/src/hooks/use-user-mcp-servers.ts apps/platform/src/lib/chat/user-enhancement-selection.ts apps/platform/src/lib/chat/*.test.ts
git commit -m "feat(platform): user skills and mcp api client, hooks, selection storage"
```

---

### Task 10: Reusable CountBadge

**Files:**
- Create: `apps/platform/src/components/ui/count-badge.tsx`
- Test: `apps/platform/src/components/ui/count-badge.test.tsx` (mirror `provenance-badge.test.tsx:5-12` `renderToStaticMarkup` style)

**Interfaces:**
- Consumes: nothing.
- Produces: `CountBadge({ count, label, tone })` for Task 11 rows (and future reuse).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CountBadge } from "./count-badge";

describe("CountBadge", () => {
  it("renders the count with an accessible label", () => {
    const html = renderToStaticMarkup(<CountBadge count={3} label="skills aktif" />);
    expect(html).toContain("3");
    expect(html).toContain('aria-label="3 skills aktif"');
  });
  it("renders nothing when count is zero", () => {
    expect(renderToStaticMarkup(<CountBadge count={0} label="skills aktif" />)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/platform exec vitest run src/components/ui/count-badge.test.tsx`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write minimal implementation**

```tsx
export function CountBadge({ count, label, tone = "neutral" }: { count: number; label: string; tone?: "neutral" | "accent" }) {
  if (!Number.isFinite(count) || count <= 0) return null;
  return (
    <span
      aria-label={`${count} ${label}`}
      className={`inline-flex min-h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${tone === "accent" ? "bg-accent/20 text-accent" : "bg-white/[0.08] text-text-muted"}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @anreal/platform exec vitest run src/components/ui/count-badge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/components/ui/count-badge.tsx apps/platform/src/components/ui/count-badge.test.tsx
git commit -m "feat(platform): reusable count badge"
```

---

### Task 11: FeaturesPopover rows + composer/session threading

**Files:**
- Modify: `features-popover.tsx` (props + 2 rows + trigger icons), `chat-composer.tsx:72-147,462-474` (optional passthrough props), `chat-session.tsx:420,451-457,625,1089-1090,2580,2812` (state + request metadata + render)
- Test: extend `features-popover.test.ts` (source-contains) + `chat-session-enhancements.test.ts` (selection default/merge logic as pure helpers if extracted, else source-contains)

**Interfaces:**
- Consumes: Task 9 selection storage; Task 10 `CountBadge`.
- Produces: per-chat `activeSkillIds/activeMcpIds` sent as `skillIds/mcpServerIds` metadata (Task 6 contract) for Task 13.

- [ ] **Step 1: Write the failing test** — extend `features-popover.test.ts` with: popover contains `skillsSummary`, `mcpSummary`, `onOpenSkills`, `onOpenMcp`, `CountBadge`; composer contains `skillsSummary`; session contains `activeSkillIds` and `activeMcpIds`.

Run: `pnpm --filter @anreal/platform exec vitest run src/components/composer/features-popover.test.ts` — Expected: FAIL on the new assertions.

- [ ] **Step 2: Implement popover rows** — new props `skillsSummary: { active: number; total: number } | null`, `mcpSummary: { active: number; total: number } | null`, `skillsPerChatEnabled: boolean`, `mcpPerChatEnabled: boolean`, `onSkillsToggle`, `onMcpToggle`, `onOpenSkills`, `onOpenMcp`. Two rows after Image generator mirroring the `role="switch"` row pattern (`features-popover.tsx:308-351`): leading icon (`Brain` for skills, `Plug` for MCP — verify both are exported by `lucide-react` first via the existing `Globe, ImagePlus, Plus, Search` import line; fallback `Sparkles`/`Settings2` which are already used in the codebase), label, `CountBadge`, manage gear button (opens modal, `event.stopPropagation`), switch (toggles per-chat). `anyEnabled` includes the two new flags; trigger active shell shows the two icons when enabled (pattern `199-296`).

- [ ] **Step 3: Thread state** — `chat-session.tsx`: `useState<string[]>(() => loadIdSelection("anreal.skills.selection"))` (+ mcp), persist on change, default intersection with fetched catalog on load, include `skillIds: activeSkillIdsRef.current, mcpServerIds: activeMcpIdsRef.current` in request metadata (pattern `:625`), hydrate from incoming flags (pattern `:1089-1090`). `ChatComposer`: optional props passed to `FeaturesPopover`.

- [ ] **Step 4: Run tests + typecheck + existing dom suite**

```bash
pnpm --filter @anreal/platform exec vitest run src/components/composer/features-popover.test.ts src/components/composer/chat-composer.dom.test.tsx
pnpm --filter @anreal/platform exec tsc --noEmit
```

Expected: PASS, 0 errors (the source-contains extensions plus the existing dom suite are this task's tests; per-chat behavior is pinned by Task 13 e2e).

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/components/composer/features-popover.tsx apps/platform/src/components/composer/chat-composer.tsx apps/platform/src/components/chat/chat-session.tsx apps/platform/src/components/composer/features-popover.test.ts
git commit -m "feat(platform): skills and mcp rows with counts in composer menu"
```

---

### Task 12: SkillsModal + McpModal + wiring

**Files:**
- Create: `apps/platform/src/components/skills/skills-modal.tsx`, `apps/platform/src/components/mcp/mcp-modal.tsx`, `apps/platform/src/components/skills/skill-issues.ts` (pure `issuesToFieldErrors`)
- Modify: `chat-session.tsx` (own `skillsOpen/mcpOpen`, render modals, refresh catalog on close)
- Test: `skill-issues.test.ts` + extend popover/composer source tests for `DialogShell` usage

**Interfaces:**
- Consumes: Task 9 hooks + api; `DialogShell`, `FormTextField`, `FormTextAreaField`, `Select`, `Button`, `ConfirmDialog`.
- Produces: working CRUD UI for Task 13.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { issuesToFieldErrors } from "./skill-issues";

describe("issuesToFieldErrors", () => {
  it("maps skill issues onto fields with a form fallback", () => {
    expect(issuesToFieldErrors([{ path: "bodyMd", message: "Frontmatter name: must match" }]))
      .toEqual({ bodyMd: "Frontmatter name: must match" });
    expect(issuesToFieldErrors([])).toEqual({ form: "Could not save" });
  });
});
```

Run: `pnpm --filter @anreal/platform exec vitest run src/components/skills/skill-issues.test.ts` — Expected: FAIL (no module).

- [ ] **Step 2: Implement** — both modals: `DialogShell size="lg" heightMode="viewport"`, list (name + status dot + enable switch + edit/delete) + editor (`FormTextField` name, `FormTextField` description, `FormTextAreaField` SKILL.md monospace ≥12 rows, upload `.md` file input reading text into the editor for Skills; `FormTextField` name/url + `Select` authType + token field + Test button + allowed-tools checklist from test result + save-gated-on-test-ok for MCP), `ConfirmDialog` on delete, field errors from `issuesToFieldErrors`, testing spinner + disabled save, empty state copy ("Belum ada — tulis yang pertama"), success closes + reloads hook data.

- [ ] **Step 3: Run tests + typecheck + full platform suite**

```bash
pnpm --filter @anreal/platform exec vitest run src/components/skills/ src/components/mcp/
pnpm --filter @anreal/platform exec tsc --noEmit
```

Expected: PASS, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/src/components/skills/ apps/platform/src/components/mcp/ apps/platform/src/components/chat/chat-session.tsx
git commit -m "feat(platform): skills and mcp management modals"
```

---

### Task 13: E2E with real LLM (no stubs)

**Files:**
- Create: `apps/platform/e2e/user-skills-mcp.e2e.ts`
- Test: the e2e itself (excluded from the stub config, like `anvia-v1-migration.e2e.ts:1-3`)

**Interfaces:**
- Consumes: all previous tasks; helpers from `./helpers` (`API_ORIGIN`, `openFreshChat`, `sendMessage`, `waitForRunDone`).
- Produces: release evidence in `.playwright-mcp/user-skills-mcp/`.

Prerequisites (document at the top of the file): API + platform + worker running, real model key configured, test user `shafiq@testing.com` / `Test@123` (register via the UI `/register` route inside the test when login fails).

- [ ] **Step 1: Confirm how e2e runs** — read `apps/platform/package.json` e2e script + `e2e/helpers.ts` exports; mirror the invocation (expected shape: `pnpm --filter @anreal/platform exec playwright test e2e/user-skills-mcp.e2e.ts`).
- [ ] **Step 2: Write the spec** — scenarios: (1) login/register test user; (2) plus-menu → Skills → write skill "Jawab setiap pesan dengan awalan [SKILL-OK]" → save → enable → count shows 1 → send chat → response contains `[SKILL-OK]`; (3) upload a `.md` file via the file input → appears in list; (4) plus-menu → MCP → add `https://mcp.context7.com/mcp` → Test → tool list non-empty → save → enable → count shows 1 → chat library question uses it; (5) disable both → counts 0 → chat answers normally; (6) reload → enabled state persists (global) while a per-chat toggle override holds for that session. Use `saveEvidence` redaction pattern from `anvia-v1-migration.e2e.ts:30-47` (no prompts/outputs in evidence files).
- [ ] **Step 3: Run it**

```bash
pnpm --filter @anreal/platform exec playwright test e2e/user-skills-mcp.e2e.ts
```

Expected: PASS; screenshots + redacted snapshots under `.playwright-mcp/user-skills-mcp/`.
- [ ] **Step 4: Commit**

```bash
git add apps/platform/e2e/user-skills-mcp.e2e.ts
git commit -m "test(e2e): user skills and self-serve mcp with real llm"
```

---

### Task 14: Final verification across the branch

**Files:** none (verification only).

- [ ] **Step 1: Typecheck all touched packages**

```bash
pnpm --filter @anreal/agent exec tsc --noEmit
pnpm --filter @anreal/api exec tsc --noEmit
pnpm --filter @anreal/platform exec tsc --noEmit
```

Expected: all exit 0.

- [ ] **Step 2: Full unit suites**

```bash
pnpm --filter @anreal/agent exec vitest run
pnpm --filter @anreal/api exec vitest run
pnpm --filter @anreal/platform exec vitest run
```

Expected: all green (only pre-existing skips/failures, each triaged in the commit message if any).

- [ ] **Step 3: Lint touched files**

```bash
pnpm --filter @anreal/api exec eslint src/modules/skills src/modules/mcp-servers src/modules/chat/user-enhancements.ts src/modules/chat/run-recipe.ts src/modules/chat/client-request.ts
pnpm --filter @anreal/platform exec eslint src/components/ui/count-badge.tsx src/components/composer/features-popover.tsx src/components/skills src/components/mcp src/hooks/use-user-skills.ts src/hooks/use-user-mcp-servers.ts src/lib/chat/user-enhancement-selection.ts
```

Expected: 0 errors (adjust paths to the eslint setup in each package — read the package's lint script first).

- [ ] **Step 4: Confirm branch state**

```bash
git status --short --branch
git log --oneline -15
```

Expected: on `feat/user-skills-mcp`, working tree clean, one commit per task above.
