/**
 * Lifecycle owner for Task 18 worker-restart acceptance.
 *
 * The worker publishes its pid after the chat-run queue is ready. This helper
 * sends SIGTERM to that process, then nudges the existing `tsx --watch`
 * supervisor so it starts a replacement. It never scans or kills unrelated
 * PIDs.
 */
import { readFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(E2E_DIR, "../../..");
const WORKER_ENTRY = resolve(REPO_ROOT, "apps/api/src/worker.ts");

export function chatWorkerPidFile(): string {
  return (
    process.env.CHAT_WORKER_PID_FILE ??
    join(tmpdir(), "anreal-worker.pid")
  );
}

function readWorkerPid(file: string): number {
  const raw = readFileSync(file, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`invalid worker pid in ${file}`);
  }
  return pid;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(label);
}

export async function restartChatWorker(): Promise<{
  previousPid: number;
  nextPid: number;
}> {
  const file = chatWorkerPidFile();
  const previousPid = readWorkerPid(file);
  process.kill(previousPid, "SIGTERM");
  await waitUntil(
    () => !pidAlive(previousPid),
    20_000,
    `chat worker ${previousPid} did not exit after SIGTERM`,
  );
  const now = new Date();
  await utimes(WORKER_ENTRY, now, now);
  await waitUntil(() => {
    try {
      const nextPid = readWorkerPid(file);
      return nextPid !== previousPid && pidAlive(nextPid);
    } catch {
      return false;
    }
  }, 30_000, "replacement chat worker did not publish a new pid");
  return { previousPid, nextPid: readWorkerPid(file) };
}
