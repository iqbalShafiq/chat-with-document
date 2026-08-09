import { describe, expect, it, vi } from "vitest";
import type {
  CompletionModel,
  CompletionRequest,
  CompletionResponse,
} from "@anvia/core/completion";
import {
  assertSafeImageUrl,
  createViewImageTool,
  isBlockedHostname,
  isBlockedIp,
  loadRemoteImage,
  sniffImageMediaType,
} from "./vision-helper.js";

function fakeModel(respondWith: string): CompletionModel {
  return {
    provider: "openai",
    defaultModel: "openai/gpt-5-nano",
    capabilities: {
      streaming: false,
      tools: false,
      toolChoice: false,
      imageInput: true,
      documentInput: false,
      outputSchema: false,
      reasoning: false,
    },
    completion: async (_request: CompletionRequest) =>
      ({
        choice: [{ type: "text", text: respondWith }],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedInputTokens: 0,
        },
        response: {},
      }) as unknown as CompletionResponse,
  };
}

function fakeImageRecord(
  overrides: Partial<{
    id: string;
    userId: string;
    sessionId: string;
    r2Key: string;
    mediaType: string;
  }> = {},
) {
  return {
    id: "img-1",
    userId: "user-1",
    sessionId: "session-1",
    r2Key: "key-1",
    mediaType: "image/png",
    ...overrides,
  };
}

function fakeStore(records: ReturnType<typeof fakeImageRecord>[]) {
  return {
    getImage: async (id: string) =>
      records.find((record) => record.id === id) ?? null,
    getObjectBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    assertImageAccess: async () => true,
  };
}

/** Minimal valid JPEG magic so sniff accepts it. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

function jsonResponse(
  status: number,
  body: BodyInit | null,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

describe("createViewImageTool", () => {
  it("describes a session image via the vision model", async () => {
    const tool = createViewImageTool({
      userId: "user-1",
      sessionId: "session-1",
      store: fakeStore([fakeImageRecord()]) as never,
      model: fakeModel("seekor kucing oranye di sofa"),
    });
    const result = await tool.call(
      { imageId: "img-1", question: "apa isinya?" },
      {} as never,
    );
    expect(result).toBe("seekor kucing oranye di sofa");
  });

  it("describes a public image URL via the vision model", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, JPEG_BYTES, { "content-type": "image/jpeg" }),
    );
    // Bypass DNS for a well-known public host by stubbing resolve path:
    // we use a literal public IP hostname pattern — use example.com after
    // mocking assert via fetch only; DNS may fail offline so stub lookup by
    // using a fetch that we control and a host that resolves in CI, or mock
    // at loadRemoteImage level via fetchFn after safety. For unit tests of
    // the tool path, inject a fetch that never hits the network and patch
    // URL to a public IP that is not blocked (1.1.1.1 is Cloudflare DNS).
    const tool = createViewImageTool({
      userId: "user-1",
      sessionId: "session-1",
      store: fakeStore([]) as never,
      model: fakeModel("logo with green leaf and bold wordmark"),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const result = await tool.call(
      {
        url: "https://1.1.1.1/logo.jpg",
        question: "describe the logo",
      },
      {} as never,
    );
    expect(result).toBe("logo with green leaf and bold wordmark");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("refuses images that are not owned by the session user", async () => {
    const tool = createViewImageTool({
      userId: "user-1",
      sessionId: "session-1",
      store: fakeStore([
        fakeImageRecord({ id: "img-2", userId: "user-2" }),
        fakeImageRecord({
          id: "img-3",
          userId: "user-1",
          sessionId: "session-9",
        }),
      ]) as never,
      model: fakeModel("should not run"),
    });
    const foreign = await tool.call({ imageId: "img-2" }, {} as never);
    const otherSession = await tool.call({ imageId: "img-3" }, {} as never);
    expect(foreign).toContain("not found");
    expect(otherSession).toContain("not found");
  });

  it("returns a helpful message for a missing image", async () => {
    const tool = createViewImageTool({
      userId: "user-1",
      sessionId: "session-1",
      store: fakeStore([]) as never,
      model: fakeModel("unused"),
    });
    const result = await tool.call({ imageId: "nope" }, {} as never);
    expect(result).toContain("not found");
  });

  it("rejects private image hosts (SSRF)", async () => {
    const tool = createViewImageTool({
      userId: "user-1",
      sessionId: "session-1",
      store: fakeStore([]) as never,
      model: fakeModel("should not run"),
      fetchFn: vi.fn(async () => {
        throw new Error("should not fetch");
      }) as unknown as typeof fetch,
    });
    const result = await tool.call(
      { url: "http://127.0.0.1/secret.png" },
      {} as never,
    );
    expect(result).toMatch(/not allowed|private/i);
  });
});

describe("assertSafeImageUrl / blocked hosts", () => {
  it("blocks localhost and private IPv4 literals", async () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("foo.local")).toBe(true);
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.5")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("1.1.1.1")).toBe(false);

    await expect(
      assertSafeImageUrl(new URL("http://127.0.0.1/a.png")),
    ).resolves.toMatch(/not allowed/i);
    await expect(
      assertSafeImageUrl(new URL("http://169.254.169.254/latest/meta")),
    ).resolves.toMatch(/not allowed/i);
    await expect(
      assertSafeImageUrl(new URL("https://1.1.1.1/logo.png")),
    ).resolves.toBeNull();
  });

  it("rejects non-http schemes and credentialed URLs", async () => {
    await expect(
      assertSafeImageUrl(new URL("file:///etc/passwd")),
    ).resolves.toMatch(/http/i);
    await expect(
      assertSafeImageUrl(new URL("https://user:pass@1.1.1.1/x.png")),
    ).resolves.toMatch(/credentials/i);
  });
});

describe("loadRemoteImage", () => {
  it("follows a single safe redirect and returns image bytes", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(302, null, {
          location: "https://1.1.1.1/cdn/logo.jpg",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, JPEG_BYTES, { "content-type": "image/jpeg" }),
      );

    const result = await loadRemoteImage({
      url: "https://1.1.1.1/logo",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ mediaType: "image/jpeg" });
    if (!("buffer" in result)) throw new Error("expected buffer");
    expect(result.buffer.length).toBe(JPEG_BYTES.length);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects non-image content types", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, "not an image", { "content-type": "text/html" }),
    );
    const result = await loadRemoteImage({
      url: "https://1.1.1.1/page",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toMatchObject({
      error: expect.stringMatching(/did not return an image/i),
    });
  });
});

describe("sniffImageMediaType", () => {
  it("detects jpeg and png magic bytes", () => {
    expect(sniffImageMediaType(Buffer.from(JPEG_BYTES))).toBe("image/jpeg");
    expect(
      sniffImageMediaType(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    expect(sniffImageMediaType(Buffer.from([0, 1, 2, 3]))).toBeNull();
  });
});
