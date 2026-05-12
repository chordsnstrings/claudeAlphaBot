/**
 * SystemClock — live-mode Clock implementation. Spec §9.17.
 *
 *   now()         returns real wall-clock UTC time
 *   sleep(ms)     resolves after `ms` milliseconds
 *   advanceTo()   is intentionally absent — wall time is not advanceable
 */

import type { Clock } from "@trading/core";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
