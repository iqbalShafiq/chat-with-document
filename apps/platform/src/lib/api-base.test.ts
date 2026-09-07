import { describe, expect, it } from "vitest";
import { resolveApiBase } from "./api";

describe("resolveApiBase", () => {
  it("points at the same host on port 3001 by default", () => {
    expect(resolveApiBase("localhost", "http:", {})).toBe(
      "http://localhost:3001",
    );
    expect(resolveApiBase("192.168.1.24", "http:", {})).toBe(
      "http://192.168.1.24:3001",
    );
  });

  it("follows VITE_API_PORT from the shared root .env when VITE_API_BASE is unset", () => {
    expect(
      resolveApiBase("localhost", "http:", { VITE_API_PORT: "4312" }),
    ).toBe("http://localhost:4312");
  });

  it("prefers VITE_API_BASE over VITE_API_PORT", () => {
    expect(
      resolveApiBase("localhost", "http:", {
        VITE_API_BASE: "http://localhost:5000/",
        VITE_API_PORT: "4312",
      }),
    ).toBe("http://localhost:5000");
  });
});
