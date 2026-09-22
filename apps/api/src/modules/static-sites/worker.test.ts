import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  siteWorker: null as null | {
    handlers: Map<string, (...args: never[]) => unknown>;
  },
}));

vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    add = vi.fn(async () => ({}));
  },
  Worker: class FakeWorker {
    handlers = new Map<string, (...args: never[]) => unknown>();
    constructor() {
      f.siteWorker = this as unknown as typeof f.siteWorker;
    }
    on(event: string, handler: (...args: never[]) => unknown) {
      this.handlers.set(event, handler);
      return this;
    }
  },
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
        files.set("site/dist/index.html", "<html></html>");
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
    async destroy() {
      (this as { destroyed: boolean }).destroyed = true;
    },
  };
}

import { createSiteBuildWorker, builderAgentErrorMessage, canonicalizeSandboxTempDir, markSiteBuildFailed, processSiteBuildJob } from "./worker.js";
import { readActiveSiteTitle, readSiteManifest, writeSiteManifest, writeSitesIndex } from "./service.js";

const JOB = {
  data: {
    siteId: "site-1",
    sessionId: "session-1",
    userId: "user-1",
    prompt: "bikinkan landing page kopi",
    brief: null,
    version: 1,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    const ready = published.find(
      (event) =>
        (event as { appEvent: { type: string } }).appEvent?.type === "site_build_ready",
    ) as { appEvent: { previewUrl: string; downloadUrl: string } } | undefined;
    expect(ready?.appEvent.previewUrl).toBe("/api/sites/site-1/v1/preview/index.html");
    expect(ready?.appEvent.downloadUrl).toBe("/api/sites/site-1/v1/download");
  });

  it("uses the enqueued brief without re-parsing", async () => {
    const sandbox = fakeSandbox();
    await processSiteBuildJob(
      {
        data: {
          ...JOB.data,
          prompt: "ganti headline hero jadi lebih berani",
          brief: {
            siteName: "Cahaya Abadi",
            audience: "calon pengantin",
            cta: "Hubungi",
            sections: ["hero", "harga"],
            vibe: "berani",
          },
        },
      },
      {
        createSandboxSession: async () => sandbox as never,
        publish: async () => undefined,
        readTemplate: async () => ({ "package.json": "{}" }),
        runBuilderAgent: f.agentRun,
      },
    );

    expect(f.brief).not.toHaveBeenCalled();
    expect(f.agentRun).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "brief:Cahaya Abadi" }),
    );
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
    const dataDir = mkdtempSync(join(tmpdir(), "site-worker-"));
    vi.stubEnv("SITE_DATA_DIR", dataDir);    const files = new Map<string, string>([
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

    const zipPath = join(dataDir, siteId, "v1", "site.zip");
    const entries = new AdmZip(await readFile(zipPath)).getEntries().map((e) => e.entryName);
    expect(entries).toContain("index.html");
    expect(entries).toContain("assets/app.js");
    expect(await readFile(join(dataDir, siteId, "v1", "index.html"), "utf8")).toBe("<html></html>");
    expect(await readFile(join(dataDir, siteId, "v1", "assets", "app.js"), "utf8")).toBe("console.log(1)");
  });

  it("writes a failed manifest and publishes failed phase when sandbox creation fails", async () => {
    const siteId = "site-session-fail";
    const dataDir = mkdtempSync(join(tmpdir(), "site-worker-"));
    vi.stubEnv("SITE_DATA_DIR", dataDir);
    const published: { appEvent: { type: string; phase?: string } }[] = [];
    await expect(
      processSiteBuildJob(
        { data: { ...JOB.data, siteId } },
        {
          createSandboxSession: async () => {
            throw new Error("docker down");
          },
          publish: async (event: unknown) => {
            published.push(event as { appEvent: { type: string; phase?: string } });
          },
          readTemplate: async () => ({ "package.json": "{}" }),
          runBuilderAgent: f.agentRun,
        },
      ),
    ).rejects.toThrow("docker down");
    const manifest = await readSiteManifest(siteId, dataDir);
    expect(manifest?.status).toBe("failed");
    expect(manifest?.error).toContain("docker down");
    expect(
      published.some((event) => event.appEvent?.type === "site_build_ready"),
    ).toBe(false);
    expect(
      published.some(
        (event) =>
          event.appEvent?.type === "site_build_progress" &&
          event.appEvent?.phase === "failed",
      ),
    ).toBe(true);
  });

  it("skips zip-slip dist entries containing .. segments", async () => {
    const siteId = "site-zip-slip";
    const dataDir = mkdtempSync(join(tmpdir(), "site-worker-"));
    vi.stubEnv("SITE_DATA_DIR", dataDir);
    const files = new Map<string, string>([
      ["site/dist/index.html", "<html></html>"],
      ["site/dist/../../evil.txt", "evil"],
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
      async listFiles() {
        return [...files.keys()].map((path) => ({ path, type: "file" as const }));
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

    const zipPath = join(dataDir, siteId, "v1", "site.zip");
    const entries = new AdmZip(await readFile(zipPath)).getEntries().map((e) => e.entryName);
    expect(entries).toContain("index.html");
    expect(entries.some((name) => name.includes("evil"))).toBe(false);
    expect(entries.some((name) => name.includes(".."))).toBe(false);
  });

  it("writes a static previewUrl, stableVersion, versions entry, and session index", async () => {
    const siteId = "site-static-ready";
    const sessionId = "session-static";
    const dataDir = mkdtempSync(join(tmpdir(), "site-worker-"));
    vi.stubEnv("SITE_DATA_DIR", dataDir);
    const sandbox = fakeSandbox();
    const published: { appEvent: { type: string; previewUrl?: string; downloadUrl?: string } }[] = [];
    await processSiteBuildJob(
      { data: { ...JOB.data, siteId, sessionId } },
      {
        createSandboxSession: async () => sandbox as never,
        publish: async (event: unknown) => {
          published.push(event as { appEvent: { type: string } });
        },
        readTemplate: async () => ({ "package.json": "{}" }),
        runBuilderAgent: f.agentRun,
      },
    );

    const manifest = await readSiteManifest(siteId, dataDir);
    expect(manifest?.status).toBe("ready");
    expect(manifest?.previewUrl).toBe(`/api/sites/${siteId}/v1/preview/index.html`);
    expect(manifest?.stableVersion).toBe(1);
    expect(manifest?.versions[1]?.status).toBe("ready");
    expect(await readFile(join(dataDir, siteId, "v1", "index.html"), "utf8")).toBe("<html></html>");
    const index = JSON.parse(await readFile(join(dataDir, "sites-index.json"), "utf8"));
    expect(index).toMatchObject({ [sessionId]: { siteId, siteName: "Kopi Senja" } });
    const ready = published.find((event) => event.appEvent?.type === "site_build_ready");
    expect(ready?.appEvent.previewUrl).toBe(`/api/sites/${siteId}/v1/preview/index.html`);
    expect(ready?.appEvent.downloadUrl).toBe(`/api/sites/${siteId}/v1/download`);
  });

  it("worker index write satisfies the readActiveSiteTitle contract", async () => {
    const siteId = "site-active-title";
    const sessionId = "session-active";
    const dataDir = mkdtempSync(join(tmpdir(), "site-worker-"));
    vi.stubEnv("SITE_DATA_DIR", dataDir);
    const sandbox = fakeSandbox();
    await processSiteBuildJob(
      { data: { ...JOB.data, siteId, sessionId } },
      {
        createSandboxSession: async () => sandbox as never,
        publish: async () => undefined,
        readTemplate: async () => ({ "package.json": "{}" }),
        runBuilderAgent: f.agentRun,
      },
    );

    await expect(readActiveSiteTitle(sessionId, dataDir)).resolves.toEqual({
      siteId,
      siteName: "Kopi Senja",
    });
  });

  it("merges the versions map and preserves other sessions on iterate", async () => {
    const siteId = "site-merge";
    const dataDir = mkdtempSync(join(tmpdir(), "site-worker-"));
    vi.stubEnv("SITE_DATA_DIR", dataDir);
    await writeSiteManifest(
      {
        siteId, sessionId: "session-1", userId: "user-1", version: 1,
        status: "ready", previewUrl: `/api/sites/${siteId}/v1/preview/index.html`,
        downloadPath: "x", error: null, prompt: "x", brief: null,
        updatedAt: new Date(0).toISOString(), stableVersion: 1,
        versions: { 1: { status: "ready", updatedAt: new Date(0).toISOString() } },
      },
      dataDir,
    );
    await writeSitesIndex({ "session-other": { siteId: "site-other", siteName: "Lain" } }, dataDir);
    const sandbox = fakeSandbox();
    await processSiteBuildJob(
      { data: { ...JOB.data, siteId, sessionId: "session-1", version: 2 } },
      {
        createSandboxSession: async () => sandbox as never,
        publish: async () => undefined,
        readTemplate: async () => ({ "package.json": "{}" }),
        runBuilderAgent: f.agentRun,
      },
    );

    const manifest = await readSiteManifest(siteId, dataDir);
    expect(manifest?.status).toBe("ready");
    expect(manifest?.stableVersion).toBe(2);
    expect(manifest?.versions[1]?.status).toBe("ready");
    expect(manifest?.versions[2]?.status).toBe("ready");
    expect(manifest?.previewUrl).toBe(`/api/sites/${siteId}/v2/preview/index.html`);
    const index = JSON.parse(await readFile(join(dataDir, "sites-index.json"), "utf8"));
    expect(index).toMatchObject({ "session-other": { siteId: "site-other", siteName: "Lain" }, "session-1": { siteId, siteName: "Kopi Senja" } });
  });

  it("preserves stableVersion and versions entries on failure", async () => {
    const siteId = "site-fail-merge";
    const dataDir = mkdtempSync(join(tmpdir(), "site-worker-"));
    vi.stubEnv("SITE_DATA_DIR", dataDir);
    await writeSiteManifest(
      {
        siteId, sessionId: "session-1", userId: "user-1", version: 1,
        status: "ready", previewUrl: `/api/sites/${siteId}/v1/preview/index.html`,
        downloadPath: "x", error: null, prompt: "x", brief: null,
        updatedAt: new Date(0).toISOString(), stableVersion: 1,
        versions: { 1: { status: "ready", updatedAt: new Date(0).toISOString() } },
      },
      dataDir,
    );
    const sandbox = fakeSandbox();
    sandbox.exec = async () => ({
      status: "exited" as const,
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    });
    await expect(
      processSiteBuildJob(
        { data: { ...JOB.data, siteId, version: 2 } },
        {
          createSandboxSession: async () => sandbox as never,
          publish: async () => undefined,
          readTemplate: async () => ({ "package.json": "{}" }),
          runBuilderAgent: f.agentRun,
        },
      ),
    ).rejects.toThrow();
    const manifest = await readSiteManifest(siteId, dataDir);
    expect(manifest?.status).toBe("failed");
    expect(manifest?.stableVersion).toBe(1);
    expect(manifest?.versions[1]?.status).toBe("ready");
    expect(manifest?.versions[2]?.status).toBe("failed");
  });
});

describe("markSiteBuildFailed", () => {
  it("moves a running manifest to failed, keeps the brief, and publishes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "site-failed-"));
    vi.stubEnv("SITE_DATA_DIR", dataDir);
    const siteId = "site-9";
    await writeSiteManifest(
      {
        siteId, sessionId: "session-9", userId: "user-9", version: 2,
        status: "running", previewUrl: null,
        downloadPath: null, error: null, prompt: "ganti headline",
        brief: {
          siteName: "Kopi Senja", audience: "pecinta kopi", cta: "Pesan",
          sections: ["hero"], vibe: "hangat",
        },
        updatedAt: new Date(0).toISOString(), stableVersion: 1,
        versions: {
          1: { status: "ready", updatedAt: new Date(0).toISOString() },
          2: { status: "running", updatedAt: new Date(0).toISOString() },
        },
      },
      dataDir,
    );
    const published: unknown[] = [];
    const moved = await markSiteBuildFailed(siteId, new Error("job stalled"), {
      publish: async (event: unknown) => {
        published.push(event);
      },
    });
    expect(moved).toBe(true);
    const manifest = await readSiteManifest(siteId, dataDir);
    expect(manifest?.status).toBe("failed");
    expect(manifest?.prompt).toBe("ganti headline");
    expect(manifest?.brief?.siteName).toBe("Kopi Senja");
    expect(manifest?.stableVersion).toBe(1);
    expect(manifest?.versions[2]?.status).toBe("failed");
    expect(published).toEqual([
      {
        sessionId: "session-9",
        appEvent: {
          type: "site_build_progress", siteId, version: 2, phase: "failed", message: "Build gagal.",
        },
      },
    ]);
  });

  it("leaves an already-ready manifest untouched", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "site-failed-"));
    vi.stubEnv("SITE_DATA_DIR", dataDir);
    const siteId = "site-10";
    await writeSiteManifest(
      {
        siteId, sessionId: "session-10", userId: "user-10", version: 1,
        status: "ready", previewUrl: "/api/sites/site-10/v1/preview/index.html",
        downloadPath: "x", error: null, prompt: "x", brief: null,
        updatedAt: new Date(0).toISOString(), stableVersion: 1,
        versions: { 1: { status: "ready", updatedAt: new Date(0).toISOString() } },
      },
      dataDir,
    );
    const publish = vi.fn(async () => undefined);
    const moved = await markSiteBuildFailed(siteId, new Error("late"), { publish });
    expect(moved).toBe(false);
    expect((await readSiteManifest(siteId, dataDir))?.status).toBe("ready");
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("createSiteBuildWorker failed handling", () => {
  it("marks the manifest failed only after attempts are exhausted", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "site-worker-"));
    vi.stubEnv("SITE_DATA_DIR", dataDir);
    const siteId = "site-11";
    await writeSiteManifest(
      {
        siteId, sessionId: "session-11", userId: "user-11", version: 1,
        status: "running", previewUrl: null,
        downloadPath: null, error: null, prompt: "x", brief: null,
        updatedAt: new Date(0).toISOString(), stableVersion: null,
        versions: { 1: { status: "running", updatedAt: new Date(0).toISOString() } },
      },
      dataDir,
    );
    const published: unknown[] = [];
    createSiteBuildWorker({
      publish: async (event: unknown) => {
        published.push(event);
      },
    });
    const onFailed = f.siteWorker?.handlers.get("failed");
    expect(onFailed).toBeDefined();
    const job = {
      data: { siteId, sessionId: "session-11", userId: "user-11", prompt: "x", brief: null, version: 1 },
      attemptsMade: 1,
      opts: { attempts: 2 },
    };
    await (onFailed as (job: unknown, error: unknown) => unknown)(job, new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await readSiteManifest(siteId, dataDir))?.status).toBe("running");
    await (onFailed as (job: unknown, error: unknown) => unknown)(
      { ...job, attemptsMade: 2 },
      new Error("boom"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await readSiteManifest(siteId, dataDir))?.status).toBe("failed");
    expect(published).toHaveLength(1);
  });
});

