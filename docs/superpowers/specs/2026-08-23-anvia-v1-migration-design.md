# Anvia v1 Stable Migration — Design Specification

Date: 2026-08-23
Status: design complete; implementation intentionally not started
Target: Anvia v1.0.1 synchronized stable package train

## 1. Goal

Migrate `chat-with-document` from its mixed Anvia v0 package line to Anvia v1.0.1 with a full cutover to native v1 semantics: durable sessions, app-owned compaction, document/image context, native approval and question interactions, queued follow-ups with steering, tabular analysis, bounded one-level Deep Research, citations, Langfuse, Context7 MCP, Qdrant retrieval, resumable streams, and real-browser evidence.

This is an architectural migration, not a dependency-only bump. Anvia v1 removes the builders and ambiguous streaming/human-input surfaces on which the current app depends, introduces a canonical client protocol and serializable interaction continuations, and moves MCP/client responsibilities into dedicated packages.

## 2. Research basis

Primary sources:

- [Anvia repository and v1 source](https://github.com/anvia-hq/anvia)
- [Anvia Core 1.0.0 release](https://github.com/anvia-hq/anvia/releases/tag/%40anvia/core%401.0.0)
- synchronized v1.0.0 package sources at tag commit `59e2889f7ecf637bad1f24d6cd2aa5080467b8e9`

No dedicated end-to-end v0-to-v1 migration guide was present in the tagged repository. Therefore the release notes, package manifests, public type declarations, tests, and cookbook examples at the tag are the executable migration authority.

## 3. Current application context

### 3.1 Package graph

| Workspace | Current Anvia dependencies | v1 target |
| --- | --- | --- |
| `packages/agent` | Core 0.26, Langfuse 0.6, Mistral 0.4, OpenAI 0.5, Qdrant 0.4 | all 1.0.0; add `@anvia/mcp@1.0.0` |
| `apps/api` | Core 0.26, memory-prisma 0.3, server 0.7 | Core/client/memory-prisma/server 1.0.0 |
| `apps/platform` | React 0.11, React UI 0.7 | client/react/react-ui 1.0.0 |

The repository currently patches built `@anvia/react-ui` files so users can compose and submit queued follow-ups during streaming. The v1 cutover removes that package patch and moves composer ownership into application code, where idle submit and active-run steering/queueing can be selected explicitly and tested end to end.

### 3.2 Runtime ownership

```text
platform useChat + product UI
  -> authenticated Hono chat route
     -> Redis resumable stream + BullMQ job
        -> scoped agent factory
           -> provider, memory, tools, Context7 MCP, Qdrant, Langfuse
```

The application—not Anvia—continues to own authentication, session/document authorization, queues, Redis leases, stop flags, approval grants/argument overrides, Prisma/R2 services, quotas, product settings, citations, profile refresh, and UI policy.

### 3.3 Behaviors that cannot regress

- One active run per session and reconnectable Redis streams.
- Follow-up queue editing, ordering, steering, acknowledgements, and fallback to a fresh run.
- Web search, image generation, and Deep Research approval policies; allow-once, allow-for-session, reject.
- Image approval parameter edits before execution.
- Native clarification questions with required single-choice or custom-text answers and durable resume.
- One-level Deep Research only; no recursive agent delegation.
- Existing citation markers/trailer and UI source chips.
- Durable Prisma memory plus app-owned compaction/profiling behavior.
- Document retrieval ownership filters and replacement ingestion.

## 4. Major v1 changes and concrete impact

| v1 change | Current usage | Migration impact |
| --- | --- | --- |
| `AgentBuilder`, prompt requests, `ExtractorBuilder` removed | `agent.ts`, worker, summarizers, evals | direct constructors and object-only runs; runner owns `AgentStream` handle |
| tools use `inputSchema`, `outputSchema`, `requiresApproval` | all tool factories use v0 options | mechanical contract rewrite plus new approval lifecycle |
| outcomes are `response`, `interaction`, `blocked` | code assumes normal/error stream | terminal handling and tests become discriminated |
| serializable continuation + `agent.resume()` | approval registry blocks worker polling | native approvals become durable suspend/resume jobs |
| canonical `anvia.client.v3` protocol | raw custom events and v0 helpers | worker translates to client events; server emits framed resume responses |
| `@anvia/client` owns UI/protocol/transports | types/transport imported from React | add direct API/platform dependency and browser-safe imports |
| React `createRequest`/`humanInput` removed | central route hook integration | transport body enriches canonical requests; unified interactions API |
| React UI aliases removed | compound imports across platform | move to `*Primitive` exports and rebase queue patch |
| memory uses `MemoryScope` and `new PrismaMemoryStore` | v0 factory and `{sessionId,userId}` calls | adapt stores/call sites; schema itself already matches v1 |
| MCP client moved to `@anvia/mcp` | `connectMcp` from Core | owned process-lifetime client, explicit connect/close, strict SSRF |
| provider factories object-only | positional Mistral/OpenAI options | rewrite factories; move reasoning to `providerOptions` |
| Qdrant has explicit client/store lifecycle | static `connect/index/upsertDocuments` | owned client, `vectorStore`, `ensure`, replacement upsert/search |
| Langfuse uses owned client and named observers | `langfuse.create` | singleton `LangfuseClient`, observer registration, awaited shutdown |
| rich tool output is strict | direct content arrays/images | strict JSON or `ToolOutput.content` text/file parts |

## 5. Considered strategies

### A. Dependency-only big bang

Upgrade every package, fix compiler errors in place, then chase runtime failures. This is fast to start but unsafe: compiler success does not prove protocol framing, interaction durability, queue steering, memory preservation, or browser behavior. Rejected.

### B. Dual v0/v1 runtime

Install v1 under aliases beside v0 and migrate one subsystem at a time. This permits partial comparison but duplicates message types, providers, agents, transports, memory, and UI state. Cross-major peer contracts and two stream protocols make the bridge more complex than the target. Rejected.

### C. Synchronized cutover with internal compatibility boundaries — selected

Upgrade the whole Anvia package train on one isolated feature branch, but implement in ordered vertical checkpoints behind application-owned adapters:

1. strict dependency and public-contract compilation;
2. provider/tool/agent/retrieval/resource factories;
3. canonical worker-to-client stream adapter;
4. durable native approval interactions;
5. React/client protocol and primitive migration;
6. focused product regressions, full tests, and real-browser acceptance.

The branch is not deployable midway. Each checkpoint is independently testable and committed, and the final merge is gated by a complete regression matrix. This minimizes mixed-contract code without hiding product semantics inside temporary shims.

## 6. Target architecture

### 6.1 Package and import boundaries

- Browser: `@anvia/client`, `@anvia/react`, `@anvia/react-ui`; interaction types only from browser-safe `@anvia/core/agent/interactions` when needed.
- API: `@anvia/client`, `@anvia/server`, `@anvia/core`, `@anvia/memory-prisma`.
- Agent package: Core, provider adapters, Qdrant, Langfuse, MCP.
- No provider, memory, Qdrant, Langfuse, MCP transport, or server helper in browser bundles.

### 6.2 Agent recipe and stable construction

Replace builder chains with a scoped `new Agent({...})`. Keep stable agent id `chat-agent`. A serializable `ChatAgentRecipe` records only safe reconstruction inputs: model id, reasoning effort, feature flags, image settings, bounded turn budgets, resolved instruction fragments/context descriptors, session/document ids, and trace correlation ids. It never contains credentials, live clients, Prisma handles, or arbitrary class instances.

Fresh runs call:

```ts
agent.stream({
  prompt: userMessage,
  session: { sessionId, userId, metadata },
  trace,
})
```

Resumed runs rebuild the same agent policy from the persisted recipe and stream `{ continuation, response, trace }`. The continuation already carries strict messages, pending tool state, queued steering, and memory scope.

### 6.3 Tool and delegation contracts

- Convert every tool to `inputSchema` and optional `outputSchema`.
- Return strict JSON/string; use `ToolOutput.content` only for mixed text/file results.
- Web/image/Deep Research tools use scoped `requiresApproval` functions that consult existing session grants.
- Image argument overrides remain app-owned: validate/stage the override before native approval, then `execute` consumes it after resume.
- The researcher remains one level deep and is exposed with `Agent.asTool({ name: "deep_research", suspension: "reject", stream: true, ... })`. Its tool catalog never contains `deep_research`.
- Custom Deep Research progress is mapped into typed client data events.

### 6.4 Approval interaction lifecycle

```text
worker receives AgentStream interaction outcome
  -> persist continuation + request + ChatAgentRecipe + ownership in Redis
  -> append canonical interaction and suspended run_end events
  -> close stream and release active-run lease

platform respondToInteraction
  -> optionally stage grant/validated image override
  -> POST canonical interaction_response
  -> API authorizes and atomically claims pending interaction
  -> opens new stream, enqueues resume job, marks response accepted
  -> worker rebuilds agent and streams continuation response
```

`InteractionStore` keys by interaction id and stores user id, session id, source stream/run, request, continuation, recipe, state (`pending|claimed|consumed|expired`), and TTL. It must reject wrong-user/session access, mismatched response type, replay, double click, and expired continuation. If enqueue fails after claim, it atomically returns to pending; after job acceptance it becomes consumed.

No BullMQ worker remains blocked for native approvals.

### 6.5 Native clarification decision

Replace the custom Promise/Redis clarification waiter with v1 `createQuestionTool`. The stable native contract supports one required nonblank answer per question, with optional bounded choices and custom text. The cutover intentionally removes application-only multi-select arrays, optional skip, recommendation flags, placeholder metadata, and timeout answers instead of maintaining a parallel human-input protocol.

The application may preserve visual presentation around native question interactions, but it must render from `tool-question` requests and respond through the canonical interaction endpoint. No compatibility route, legacy clarification event, or deterministic timeout answer remains after cutover.

### 6.6 Canonical queue-backed streaming

The worker, not the API request process, owns provider execution. It wraps agent events with `agentToClientStream` or `customAgentEventsToClientStream`, maps app events (`deepResearchProgress`, `queuedMessageApplied`, compaction signals) to validated data events, and appends `ClientResumableEvent` records tagged with `anvia.client.v3` into the Redis `ResumableStreamStore`.

The API serves both initial and reconnect subscriptions with `resumeClientStreamResponse`. It validates stream ownership before subscribing. Legacy raw stream records are not accepted after cutover.

Steering keeps the current Redis queue but targets the live v1 `AgentStream.steer(...)` handle. The stop route keeps the app stop flag and also cancels the live stream handle when available. Retry-before-first-visible-event may recreate a stream once; prompt-memory cleanup must use strict v1 messages and the new memory scope.

### 6.7 React and UI integration

- Replace `createChatTransport` with `createHttpClientTransport`.
- Replace hook `createRequest` by enriching canonical request bodies in the transport `body` callback from current refs; validate as `ChatRequestMetadata` server-side.
- Replace hook `humanInput` with `chat.interactions.pending`, `respondingInteractions`, and `respondToInteraction`.
- Move UI/protocol types to `@anvia/client`.
- Replace removed React UI aliases with v1 primitives.
- Remove the React UI pnpm patch and implement an application-owned composer that stays editable while active, sends normally while ready, and queues/steers while streaming.
- Render clarification from native `tool-question` interactions and respond through `respondToInteraction`.

### 6.8 Memory and compaction

Use `new PrismaMemoryStore({ client: prisma, ... })`, call `validate()` at worker startup, and use `{ scope: { sessionId, userId } }` for load/clear. The current Prisma models match v1 exactly except for an additive application index, so no schema migration is expected. However, direct verification against the published 0.26.0 and 1.0.1 message parsers proves that persisted v0 message JSON (`tool_call`, `tool_result`, legacy image/document sources, and reasoning content) is not accepted by v1 strict parsing. The cutover therefore includes an explicit one-time, idempotent data normalization command: dry-run/audit every `AgentMemoryMessage.message` and `AgentMemoryError.messages`, reject ambiguous or unconvertible rows without writing, then rewrite convertible rows in per-session transactions while chat workers are quiesced. Already-v1 rows are skipped, making interrupted execution safely resumable. The v1 runtime keeps strict validation and contains no legacy dual parser.

Keep app-owned compaction for the first cutover because it also drives product context-usage behavior and has existing evidence. Do not enable Anvia automatic compaction simultaneously. Update compaction, sanitizer, profile, retry-cleanup, and session snapshot logic to strict structural messages and test tool/result/citation preservation. Native `memory_compaction` events may be adopted later after parity is demonstrated.

### 6.9 Providers, retrieval, and lifecycle owners

- OpenAI: `new OpenAIClient({ apiKey, baseUrl })`; `completionModel({ modelId, api: "responses" })`; reasoning settings become agent `providerOptions`.
- Mistral: `embeddingModel({ modelId: "mistral-embed", dimensions: 1024, maxBatchSize: 32 })`; `ocrModel({ modelId: ... })` with the exact configured official id.
- Qdrant: process-owned `QdrantVectorClient`; create dense store, call `ensure`, use replacement `upsert({ documents })`, use v1 retrieval/search contract, close on shutdown.
- MCP: process-owned `McpClient` from `@anvia/mcp`, strict Streamable HTTP transport, `connect` once, pass returned server registration, degrade intentionally when Context7 is unavailable, close on shutdown.
- Langfuse: process-owned `LangfuseClient`; install `observer()` in named agent observers, use client eval reporter APIs, flush/close on worker shutdown.

## 7. Data and API contracts

### 7.1 Canonical request metadata

`ChatRequestMetadata` remains strict JSON and includes session id, document ids, selected model/reasoning effort, web/image/deep-research flags, and image settings. The server trusts none of it: it re-authorizes session/documents and validates model/capabilities. Resume cursors stay in the canonical request rather than metadata.

### 7.2 Client data map

Define one shared documented mapping, mirrored with runtime schemas:

- `deepResearchProgress`
- `queuedMessageApplied`
- `compactionStatus` only if app compaction remains outside official events

Usage, context usage, tool state, messages, errors, interaction, and run terminal status use standard client events.

### 7.3 Queue job union

Replace the single prompt job with a discriminated job:

- `kind: "start"`: prompt message plus recipe inputs.
- `kind: "resume"`: continuation, validated interaction response, persisted recipe, and source interaction id.

Both carry stream/session/user identity and use the same worker execution pipeline. No secret is serialized into BullMQ.

## 8. Error and recovery behavior

- Invalid protocol/request/metadata: 400, no job.
- Unauthorized session/stream/interaction: 404 or 403 per existing anti-enumeration policy, no leaked metadata.
- Missing/expired/replayed interaction: 409 with stable product code.
- Failed resume enqueue: release interaction claim and close new stream as error.
- Worker crash after suspension persistence: response can still enqueue a new worker resume.
- Worker crash after claim: BullMQ retry/idempotency determines whether the claimed interaction is completed or released; tests cover the boundary.
- `blocked` outcome: canonical terminal state, no generic provider error, no profile refresh as a successful answer.
- Context7/Qdrant/Langfuse startup failure: preserve current intentional degradation only where product policy allows it; otherwise fail startup with a clear diagnostic.
- Shutdown: stop accepting jobs, cancel/drain handles, close MCP/Qdrant/Langfuse/queues/Redis in a bounded order.

## 9. Testing strategy

### 9.1 Contract/unit tests

- Dependency graph contains only Anvia 1.0.1 and required direct peers.
- Removed symbols/options/imports are absent.
- Providers use object-only factories and correct strict provider options.
- Every tool parses strict input and serializes output; approvals and overrides execute exactly once.
- Deep Research rejects nested suspension and cannot recurse.
- Memory load/append/clear and compaction preserve strict messages and current data.
- Qdrant ensure/replacement/delete/search preserve ownership filters, logical `topK`, score order, and stable metadata.
- MCP connect/degrade/close and strict SSRF/header configuration.
- Langfuse observer registration and awaited close.

### 9.2 Protocol and interaction tests

- v3 header, `stream_start`, contiguous ids, standard/data events, one `stream_end`.
- Resume from event N has no gap or duplication; stale/wrong-user cursor rejected.
- Approval continuation persisted before suspended terminal exposure.
- Allow once, allow for session, reject, edited image args, expired continuation, wrong response type, double submit, replay, worker restart, enqueue failure rollback.
- Native clarification single-choice/custom-text interactions suspend, authorize, resume, and reject replay correctly.
- Stop, transient model retry, queued steering acknowledgements, and leftovers behave as before.

### 9.3 Package and behavior suites

Run agent/API/platform tests, API TypeScript build, platform production build, eval contract suites, and `git diff --check`. Existing tabular, citations, image, web, queued-message, session, compaction, and Deep Research tests remain mandatory.

### 9.4 Browser acceptance

Automated Playwright plus hands-on headed browser checks must cover:

1. normal streamed chat and reload resume;
2. upload/retrieve/cite PDF and tabular sources;
3. web approval allow/reject/session grant;
4. image approval with edited settings;
5. Deep Research direct and approval-gated paths with visible progress/citations;
6. queue multiple follow-ups while streaming, edit/reorder, steer, and observe acknowledgements;
7. native clarification single-choice/custom-text and reload resume;
8. stop/regenerate/resubmit and error recovery;
9. session switching/deletion without cross-session stream or interaction access;
10. console/network checks for protocol errors, duplicate events, and server-only bundle leakage.

Real-LLM cases retain the repository's existing cost-controlled models and evidence convention. Provider-dependent flakes must be diagnosed through the systematic-debugging loop, not hidden by weakening assertions.

## 10. Rollout, rollback, and observability

Development starts from clean `main` on `feat/anvia-v1-migration`, matching the repository's existing `feat/*` branch convention. Do not create the branch during this planning session.

The cutover is one merge/deploy because package/protocol majors must stay synchronized. Before merge:

- clean install/lockfile verification;
- all package and focused migration suites green;
- representative real-browser evidence green;
- no unowned v0 imports/symbols;
- no database migration unless schema diff proves one;
- startup/shutdown lifecycle smoke passes;
- rollback note identifies the last v0 commit and confirms no irreversible data migration.

Observe error rate, stream resume failures, interaction suspension/resume counts, replay/expiry conflicts, tool approval outcomes, worker duration, model/tool latency, memory compaction, Qdrant errors, and Langfuse delivery. Because no data rewrite is expected, rollback is application/lockfile rollback; any unexpectedly required schema migration must be additive, explicitly justified, and rollback-safe before merge.

## 11. Explicit non-goals

- No visual redesign.
- No replacement of BullMQ, Redis, Prisma, R2, Hono, TanStack Router, or current auth.
- No simplification/removal of current queue, approvals, Deep Research, data analysis, or citation behavior. Clarification intentionally adopts the narrower native v1 question contract.
- No adoption of native Anvia memory compaction until parity is separately proven.
- No development or branch creation in this planning session.

## 12. Design acceptance criteria

- One coherent v1 package train and import boundary.
- All v0 removed APIs have an explicit v1 replacement; no runtime compatibility path remains.
- Native approval suspension is durable across request/worker lifetime and authorized/replay-safe.
- Clarification uses native question interactions end to end.
- Protocol-v3 framing, resume, queue steering, and custom progress coexist without raw undocumented events.
- Memory data remains readable after the required one-time JSON normalization, with no permanent v0 parser or unnecessary schema migration.
- Resources have explicit process lifecycle ownership.
- The implementation plan traces every design decision to files, tests, commands, and fix loops.
