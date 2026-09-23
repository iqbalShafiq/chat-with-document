import { describe, expect, it, vi } from "vitest";
import {
  SkillInputError,
  createSkill,
  setSkillEnabled,
  updateSkill,
  validateSkillInput,
} from "./service.js";

function setup() {
  return {
    db: {
      userSkill: {
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        findFirst: vi.fn(
          async (): Promise<Record<string, unknown> | null> => null,
        ),
        create: vi.fn(async (a: { data: unknown }) => a.data),
        update: vi.fn(async (a: { data: unknown }) => a.data),
        delete: vi.fn(),
        count: vi.fn(async () => 0),
      },
    },
  };
}

const VALID = {
  name: "brief",
  description: "Write a morning brief",
  bodyMd: "---\nname: brief\ndescription: Write a morning brief\n---\nDo the brief.",
};

describe("validateSkillInput", () => {
  it("rejects a name with uppercase and reports the field", () => {
    const result = validateSkillInput({
      name: "My Skill",
      description: "d",
      bodyMd: "---\nname: x\ndescription: d\n---\nbody",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("name");
  });

  it("rejects a frontmatter name that differs from the field", () => {
    const result = validateSkillInput({
      ...VALID,
      bodyMd: "---\nname: other\ndescription: Write a morning brief\n---\nbody",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "bodyMd")).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes('"other"'))).toBe(true);
    }
  });

  it("accepts a well-formed skill", () => {
    expect(validateSkillInput(VALID)).toEqual({ ok: true, value: VALID });
  });

  it("accepts quoted frontmatter values", () => {
    const result = validateSkillInput({
      ...VALID,
      bodyMd: '---\nname: "brief"\ndescription: "Write a morning brief"\n---\nbody',
    });
    expect(result.ok).toBe(true);
  });
});

describe("createSkill", () => {
  it("throws SkillInputError on invalid input without touching the db", async () => {
    const { db } = setup();
    await expect(
      createSkill(db, "u1", {
        name: "Bad Name",
        description: "d",
        bodyMd: "---\nname: x\ndescription: d\n---\nb",
      }),
    ).rejects.toBeInstanceOf(SkillInputError);
    expect(db.userSkill.create).not.toHaveBeenCalled();
  });

  it("creates drafts disabled when asked", async () => {
    const { db } = setup();
    const created = (await createSkill(db, "u1", { ...VALID, status: "draft" })) as {
      status: string;
      isEnabled: boolean;
    };
    expect(created.status).toBe("draft");
    expect(created.isEnabled).toBe(false);
  });

  it("refuses when the active skill cap is reached", async () => {
    const { db } = setup();
    db.userSkill.count.mockResolvedValueOnce(20);
    await expect(createSkill(db, "u1", VALID)).rejects.toThrow(
      "Skill limit reached",
    );
  });
});

describe("updateSkill", () => {
  it("bumps the version on valid update", async () => {
    const { db } = setup();
    db.userSkill.findFirst.mockResolvedValueOnce({ id: "s1", version: 2 });
    const updated = (await updateSkill(db, "u1", "s1", VALID)) as {
      version: number;
    };
    expect(updated.version).toBe(3);
  });
});

describe("setSkillEnabled", () => {
  it("refuses to enable past the active cap", async () => {
    const { db } = setup();
    db.userSkill.findFirst.mockResolvedValueOnce({ id: "s1", status: "active" });
    db.userSkill.count.mockResolvedValueOnce(20);
    await expect(setSkillEnabled(db, "u1", "s1", true)).rejects.toThrow(
      "Skill limit reached",
    );
    expect(db.userSkill.update).not.toHaveBeenCalled();
  });

  it("refuses to enable an invalid skill", async () => {
    const { db } = setup();
    db.userSkill.findFirst.mockResolvedValueOnce({ id: "s1", status: "invalid" });
    await expect(setSkillEnabled(db, "u1", "s1", true)).rejects.toThrow(
      "Fix the skill before enabling",
    );
  });

  it("disabling never hits the cap", async () => {
    const { db } = setup();
    db.userSkill.findFirst.mockResolvedValueOnce({ id: "s1", status: "active" });
    await setSkillEnabled(db, "u1", "s1", false);
    expect(db.userSkill.update).toHaveBeenCalled();
  });

  it("refuses to enable a draft skill", async () => {
    const { db } = setup();
    db.userSkill.findFirst.mockResolvedValueOnce({ id: "s1", status: "draft" });
    await expect(setSkillEnabled(db, "u1", "s1", true)).rejects.toThrow(
      "Review the skill",
    );
    expect(db.userSkill.update).not.toHaveBeenCalled();
  });

  it("still allows disabling a draft", async () => {
    const { db } = setup();
    db.userSkill.findFirst.mockResolvedValueOnce({ id: "s1", status: "draft" });
    await setSkillEnabled(db, "u1", "s1", false);
    expect(db.userSkill.update).toHaveBeenCalled();
  });
});
