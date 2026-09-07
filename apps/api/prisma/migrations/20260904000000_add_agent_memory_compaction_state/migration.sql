-- Anvia 1.0.7 stores the latest compaction summary as a session checkpoint
-- instead of replacing canonical memory rows. Nullable so existing sessions
-- keep loading until the next compaction writes a checkpoint.
ALTER TABLE "AgentMemorySession" ADD COLUMN "compactionState" JSONB;
