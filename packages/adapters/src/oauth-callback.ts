/**
 * OAuth callback endpoint for the cTrader connect flow (spec §9.17).
 *
 * cTrader's OAuth2 flow:
 *   1. Operator visits https://connect.spotware.com/apps/auth
 *        ?client_id=<CTRADER_CLIENT_ID>
 *        &redirect_uri=https://bot.<domain>/oauth/callback
 *        &scope=trading
 *        &response_type=code
 *   2. After granting access, cTrader redirects to our callback URL
 *      with `?code=<authorization_code>` (and optionally `state`).
 *   3. Our callback exchanges the code at
 *      https://connect.spotware.com/apps/token (POST form-urlencoded)
 *      for an access_token + refresh_token.
 *   4. Tokens are persisted via the supplied `saveTokens` callback —
 *      operator chooses Replit secrets, DB config_setting, or a file.
 *
 * The handler returns a small HTML success page; failures return 4xx/5xx
 * with the cTrader error message verbatim so the operator can debug.
 *
 * This module exposes `createOAuthHandler` (testable, no I/O) and
 * `startOAuthServer` (wraps a Node http server around it). Phase 17 wires
 * the server into the live composition root; production deployments
 * front it with TLS via Caddy/nginx + Let's Encrypt.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { logger } from "@trading/core";

const log = logger("adapters.oauth-callback");

export const CTRADER_TOKEN_URL = "https://connect.spotware.com/apps/token";
export const CTRADER_AUTH_URL = "https://connect.spotware.com/apps/auth";

export interface CTraderTokenResponse {
  accessToken: string;
  refreshToken: string;
  /** Seconds until access token expiry. */
  expiresIn: number;
  scope: string;
  tokenType: string;
}

export interface ExchangeArgs {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}

export interface OAuthHandlerDeps {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Hook for tests: defaults to `fetch`. */
  exchange?: (args: ExchangeArgs) => Promise<CTraderTokenResponse>;
  /** Called with the freshly minted tokens; persistence is the operator's choice. */
  saveTokens: (tokens: CTraderTokenResponse) => Promise<void>;
}

/**
 * Exchange an authorization code for tokens. Uses the global `fetch`
 * (Node 18+) by default; tests can inject a stub via deps.exchange.
 */
export async function exchangeAuthorizationCode(
  args: ExchangeArgs,
): Promise<CTraderTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  const res = await fetch(CTRADER_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`cTrader token exchange failed (${res.status}): ${text}`);
  }
  const payload = JSON.parse(text) as {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    scope?: string;
    tokenType?: string;
    // cTrader docs sometimes use snake_case; accept both.
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  const accessToken = payload.accessToken ?? payload.access_token;
  const refreshToken = payload.refreshToken ?? payload.refresh_token;
  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string"
  ) {
    throw new Error(`cTrader token exchange returned malformed payload: ${text}`);
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: payload.expiresIn ?? payload.expires_in ?? 0,
    scope: payload.scope ?? "",
    tokenType: payload.tokenType ?? payload.token_type ?? "bearer",
  };
}

/**
 * Build a request handler suitable for use with Node's http.Server.
 * Returns 200 + an HTML success page on the happy path; 400 if `code`
 * is missing; 5xx if the token exchange fails.
 */
export function createOAuthHandler(deps: OAuthHandlerDeps) {
  const exchange = deps.exchange ?? exchangeAuthorizationCode;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/oauth/callback") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const code = url.searchParams.get("code");
    if (code === null || code.length === 0) {
      // Spec §9.17 verification: returns a placeholder when no code.
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("OAuth callback endpoint ready. Awaiting authorization.");
      return;
    }
    try {
      const tokens = await exchange({
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
        redirectUri: deps.redirectUri,
        code,
      });
      await deps.saveTokens(tokens);
      log.info(
        {
          accessTokenPrefix: tokens.accessToken.slice(0, 6),
          expiresIn: tokens.expiresIn,
          scope: tokens.scope,
        },
        "cTrader OAuth completed; tokens persisted",
      );
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html><html><body><h1>cTrader OAuth complete</h1>" +
          "<p>Tokens have been persisted. You can close this window.</p></body></html>",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "cTrader OAuth exchange failed");
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`OAuth exchange failed: ${msg}`);
    }
  };
}

/** Start a tiny HTTP server with just the /oauth/callback route. */
export function startOAuthServer(
  deps: OAuthHandlerDeps,
  port: number,
  host = "0.0.0.0",
): Server {
  const handler = createOAuthHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res).catch((err) => {
      log.error({ err: err instanceof Error ? err.stack : String(err) }, "handler crashed");
      try {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      } catch {
        /* socket already closed; nothing to do */
      }
    });
  });
  server.listen(port, host, () => {
    log.info({ host, port }, "OAuth callback server listening");
  });
  return server;
}

/** Build the auth URL the operator should visit to start the flow. */
export function buildAuthorizationUrl(args: {
  clientId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
}): string {
  const url = new URL(CTRADER_AUTH_URL);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", args.scope ?? "trading");
  url.searchParams.set("response_type", "code");
  if (args.state !== undefined) {
    url.searchParams.set("state", args.state);
  }
  return url.toString();
}
