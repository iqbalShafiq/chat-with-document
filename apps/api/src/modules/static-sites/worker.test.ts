import { beforeEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  const cwds: (string | undefined)[] = [];
  return {
    files,
    cwds,
    destroyed: false,
    publishedPorts: [{ containerPort: 4173, hostPort: 49111 }],
    async exec({ command, args, cwd }: { command: string; args?: string[]; cwd?: string }) {
      cwds.push(cwd);
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

  it("uses workspace-relative site/ paths for scaffold writes and commands", async () => {
    const sandbox = fakeSandbox();
    await processSiteBuildJob(JOB, {
      createSandboxSession: async () => sandbox as never,
      publish: async () => undefined,
      readTemplate: async () => ({ "package.json": "{}" }),
      runBuilderAgent: f.agentRun,
    });

    const written = [...sandbox.files.keys()];
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(key.startsWith("site/") || key.startsWith("dist/")).toBe(true);
      expect(key.startsWith("/")).toBe(false);
      expect(key.includes("workspace")).toBe(false);
    }
    expect(sandbox.cwds.length).toBeGreaterThan(0);
    for (const cwd of sandbox.cwds) {
      expect(cwd).toBe("site");
    }
  });

  it("zips nested dist output via recursive workspace-relative listing", async () => {
    const siteId = "site-nested-dist";
    const files = new Map<string, string>([
      ["site/dist/index.html", "<html></html>"],
      ["site/dist/assets/app.js", "console.log(1)"],
    ]);
    const sandbox = {
      destroyed: false,
      publishedPorts: [{ containerPort: 4173, hostPort: 49111 }],
      async exec() {
        return { status: "exited" as const, exitCode: 0, stdout: "", stderr: "" };
      },
      async writeTextFile({ path, text }: { path: string; text: string }) {
        files.set(path, text);
      },
      async readTextFilePage({ path }: { path: string }) {
        return { content: files.get(path) ?? "", startLine: 1, endLine: 1, nextStartLine: null, truncated: false, truncatedBy: null };
      },
      async listFiles({ path }: { path?: string } = {}) {
        const dir = (path ?? "").replace(/\/$/, "");
        const children = new Map<string, "file" | "directory">();
        for (const key of files.keys()) {
          if (!key.startsWith(`${dir}/`)) continue;
          const rest = key.slice(dir.length + 1);
          const slash = rest.indexOf("/");
          if (slash < 0) children.set(key, "file");
          else children.set(`${dir}/${rest.slice(0, slash)}`, "directory");
        }
        return [...children].map(([entryPath, type]) => ({ path: entryPath, type }));
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
    await processSiteBuildJob(
      { data: { ...JOB.data, siteId } },
      {
        createSandboxSession: async () => sandbox as never,
        publish: async () => undefined,
        readTemplate: async () => ({ "package.json": "{}" }),
        runBuilderAgent: f.agentRun,
      },
    );

    const zipPath = join(process.cwd(), "data", "sites", siteId, "v1", "site.zip");
    const entries = new AdmZip(await readFile(zipPath)).getEntries().map((e) => e.entryName);
    expect(entries).toContain("index.html");
    expect(entries).toContain("assets/app.js");
  });
});
