import { describe, expect, it } from "vitest";
import { listSitesByScope } from "./service.js";

describe("listSitesByScope", () => {
  it("returns empty without an index", async () => {
    const sites = await listSitesByScope("u1", null, {
      dir: "/tmp/anreal-nope-sites",
    });
    expect(sites).toEqual([]);
  });
});
