import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const server = Object.freeze({
    name: "context7",
    tools: Object.freeze([]),
  });

  return {
    server,
    clientConstructor: vi.fn((_options: unknown) => undefined),
    connect: vi.fn(async () => server),
    close: vi.fn(async () => undefined),
    legacyConnect: vi.fn(async () => server),
    legacyHttp: vi.fn((options: unknown) => options),
  };
});

vi.mock("@anvia/mcp", () => ({
  McpClient: class {
    constructor(options: unknown) {
      mocks.clientConstructor(options);
    }

    connect() {
      return mocks.connect();
    }

    close() {
      return mocks.close();
    }
  },
}));

// Keeps the v0 module importable during the RED run. The GREEN implementation
// must not call either legacy API.
vi.mock("@anvia/core/mcp", () => ({
  connectMcp: mocks.legacyConnect,
  mcp: { http: mocks.legacyHttp },
}));

type Context7Module = typeof import("./context7.js") & {
  closeContext7Mcp?: () => Promise<void>;
};

async function loadContext7(): Promise<Context7Module> {
  return (await import("./context7.js")) as Context7Module;
}

beforeEach(() => {
  vi.resetModules();
  mocks.clientConstructor.mockClear();
  mocks.connect.mockReset().mockResolvedValue(mocks.server);
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.legacyConnect.mockReset().mockResolvedValue(mocks.server);
  mocks.legacyHttp.mockClear();
});

describe("Context7 MCP v1 lifecycle", () => {
  it("uses one strict Streamable HTTP client with an explicit authorization header", async () => {
    const context7 = await loadContext7();

    const first = context7.createContext7McpServer({
      url: "https://context7.example/mcp",
      apiKey: "  context7-secret  ",
    });
    const second = context7.createContext7McpServer({
      url: "https://ignored-after-first-connect.example/mcp",
      apiKey: "ignored-secret",
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      mocks.server,
      mocks.server,
    ]);
    expect(mocks.clientConstructor).toHaveBeenCalledOnce();
    expect(mocks.clientConstructor).toHaveBeenCalledWith({
      name: "context7",
      transport: {
        type: "streamableHttp",
        url: "https://context7.example/mcp",
        ssrfProtection: "strict",
        headers: { authorization: "Bearer context7-secret" },
      },
    });
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.legacyHttp).not.toHaveBeenCalled();
    expect(mocks.legacyConnect).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.server)).not.toContain("context7-secret");
  });

  it("uses the public endpoint without synthesizing an empty header", async () => {
    const context7 = await loadContext7();

    await expect(
      context7.createContext7McpServer({ apiKey: "   " }),
    ).resolves.toBe(mocks.server);

    expect(mocks.clientConstructor).toHaveBeenCalledWith({
      name: "context7",
      transport: {
        type: "streamableHttp",
        url: context7.DEFAULT_CONTEXT7_URL,
        ssrfProtection: "strict",
      },
    });
  });

  it("degrades a configured remote failure to null and closes once on shutdown", async () => {
    const connectionError = new Error("remote unavailable");
    mocks.connect.mockRejectedValueOnce(connectionError);
    const context7 = await loadContext7();

    await expect(
      context7.createContext7McpServer({
        url: "https://context7.example/mcp",
        apiKey: "configured-secret",
      }),
    ).resolves.toBeNull();

    expect(context7.closeContext7Mcp).toBeTypeOf("function");
    if (!context7.closeContext7Mcp) {
      throw new Error("closeContext7Mcp is not implemented");
    }
    const first = context7.closeContext7Mcp();
    const second = context7.closeContext7Mcp();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
