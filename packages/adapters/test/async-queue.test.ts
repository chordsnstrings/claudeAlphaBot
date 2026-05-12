import { describe, expect, it } from "vitest";

import { AsyncQueue } from "../src/async-queue.js";

describe("AsyncQueue", () => {
  it("delivers items pushed before next() is called", async () => {
    const q = new AsyncQueue<number>(4);
    await q.push(1);
    await q.push(2);
    expect(await q.next()).toBe(1);
    expect(await q.next()).toBe(2);
  });

  it("delivers items pushed after next() is awaited", async () => {
    const q = new AsyncQueue<number>(4);
    const promise = q.next();
    await q.push(42);
    expect(await promise).toBe(42);
  });

  it("applies backpressure when at capacity", async () => {
    const q = new AsyncQueue<number>(2);
    await q.push(1);
    await q.push(2);
    let pushed = false;
    const p = q.push(3).then(() => {
      pushed = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(pushed).toBe(false);
    expect(await q.next()).toBe(1);
    await p;
    expect(pushed).toBe(true);
  });

  it("returns null after close() drains", async () => {
    const q = new AsyncQueue<number>(2);
    await q.push(1);
    q.close();
    expect(await q.next()).toBe(1);
    expect(await q.next()).toBeNull();
    expect(await q.next()).toBeNull();
  });

  it("wakes pending next() waiters on close()", async () => {
    const q = new AsyncQueue<number>(2);
    const p = q.next();
    q.close();
    expect(await p).toBeNull();
  });
});
