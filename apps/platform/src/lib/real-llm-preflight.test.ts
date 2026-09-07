import { describe, expect, it } from "vitest";
import { assertRealLlmEnv } from "../../e2e/real-llm.global-setup";

describe("real LLM browser preflight", () => {
  it("accepts only the exact OpenRouter endpoint with a configured key", () => {
    expect(() =>
      assertRealLlmEnv({
        OPENAI_BASE_URL: "https://openrouter.ai/api/v1/",
        OPENAI_API_KEY: "configured",
      }),
    ).not.toThrow();
  });

  it.each([
    {},
    { OPENAI_BASE_URL: "http://127.0.0.1:18765/api/v1", OPENAI_API_KEY: "stub" },
    { OPENAI_BASE_URL: "https://example.com/api/v1", OPENAI_API_KEY: "key" },
    { OPENAI_BASE_URL: "https://openrouter.ai/api/v1", OPENAI_API_KEY: "  " },
  ])("fails closed for an unverified provider configuration", (env) => {
    expect(() => assertRealLlmEnv(env)).toThrow();
  });
});
