import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE_SECTIONS, normalizeProfileBullet } from "./types.js";
import { buildProfileSummaryText, renderProfileContextText } from "./profile-summarizer.js";
import type { ProfileBullet, ProfileData, ProfileDeltaMessage } from "./types.js";

describe("normalizeProfileBullet", () => {
  it("passes {text, sources} objects through, filtering non-string sources", () => {
    expect(
      normalizeProfileBullet({ text: "prefers dark mode", sources: ["s1", 42, "s2", null] }),
    ).toEqual({ text: "prefers dark mode", sources: ["s1", "s2"] });
  });

  it("converts legacy string bullets to {text, sources: []}", () => {
    expect(normalizeProfileBullet("legacy bullet")).toEqual({
      text: "legacy bullet",
      sources: [],
    });
  });

  it("returns an empty bullet for malformed input", () => {
    expect(normalizeProfileBullet(42)).toEqual({ text: "", sources: [] });
    expect(normalizeProfileBullet(null)).toEqual({ text: "", sources: [] });
    expect(normalizeProfileBullet({ text: 42, sources: [] })).toEqual({
      text: "",
      sources: [],
    });
    expect(normalizeProfileBullet(["not", "an", "object"])).toEqual({
      text: "",
      sources: [],
    });
  });
});

function profile(explicitFacts: ProfileData["explicitFacts"] = []): ProfileData {
  return {
    sections: EMPTY_PROFILE_SECTIONS,
    explicitFacts,
  };
}

function delta(lines: Array<[createdAt: string, text: string, sessionId: string]>): ProfileDeltaMessage[] {
  return lines.map(([createdAt, text, sessionId]) => ({ createdAt, text, sessionId }));
}

describe("buildProfileSummaryText", () => {
  it("tags delta lines with their session ids", () => {
    const text = buildProfileSummaryText({
      existing: profile(),
      delta: delta([
        ["2026-08-12T10:00:00.000Z", "I prefer dark mode", "session-a"],
        ["2026-08-12T10:01:00.000Z", "I like short answers", "session-b"],
      ]),
    });
    expect(text).toContain("[2026-08-12T10:00:00.000Z] (session session-a) I prefer dark mode");
    expect(text).toContain("[2026-08-12T10:01:00.000Z] (session session-b) I like short answers");
  });

  it("includes DELETED CONVERSATIONS and RE-EXAMINE when reconsiderations are given", () => {
    const text = buildProfileSummaryText({
      existing: profile(),
      delta: [],
      reconsiderations: [
        {
          deletedSessionId: "session-gone",
          snapshot: "[2026-08-01T09:00:00.000Z] my name is Jane",
        },
      ],
    });
    expect(text).toContain("DELETED CONVERSATIONS");
    expect(text).toContain("Session session-gone was deleted by the user. Its content was:");
    expect(text).toContain("[2026-08-01T09:00:00.000Z] my name is Jane");
    expect(text).toContain("RE-EXAMINE the EXISTING PROFILE in light of the deleted conversations");
  });

  it("omits DELETED CONVERSATIONS and RE-EXAMINE when no reconsiderations are given", () => {
    const text = buildProfileSummaryText({
      existing: profile(),
      delta: [],
    });
    expect(text).not.toContain("DELETED CONVERSATIONS");
    expect(text).not.toContain("RE-EXAMINE");
  });

  it("appends a source session tag to explicit facts that have one", () => {
    const text = buildProfileSummaryText({
      existing: profile([
        {
          section: "preferences",
          fact: "prefers dark mode",
          createdAt: "2026-08-12T10:00:00.000Z",
          source: { sessionId: "session-x", messageId: "msg-1" },
        },
        {
          section: "facts",
          fact: "name is Jane",
          createdAt: "2026-08-12T11:00:00.000Z",
        },
      ]),
      delta: [],
    });
    expect(text).toContain("- prefers dark mode (source session session-x)");
    expect(text).toContain("- name is Jane");
  });
});

describe("renderProfileContextText", () => {
  it("renders bullet text with provenance and remembered facts as bullets", () => {
    const bullets: ProfileBullet[] = [
      { text: "prefers dark mode", sources: ["session-a"] },
    ];
    const data: ProfileData = {
      sections: {
        ...EMPTY_PROFILE_SECTIONS,
        preferences: bullets,
      },
      explicitFacts: [
        { section: "facts", fact: "name is Jane", createdAt: "2026-08-12T10:00:00.000Z" },
      ],
    };
    const text = renderProfileContextText(data, "Profile");
    expect(text).toContain("Preferences:");
    expect(text).toContain("- prefers dark mode");
    expect(text).toContain("Remembered:");
    expect(text).toContain("- name is Jane");
  });
});
