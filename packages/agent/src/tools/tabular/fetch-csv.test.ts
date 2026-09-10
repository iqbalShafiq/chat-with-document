import { describe, expect, it, vi } from "vitest";
import { assertFetchableUrl, fetchTabularUrl, isBlockedAddress } from "./fetch-csv.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function response(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    ...(init.headers ? { headers: init.headers } : {}),
  });
}

describe("assertFetchableUrl", () => {
  it("accepts public http(s) URLs", () => {
    expect(assertFetchableUrl("https://example.com/data.csv").hostname).toBe("example.com");
  });
  it("blocks private hosts and non-http schemes", () => {
    for (const url of [
      "http://localhost/data.csv",
      "http://127.0.0.1/data.csv",
      "http://10.0.0.5/data.csv",
      "http://192.168.1.10/data.csv",
      "http://169.254.169.254/latest",
      "http://[::1]/data.csv",
      "http://[::ffff:127.0.0.1]/data.csv",
      "http://2130706433/data.csv",
      "http://127.1/data.csv",
      "ftp://example.com/data.csv",
      "file:///etc/passwd",
    ]) {
      expect(() => assertFetchableUrl(url), url).toThrow();
    }
  });
});

describe("isBlockedAddress", () => {
  it("blocks mapped and decimal loopback", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
  });
});

describe("fetchTabularUrl", () => {
  it("returns bytes, media type, and final URL", async () => {
    const fetchFn = vi.fn(async () => response("a,b\n1,2\n", { headers: { "content-type": "text/csv" } }));
    const result = await fetchTabularUrl("https://example.com/data.csv", {
      fetchFn: fetchFn as typeof fetch,
      lookupFn: publicLookup,
    });
    expect(result.finalUrl).toBe("https://example.com/data.csv");
    expect(result.mediaType).toBe("text/csv");
    expect(new TextDecoder().decode(result.bytes)).toContain("a,b");
  });

  it("follows redirects and re-validates each hop", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === "https://example.com/data.csv") {
        return response("", { status: 302, headers: { location: "https://cdn.example.com/data.csv" } });
      }
      return response("a,b\n1,2\n", { headers: { "content-type": "text/csv" } });
    });
    const result = await fetchTabularUrl("https://example.com/data.csv", {
      fetchFn: fetchFn as unknown as typeof fetch,
      lookupFn: publicLookup,
    });
    expect(result.finalUrl).toBe("https://cdn.example.com/data.csv");
  });

  it("rejects a public name that resolves to a private address", async () => {
    const fetchFn = vi.fn(async () => response("a,b\n1,2\n"));
    await expect(
      fetchTabularUrl("https://evil.example.com/data.csv", {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toThrow("not allowed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects redirect chains into private hosts", async () => {
    const fetchFn = vi.fn(async () => response("", { status: 302, headers: { location: "http://169.254.169.254/x" } }));
    await expect(
      fetchTabularUrl("https://example.com/data.csv", {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow("not allowed");
  });

  it("aborts oversized downloads", async () => {
    const fetchFn = vi.fn(async () => response("a".repeat(100)));
    await expect(
      fetchTabularUrl("https://example.com/big.csv", {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookupFn: publicLookup,
        maxBytes: 10,
      }),
    ).rejects.toThrow("exceeds");
  });

  it("surfaces HTTP failures", async () => {
    const fetchFn = vi.fn(async () => response("missing", { status: 404 }));
    await expect(
      fetchTabularUrl("https://example.com/missing.csv", {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow("HTTP 404");
  });
});
