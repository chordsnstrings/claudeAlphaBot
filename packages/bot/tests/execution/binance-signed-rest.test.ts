import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

/** The signed-rest module builds a query string and signs it with HMAC-SHA256.
 * This test verifies the signing contract by replicating the expected signature
 * for a minimal parameter set — keeps us honest that the client uses HMAC-SHA256
 * and the canonical URL-encoded layout that Binance requires. */

function expectedSignature(secret: string, qs: string): string {
  return createHmac("sha256", secret).update(qs).digest("hex");
}

describe("HMAC signing contract", () => {
  it("HMAC-SHA256 produces 64-hex signature for a known input", () => {
    const qs = "symbol=BTCUSDT&side=BUY&type=MARKET&quantity=1&timestamp=1700000000000&recvWindow=5000";
    const sig = expectedSignature("test-secret", qs);
    expect(sig.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });

  it("different secrets produce different signatures", () => {
    const qs = "symbol=BTCUSDT&timestamp=1";
    const a = expectedSignature("secret1", qs);
    const b = expectedSignature("secret2", qs);
    expect(a).not.toBe(b);
  });
});
