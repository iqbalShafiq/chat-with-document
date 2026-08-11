# @agent (packages/agent)

Agent building blocks: the chat agent, its tools, providers, and tracing.

## Behavior evals

Behavior evals exercise the agent against scripted scenarios with stub tool
backends (fake document chunks, fake web search, auto-clarification responder,
stub image models) and score its behavior: tool choice, approvals,
clarifications, groundedness, document tools, and `view_image` handling.

Every case makes real model calls to `EVAL_MODEL` (default
`deepseek/deepseek-v4-flash-0731` at effort `max`); the judge model
(`EVAL_JUDGE_MODEL`, default `openai/gpt-5.6-luna` at effort `high`) is used
only by the groundedness suite's `no_fabricated_bonus_policy` metric.

### Run

```bash
pnpm --filter agent evals                # all suites
pnpm --filter agent evals --suite tool-choice   # one suite
pnpm --filter agent evals --json         # machine-readable output
```

### Case expectations

Every case declares `expected` (a `BehaviorExpectation`): required/forbidden
tools, approval expectations, clarification/citation requirements, and output
text checks. The generic `expectationMetric` (suites/helpers.ts) is part of
every suite and enforces `case.expected` directly against the collected trace,
so expectations are a single source of truth instead of being duplicated in
hand-written metrics. Metrics that cannot be expressed as expectations
(fabrication claims, judge-graded abstention, answer reflection) stay as
suite-specific metrics.

Exit code is the raw case failure count: `0` all pass, `1` any case failed or
invalid, `2` bad CLI usage or unknown suite. Suites are repeatable via
`EVAL_REPEAT` and run concurrently per `EVAL_CONCURRENCY`.

### Per-case model override

Cases run on `EVAL_MODEL` by default. A case can pin its own model with
`sessionConfig.models` (first entry wins); `createBehaviorTarget` falls back
to `EVAL_MODEL` when unset. The `document-tools` suite uses this to run the
vision-capable `view_image` case on `openai/gpt-5.6-luna` while the text-only
case stays on the default model.

### Suites

| Suite | Covers |
| --- | --- |
| `approval-image` | image generation approval gate: requests approval when disabled, runs directly when enabled, no fabricated success claims on rejection |
| `approval-web-search` | web search/fetch approval gate: requests approval when disabled, runs directly when enabled, no web citation after rejection |
| `clarification` | asks `request_clarification` on ambiguous prompts, skips it on clear prompts, respects clarification answers |
| `tool-choice` | picks web search vs document search vs abstaining per context |
| `groundedness` | document-grounded answers cite sources and contain fixture facts; no fabrication of policies absent from the docs (judge-graded) |
| `document-tools` | `search_document_pages` flow (`finds` then `search`), next-page continuation, `view_image` with and without a vision model |

### Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `EVAL_MODEL` | `deepseek/deepseek-v4-flash-0731` | model id used by the agent under test |
| `EVAL_MODEL_EFFORT` | `max` | reasoning effort for the model under test (`low`/`medium`/`high`/`max`) |
| `EVAL_JUDGE_MODEL` | `openai/gpt-5.6-luna` | model id used by judge metrics (groundedness) |
| `EVAL_JUDGE_EFFORT` | `high` | reasoning effort for judge metrics |
| `EVAL_CONCURRENCY` | `2` | cases per suite run in parallel |
| `EVAL_TIMEOUT_MS` | `120000` | per-run timeout |
| `EVAL_REPEAT` | `1` | repetitions per case (result = best score) |

### Langfuse

When `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` are
set, eval scores are posted to Langfuse (missing traces are warned, not
fatal). `case.metadata` carries the suite name and expectation id so scores can
be traced back to scenarios.
