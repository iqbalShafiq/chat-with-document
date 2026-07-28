import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../api/src/generated/prisma/client.js";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const prisma = new PrismaClient({
  adapter,
});
