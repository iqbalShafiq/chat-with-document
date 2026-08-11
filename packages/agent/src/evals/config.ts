export const evalConfig = {
  get model() {
    return process.env.EVAL_MODEL?.trim() || "deepseek/deepseek-v4-flash-0731";
  },
  get modelEffort() {
    return process.env.EVAL_MODEL_EFFORT?.trim() || "max";
  },
  get judgeModel() {
    return process.env.EVAL_JUDGE_MODEL?.trim() || "openai/gpt-5.6-luna";
  },
  get judgeEffort() {
    return process.env.EVAL_JUDGE_EFFORT?.trim() || "high";
  },
  get concurrency() {
    return Number(process.env.EVAL_CONCURRENCY ?? 2);
  },
  get timeoutMs() {
    return Number(process.env.EVAL_TIMEOUT_MS ?? 120_000);
  },
};
