import { afterEach, describe, expect, it } from "vitest";
import {
  getApiOrigin,
  getLanDevOrigins,
  getListenHostname,
  getPlatformOrigin,
  getTrustedOrigins,
  isLanOriginAutoTrustEnabled,
  listLanIpv4Addresses,
  resolveAllowedOrigin,
} from "./origins.js";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env.PLATFORM_ORIGIN = ORIGINAL.PLATFORM_ORIGIN;
  process.env.BETTER_AUTH_URL = ORIGINAL.BETTER_AUTH_URL;
  process.env.TRUSTED_ORIGINS = ORIGINAL.TRUSTED_ORIGINS;
  process.env.PORT = ORIGINAL.PORT;
  process.env.HOST = ORIGINAL.HOST;
  process.env.TRUST_LAN_ORIGINS = ORIGINAL.TRUST_LAN_ORIGINS;
  process.env.NODE_ENV = ORIGINAL.NODE_ENV;
});

describe("getTrustedOrigins", () => {
  it("always includes the platform origin and the API origin", () => {
    process.env.PLATFORM_ORIGIN = "http://localhost:3000";
    process.env.BETTER_AUTH_URL = "http://localhost:3001";
    delete process.env.TRUSTED_ORIGINS;

    expect(getTrustedOrigins()).toEqual([
      "http://localhost:3000",
      "http://localhost:3001",
    ]);
  });

  it("merges extra TRUSTED_ORIGINS without duplicates", () => {
    process.env.PLATFORM_ORIGIN = "http://localhost:3000";
    process.env.BETTER_AUTH_URL = "http://localhost:3001";
    process.env.TRUSTED_ORIGINS =
      "http://localhost:8081, myapp://, http://localhost:3000";

    expect(getTrustedOrigins()).toEqual([
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:8081",
      "myapp://",
    ]);
  });

  it("resolves only listed origins", () => {
    process.env.PLATFORM_ORIGIN = "http://localhost:3000";
    process.env.BETTER_AUTH_URL = "http://localhost:3001";
    delete process.env.TRUSTED_ORIGINS;

    expect(resolveAllowedOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(resolveAllowedOrigin("https://evil.example")).toBe("");
  });
});

describe("defaults", () => {
  it("falls back to localhost ports", () => {
    delete process.env.PLATFORM_ORIGIN;
    delete process.env.BETTER_AUTH_URL;
    delete process.env.PORT;

    expect(getPlatformOrigin()).toBe("http://localhost:3000");
    expect(getApiOrigin()).toBe("http://localhost:3001");
  });

  it("listens on all interfaces by default", () => {
    delete process.env.HOST;
    expect(getListenHostname()).toBe("0.0.0.0");
  });

  it("does not auto-trust LAN origins during unit tests", () => {
    delete process.env.TRUST_LAN_ORIGINS;
    expect(isLanOriginAutoTrustEnabled()).toBe(false);
    expect(getLanDevOrigins()).toEqual([]);
  });

  it("lists LAN IPv4 addresses when TRUST_LAN_ORIGINS is on", () => {
    process.env.TRUST_LAN_ORIGINS = "true";
    process.env.PLATFORM_ORIGIN = "http://localhost:3000";
    process.env.BETTER_AUTH_URL = "http://localhost:3001";

    const ips = listLanIpv4Addresses();
    const origins = getLanDevOrigins();
    for (const ip of ips) {
      expect(origins).toContain(`http://${ip}:3000`);
      expect(origins).toContain(`http://${ip}:3001`);
    }
    expect(getTrustedOrigins()).toEqual(
      expect.arrayContaining([
        "http://localhost:3000",
        "http://localhost:3001",
        ...origins,
      ]),
    );
  });
});
