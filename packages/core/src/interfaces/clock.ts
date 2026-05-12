/** Spec §9.5 T5.3 — Clock abstraction. */

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}
