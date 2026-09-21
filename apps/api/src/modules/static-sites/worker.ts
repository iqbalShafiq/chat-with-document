import AdmZip from "adm-zip";
import { Worker } from "bullmq";
import {
  buildSiteBuilderPrompt,
  createSiteBuilderAgent,
  parseSiteBrief,
} from "@anreal/agent";
import {
  createDockerSandboxTools,
  DockerSandboxClient,
  type DockerSandboxRuntime,
} from "@anvia/sandbox";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getBullmqConnectionOptions } from "../../lib/redis.js";
import { SITE_BUILD_QUEUE, type SiteBuildJobData } from "./queue.js";
import {
  SITE_BUILD_TIMEOUT_MS,
  assertSafeSiteId,
  siteBuildConfig,
  siteDataDir,
  writeSiteManifest,
  type SiteManifest,
} from "./service.js";
import { publishSiteBuildEvent, type SiteBuildPhase } from "../chat/site-events.js";

export const SITE_PREVIEW_PORT = 4173;
export const SITE_TEMPLATE_DIR = join(process.cwd(), "sites-template");

export type BuilderAgentRunner = (input: {
  prompt: string;
  tools: { name: string }[];
}) => Promise<{ text: string }>;

export type SiteBuildEventEnvelope = {
  sessionId: string;
  appEvent: { type: string; [key: string]: unknown };
};

export type SandboxSession = {
  exec(input: {
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
  }): Promise<{ status: string; exitCode?: number; stdout: unknown; stderr: unknown }>;
  writeTextFile(input: { path: string; text: string }): Promise<unknown>;
  readTextFilePage(input: {
    path: string;
    startLine?: number;
    lineCount?: number;
    maxBytes?: number;
  }): Promise<{ content: string; nextStartLine: number | null }>;
  listFiles(input?: { path?: string }): Promise<readonly { path: string }[]>;
  startProcess(input: {
    command: string;
    args?: string[];
    cwd?: string;
  }): Promise<{ id: string }>;
  waitForPort(input: {
    containerPort: number;
    timeoutMs?: number;
  }): Promise<{ hostPort: number }>;
  publishedPorts: readonly { containerPort: number; hostPort: number }[];
  destroy(): Promise<void>;
  runtime?: unknown;
};

export type SiteBuildDeps = {
  createSandboxSession?: () => Promise<SandboxSession>;
  publish?: (event: SiteBuildEventEnvelope) => Promise<void>;
  readTemplate?: () => Promise<Record<string, string>>;
  runBuilderAgent?: BuilderAgentRunner;
};

function decodeOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value ?? "");
}

