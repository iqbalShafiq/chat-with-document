export const PROFILE_SECTION_KEYS = [
  "facts",
  "preferences",
  "interests",
  "expertise",
  "goals",
] as const;

export type ProfileSectionKey = (typeof PROFILE_SECTION_KEYS)[number];

export type ProfileSections = Record<ProfileSectionKey, string[]>;

export type ExplicitFact = {
  section: ProfileSectionKey | null;
  fact: string;
  createdAt: string;
};

export type ProfileScope =
  | { kind: "user"; userId: string }
  | { kind: "project"; userId: string; projectId: string };

export type ProfileData = {
  sections: ProfileSections;
  explicitFacts: ExplicitFact[];
};

/** One user-originated message text included in the summarizer input. */
export type ProfileDeltaMessage = {
  createdAt: string;
  text: string;
};

export const EMPTY_PROFILE_SECTIONS: ProfileSections = {
  facts: [],
  preferences: [],
  interests: [],
  expertise: [],
  goals: [],
};
