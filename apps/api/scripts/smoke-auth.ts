/**
 * API-level smoke: register → login → unauth guard → sessions → chat → usage audit.
 * Precondition: API running on SMOKE_API_BASE (default http://localhost:3001).
 *
 *   pnpm --filter api smoke:auth
 */
import { prisma } from "../src/utils/prisma.js";

const API_BASE = process.env.SMOKE_API_BASE ?? "http://localhost:3001";
const ORIGIN = process.env.PLATFORM_ORIGIN ?? "http://localhost:3000";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function jsonHeaders(cookie?: string): HeadersInit {
  return {
    "content-type": "application/json",
    origin: ORIGIN,
    ...(cookie ? { cookie } : {}),
  };
}

function parseSetCookie(headers: Headers): string {
  const anyHeaders = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const parts =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : [];
  if (parts.length > 0) {
    return parts.map((c) => c.split(";")[0]!).join("; ");
  }
  const single = headers.get("set-cookie");
  if (!single) return "";
  // Best-effort for runtimes that collapse set-cookie
  return single
    .split(/,(?=\s*[^;]+=)/)
    .map((c) => c.split(";")[0]!.trim())
    .join("; ");
}

async function main() {
  const stamp = Date.now();
  const email = `smoke-${stamp}@example.com`;
  const password = "smoke-pass-12345";
  const name = "Smoke Tester";
  const sessionId = crypto.randomUUID();

  console.log(`[smoke] API ${API_BASE}`);
  console.log(`[smoke] register ${email}`);

  const signUpRes = await fetch(`${API_BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password, name }),
  });
  assert(signUpRes.ok, `sign-up failed: ${signUpRes.status} ${await signUpRes.text()}`);
  let cookie = parseSetCookie(signUpRes.headers);
  assert(cookie.length > 0, "sign-up did not return session cookie");

  // Fresh login path
  console.log("[smoke] sign-in");
  const signInRes = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password }),
  });
  assert(signInRes.ok, `sign-in failed: ${signInRes.status} ${await signInRes.text()}`);
  const loginCookie = parseSetCookie(signInRes.headers);
  if (loginCookie) cookie = loginCookie;

  console.log("[smoke] unauthenticated guard");
  const unauth = await fetch(`${API_BASE}/api/chat/sessions`, {
    headers: { origin: ORIGIN },
  });
  assert(unauth.status === 401, `expected 401 without cookie, got ${unauth.status}`);

  console.log("[smoke] list sessions (auth)");
  const sessionsRes = await fetch(`${API_BASE}/api/chat/sessions`, {
    headers: { cookie, origin: ORIGIN },
  });
  assert(sessionsRes.ok, `sessions failed: ${sessionsRes.status}`);
  const sessionsBody = (await sessionsRes.json()) as { items?: unknown };
  assert(Array.isArray(sessionsBody.items), "sessions response missing items");

  console.log("[smoke] chat agent turn");
  const chatRes = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: jsonHeaders(cookie),
    body: JSON.stringify({
      sessionId,
      stream: true,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Reply with exactly: pong" }],
        },
      ],
    }),
  });
  const streamText = await chatRes.text();
  assert(
    chatRes.ok,
    `chat failed: ${chatRes.status} ${streamText.slice(0, 500)}`,
  );
  assert(streamText.length > 0, "chat stream empty");

  // Allow async usage write + memory settle
  await new Promise((r) => setTimeout(r, 1500));

  console.log("[smoke] load history");
  const historyRes = await fetch(
    `${API_BASE}/api/chat?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: { cookie, origin: ORIGIN } },
  );
  assert(historyRes.ok, `history failed: ${historyRes.status}`);
  const history = (await historyRes.json()) as unknown[];
  assert(Array.isArray(history), "history not array");
  // Memory may lag slightly; usage row is the hard assert for auth+agent wiring

  const sessionRow = await prisma.agentMemorySession.findFirst({
    where: { sessionId, userId: { not: null } },
    select: { userId: true },
  });
  assert(sessionRow?.userId, "AgentMemorySession missing userId after chat");

  console.log("[smoke] usage audit row");
  // Poll briefly — stream tap records after full consume
  let usage = await prisma.agentUsageEvent.findFirst({
    where: { sessionId, userId: sessionRow.userId },
    orderBy: { createdAt: "desc" },
  });
  for (let i = 0; !usage && i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    usage = await prisma.agentUsageEvent.findFirst({
      where: { sessionId, userId: sessionRow.userId },
      orderBy: { createdAt: "desc" },
    });
  }
  assert(usage, "AgentUsageEvent not found after chat");
  assert(typeof usage.inputTokens === "number", "inputTokens missing");
  assert(typeof usage.outputTokens === "number", "outputTokens missing");
  assert(usage.model.length > 0, "model missing");
  // totalCostUsd may be null (OpenAI does not return USD on completion)

  console.log("[smoke] sign-out");
  await fetch(`${API_BASE}/api/auth/sign-out`, {
    method: "POST",
    headers: jsonHeaders(cookie),
  });

  console.log("[smoke] OK");
}

main()
  .catch((error) => {
    console.error("[smoke] FAILED", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
