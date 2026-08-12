export const PROFILE_SECTION_KEYS = [
  "facts",
  "preferences",
  "interests",
  "expertise",
  "goals",
] as const;

export type ProfileSectionKey = (typeof PROFILE_SECTION_KEYS)[number];

/** One bullet of a summarized section with its provenance (session ids). */
export type ProfileBullet = {
  text: string;
  sources: string[];
};

export type ProfileSections = Record<ProfileSectionKey, ProfileBullet[]>;

/** Which conversation produced an explicit fact (remember tool). */
export type ProfileFactSource = {
  sessionId: string;
  messageId?: string | null;
};

export type ExplicitFact = {
  section: ProfileSectionKey | null;
  fact: string;
  createdAt: string;
  /** Provenance of the conversation that produced this fact. */
  source?: ProfileFactSource | null;
};

export type ProfileScope =
  | { kind: "user"; userId: string }
  | { kind: "project"; userId: string; projectId: string };

export type ProfileData = {
  sections: ProfileSections;
  explicitFacts: ExplicitFact[];
};

/** One user-originated message included in the summarizer input. */
export type ProfileDeltaMessage = {
  createdAt: string;
  text: string;
  /** Source chat session of this message (rendered as a prompt tag). */
  sessionId: string;
};

export const EMPTY_PROFILE_SECTIONS: ProfileSections = {
  facts: [],
  preferences: [],
  interests: [],
  expertise: [],
  goals: [],
};

/** Defensive normalization for legacy/unknown bullet storage shapes. */
export function normalizeProfileBullet(value: unknown): ProfileBullet {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return {
        text: record.text,
        sources: Array.isArray(record.sources)
          ? record.sources.filter((item): item is string => typeof item === "string")
          : [],
      };
    }
  }
  return { text: typeof value === "string" ? value : "", sources: [] };
}

/** Normalize stored sections JSON (new {text, sources} or legacy string lists). */
export function normalizeProfileSections(value: unknown): ProfileSections {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    PROFILE_SECTION_KEYS.map((key) => {
      const items = Array.isArray(record[key]) ? (record[key] as unknown[]) : [];
      return [key, items.map(normalizeProfileBullet).filter((b) => b.text)];
    }),
  ) as ProfileSections;
}
