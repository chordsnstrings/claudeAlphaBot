/**
 * Tiny password-based session auth. No public access — every route
 * except /login + /api/health requires a signed session cookie.
 *
 * Credentials come from env vars (Replit secrets in production):
 *   UI_USERNAME, UI_PASSWORD_HASH (scrypt N=16384,r=8,p=1 hex), UI_SESSION_SECRET.
 *
 * Password verification uses timing-safe compare. Sessions are signed
 * JWT-like (header.payload.HMAC) with the session secret.
 */

import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export interface AuthConfig {
  username: string;
  /** Hex-encoded scrypt hash of the password. */
  passwordHashHex: string;
  /** Hex-encoded salt used to derive the hash. */
  passwordSaltHex: string;
  sessionSecret: string;
  /** Session TTL in seconds; default 12h. */
  sessionTtlSec?: number;
}

export interface Session {
  username: string;
  issuedAt: number;
}

/** Hash a password with scrypt; convenience for setup scripts. */
export function hashPassword(password: string, saltHex: string): string {
  const salt = Buffer.from(saltHex, "hex");
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return derived.toString("hex");
}

export function verifyCredentials(
  cfg: AuthConfig,
  username: string,
  password: string,
): boolean {
  if (username !== cfg.username) {
    return false;
  }
  const expected = Buffer.from(cfg.passwordHashHex, "hex");
  const provided = scryptSync(
    password,
    Buffer.from(cfg.passwordSaltHex, "hex"),
    SCRYPT_KEYLEN,
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
  );
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueSession(cfg: AuthConfig, username: string): string {
  const session: Session = { username, issuedAt: Date.now() };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const sig = sign(payload, cfg.sessionSecret);
  return `${payload}.${sig}`;
}

export function verifySession(cfg: AuthConfig, token: string | undefined): Session | null {
  if (token === undefined || token.length === 0) {
    return null;
  }
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 0) {
    return null;
  }
  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expected = sign(payload, cfg.sessionSecret);
  if (sig.length !== expected.length) {
    return null;
  }
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Session;
    const ttl = (cfg.sessionTtlSec ?? 12 * 3600) * 1000;
    if (Date.now() - decoded.issuedAt > ttl) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}
