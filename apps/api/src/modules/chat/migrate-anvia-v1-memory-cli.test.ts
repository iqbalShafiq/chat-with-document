import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatMigrationCliError,
  parseMigrationCliArgs,
  runMigrationCli,
} from "./anvia-v1-memory-migration-cli.js";
import { MemoryMigrationDriftError } from "./anvia-v1-memory-migration.js";
import type { MemoryMigrationClient } from "./anvia-v1-memory-migration.js";

function client(): MemoryMigrationClient {
  const noRows = async () => [];
  const noUpdateMany = async () => ({ count: 0 });
  return {
    agentMemorySession: { findMany: noRows },
    agentMemoryMessage: {
      findMany: noRows,
    },
    agentMemoryError: {
      findMany: noRows,
    },
    $transaction: async (operation) => operation({
      agentMemoryMessage: { updateMany: noUpdateMany },
      agentMemoryError: { updateMany: noUpdateMany },
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("migrate-anvia-v1-memory CLI", () => {
  it("defaults to an anonymized dry-run and accepts a bounded page size", () => {
    expect(parseMigrationCliArgs([])).toEqual({ write: false });
    expect(parseMigrationCliArgs(["--write", "--page-size", "17"])).toEqual({
      write: true,
      pageSize: 17,
    });
  });

  it("prints counts without row ids or message content", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(
      runMigrationCli([], client(), (text) => write(text)),
    ).resolves.toBe(0);

    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("dry-run");
    expect(output).toContain("messages total=0");
    expect(output).not.toContain("memorySessionId");
  });

  it("formats migration failures without row identifiers or legacy content", () => {
    const error = new MemoryMigrationDriftError("message", "secret-row-id");
    const output = formatMigrationCliError(error);

    expect(output).toContain("migration failed");
    expect(output).not.toContain("secret-row-id");
    expect(output).not.toContain("message");
  });
});