describe("canonicalizeSandboxTempDir", () => {
  it("points TEMP, TMP, and TMPDIR at the canonical temp dir spelling", async () => {
    const { realpath } = await import("node:fs/promises");
    const { tmpdir: osTmpdir } = await import("node:os");
    await canonicalizeSandboxTempDir();
    const canonical = await realpath(osTmpdir());
    expect(process.env.TEMP).toBe(canonical);
    expect(process.env.TMP).toBe(canonical);
    // os.tmpdir() prefers TMPDIR over TEMP/TMP: without this, @anvia/sandbox
    // mkdtemp(os.tmpdir()) + realpath() mismatch fails every read with
    // "escaped its temporary read boundary" (macOS /var -> /private/var).
    expect(process.env.TMPDIR).toBe(canonical);
  });
});

describe("builderAgentErrorMessage", () => {
  it("extracts the underlying error from Anvia stream error events", () => {
    // Installed @anvia/core declares AgentErrorStreamEvent as
    // { type: "error", error: unknown, usage: Usage } — the message lives in
    // `error`, so throwing the whole event serializes as "[object Object]".
    expect(builderAgentErrorMessage({ type: "error", error: new Error("npm install failed") }))
      .toBe("npm install failed");
    expect(builderAgentErrorMessage({ type: "error", error: "boom" })).toBe("boom");
  });

  it("never returns [object Object] for bare error events", () => {
    const message = builderAgentErrorMessage({ type: "error" });
    expect(message).not.toBe("[object Object]");
    expect(message.length).toBeGreaterThan(0);
  });
});
