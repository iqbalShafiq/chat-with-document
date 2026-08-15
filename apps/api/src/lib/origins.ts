/**
 * Origins that may call this API from a browser (CORS + Better Auth CSRF).
 *
 * Native mobile clients typically send no Origin and are not subject to CORS.
 * They authenticate with `Authorization: Bearer <token>` instead of cookies.
 */

import { networkInterfaces } from "node:os";

const DEFAULT_PLATFORM_ORIGIN = "http://localhost:3000";
const DEFAULT_API_ORIGIN = "http://localhost:3001";
const DEFAULT_PLATFORM_PORT = 3000;
const DEFAULT_API_PORT = 3001;

function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function getPlatformOrigin(): string {
  return process.env.PLATFORM_ORIGIN?.trim() || DEFAULT_PLATFORM_ORIGIN;
}

export function getApiOrigin(): string {
  const fromAuthUrl = process.env.BETTER_AUTH_URL?.trim();
  if (fromAuthUrl) {
    try {
      return new URL(fromAuthUrl).origin;
    } catch {
      return fromAuthUrl.replace(/\/+$/, "");
    }
  }
  const port = process.env.PORT?.trim();
  return port ? `http://localhost:${port}` : DEFAULT_API_ORIGIN;
}

export function getListenHostname(): string {
  return process.env.HOST?.trim() || "0.0.0.0";
}

/** Non-internal IPv4 addresses (skips 169.254 link-local). */
export function listLanIpv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      const isV4 = net.family === "IPv4";
      if (!isV4 || net.internal) continue;
      if (net.address.startsWith("169.254.")) continue;
      addresses.push(net.address);
    }
  }
  return [...new Set(addresses)];
}

/**
 * Trust LAN IPs in local dev so a phone can open http://192.168.x.x:3000
 * without editing TRUSTED_ORIGINS every time DHCP changes the address.
 * Off in production and in unit tests. Override with TRUST_LAN_ORIGINS.
 */
export function isLanOriginAutoTrustEnabled(): boolean {
  if (process.env.TRUST_LAN_ORIGINS === "false") return false;
  if (process.env.TRUST_LAN_ORIGINS === "true") return true;
  return process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";
}

function portFromOrigin(origin: string, fallback: number): number {
  try {
    const port = Number(new URL(origin).port);
    return Number.isFinite(port) && port > 0 ? port : fallback;
  } catch {
    return fallback;
  }
}

export function getLanDevOrigins(): string[] {
  if (!isLanOriginAutoTrustEnabled()) return [];
  const platformPort = portFromOrigin(getPlatformOrigin(), DEFAULT_PLATFORM_PORT);
  const apiPort = Number(process.env.PORT) || portFromOrigin(getApiOrigin(), DEFAULT_API_PORT);
  const origins: string[] = [];
  for (const ip of listLanIpv4Addresses()) {
    origins.push(`http://${ip}:${platformPort}`);
    origins.push(`http://${ip}:${apiPort}`);
  }
  return origins;
}

/**
 * Allowed browser origins: the web platform, this API (Scalar "Try it"),
 * extra TRUSTED_ORIGINS, and (in local dev) this machine's LAN IPs.
 */
export function getTrustedOrigins(): string[] {
  return [
    ...new Set([
      getPlatformOrigin(),
      getApiOrigin(),
      ...parseOriginList(process.env.TRUSTED_ORIGINS),
      ...getLanDevOrigins(),
    ]),
  ];
}

/** Resolve the request Origin against the allow-list. Empty string = deny. */
export function resolveAllowedOrigin(requestOrigin: string): string {
  return getTrustedOrigins().includes(requestOrigin) ? requestOrigin : "";
}
