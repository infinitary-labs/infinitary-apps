import { afterEach, expect, it, vi } from "vitest";
import { AdmissionClock } from "./admissionClock";

afterEach(() => vi.useRealTimers());

it("does not advance a deadline past an unfinished admission", async () => {
  const advance = vi.fn(async (_ms: number) => {});
  const clock = new AdmissionClock(advance);
  let release!: () => void;
  const admitted = clock.track(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  )();
  const ticking = clock.advance(100);
  await Promise.resolve();
  expect(advance).not.toHaveBeenCalled();
  release();
  await Promise.all([admitted, ticking]);
  expect(advance.mock.calls.flat()).toEqual(Array.from({ length: 10 }, () => 10));
});

it("preserves an admission rejection instead of hiding it", async () => {
  const clock = new AdmissionClock(async () => {});
  let reject!: (error: Error) => void;
  const pending = clock.track(
    () =>
      new Promise<void>((_resolve, no) => {
        reject = no;
      }),
  )();
  const ticking = clock.advance(100);
  const originalFailure = expect(pending).rejects.toThrow("admission failed");
  const clockFailure = expect(ticking).rejects.toThrow("admission failed");
  reject(new Error("admission failed"));
  await Promise.all([originalFailure, clockFailure]);
  await expect(clock.advance(10)).resolves.toBeUndefined();
});

it("waits for timer-triggered admissions before advancing their next deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const start = Date.now();
  const clock = new AdmissionClock((ms) => vi.advanceTimersByTimeAsync(ms));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admissionStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const events: string[] = [];
  const admit = clock.track(async () => {
    entered();
    await gate;
    events.push("admitted");
    setTimeout(() => events.push("deadline"), 5);
  });
  setTimeout(() => {
    void admit();
  }, 10);
  const ticking = clock.advance(25);
  await admissionStarted;
  expect(Date.now()).toBe(start + 10);
  expect(events).toEqual([]);
  release();
  await ticking;
  expect(Date.now()).toBe(start + 25);
  expect(events).toEqual(["admitted", "deadline"]);
});
