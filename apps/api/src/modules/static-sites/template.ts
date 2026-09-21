import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SITE_TEMPLATE_DIR } from "./worker.js";

const TEMPLATE_FILES = [
  "package.json",
  "vite.config.ts",
  "index.html",
  "src/main.tsx",
  "src/App.tsx",
  "src/tokens.css",
] as const;

export async function readSiteTemplate(
  dir: string = SITE_TEMPLATE_DIR,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    TEMPLATE_FILES.map(
      async (file) => [file, await readFile(join(dir, file), "utf8")] as const,
    ),
  );
  return Object.fromEntries(entries);
}
