import { describe, expect, it } from "vitest";
import { shouldReturnToList } from "./modal-navigation";

describe("shouldReturnToList", () => {
  it("returns to the list when an editor is open", () => {
    expect(shouldReturnToList("skill-1")).toBe(true);
    expect(shouldReturnToList(null)).toBe(true);
  });

  it("closes the modal when already on the list", () => {
    expect(shouldReturnToList(undefined)).toBe(false);
  });
});
