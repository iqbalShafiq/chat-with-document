import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = new URL("../", import.meta.url).pathname;
const LEGACY_KEYS = new Set(["input", "output", "approval"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (extname(entry.name) !== ".ts" || entry.name.endsWith(".test.ts")) {
      return [];
    }
    return [path];
  });
}

function legacyCreateToolKeys(path: string): string[] {
  const failures: string[] = [];
  let optionIndent: number | undefined;
  let callIndent: number | undefined;

  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (/\bcreateTool\s*\(\s*\{\s*$/.test(line)) {
      callIndent = indent;
      optionIndent = undefined;
      continue;
    }
    if (callIndent === undefined) continue;
    if (optionIndent === undefined && /^\s*name\s*:/.test(line)) {
      optionIndent = indent;
    }
    const key = line.match(/^\s*(input|output|approval)\s*:/)?.[1];
    if (key && indent === optionIndent && LEGACY_KEYS.has(key)) {
      failures.push(
        `${relative(SOURCE_ROOT, path)}:${index + 1} uses legacy createTool option \`${key}\``,
      );
    }
    if (indent <= callIndent && /^\s*\}\)\s*[,;]?\s*$/.test(line)) {
      callIndent = undefined;
      optionIndent = undefined;
    }
  }
  return failures;
}

describe("Anvia v1 tool source contracts", () => {
  it("contains no legacy createTool option keys", () => {
    const failures = sourceFiles(SOURCE_ROOT).flatMap(legacyCreateToolKeys);
    expect(failures).toEqual([]);
  });
});
