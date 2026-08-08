import { describe, expect, it } from "vitest";
import { MODEL_SELECT } from "./service.js";

describe("models service", () => {
  it("exposes capability columns on MODEL_SELECT", () => {
    const keys = Object.keys(MODEL_SELECT);
    expect(keys).toContain("outputType");
    expect(keys).toContain("inputModalities");
    expect(keys).toContain("outputModalities");
    expect(keys).toContain("imageCapabilities");
  });
});
