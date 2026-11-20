import { afterEach, describe, expect, it, vi } from "vitest";
import { GITHUB_READ_TOOL, GITHUB_WRITE_TOOL } from "../pi/forgeTools";
import { GITHUB_READ_ATTEMPT_MS } from "./githubRead";
import { bindTool, type CrewmateToolDelegate } from "./tools";

// Finding D, approved by the captain: 30 seconds per attempt and one retry.
// Exercise the common bound tool used locally and by SessionHost, not a provider twin.
const INPUT = { path: "/repos/octocat/Hello-World" };
// GitHub's documented repository response, keeping only fields relevant to this read.
const ANSWER = JSON.stringify({
  status: 200,
  body: { id: 1296269, full_name: "octocat/Hello-World" },
});

afterEach(() => vi.useRealTimers());

function readTool(delegate: CrewmateToolDelegate) {
  const tool = bindTool(GITHUB_READ_TOOL, delegate);
  if (!tool) throw new Error("The read callback was not bound.");
  return tool;
}

describe("the crewmate's bounded GitHub read", () => {
  it("answers a lost callback after two deadlines even when it ignores cancellation", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const tool = readTool({
      onGithubRead: async (_input, signal) => {
        if (!signal) throw new Error("The read has no cancellation.");
        signals.push(signal);
        return new Promise<string>(() => {});
      },
    });
    const result = tool.run(INPUT);
    // The quiet fallback can cancel as soon as a read opens, before another microtask.
    expect(signals).toHaveLength(1);
    const failed = expect(result).rejects.toThrow("may have been lost");
    await vi.advanceTimersByTimeAsync(GITHUB_READ_ATTEMPT_MS - 1);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(GITHUB_READ_ATTEMPT_MS);
    await failed;
    expect(signals[1]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the retry's complete answer and ignores a late first answer", async () => {
    vi.useFakeTimers();
    let late!: (text: string) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            late = resolve;
          }),
      )
      .mockResolvedValueOnce(ANSWER);
    const result = readTool({ onGithubRead: read }).run(INPUT);
    await vi.advanceTimersByTimeAsync(GITHUB_READ_ATTEMPT_MS);
    await expect(result).resolves.toEqual({ text: ANSWER });
    late("old answer");
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a transport failure once without retrying a successful read", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(ANSWER);
    const tool = readTool({ onGithubRead: read });
    await expect(tool.run(INPUT)).resolves.toEqual({ text: ANSWER });
    expect(read).toHaveBeenCalledTimes(2);
    await expect(tool.run(INPUT)).resolves.toEqual({ text: ANSWER });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([
    "Cannot call GitHub (refused): The answer exceeds the 256 KiB read limit. It is one object, not a list, so a smaller page would not shrink it.",
    JSON.stringify({
      status: 429,
      retryAfterSeconds: 60,
      rateLimit: { remaining: 0, resetAt: "2026-11-09T19:05:32.000Z" },
      body: { message: "API rate limit exceeded" },
    }),
    "Cannot call GitHub (sign-in): Sign in to GitHub again.",
  ])("preserves a definite refusal without spending a retry: %s", async (answer) => {
    const read = vi.fn().mockResolvedValue(answer);
    await expect(readTool({ onGithubRead: read }).run(INPUT)).resolves.toEqual({
      text: answer,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("cancels immediately without retrying, even if the callback ignores cancellation", async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<string>(() => {}));
    const stop = new AbortController();
    const result = readTool({ onGithubRead: read }).run(INPUT, stop.signal);
    const failed = expect(result).rejects.toThrow("conversation stopped");
    await vi.advanceTimersByTimeAsync(0);
    stop.abort(new Error("conversation stopped"));
    await failed;
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not apply the read deadline or retry to a release write", async () => {
    vi.useFakeTimers();
    let finish!: (text: string) => void;
    const write = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const tool = bindTool(GITHUB_WRITE_TOOL, { onGithubWrite: write });
    if (!tool) throw new Error("The write callback was not bound.");
    const result = tool.run({
      method: "POST",
      path: "/repos/octocat/Hello-World/releases/1/assets",
      file: "release.zip",
    });
    await vi.advanceTimersByTimeAsync(3 * GITHUB_READ_ATTEMPT_MS);
    expect(write).toHaveBeenCalledTimes(1);
    finish("uploaded");
    await expect(result).resolves.toEqual({ text: "uploaded" });
  });
});
