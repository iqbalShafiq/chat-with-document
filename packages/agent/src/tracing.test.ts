import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const observerHandle = { name: "langfuse-observer" };

  return {
    clientConstructor: vi.fn((_options: unknown) => undefined),
    observer: vi.fn(() => observerHandle),
    observerHandle,
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    legacyCreate: vi.fn(() => ({ legacy: true })),
  };
});

vi.mock("@anvia/langfuse", () => ({
  LangfuseClient: class {
    constructor(options: unknown) {
      mocks.clientConstructor(options);
    }

    observer() {
      return mocks.observer();
    }

    flush() {
      return mocks.flush();
    }

    close() {
      return mocks.close();
    }
  },
  langfuse: { create: mocks.legacyCreate },
}));

type TracingModule = typeof import("./tracing.js") & {
  flushTracing?: () => Promise<void>;
  closeTracing?: () => Promise<void>;
};

let tracingModule: TracingModule;

beforeAll(async () => {
  vi.stubEnv("LANGFUSE_BASE_URL", "https://langfuse.example");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");
  vi.stubEnv("NODE_ENV", "test");
  tracingModule = (await import("./tracing.js")) as TracingModule;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe.sequential("tracing lifecycle", () => {
  it("owns one v1 Langfuse client and exposes its observer", () => {
    expect(mocks.legacyCreate).not.toHaveBeenCalled();
    expect(mocks.clientConstructor).toHaveBeenCalledOnce();
    expect(mocks.clientConstructor).toHaveBeenCalledWith({
      baseUrl: "https://langfuse.example",
      publicKey: "pk-test",
      secretKey: "sk-test",
      environment: "test",
    });

    const tracing = tracingModule.tracing as {
      observer?: () => unknown;
    };
    expect(tracing.observer?.()).toBe(mocks.observerHandle);
    expect(mocks.observer).toHaveBeenCalledOnce();
  });

  it("flushes through the owned client", async () => {
    expect(tracingModule.flushTracing).toBeTypeOf("function");
    if (!tracingModule.flushTracing) return;

    await tracingModule.flushTracing();

    expect(mocks.flush).toHaveBeenCalledOnce();
  });

  it("reuses one close promise and closes the owned client once", async () => {
    expect(tracingModule.closeTracing).toBeTypeOf("function");
    if (!tracingModule.closeTracing) return;

    const first = tracingModule.closeTracing();
    const second = tracingModule.closeTracing();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
