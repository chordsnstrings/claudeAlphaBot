/** Spec §9.5 T5.3 — Clock abstraction. */

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  /**
   * Optional: advance the clock to `t`. Implemented by SimulatedClock and
   * called by the engine on each new bar. SystemClock (wall time) does not
   * implement this — wall time advances by itself.
   */
  advanceTo?(t: Date): void;
}
