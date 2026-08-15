import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { bearer } from "better-auth/plugins";
import { getApiOrigin, getTrustedOrigins } from "../../lib/origins.js";
import { prisma } from "../../utils/prisma.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

const betterAuthUrl =
  process.env.BETTER_AUTH_URL?.trim() || getApiOrigin();

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  secret: requireEnv("BETTER_AUTH_SECRET"),
  baseURL: betterAuthUrl,
  trustedOrigins: getTrustedOrigins(),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
  },
  // Lets native / extra-repo clients send `Authorization: Bearer <token>`
  // (token is returned as the `set-auth-token` response header on sign-in).
  // Cookie sessions for the web platform keep working unchanged.
  plugins: [bearer()],
});
