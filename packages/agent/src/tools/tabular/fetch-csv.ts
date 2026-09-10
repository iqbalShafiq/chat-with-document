import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { FETCH_MAX_REDIRECTS, FETCH_TIMEOUT_MS, MAX_FETCH_BYTES } from "./limits.js";

export type FetchTabularResult = {
  bytes: Uint8Array;
  mediaType: string;
  finalUrl: string;
};

export type DnsLookupResult = { address: string; family: number };

export type FetchTabularDeps = {
  fetchFn?: typeof fetch | undefined;
  lookupFn?: ((hostname: string) => Promise<DnsLookupResult[]>) | undefined;
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
};

const PRIVATE_NET = new BlockList();
PRIVATE_NET.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE_NET.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NET.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_NET.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_NET.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_NET.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NET.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NET.addSubnet("224.0.0.0", 4, "ipv4");
PRIVATE_NET.addAddress("255.255.255.255", "ipv4");
PRIVATE_NET.addAddress("::1", "ipv6");
PRIVATE_NET.addSubnet("fc00::", 7, "ipv6");
PRIVATE_NET.addSubnet("fe80::", 10, "ipv6");

function isBlockedHostnameLabel(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  return false;
}

/** Integer or short-form IPv4 (2130706433, 127.1) to dotted quad. */
export function coerceIPv4Literal(host: string): string | null {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
    return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
  }
  const parts = host.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  if (parts.length === 4) return nums.join(".");
  if (parts.length === 2) {
    const rest = nums[1]!;
    if (rest > 0xffffff) return null;
    return `${nums[0]}.${(rest >>> 16) & 255}.${(rest >>> 8) & 255}.${rest & 255}`;
  }
  const rest = nums[2]!;
  if (rest > 0xffff) return null;
  return `${nums[0]}.${nums[1]}.${(rest >>> 8) & 255}.${rest & 255}`;
}

function ipv4MappedFromV6(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1] ?? null;
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1]!, 16);
  const lo = Number.parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isBlockedAddress(address: string): boolean {
  const mapped = ipv4MappedFromV6(address);
  if (mapped) return isBlockedAddress(mapped);
  const family = isIP(address);
  if (family === 4) return PRIVATE_NET.check(address, "ipv4");
  if (family === 6) return PRIVATE_NET.check(address, "ipv6");
  const coerced = coerceIPv4Literal(address);
  if (coerced) return PRIVATE_NET.check(coerced, "ipv4");
  return false;
}

function assertPublicHostname(hostname: string): void {
  const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (isBlockedHostnameLabel(host)) {
    throw new Error("URL host is not allowed for dataset fetch.");
  }
  if (isIP(host) || coerceIPv4Literal(host)) {
    if (isBlockedAddress(host) || (coerceIPv4Literal(host) && isBlockedAddress(coerceIPv4Literal(host)!))) {
      throw new Error("URL host is not allowed for dataset fetch.");
    }
  }
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
  assertPublicHostname(url.hostname);
  return url;
}

async function defaultLookup(hostname: string): Promise<DnsLookupResult[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function resolvePublicAddresses(
  hostname: string,
  lookupFn: (hostname: string) => Promise<DnsLookupResult[]>,
): Promise<DnsLookupResult[]> {
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host) || coerceIPv4Literal(host)) {
    const address = coerceIPv4Literal(host) ?? host;
    if (isBlockedAddress(address)) {
      throw new Error("URL host is not allowed for dataset fetch.");
    }
    return [{ address, family: isIP(address) === 6 ? 6 : 4 }];
  }
  let records: DnsLookupResult[];
  try {
    records = await lookupFn(host);
  } catch {
    throw new Error("URL host could not be resolved for dataset fetch.");
  }
  if (records.length === 0) {
    throw new Error("URL host could not be resolved for dataset fetch.");
  }
  if (records.some((r) => isBlockedAddress(r.address))) {
    throw new Error("URL host is not allowed for dataset fetch.");
  }
  return records;
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

// Fetch a remote CSV/XLSX with SSRF guards: http(s) only, no private hosts
// or resolved private IPs, bounded redirects, timeout, and size cap.
// Each hop is DNS-resolved before connect. The request keeps the original
// hostname so TLS SNI/certificates still match; we do not rewrite the URL
// to a raw IP.
export async function fetchTabularUrl(rawUrl: string, deps: FetchTabularDeps = {}): Promise<FetchTabularResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const lookupFn = deps.lookupFn ?? defaultLookup;
  const maxBytes = deps.maxBytes ?? MAX_FETCH_BYTES;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = assertFetchableUrl(rawUrl);

  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop += 1) {
    await resolvePublicAddresses(current.hostname, lookupFn);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Dataset fetch timed out.")), timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(current.toString(), {
        signal: controller.signal,
        redirect: "manual",
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      if (hop >= FETCH_MAX_REDIRECTS) throw new Error("Too many redirects while fetching the dataset (max 3).");
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect response is missing a Location header.");
      current = assertFetchableUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Dataset fetch failed with HTTP ${response.status}.`);
    const bytes = await readCappedBytes(response, maxBytes);
    if (bytes.byteLength === 0) throw new Error("Downloaded file is empty.");
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
    return { bytes, mediaType, finalUrl: current.toString() };
  }
  throw new Error("Too many redirects while fetching the dataset (max 3).");
}
