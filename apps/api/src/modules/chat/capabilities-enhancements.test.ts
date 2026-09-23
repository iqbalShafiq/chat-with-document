import { describe, expect, it, vi } from "vitest";
import { getUserEnhancementCounts } from "./user-enhancements.js";

describe("getUserEnhancementCounts", () => {
  it("counts owned rows without leaking urls or credentials", async () => {
    const db = {
      userSkill: {
        count: vi.fn(async () => 2),
      },
      userMcpServer: {
        count: vi.fn(async () => 1),
      },
    };
    const counts = await getUserEnhancementCounts(db, "u1");
    expect(counts).toEqual({ userSkillsCount: 2, userMcpCount: 1 });
    expect(JSON.stringify(counts)).not.toContain("http");
    expect(db.userSkill.count).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });
});
