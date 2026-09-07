import {
  formatMigrationSummary,
  migrateMemoryStore,
  type MemoryMigrationClient,
} from "./anvia-v1-memory-migration.js";

export type MigrationCliOptions = {
  write: boolean;
  pageSize?: number;
};

/**
 * Keep migration failures safe for stderr. Row IDs and normalization reasons
 * are structured on the error object for internal diagnostics, but may carry
 * user data and must never be rendered by the offline CLI.
 */
export function formatMigrationCliError(_error: unknown): string {
  return "Anvia v1 memory migration failed; inspect structured migration diagnostics.";
}

export function parseMigrationCliArgs(args: string[]): MigrationCliOptions {
  let write = false;
  let pageSize: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--page-size") {
      const raw = args[++index];
      if (raw === undefined) throw new Error("--page-size requires a value");
      pageSize = Number(raw);
      continue;
    }
    if (arg?.startsWith("--page-size=")) {
      pageSize = Number(arg.slice("--page-size=".length));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: migrate-anvia-v1-memory.ts [--write] [--page-size N]",
      );
    }
    throw new Error(`unknown migration option: ${arg}`);
  }
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) {
    throw new Error("--page-size must be a positive integer");
  }
  return { write, ...(pageSize === undefined ? {} : { pageSize }) };
}

export async function runMigrationCli(
  args: string[],
  client: MemoryMigrationClient,
  writeOutput: (text: string) => void,
): Promise<number> {
  const options = parseMigrationCliArgs(args);
  const audit = await migrateMemoryStore(client, options);
  writeOutput(`${formatMigrationSummary(audit, options)}\n`);
  return audit.blocked ? 1 : 0;
}
