import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "../../utils/prisma.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

const platformOrigin =
  process.env.PLATFORM_ORIGIN?.trim() || "http://localhost:3000";
const betterAuthUrl =
  process.env.BETTER_AUTH_URL?.trim() || "http://localhost:3001";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  secret: requireEnv("BETTER_AUTH_SECRET"),
  baseURL: betterAuthUrl,
  trustedOrigins: [platformOrigin],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
  },
});
