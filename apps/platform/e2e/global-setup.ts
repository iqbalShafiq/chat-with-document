import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = resolve(E2E_DIR, ".auth");
const STORAGE_STATE_PATH = resolve(AUTH_DIR, "user.json");
const ENV_PATH = resolve(AUTH_DIR, "env.json");

const API_ORIGIN = "http://localhost:3001";
const HEALTH_URL = `${API_ORIGIN}/api/auth/get-session`;
const SIGN_UP_URL = `${API_ORIGIN}/api/auth/sign-up/email`;
const SIGN_IN_URL = `${API_ORIGIN}/api/auth/sign-in/email`;

const PASSWORD = "password123";

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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`API did not become healthy within ${timeoutMs}ms: ${String(lastError)}`);
}

function sessionCookieFromHeaders(headers: Headers): string | null {
  const setCookies = headers.getSetCookie();
  for (const header of setCookies) {
    const [pair] = header.split(";");
    const equals = pair?.indexOf("=");
    if (!pair || equals === undefined || equals < 0) continue;
    const name = pair.slice(0, equals).trim();
    if (name === "better-auth.session_token") {
      return pair.slice(equals + 1).trim();
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
      name: "E2E User",
      email,
      password: PASSWORD,
    }),
  });
  if (response.ok) {
    const cookie = sessionCookieFromHeaders(response.headers);
    if (cookie) return cookie;
  }
  if (response.status === 422 || response.status === 409) {
    const signIn = await fetch(SIGN_IN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (signIn.ok) {
      const cookie = sessionCookieFromHeaders(signIn.headers);
      if (cookie) return cookie;
    }
    throw new Error(`sign-in failed for existing user: ${signIn.status}`);
  }
  throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
}

async function writeStorageState(cookieValue: string): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  const storageState = {
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
  };
  await writeFile(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2));
}

async function globalSetup(): Promise<void> {
  await waitForApi();
  const email = `e2e-${Date.now()}@test.local`;
  const cookie = await signUp(email);
  await writeStorageState(cookie);
  await writeFile(ENV_PATH, JSON.stringify({ email }, null, 2));
  console.log(`[global-setup] e2e user ready: ${email}`);
}

export default globalSetup;
