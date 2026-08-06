-- Remove ChatSession rows that have no agent messages (empty "New chat" drafts).
-- Related session-scoped rows are cleaned first (no FK from DocumentSession → ChatSession).

BEGIN;

CREATE TEMP TABLE empty_chat_ids ON COMMIT DROP AS
SELECT cs.id
FROM "ChatSession" cs
WHERE NOT EXISTS (
  SELECT 1
  FROM "AgentMemoryMessage" msg
  JOIN "AgentMemorySession" m ON msg."memorySessionId" = m.id
  WHERE m."sessionId" = cs.id
);

SELECT COUNT(*) AS empty_chats_to_delete FROM empty_chat_ids;

DELETE FROM "DocumentSession"
WHERE "sessionId" IN (SELECT id FROM empty_chat_ids);

DELETE FROM "AgentUsageEvent"
WHERE "sessionId" IN (SELECT id FROM empty_chat_ids);

-- Messages/errors cascade from AgentMemorySession
DELETE FROM "AgentMemorySession"
WHERE "sessionId" IN (SELECT id FROM empty_chat_ids);

DELETE FROM "ChatSession"
WHERE id IN (SELECT id FROM empty_chat_ids);

SELECT COUNT(*) AS remaining_chat_sessions FROM "ChatSession";

COMMIT;
