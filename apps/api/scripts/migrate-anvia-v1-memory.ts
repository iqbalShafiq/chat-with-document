import { pathToFileURL } from "node:url";
import {
  formatMigrationCliError,
  runMigrationCli,
} from "../src/modules/chat/anvia-v1-memory-migration-cli.js";
import type { MemoryMigrationClient } from "../src/modules/chat/anvia-v1-memory-migration.js";
import { prisma } from "../src/utils/prisma.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const exitCode = await runMigrationCli(
      process.argv.slice(2),
      prisma as unknown as MemoryMigrationClient,
      (text) => process.stdout.write(text),
    );
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${formatMigrationCliError(error)}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
