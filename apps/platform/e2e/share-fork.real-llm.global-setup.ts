import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = resolve(E2E_DIR, ".auth");
const STORAGE_STATE_PATH = resolve(AUTH_DIR, "real-llm-user.json");

const API_ORIGIN =
  process.env.E2E_API_ORIGIN?.replace(/\/+$/, "") || "http://localhost:4312";
const HEALTH_URL = `${API_ORIGIN}/api/auth/get-session`;
const SIGN_UP_URL = `${API_ORIGIN}/api/auth/sign-up/email`;
const MODELS_URL = `${API_ORIGIN}/api/models`;
const PASSWORD = "password123";
const REQUIRED_BASE_URL = "https://openrouter.ai/api/v1";
const REQUIRED_MODEL = "meta/muse-spark-1.3-contributor";
const REQUIRED_EFFORT = "minimal";

export function assertRealLlmEnv(env: NodeJS.ProcessEnv = process.env): void {
  const base = (env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
  if (base !== REQUIRED_BASE_URL) {
    throw new Error(
      `real-LLM e2e requires OPENAI_BASE_URL=${REQUIRED_BASE_URL}`,
    );
  }
  if (!(env.OPENAI_API_KEY ?? "").trim()) {
    throw new Error("real-LLM e2e requires a non-empty OPENAI_API_KEY");
  }
}

async function waitForApi(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(HEALTH_URL);
      if (response.ok) return;
      lastError = new Error(`health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`API not ready at ${HEALTH_URL}: ${String(lastError)}`);
}

function sessionCookieFromHeaders(headers: Headers): string | null {
  const raw = headers.getSetCookie?.() ?? [];
  const cookies = raw.length > 0 ? raw : [headers.get("set-cookie") ?? ""];
  for (const header of cookies) {
    for (const pair of header.split(/,(?=[^ ;]+=)/)) {
      const equals = pair.indexOf("=");
      if (equals < 0) continue;
      const name = pair.slice(0, equals).trim();
      if (name === "better-auth.session_token") {
        return pair.slice(equals + 1).split(";")[0]!.trim();
      }
    }
  }
  return null;
}

async function signUp(email: string): Promise<string> {
  const response = await fetch(SIGN_UP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      name: "Share Fork Real LLM E2E",
      email,
      password: PASSWORD,
    }),
  });
  if (!response.ok) {
    throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  }
  const cookie = sessionCookieFromHeaders(response.headers);
  if (!cookie) throw new Error("sign-up did not return a session cookie");
  return cookie;
}

async function writeStorageState(cookieValue: string): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  await writeFile(
    STORAGE_STATE_PATH,
    JSON.stringify(
      {
        cookies: [
          {
            name: "better-auth.session_token",
            value: cookieValue,
            domain: "localhost",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
      null,
      2,
    ),
  );
}

async function assertRequiredModel(cookieValue: string): Promise<void> {
  const response = await fetch(MODELS_URL, {
    headers: { cookie: `better-auth.session_token=${cookieValue}` },
  });
  if (!response.ok) {
    throw new Error(`model catalog preflight failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    models?: Array<{ modelId?: string; reasoningEfforts?: string[] }>;
  };
  const model = body.models?.find(
    (candidate) => candidate.modelId === REQUIRED_MODEL,
  );
  if (!model || !model.reasoningEfforts?.includes(REQUIRED_EFFORT)) {
    throw new Error(
      `model catalog must expose ${REQUIRED_MODEL} with reasoning effort ${REQUIRED_EFFORT}`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  assertRealLlmEnv();
  await waitForApi();
  const email = `share-fork-real-llm-${Date.now()}@test.local`;
  const cookie = await signUp(email);
  await assertRequiredModel(cookie);
  await writeStorageState(cookie);
  console.log(`[share-fork-real-llm-setup] user ready: ${email}`);
}
