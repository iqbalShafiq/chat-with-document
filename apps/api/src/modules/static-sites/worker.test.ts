import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  brief: vi.fn(async () => ({
    brief: {
      siteName: "Kopi Senja",
      audience: "pecinta kopi",
      cta: "Pesan",
      sections: ["hero", "kontak"],
      vibe: "hangat",
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  })),
  agentRun: vi.fn(async () => ({ text: "done", usage: { inputTokens: 2, outputTokens: 2 } })),
  publish: vi.fn(async (_event: unknown) => undefined),
}));

vi.mock("@anreal/agent", () => ({
  parseSiteBrief: f.brief,
  createSiteBuilderAgent: vi.fn(() => ({})),
  buildSiteBuilderPrompt: (brief: { siteName: string }) => `brief:${brief.siteName}`,
  createCompletionModel: (modelId: string) => ({ modelId }),
  parseCompletionModel: (value: unknown) =>
    typeof value === "string" && value.trim() ? value : null,
}));

function fakeSandbox() {
  const files = new Map<string, string>();
  return {
    files,
    destroyed: false,
    publishedPorts: [{ containerPort: 4173, hostPort: 49111 }],
    async exec({ command, args }: { command: string; args?: string[] }) {
      if (command === "npm" && args?.[0] === "run" && args?.[1] === "build") {
        files.set("dist/index.html", "<html></html>");
        return { status: "exited" as const, exitCode: 0, stdout: "built", stderr: "" };
      }
      return { status: "exited" as const, exitCode: 0, stdout: "", stderr: "" };
    },
    async writeTextFile({ path, text }: { path: string; text: string }) {
      files.set(path, text);
    },
    async readTextFilePage({ path }: { path: string }) {
      return { content: files.get(path) ?? "", startLine: 1, endLine: 1, nextStartLine: null, truncated: false, truncatedBy: null };
    },
    async listFiles() {
      return [...files.keys()].map((path) => ({ path, type: "file" as const }));
    },
    async startProcess() {
      return { id: "p1" };
    },
    async waitForPort() {
      return { containerPort: 4173, host: "127.0.0.1", hostPort: 49111 };
    },
    async destroy() {
      (this as { destroyed: boolean }).destroyed = true;
    },
  };
}

import { processSiteBuildJob } from "./worker.js";

const JOB = {
  data: {
    siteId: "site-1",
    sessionId: "session-1",
    userId: "user-1",
    prompt: "bikinkan landing page kopi",
    version: 1,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processSiteBuildJob", () => {
  it("parses the brief, runs the agent, builds, and publishes ready", async () => {
    const sandbox = fakeSandbox();
    const published: unknown[] = [];
    await processSiteBuildJob(JOB, {
      createSandboxSession: async () => sandbox as never,
      publish: async (event: unknown) => {
        published.push(event);
        await f.publish(event);
      },
      readTemplate: async () => ({ "package.json": "{}" }),
      runBuilderAgent: f.agentRun,
    });

    expect(f.brief).toHaveBeenCalledOnce();
    expect(f.agentRun).toHaveBeenCalledOnce();
    expect(sandbox.destroyed).toBe(true);
    expect(
      published.some(
        (event) =>
          (event as { appEvent: { type: string } }).appEvent?.type === "site_build_ready",
      ),
    ).toBe(true);
  });

  it("destroys the sandbox when the build fails", async () => {
    const sandbox = fakeSandbox();
    sandbox.exec = async () => ({
      status: "exited" as const,
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    });
    await expect(
      processSiteBuildJob(JOB, {
        createSandboxSession: async () => sandbox as never,
        publish: async () => undefined,
        readTemplate: async () => ({ "package.json": "{}" }),
        runBuilderAgent: f.agentRun,
      }),
    ).rejects.toThrow();
    expect(sandbox.destroyed).toBe(true);
  });
});
