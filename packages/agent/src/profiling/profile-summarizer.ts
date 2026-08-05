import type { CompletionModel, Usage } from "@anvia/core";
import { ExtractorBuilder } from "@anvia/core/extractor";
import z from "zod";
import { EMPTY_PROFILE_SECTIONS } from "./types.js";
import type {
  ExplicitFact,
  ProfileData,
  ProfileDeltaMessage,
  ProfileSectionKey,
  ProfileSections,
} from "./types.js";

export const profileSectionsSchema = z.object({
  sections: z.object({
    facts: z.array(z.string()).default([]),
    preferences: z.array(z.string()).default([]),
    interests: z.array(z.string()).default([]),
    expertise: z.array(z.string()).default([]),
    goals: z.array(z.string()).default([]),
  }),
});

export const PROFILE_SUMMARY_INSTRUCTIONS = [
  "You maintain a durable user profile used to personalize future conversations.",
  "Merge the NEW MESSAGES into the EXISTING PROFILE. Keep every existing point unless a new message directly contradicts it.",
  "EXPLICIT FACTS were confirmed by the user and MUST be preserved verbatim or merged into the matching section without changing their meaning.",
  "Write each section as a list of concise, concrete, non-redundant bullet points (1-2 lines each, max 12 per section).",
  "Infer only what is clearly supported by the messages; mark uncertainty with 'possibly'.",
  "NEVER include sensitive data: passwords, credentials, tokens, financial account numbers, health records, or government IDs. Such content stays out of the profile entirely.",
  "Output the COMPLETE updated profile (a replacement, not a diff).",
].join("\n");

function renderList(items: string[]): string {
  return items.length === 0 ? "(none)" : items.map((item) => `- ${item}`).join("\n");
}

export function renderProfileContextText(profile: ProfileData, label: string): string {
  const sectionLabels: Array<[ProfileSectionKey, string]> = [
    ["facts", "Facts"],
    ["preferences", "Preferences"],
    ["interests", "Interests"],
    ["expertise", "Expertise"],
    ["goals", "Goals"],
  ];
  const lines = [label];
  for (const [key, labelText] of sectionLabels) {
    lines.push(`${labelText}:`, renderList(profile.sections[key]));
  }
  if (profile.explicitFacts.length > 0) {
    lines.push("Remembered:", renderList(profile.explicitFacts.map((f) => f.fact)));
  }
  return lines.join("\n");
}

export function hasProfileContent(profile: ProfileData): boolean {
  return (
    profile.explicitFacts.length > 0 ||
    Object.values(profile.sections).some((items) => items.length > 0)
  );
}

export function buildProfileSummaryText(input: {
  existing: ProfileData;
  delta: ProfileDeltaMessage[];
}): string {
  const existingLines = [
    "EXISTING PROFILE",
    renderProfileContextText(input.existing, "Profile"),
  ].join("\n");

  const factLines =
    input.existing.explicitFacts.length === 0
      ? "(none)"
      : input.existing.explicitFacts
          .map((fact: ExplicitFact) => `- ${fact.fact}`)
          .join("\n");

  const deltaLines =
    input.delta.length === 0
      ? "(none)"
      : input.delta.map((message) => `[${message.createdAt}] ${message.text}`).join("\n");

  return [
    existingLines,
    "EXPLICIT FACTS",
    factLines,
    "NEW MESSAGES",
    deltaLines,
  ].join("\n\n");
}

export async function summarizeProfileDelta(input: {
  model: CompletionModel;
  existing: ProfileData;
  delta: ProfileDeltaMessage[];
}): Promise<{ sections: ProfileSections; usage: Usage }> {
  const text = buildProfileSummaryText(input);
  const extractor = new ExtractorBuilder(input.model, profileSectionsSchema)
    .instructions(PROFILE_SUMMARY_INSTRUCTIONS)
    .retries(1)
    .build();

  const result = await extractor.extractWithUsage(text);
  return {
    sections: {
      ...EMPTY_PROFILE_SECTIONS,
      ...result.data.sections,
    },
    usage: result.usage,
  };
}
