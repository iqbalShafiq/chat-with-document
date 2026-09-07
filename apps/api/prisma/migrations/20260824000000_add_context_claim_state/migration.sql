-- Persist fresh-run ownership so a process restart cannot lose claimed
-- single-use context between recipe resolution and queue acceptance.
ALTER TABLE "session_image_context"
  ADD COLUMN "claimId" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3);

CREATE INDEX "session_image_context_claimId_claimedAt_idx"
  ON "session_image_context"("claimId", "claimedAt");

ALTER TABLE "session_context_snippet"
  ADD COLUMN "claimId" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3);

CREATE INDEX "session_context_snippet_claimId_claimedAt_idx"
  ON "session_context_snippet"("claimId", "claimedAt");
