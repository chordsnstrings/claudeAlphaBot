/**
 * Tiny wrapper around the bot's internal command API. Lives server-side
 * only — the UI never talks to the bot from the browser; every call goes
 * through a Next.js route handler that uses this helper.
 */
const BOT_URL =
  process.env["BOT_INTERNAL_API_URL"] ??
  process.env["BOT_API_URL"] ??
  "http://localhost:8080";

export interface BotCallResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

export async function callBot(
  path: string,
  init: { method: "POST" | "GET"; body?: unknown; requester?: string },
): Promise<BotCallResult> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.requester) headers["x-requester"] = init.requester;
    const reqInit: RequestInit = {
      method: init.method,
      headers,
      cache: "no-store",
    };
    if (init.body !== undefined) reqInit.body = JSON.stringify(init.body);
    const res = await fetch(`${BOT_URL}${path}`, reqInit);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: "bot_unreachable", message: err instanceof Error ? err.message : String(err) },
    };
  }
}
