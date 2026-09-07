import { createAgent } from "./agent.js";
import {
  createCompletionModel,
  parseReasoningEffort,
} from "./providers/openai.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error("Usage: pnpm runner:dev -- <prompt>");
  process.exitCode = 2;
} else if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set.");
  process.exitCode = 3;
} else {
  const modelId = process.env.EVAL_MODEL?.trim();
  const reasoningEffort = parseReasoningEffort(
    process.env.EVAL_MODEL_EFFORT,
  );
  const agent = createAgent({
    agentId: "runner-dev",
    model: createCompletionModel(modelId || undefined),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  });

  try {
    const outcome = await agent.generate({ prompt });
    if (outcome.type === "response") {
      console.log(outcome.text);
    } else if (outcome.type === "interaction") {
      console.error(
        `Agent interaction requires a native response: ${JSON.stringify(outcome.interaction)}`,
      );
      process.exitCode = 2;
    } else {
      console.error(`Agent run blocked: ${outcome.reason}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
