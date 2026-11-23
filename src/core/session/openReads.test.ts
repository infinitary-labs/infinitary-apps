import { describe, expect, it } from "vitest";
import { GITHUB_READ_TOOL, GITHUB_WRITE_TOOL } from "../pi/forgeTools";
import { answeredReadText, isAppRead, OpenReads } from "./openReads";
import { bindTools } from "./tools";

// INF-2603, the captain's approved direction B: "Name the wait and settle the
// app's own calls". INF-2550's turn sat 13 hours inside one github_read that
// never answered; the app answers its own read "ask again" at the quiet
// check, and never a change.

/** A host callback that never answers, keeping the cancellation each call was given. */
function neverAnswers() {
  const signals: (AbortSignal | undefined)[] = [];
  const run = (_input: unknown, signal?: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>(() => {});
  };
  return { run, signals };
}

/** The real GitHub pair, bound to callbacks that never answer, as the quiet check finds them. */
function stuckPair(reads: OpenReads) {
  const read = neverAnswers();
  const write = neverAnswers();
  const tools = reads.serve(
    bindTools([GITHUB_READ_TOOL, GITHUB_WRITE_TOOL], {
      onGithubRead: read.run,
      onGithubWrite: write.run,
    }),
  );
  const tool = (name: string) => {
    const found = tools.find((each) => each.name === name);
    if (!found) throw new Error(`${name} is not served`);
    return found;
  };
  return { read, write, githubRead: tool("github_read"), githubWrite: tool("github_write") };
}

describe("OpenReads", () => {
  it("reads the app's own read and change tools off the work requests' declared effect", () => {
    expect(isAppRead("github_read")).toBe(true);
    expect(isAppRead("tasks")).toBe(true);
    expect(isAppRead("github_write")).toBe(false);
    expect(isAppRead("report")).toBe(false);
    // A crewmate's own tools are never the app's.
    expect(isAppRead("Bash")).toBe(false);
    expect(isAppRead("Agent")).toBe(false);
  });

  it("answers a read that never returns 'ask again', cancels its work, and leaves a change running", async () => {
    let clock = Date.parse("2026-11-04T03:02:08Z");
    const reads = new OpenReads(() => clock);
    const { read, write, githubRead, githubWrite } = stuckPair(reads);
    const runs = new AbortController();
    const reading = githubRead.run(
      { path: "/repos/acme/shop/actions/runs?per_page=100" },
      runs.signal,
    );
    let wrote = false;
    void githubWrite
      .run({ method: "POST", path: "/repos/acme/shop/dispatches" }, runs.signal)
      .finally(() => {
        wrote = true;
      });
    clock += 21 * 60_000;

    const answered = reads.answer(clock - 20 * 60_000);

    expect(answered).toEqual([{ tool: "github_read", since: Date.parse("2026-11-04T03:02:08Z") }]);
    await expect(reading).rejects.toThrow(answeredReadText("github_read", 21 * 60_000));
    expect(read.signals[0]?.aborted).toBe(true);
    // The change is never answered for the crewmate: it runs on.
    expect(write.signals[0]?.aborted).toBe(false);
    await Promise.resolve();
    expect(wrote).toBe(false);
    expect(reads.answer(clock)).toEqual([]);
  });

  it("leaves a read that began after the quiet stretch's mark", async () => {
    let seq = 7;
    const reads = new OpenReads(Date.now, () => seq);
    const { githubRead } = stuckPair(reads);
    const first = githubRead.run({ path: "/repos/acme/shop/pulls" }, new AbortController().signal);
    seq = 8;
    const later = githubRead.run({ path: "/repos/acme/shop/issues" }, new AbortController().signal);

    // The home has taken event 7: only the read that began by then is answered.
    expect(reads.answer(7).map((read) => read.tool)).toEqual(["github_read"]);
    await expect(first).rejects.toThrow("Ask for it again");
    expect(reads.answer(7)).toEqual([]);
    expect(reads.answer(8)).toHaveLength(1);
    await expect(later).rejects.toThrow("Ask for it again");
  });
});
