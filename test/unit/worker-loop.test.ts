import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkerLoop } from "../../src/operations/worker-loop.js";

describe("WorkerLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls less often while idle and returns to the busy pace after work", async () => {
    const found: boolean[] = [false, false, false, false, true];
    const startedAt: number[] = [];
    const loop = new WorkerLoop(
      "test",
      async () => {
        startedAt.push(Date.now());
        return found.shift() ?? false;
      },
      { busyMs: 100, idleMs: 500 },
    );

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200 + 400 + 500 + 500 + 100);
    await loop.stop();

    const gaps = startedAt
      .slice(1)
      .map((time, index) => time - startedAt[index]!);
    expect(gaps).toEqual([200, 400, 500, 500, 100]);
  });

  it("starts the next cycle at once when woken", async () => {
    let cycles = 0;
    const loop = new WorkerLoop(
      "test",
      async () => {
        cycles += 1;
        return false;
      },
      { busyMs: 100, idleMs: 60_000 },
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    const beforeWake = cycles;

    loop.wake();
    await vi.advanceTimersByTimeAsync(0);

    expect(cycles).toBe(beforeWake + 1);
    await loop.stop();
  });

  it("waits for the running cycle on stop and schedules nothing after it", async () => {
    let release!: () => void;
    let cycles = 0;
    let signal: AbortSignal | undefined;
    const loop = new WorkerLoop(
      "test",
      async (cycleSignal) => {
        cycles += 1;
        signal = cycleSignal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return true;
      },
      { busyMs: 1, idleMs: 1 },
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(signal?.aborted).toBe(true);
    expect(stopped).toBe(false);

    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).toBe(true);
    expect(cycles).toBe(1);
  });

  it("reports a failed cycle and keeps running", async () => {
    const outcomes: (() => Promise<boolean>)[] = [
      () => Promise.reject(new RangeError("synthetic")),
      () => Promise.resolve(true),
    ];
    let cycles = 0;
    const loop = new WorkerLoop(
      "test",
      () => {
        cycles += 1;
        return (outcomes.shift() ?? (() => Promise.resolve(false)))();
      },
      { busyMs: 10, idleMs: 100 },
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    await loop.stop();

    expect(cycles).toBeGreaterThanOrEqual(2);
    expect(
      String(vi.mocked(process.stderr.write).mock.calls[0]?.[0]),
    ).toContain('"failure":"error_range_error"');
  });
});
