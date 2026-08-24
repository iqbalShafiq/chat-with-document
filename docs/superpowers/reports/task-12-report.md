# Task 12 implementation report — native Anvia v1 worker

See the canonical SDD ledger report at
`.superpowers/sdd/2026-08-23-anvia-v1-migration/task-12-report.md`.

In brief, the worker now uses native Anvia v1 start/resume streams, the Task 9
client adapter, awaited Task 10 interaction persistence, native steering
receipts, run-local crash-safe policy overrides, stop/abort cancellation,
bounded pre-visible retry with exact transactional single-prompt cleanup, and
ordered idempotent shutdown. The final scoped Task 12 suite passes 95/95 tests
across 10 files; the expanded real-Redis policy suite passes 12/12. Independent
review is PASS. Real DeepSeek V4 Flash E2E remains part of the Task 17/18 final
acceptance flow.
