// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  SKILLS_SELECTION_KEY,
  intersectWithCatalog,
  loadIdSelection,
  saveIdSelection,
} from "./user-enhancement-selection";

const store = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  },
  configurable: true,
});

beforeEach(() => store.clear());

describe("id selection storage", () => {
  it("round-trips ids and drops blanks", () => {
    saveIdSelection("anreal.test.selection", ["s1", " ", "s2"]);
    expect(loadIdSelection("anreal.test.selection")).toEqual(["s1", "s2"]);
  });
  it("intersects a saved selection with the catalog", async () => {
    const { intersectWithCatalog: intersect } = await import(
      "./user-enhancement-selection"
    );
    expect(intersect(["s1", "gone"], ["s1"])).toEqual(["s1"]);
  });
  it("exposes stable storage keys", () => {
    expect(SKILLS_SELECTION_KEY).toBe("anreal.skills.selection");
    expect(intersectWithCatalog(["a"], [])).toEqual([]);
  });
});
