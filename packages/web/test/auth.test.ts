import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hashPassword,
  issueSession,
  verifyCredentials,
  verifySession,
  type AuthConfig,
} from "../src/auth.js";

function makeCfg(password: string): AuthConfig {
  const saltHex = randomBytes(16).toString("hex");
  return {
    username: "ops",
    passwordHashHex: hashPassword(password, saltHex),
    passwordSaltHex: saltHex,
    sessionSecret: "test-session-secret",
  };
}

describe("verifyCredentials", () => {
  it("accepts the right password", () => {
    const cfg = makeCfg("hunter2");
    expect(verifyCredentials(cfg, "ops", "hunter2")).toBe(true);
  });
  it("rejects a wrong password", () => {
    const cfg = makeCfg("hunter2");
    expect(verifyCredentials(cfg, "ops", "wrong")).toBe(false);
  });
  it("rejects a wrong username", () => {
    const cfg = makeCfg("hunter2");
    expect(verifyCredentials(cfg, "someone-else", "hunter2")).toBe(false);
  });
});

describe("session sign/verify", () => {
  it("round-trips a fresh session", () => {
    const cfg = makeCfg("p");
    const token = issueSession(cfg, "ops");
    const s = verifySession(cfg, token);
    expect(s?.username).toBe("ops");
  });

  it("rejects a tampered token", () => {
    const cfg = makeCfg("p");
    const token = issueSession(cfg, "ops");
    const dot = token.lastIndexOf(".");
    const tampered = token.slice(0, dot) + ".AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(verifySession(cfg, tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const cfgA = makeCfg("p");
    const cfgB = { ...cfgA, sessionSecret: "different-secret" };
    const token = issueSession(cfgA, "ops");
    expect(verifySession(cfgB, token)).toBeNull();
  });

  it("expires after TTL", () => {
    const cfg = { ...makeCfg("p"), sessionTtlSec: 1 } satisfies AuthConfig;
    const token = issueSession(cfg, "ops");
    // Advance perceived time via the issuedAt overwrite trick: re-issue
    // with a backdated session by patching the JSON payload.
    const dot = token.lastIndexOf(".");
    const payload = JSON.parse(
      Buffer.from(token.slice(0, dot), "base64url").toString("utf8"),
    ) as { username: string; issuedAt: number };
    payload.issuedAt = Date.now() - 10_000;
    const backdated = Buffer.from(JSON.stringify(payload)).toString("base64url");
    // Re-sign with the same secret.
    const reissued = issueSessionFromPayload(cfg.sessionSecret, backdated);
    expect(verifySession(cfg, reissued)).toBeNull();
  });
});

// helper: re-sign a known payload with the test secret to simulate clock drift
function issueSessionFromPayload(secret: string, payload: string): string {
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
