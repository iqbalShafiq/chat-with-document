import { FETCH_MAX_REDIRECTS, FETCH_TIMEOUT_MS, MAX_FETCH_BYTES } from "./limits.js";

export type FetchTabularResult = {
  bytes: Uint8Array;
  mediaType: string;
  finalUrl: string;
};

export type FetchTabularDeps = {
  fetchFn?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
};

function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host === "localhost.") return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const parts = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6 literals (brackets stripped by URL): loopback, unique-local, link-local.
  if (host.includes(":")) {
    const expanded = host.replace(/^\[(.*)\]$/, "$1");
    if (expanded === "::1" || expanded.startsWith("fc") || expanded.startsWith("fd") || expanded.startsWith("fe80")) {
      return true;
    }
  }
  return false;
}

export function assertFetchableUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL is not valid. Provide an absolute http(s) URL to a CSV/XLSX file.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported for dataset fetch.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error("URL host is not allowed for dataset fetch.");
  }
  return url;
}

async function readCappedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error(`Downloaded file exceeds the ${(maxBytes / 1024 / 1024).toFixed(1)}MB limit.`);
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Downloaded file exceeds the ${(maxBytes / 1024 / 1024).toFixed(1)}MB limit.`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Fetch a remote CSV/XLSX with SSRF guards: http(s) only, no private hosts,
// bounded redirects, timeout, and size cap. DNS rebinding across redirects
// is mitigated by re-validating every hop. Provide fetchFn in tests.
export async function fetchTabularUrl(rawUrl: string, deps: FetchTabularDeps = {}): Promise<FetchTabularResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const maxBytes = deps.maxBytes ?? MAX_FETCH_BYTES;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = assertFetchableUrl(rawUrl).toString();

  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Dataset fetch timed out.")), timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(current, { signal: controller.signal, redirect: "manual" });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      if (hop >= FETCH_MAX_REDIRECTS) throw new Error("Too many redirects while fetching the dataset (max 3).");
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect response is missing a Location header.");
      current = assertFetchableUrl(new URL(location, current).toString()).toString();
      continue;
    }
    if (!response.ok) throw new Error(`Dataset fetch failed with HTTP ${response.status}.`);
    const bytes = await readCappedBytes(response, maxBytes);
    if (bytes.byteLength === 0) throw new Error("Downloaded file is empty.");
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
    return { bytes, mediaType, finalUrl: current };
  }
  throw new Error("Too many redirects while fetching the dataset (max 3).");
}
