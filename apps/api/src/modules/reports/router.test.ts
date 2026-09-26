import { describe, expect, it, vi } from "vitest";
import { reportsRouter } from "./router.js";

vi.mock("../auth/middleware.js", () => ({
  requireUser: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "u1", email: "u1@example.com", name: "U1", image: null });
    await next();
  },
}));

vi.mock("./store.js", () => ({
  createReport: vi.fn(async () => ({ documentId: "d1", filename: "r.pdf" })),
  editReport: vi.fn(async () => ({ documentId: "d1", filename: "r.pdf" })),
  getReportFile: vi.fn(async () => null),
}));

import { getReportFile } from "./store.js";

describe("reportsRouter", () => {
  it("previews a report PDF inline", async () => {
    vi.mocked(getReportFile).mockResolvedValueOnce({
      bytes: new Uint8Array([37, 80, 68, 70]),
      filename: "r.pdf",
      mimeType: "application/pdf",
    });
    const response = await reportsRouter.request("/d1/pdf?sessionId=s1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("inline");
  });

  it("requires sessionId and hides out-of-scope reports", async () => {
    const missing = await reportsRouter.request("/d1/pdf");
    expect(missing.status).toBe(400);
    const notFound = await reportsRouter.request("/d1/pdf?sessionId=s1");
    expect(notFound.status).toBe(404);
  });
});
