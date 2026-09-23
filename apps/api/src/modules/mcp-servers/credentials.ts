import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const KEY_ENV = "MCP_CREDENTIALS_KEY";
const ENVELOPE_VERSION = 1;

let devKey: Buffer | null = null;
let devWarned = false;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Resolve the 32-byte credentials key. Production fails closed without an
 * explicit key; dev/test fall back to an ephemeral key (tokens do not
 * survive restarts) with a one-time warning.
 */
export function resolveCredentialsKey(): Buffer {
  const raw = process.env[KEY_ENV]?.trim();
  if (raw) {
    const key = Buffer.from(raw, "hex");
    if (key.length === 32) return key;
    throw new Error(
      `${KEY_ENV} must be 32 bytes as 64 hex characters (generate with: openssl rand -hex 32)`,
    );
  }
  if (isProduction()) {
    throw new Error(
      `${KEY_ENV} is required in production to store MCP credentials`,
    );
  }
  devKey ??= randomBytes(32);
  if (!devWarned) {
    devWarned = true;
    console.warn(
      `[mcp] ${KEY_ENV} is not set — using an ephemeral key; stored MCP credentials will not survive restarts`,
    );
  }
  return devKey;
}

type Envelope = {
  v: number;
  iv: string;
  tag: string;
  data: string;
};

/** Encrypt a credential into an opaque storage reference. */
export function encryptToken(plaintext: string): string {
  const key = resolveCredentialsKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** Decrypt a storage reference. Throws on tampering, wrong key, or version. */
export function decryptToken(ref: string): string {
  const key = resolveCredentialsKey();
  let envelope: Envelope;
  try {
    envelope = JSON.parse(
      Buffer.from(ref, "base64").toString("utf8"),
    ) as Envelope;
  } catch {
    throw new Error("MCP credential reference is invalid");
  }
  if (
    !envelope ||
    envelope.v !== ENVELOPE_VERSION ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.data !== "string"
  ) {
    throw new Error("MCP credential reference is invalid");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new Error("MCP credential failed to decrypt — wrong key or tampered data");
  }
}
