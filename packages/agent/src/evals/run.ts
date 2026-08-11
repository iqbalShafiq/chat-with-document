import {
  runEvalCli,
  type EvalSuiteResult,
  type RunEvalSuiteOptions,
} from "@anvia/core/evals";
import { createLangfuseEvalReporter } from "@anvia/langfuse";
import { tracing } from "../tracing.js";
import { evalConfig } from "./config.js";
import { EVAL_SUITES } from "./suites/index.js";

const args = process.argv.slice(2);
const suiteArg = args.includes("--suite")
  ? args[args.indexOf("--suite") + 1]
  : undefined;
const json = args.includes("--json");
const names = suiteArg ? [suiteArg] : Object.keys(EVAL_SUITES);

if (suiteArg !== undefined && !(suiteArg in EVAL_SUITES)) {
  console.error(`Unknown suite. Available: ${Object.keys(EVAL_SUITES).join(", ")}`);
  process.exit(2);
}

const langfuseConfigured = Boolean(
  process.env.LANGFUSE_BASE_URL &&
    process.env.LANGFUSE_PUBLIC_KEY &&
    process.env.LANGFUSE_SECRET_KEY,
);
const reporters = langfuseConfigured
  ? [createLangfuseEvalReporter(tracing, { onMissingTrace: "warn" })]
  : [];

function computeExitCode(result: EvalSuiteResult<unknown, unknown, unknown>): number {
  return result.cases.failed > 0 || result.cases.invalid > 0 ? 1 : 0;
}

let failed = false;
for (const name of names) {
  const suite = EVAL_SUITES[name as keyof typeof EVAL_SUITES];
  const result = await runEvalCli({
    ...(suite as unknown as RunEvalSuiteOptions<unknown, unknown, unknown>),
    concurrency: evalConfig.concurrency,
    reporters,
    format: json ? "json" : "pretty",
    exitCode: false,
  });
  if (computeExitCode(result) !== 0) failed = true;
}
if (failed) process.exitCode = 1;
