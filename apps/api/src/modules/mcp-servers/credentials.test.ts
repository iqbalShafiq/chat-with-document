import { describe, expect, it, vi } from "vitest";
import { decryptToken, encryptToken } from "./credentials.js";

const TEST_KEY = "0".repeat(64);

describe("mcp credential encryption", () => {
  it("round-trips a token without exposing plaintext", () => {
    vi.stubEnv("MCP_CREDENTIALS_KEY", TEST_KEY);
    const ref = encryptToken("secret-token");
    expect(ref).not.toContain("secret-token");
    expect(decryptToken(ref)).toBe("secret-token");
    vi.unstubAllEnvs();
  });

  it("produces unique ciphertexts for the same plaintext", () => {
    vi.stubEnv("MCP_CREDENTIALS_KEY", TEST_KEY);
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
    vi.unstubAllEnvs();
  });

  it("rejects tampered envelopes", () => {
    vi.stubEnv("MCP_CREDENTIALS_KEY", TEST_KEY);
    const ref = encryptToken("secret-token");
    const tampered = ref.slice(0, -4) + "AAAA";
    expect(() => decryptToken(tampered)).toThrow(/invalid|decrypt/);
    vi.unstubAllEnvs();
  });

  it("fails closed in production without a key", () => {
    vi.stubEnv("MCP_CREDENTIALS_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => encryptToken("x")).toThrow("MCP_CREDENTIALS_KEY");
    vi.unstubAllEnvs();
  });
});
