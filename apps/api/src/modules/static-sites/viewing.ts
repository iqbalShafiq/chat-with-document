import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  assertSafeSiteId,
  getScopedSite,
  siteDataDir,
} from "./service.js";

export type SiteVersionRef = { siteId: string; version: number };

export async function resolveSiteVersion(input: {
  userId: string;
  sessionProjectId: string | null;
  siteId: string;
  version?: number;
  /** Test/override seam for the sites data dir. */
  dir?: string;
}): Promise<SiteVersionRef> {
  const manifest = await getScopedSite(input.userId, input.sessionProjectId, input.siteId, input.dir);
  if (!manifest) throw new Error("Site not found in the current scope.");
  const version = input.version ?? manifest.stableVersion ?? manifest.version;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("Site version not found in the current scope.");
  }
  return { siteId: manifest.siteId, version };
}

const READ_CAP_BYTES = 256 * 1024;

export async function readSiteIndexHtml(ref: SiteVersionRef): Promise<string> {
  assertSafeSiteId(ref.siteId);
  const path = join(siteDataDir(), ref.siteId, `v${ref.version}`, "index.html");
  const handle = await readFile(path, "utf8").catch(() => null);
  // Pola baca-dibatasi: baca penuh lalu potong — file dist statis kecil;
  // cap di sini mencegah OOM bila ada aset raksasa nyasar.
  if (handle === null) throw new Error("Site page has nothing viewable yet.");
  return handle.length > READ_CAP_BYTES ? handle.slice(0, READ_CAP_BYTES) : handle;
}

export function stripHtmlToText(html: string, maxChars: number): {
  title: string;
  headings: string[];
  excerpt: string;
  truncated: boolean;
} {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 20);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    title,
    headings,
    excerpt: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
  };
}

export async function extractSiteExcerpt(input: {
  ref: SiteVersionRef;
  maxChars?: number;
  readHtml?: (ref: SiteVersionRef) => Promise<string>;
}): Promise<{ title: string; headings: string[]; excerpt: string; truncated: boolean }> {
  const html = await (input.readHtml ?? readSiteIndexHtml)(input.ref);
  return stripHtmlToText(html, input.maxChars ?? 6000);
}
