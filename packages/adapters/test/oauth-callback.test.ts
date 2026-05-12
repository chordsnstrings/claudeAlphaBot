import type { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";

import {
  buildAuthorizationUrl,
  createOAuthHandler,
  type CTraderTokenResponse,
} from "../src/oauth-callback.js";

/** Tiny stub Response with capture helpers (no actual socket). */
function stubRes(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
  headers: () => Record<string, string | string[]>;
} {
  const chunks: string[] = [];
  const hdrs: Record<string, string | string[]> = {};
  let status = 200;
  const res = {
    writeHead(code: number, h?: Record<string, string | string[]>) {
      status = code;
      Object.assign(hdrs, h ?? {});
    },
    end(s?: string) {
      if (s !== undefined) {chunks.push(s);}
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    body: () => chunks.join(""),
    headers: () => hdrs,
  };
}

function req(url: string, host = "bot.example.com"): IncomingMessage {
  // Construct a minimal IncomingMessage; node's IM is normally tied to a
  // Socket; we use a real Socket so the handler's `req.headers.host`
  // lookup works without surprise.
  const socket = new Socket();
  const im = {
    url,
    headers: { host },
    socket,
  } as unknown as IncomingMessage;
  return im;
}

describe("oauth-callback", () => {
  it("returns 404 for paths other than /oauth/callback", async () => {
    const h = createOAuthHandler({
      clientId: "x",
      clientSecret: "y",
      redirectUri: "https://bot.example.com/oauth/callback",
      exchange: async () => {
        throw new Error("should not be called");
      },
      saveTokens: async () => {
        throw new Error("should not be called");
      },
    });
    const { res, status } = stubRes();
    await h(req("/foo"), res);
    expect(status()).toBe(404);
  });

  it("returns the placeholder when no `code` is supplied", async () => {
    const h = createOAuthHandler({
      clientId: "x",
      clientSecret: "y",
      redirectUri: "https://bot.example.com/oauth/callback",
      exchange: async () => {
        throw new Error("should not be called");
      },
      saveTokens: async () => {
        /* unused */
      },
    });
    const { res, status, body } = stubRes();
    await h(req("/oauth/callback"), res);
    expect(status()).toBe(200);
    expect(body()).toContain("OAuth callback endpoint ready");
  });

  it("exchanges code and persists tokens on success", async () => {
    let saved: CTraderTokenResponse | null = null;
    const h = createOAuthHandler({
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "https://bot.example.com/oauth/callback",
      exchange: async (args) => {
        expect(args.code).toBe("AUTHCODE");
        expect(args.clientId).toBe("cid");
        return {
          accessToken: "AT",
          refreshToken: "RT",
          expiresIn: 3600,
          scope: "trading",
          tokenType: "bearer",
        };
      },
      saveTokens: async (t) => {
        saved = t;
      },
    });
    const { res, status, body } = stubRes();
    await h(req("/oauth/callback?code=AUTHCODE"), res);
    expect(status()).toBe(200);
    expect(body()).toContain("cTrader OAuth complete");
    expect(saved).not.toBeNull();
    expect(saved?.accessToken).toBe("AT");
  });

  it("reports a 502 if the exchange throws", async () => {
    const h = createOAuthHandler({
      clientId: "x",
      clientSecret: "y",
      redirectUri: "https://bot.example.com/oauth/callback",
      exchange: async () => {
        throw new Error("invalid_grant");
      },
      saveTokens: async () => {
        /* unused */
      },
    });
    const { res, status, body } = stubRes();
    await h(req("/oauth/callback?code=BAD"), res);
    expect(status()).toBe(502);
    expect(body()).toContain("invalid_grant");
  });
});

describe("buildAuthorizationUrl", () => {
  it("includes the required query params", () => {
    const url = buildAuthorizationUrl({
      clientId: "abc",
      redirectUri: "https://bot.example.com/oauth/callback",
      state: "xyz",
    });
    const u = new URL(url);
    expect(u.origin).toBe("https://connect.spotware.com");
    expect(u.pathname).toBe("/apps/auth");
    expect(u.searchParams.get("client_id")).toBe("abc");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://bot.example.com/oauth/callback",
    );
    expect(u.searchParams.get("scope")).toBe("trading");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("xyz");
  });
});
