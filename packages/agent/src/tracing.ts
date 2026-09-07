import { LangfuseClient } from "@anvia/langfuse";

/**
 * Process-owned tracing client. Langfuse initializes its transport resources
 * lazily on first observed run, while this module owns final flush/close.
 */
export const tracing = new LangfuseClient({
  baseUrl: process.env.LANGFUSE_BASE_URL,
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  environment: process.env.NODE_ENV,
});

let closePromise: Promise<void> | null = null;

export function flushTracing(): Promise<void> {
  return tracing.flush();
}

export function closeTracing(): Promise<void> {
  closePromise ??= tracing.close();
  return closePromise;
}
