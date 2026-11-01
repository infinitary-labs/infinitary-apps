import { describe, expect, it } from "vitest";
import { renderWake } from "../orchestrator/wakes";
import { type FreezeLine, freezeWake, infinitaryProject } from "./freezeRecorder";
import { isFreezeRecorderEnabled } from "./watchdog";

// INF-2066: the captain's answer on INF-2061's first mate question, "activate
// it only in alpha builds, and offer a fix task only if the canonical
// infinitary github repo is a project in the project list".

/** INF-2059's freeze as the recorder names it (INF-2061's lab reading). */
const OPEN_MESSAGES: FreezeLine = {
  at: "2026-10-31T07:12:04.512Z",
  wallMs: 1_020,
  cpuMs: 986,
  frames: [
    { name: "taskIdsWithRef", file: "index.js", line: 48213, column: 22 },
    { name: "askActedOn", file: "index.js", line: 51877, column: 15 },
    { name: "renderOpenAsks", file: "index.js", line: 52004, column: 9 },
  ],
};

const project = (id: string, origin: string | null) => ({ id, name: id, origin });

describe("whether a build runs the freeze recorder", () => {
  const env = {};
  it("runs in an alpha build", () => {
    expect(isFreezeRecorderEnabled({ packaged: true, version: "0.6.2-alpha.44", env })).toBe(true);
  });

  it("stays off in a stable build and an unpackaged run", () => {
    expect(isFreezeRecorderEnabled({ packaged: true, version: "0.6.1", env })).toBe(false);
    expect(isFreezeRecorderEnabled({ packaged: false, version: "0.6.2-alpha.44", env })).toBe(
      false,
    );
  });

  it("runs where the run turns it on, for a journey that reads the record", () => {
    expect(
      isFreezeRecorderEnabled({
        packaged: false,
        version: "0.1.30",
        env: { INFINITARY_FREEZE_RECORDER: "1" },
      }),
    ).toBe(true);
  });
});

describe("the project a freeze's fix goes to", () => {
  it("is the captain's project that lives at Infinitary's own source", () => {
    const own = project("infinitary", "https://github.com/infinitary-labs/infinitary");
    expect(infinitaryProject([project("meter", "https://github.com/acme/meter"), own])).toBe(own);
    const ssh = project("inf", "git@github.com:Infinitary-Labs/infinitary.git");
    expect(infinitaryProject([ssh])).toBe(ssh);
  });

  it("is none when no project lives there, such as a fork or a project kept on this Mac", () => {
    expect(
      infinitaryProject([
        project("fork", "https://github.com/someone/infinitary"),
        project("local", null),
        project("tap", "https://github.com/infinitary-labs/homebrew-tap"),
      ]),
    ).toBeUndefined();
  });
});

describe("the first mate's wake about a recorded freeze", () => {
  const own = { id: "infinitary", name: "infinitary" };

  it("names the freeze, its call path and the project, and offers a fix task on the captain's choice", () => {
    const text = renderWake(freezeWake(OPEN_MESSAGES, own));
    expect(text).toContain("1020 ms");
    expect(text).toContain("986 ms of that was the main thread's own processor time");
    expect(text).toContain(
      "taskIdsWithRef (index.js:48213:22) <- askActedOn (index.js:51877:15) <- renderOpenAsks (index.js:52004:9)",
    );
    expect(text).toContain('project "infinitary" (repo_id infinitary)');
    expect(text).toContain("offer a fix task in that project on a decision card");
    expect(text).not.toContain("uncertain");
  });

  it("says when a wait's names are uncertain", () => {
    const wait = { ...OPEN_MESSAGES, cpuMs: 5, uncertain: "waited" as const };
    expect(renderWake(freezeWake(wait, own))).toContain("These names are uncertain");
  });

  it("goes out once per call path, so the same freeze recurring is not new", () => {
    const again = freezeWake(
      { ...OPEN_MESSAGES, at: "2026-10-31T07:13:04.512Z", wallMs: 1_400 },
      own,
    );
    expect(again.once).toBe(freezeWake(OPEN_MESSAGES, own).once);
    const other = freezeWake(
      { ...OPEN_MESSAGES, frames: [{ name: "hashFile", file: "index.js", line: 9, column: 3 }] },
      own,
    );
    expect(other.once).not.toBe(freezeWake(OPEN_MESSAGES, own).once);
  });
});
