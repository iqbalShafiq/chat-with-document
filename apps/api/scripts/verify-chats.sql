SELECT
  cs.id,
  cs."projectId" IS NOT NULL AS in_project,
  (
    SELECT COUNT(*)
    FROM "AgentMemoryMessage" msg
    JOIN "AgentMemorySession" m ON msg."memorySessionId" = m.id
    WHERE m."sessionId" = cs.id
  ) AS msgs
FROM "ChatSession" cs
ORDER BY cs."updatedAt" DESC;