async function defaultCreateSandboxSession(): Promise<SandboxSession> {
  const client = new DockerSandboxClient();
  await client.pullImage({ image: "node:22-bookworm" });
  const sandbox = await client.createSandbox({
    image: "node:22-bookworm",
    workspace: { type: "ephemeral" },
    network: { mode: "bridge", ports: [SITE_PREVIEW_PORT] },
  });
  const runtime = sandbox.runtime;
  return {
    runtime,
    publishedPorts: runtime.publishedPorts.map((port) => ({
      containerPort: port.containerPort,
      hostPort: port.hostPort,
    })),
    exec: async (input) => {
      const result = await runtime.exec(input);
      return {
        status: result.status,
        ...(result.status === "exited" ? { exitCode: result.exitCode } : {}),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    writeTextFile: (input) => runtime.writeTextFile(input),
    readTextFilePage: (input) => runtime.readTextFilePage(input),
    listFiles: (input) => runtime.listFiles(input),
    startProcess: (input) => runtime.startProcess(input),
    waitForPort: (input) => runtime.waitForPort(input),
    destroy: () => sandbox.destroy(),
  };
}

export async function processSiteBuildJob(
  job: { data: SiteBuildJobData },
  deps: SiteBuildDeps = {},
): Promise<void> {
  const config = siteBuildConfig();
  const { siteId, sessionId, userId, prompt, version } = job.data;
  assertSafeSiteId(siteId);
  const startedAt = Date.now();
  const baseDir = join(siteDataDir(), siteId, `v${version}`);
  const publish = deps.publish ?? publishSiteBuildEvent;
  const progress = (phase: SiteBuildPhase, message: string) =>
    publish({ sessionId, appEvent: { type: "site_build_progress", siteId, version, phase, message } }).catch((error) => {
      console.warn(`[sites] progress publish failed ${siteId}`, error);
    });

  await writeSiteManifest({
    siteId, sessionId, userId, version,
    status: "running",
    previewUrl: null, downloadPath: null, error: null,
    prompt,
    updatedAt: new Date().toISOString(),
  });
  await progress("starting", "Menyiapkan sandbox build.");

  const createSession = deps.createSandboxSession ?? defaultCreateSandboxSession;
  const session = await createSession();
  const ops = (session.runtime as Omit<SandboxSession, "destroy" | "runtime"> | undefined) ?? session;
  try {
    const readTemplate = deps.readTemplate ?? (await import("./template.js")).readSiteTemplate;
    const template = await readTemplate();
    for (const [path, text] of Object.entries(template)) {
      await ops.writeTextFile({ path: `/workspace/site/${path}`, text });
    }
    await progress("planning", "Menyusun brief situs.");

    const { brief } = await parseSiteBrief({
      model: config.model,
      modelId: config.modelId,
      prompt,
      abortSignal: AbortSignal.timeout(SITE_BUILD_TIMEOUT_MS),
    });

    let tools: { name: string }[];
    try {
      tools = createDockerSandboxTools({
        sandbox: ((session.runtime ?? session) as unknown as DockerSandboxRuntime),
        tools: ["exec_command", "read_file", "write_file", "list_files", "start_process", "wait_for_port"],
        exec: { commands: { mode: "allow", values: ["npm", "npx", "node"] } },
      }) as unknown as { name: string }[];
    } catch (error) {
      if (!deps.runBuilderAgent) throw error;
      tools = [];
    }
    const runAgent: BuilderAgentRunner = deps.runBuilderAgent ??
      (async ({ prompt: agentPrompt, tools: agentTools }) => {
        const agent = createSiteBuilderAgent({ model: config.model, tools: agentTools as never[] });
        const stream = agent.stream({
          prompt: agentPrompt,
          session: { sessionId, userId },
          abortSignal: AbortSignal.timeout(SITE_BUILD_TIMEOUT_MS),
        });
        const iterator = stream[Symbol.asyncIterator]();
        let text = "";
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          const event = next.value as { type?: string; delta?: string };
          if (event?.type === "text_delta" && typeof event.delta === "string") text += event.delta;
          if (event?.type === "error") throw event;
        }
        const outcome = (await stream.result) as { type: string };
        if (outcome.type !== "response") throw new Error(`Builder agent did not complete: ${outcome.type}`);
        return { text };
      });

    await progress("building", "Membangun halaman per section.");
    await runAgent({
      prompt: buildSiteBuilderPrompt(brief),
      tools: [...tools] as { name: string }[],
    });

    await progress("bundling", "Menjalankan production build.");
    const install = await ops.exec({ command: "npm", args: ["install", "--no-audit", "--no-fund"], cwd: "/workspace/site", timeoutMs: 240_000 });
    if (install.status !== "exited" || install.exitCode !== 0) {
      throw new Error(`npm install failed: ${decodeOutput(install.stderr) || decodeOutput(install.stdout)}`.slice(0, 2000));
    }
    const build = await ops.exec({ command: "npm", args: ["run", "build"], cwd: "/workspace/site", timeoutMs: 240_000 });
    if (build.status !== "exited" || build.exitCode !== 0) {
      throw new Error(`vite build failed: ${decodeOutput(build.stderr) || decodeOutput(build.stdout)}`.slice(0, 2000));
    }

    await progress("preview", "Menyiapkan pratinjau.");
    await ops.startProcess({ command: "npm", args: ["run", "preview", "--", "--host", "0.0.0.0"], cwd: "/workspace/site" });
    const port = await ops.waitForPort({ containerPort: SITE_PREVIEW_PORT, timeoutMs: 60_000 });
    const previewUrl = `http://127.0.0.1:${port.hostPort}`;

    await mkdir(baseDir, { recursive: true });
    const zip = new AdmZip();
    const entries = await ops.listFiles({ path: "/workspace/site/dist" });
    for (const entry of entries) {
      if (entry.path.endsWith("/")) continue;
      const text = await readSandboxText(ops, `/workspace/site/dist/${entry.path}`);
      zip.addFile(entry.path, Buffer.from(text, "utf8"));
    }
    const downloadPath = join(baseDir, "site.zip");
    zip.writeZip(downloadPath);

    const manifest: SiteManifest = {
      siteId, sessionId, userId, version,
      status: "ready",
      previewUrl, downloadPath, error: null,
      prompt,
      updatedAt: new Date().toISOString(),
    };
    await writeSiteManifest(manifest);
    await publish({
      sessionId,
      appEvent: {
        type: "site_build_ready",
        siteId, version, previewUrl,
        screenshotUrl: null,
        downloadUrl: `/api/sites/${siteId}/v${version}/download`,
      },
    }).catch((error) => {
      console.warn(`[sites] ready publish failed ${siteId}`, error);
    });
    console.log(`[sites] ready ${siteId} v${version} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    await writeSiteManifest({
      siteId, sessionId, userId, version,
      status: "failed",
      previewUrl: null, downloadPath: null,
      error: error instanceof Error ? error.message.slice(0, 1000) : String(error),
      prompt,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    await session.destroy().catch((error) => {
      console.warn(`[sites] sandbox destroy failed ${siteId}`, error);
    });
  }
}

async function readSandboxText(
  sandbox: { readTextFilePage(input: { path: string; startLine: number; lineCount: number; maxBytes: number }): Promise<{ content: string; nextStartLine: number | null }> },
  path: string,
): Promise<string> {
  let startLine = 1;
  let out = "";
  for (;;) {
    const page = await sandbox.readTextFilePage({ path, startLine, lineCount: 2000, maxBytes: 1024 * 1024 });
    out += page.content;
    if (page.nextStartLine == null) return out;
    startLine = page.nextStartLine;
  }
}

export function createSiteBuildWorker(): Worker<SiteBuildJobData> {
  return new Worker<SiteBuildJobData>(
    SITE_BUILD_QUEUE,
    async (job) => {
      try {
        await processSiteBuildJob(job);
      } catch (error) {
        console.error(`[sites] failed ${job.id}`, error);
        throw error;
      }
    },
    {
      connection: getBullmqConnectionOptions(),
      concurrency: siteBuildConfig().concurrency,
    },
  );
}
