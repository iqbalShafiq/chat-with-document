import { describe, expect, it } from "vitest";
import { resolveApiBase } from "./api";

describe("resolveApiBase", () => {
  it("points at the same host on port 3001", () => {
    expect(resolveApiBase("localhost", "http:")).toBe("http://localhost:3001");
    expect(resolveApiBase("192.168.1.24", "http:")).toBe(
      "http://192.168.1.24:3001",
    );
  });
});
