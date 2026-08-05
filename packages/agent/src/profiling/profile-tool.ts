import { createTool, type AnyTool } from "@anvia/core";
import z from "zod";
import { PROFILE_SECTION_KEYS, type ProfileScope } from "./types.js";

export type RememberUserProfileDeps = {
  scope: ProfileScope;
  /** Wait for a running background refresh of this scope before writing. */
  waitForActiveJob: () => Promise<void>;
  /** Persist the fact immediately; never fails the chat run. */
  appendFact: (input: { section: string | null; fact: string }) => Promise<void>;
  /** Incrementally summarize the unprocessed delta of this scope. */
  refreshNow: () => Promise<{ processed: number }>;
  /** Open a fresh debounce window for the background worker. */
  reschedule: () => Promise<void>;
};

export function createRememberUserProfileTool(
  deps: RememberUserProfileDeps,
): AnyTool {
  return createTool({
    name: "remember_user_profile",
    description:
      "Save an explicit fact about the user into their durable profile, immediately. " +
      "Call this ONLY when the user explicitly asks you to remember something about them " +
      "(for example 'remember that I prefer X' or 'remember my name is X'). One fact per call.",
    input: z.object({
      fact: z.string().min(1).max(500),
      section: z.enum(PROFILE_SECTION_KEYS).optional(),
    }),
    execute: async ({ fact, section }) => {
      try {
        await deps.waitForActiveJob();
        await deps.appendFact({ section: section ?? null, fact });
        const { processed } = await deps.refreshNow();
        await deps.reschedule();
        return {
          ok: true,
          remembered: fact,
          processed,
        };
      } catch (error) {
        // Facts are already persisted; the chat's stream-complete tap will
        // still enqueue the background refresh, so nothing is lost.
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: `Could not update profile right now: ${message}`,
        };
      }
    },
  });
}
