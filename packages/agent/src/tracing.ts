import { langfuse } from "@anvia/langfuse";

export const tracing = langfuse.create({
  baseUrl: process.env.LANGFUSE_BASE_URL,
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  environment: process.env.NODE_ENV,
});
