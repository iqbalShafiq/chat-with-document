import { describe, expect, it } from "vitest";
import { issuesToFieldErrors } from "./skill-issues";

describe("issuesToFieldErrors", () => {
  it("maps skill issues onto fields with a form fallback", () => {
    expect(
      issuesToFieldErrors([{ path: "bodyMd", message: "Frontmatter name: must match" }]),
    ).toEqual({ bodyMd: "Frontmatter name: must match" });
    expect(issuesToFieldErrors([])).toEqual({ form: "Could not save" });
  });
});
