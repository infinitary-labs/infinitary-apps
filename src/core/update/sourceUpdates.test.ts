import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as m from "@shared/i18n/messages.generated";
import { UPDATE_LATER, UPDATE_PROBLEMS } from "@shared/updateWords";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { StarterSession } from "./devStarter";
import { compareUrlOf, createSourceUpdateChecker } from "./sourceUpdates";
import { type CrewWorkForUpdate, createUpdateSaving } from "./updateWork";

// The product's git runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// INF-5635's approved plan, piece 2: a copy run by pnpm dev's starter offers
// Update and restart when main has newer commits and the copy is clean and
// can move forward, and says why otherwise; the update saves the crew's work
// before it asks the starter, as an installed update does.

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();

/** A project where it lives (a bare repository) and the person's own clone of main. */
function project() {
  const base = scratchDir("infinitary-source-update-");
  const seed = join(base, "seed");
  run(base, "init", "--quiet", "--initial-branch=main", seed);
  writeFileSync(join(seed, "README.md"), "one\n");
  run(seed, "add", ".");
  run(seed, "commit", "--quiet", "-m", "first");
  const remote = join(base, "remote.git");
  run(base, "clone", "--quiet", "--bare", seed, remote);
  const copy = join(base, "copy");
  run(base, "clone", "--quiet", remote, copy);
  /** A newer commit on main where the project lives. */
  const advance = (text: string) => {
    writeFileSync(join(seed, "README.md"), text);
    run(seed, "commit", "--quiet", "-am", text.trim());
    run(seed, "push", "--quiet", remote, "main");
    return run(seed, "rev-parse", "HEAD");
  };
  return { base, copy, remote, advance };
}

function checker(
  copy: string,
  options: { work?: CrewWorkForUpdate; last?: StarterSession["last"] } = {},
) {
  const starterDir = scratchDir("infinitary-starter-");
  const session: StarterSession = {
    root: copy,
    commit: run(copy, "rev-parse", "HEAD"),
    edited: false,
    lockDigest: "",
    ...(options.last ? { last: options.last } : {}),
  };
  const end = vi.fn();
  const updates = createSourceUpdateChecker({
    starterDir,
    session,
    channel: () => "alpha",
    saving: createUpdateSaving(options.work),
    end,
    openExternal: () => undefined,
  });
  const request = () => {
    const path = join(starterDir, "update.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  };
  return { updates, end, request };
}

describe("a copy run from source", () => {
  it("is up to date when main has nothing newer", async () => {
    const { copy } = project();
    const status = await checker(copy).updates.checkNow();
    expect(status).toMatchObject({
      currentVersion: run(copy, "rev-parse", "--short=7", "HEAD"),
      updateAvailable: false,
      notice: m.updateSourceUpToDate({ branch: "main" }),
      source: { branch: "main", behind: 0 },
    });
    expect(status.install).toBeUndefined();
  });

  it("offers Update and restart for main's newer commits, naming how many", async () => {
    const { copy, advance } = project();
    advance("two\n");
    const target = advance("three\n");
    const status = await checker(copy).updates.checkNow();
    expect(status).toMatchObject({
      updateAvailable: true,
      latestVersion: target.slice(0, 7),
      install: { asksPassword: false, restarts: true },
      source: { branch: "main", behind: 2 },
    });
    expect(status.source?.held).toBeUndefined();
  });

  it("offers no update over edits that are not committed, and says so", async () => {
    const { copy, advance } = project();
    advance("two\n");
    writeFileSync(join(copy, "README.md"), "my own edit\n");
    const status = await checker(copy).updates.checkNow();
    expect(status).toMatchObject({ updateAvailable: true, source: { behind: 1, held: "edited" } });
    expect(status.install).toBeUndefined();
  });

  it("offers no update over a commit main does not have, and says so", async () => {
    const { copy, advance } = project();
    advance("two\n");
    writeFileSync(join(copy, "notes.md"), "mine\n");
    run(copy, "add", ".");
    run(
      copy,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "mine",
    );
    const status = await checker(copy).updates.checkNow();
    expect(status).toMatchObject({ updateAvailable: true, source: { behind: 1, held: "ahead" } });
    expect(status.install).toBeUndefined();
  });

  it("says why a copy on no branch, or on a branch that follows none, cannot update", async () => {
    const { copy } = project();
    run(copy, "checkout", "--quiet", "--detach");
    expect((await checker(copy).updates.checkNow()).problem).toBe(m.updateSourceDetached());
    run(copy, "checkout", "--quiet", "-b", "local");
    expect((await checker(copy).updates.checkNow()).problem).toBe(
      m.updateSourceNoUpstream({ branch: "local" }),
    );
  });

  it("says a check that cannot reach where the project lives failed", async () => {
    const { copy, remote } = project();
    const { updates } = checker(copy);
    run(copy, "remote", "set-url", "origin", `${remote}-gone`);
    const status = await updates.checkNow();
    expect(status).toMatchObject({ phase: "error", problem: UPDATE_PROBLEMS.checkFailed });
  });

  it("saves the crew's work, then asks the starter for the newest commit and ends", async () => {
    const { copy, advance } = project();
    const from = run(copy, "rev-parse", "HEAD");
    const to = advance("two\n");
    const order: string[] = [];
    const work: CrewWorkForUpdate = {
      save: async () => {
        order.push("saved");
        return "saved";
      },
      release: () => order.push("released"),
      resuming: () => [],
    };
    const { updates, end, request } = checker(copy, { work });
    end.mockImplementation(() => order.push(request() ? "ended after the request" : "ended"));
    expect(await updates.install()).toEqual({ ok: true });
    expect(order).toEqual(["saved", "ended after the request"]);
    expect(request()).toEqual({ from, to });
  });

  it("asks the starter nothing when Update later lets the update go", async () => {
    const { copy, advance } = project();
    advance("two\n");
    let asked = false;
    const work: CrewWorkForUpdate = {
      save: ({ signal, waiting }) =>
        new Promise((resolve) => {
          waiting(["Release notes"]);
          asked = true;
          signal.addEventListener("abort", () => resolve("withdrawn"));
        }),
      release: () => undefined,
      resuming: () => [],
    };
    const { updates, end, request } = checker(copy, { work });
    const pressed = updates.install();
    await vi.waitFor(() => expect(asked).toBe(true));
    expect((await updates.getStatus()).work).toEqual({ state: "saving", tasks: ["Release notes"] });
    await updates.later?.();
    expect(await pressed).toEqual({ ok: false, later: true, problem: UPDATE_LATER });
    expect(request()).toBeNull();
    expect(end).not.toHaveBeenCalled();
  });

  it("says an update that went back, beside main's commits it still lacks", async () => {
    const { copy, advance } = project();
    const from = run(copy, "rev-parse", "HEAD");
    const to = advance("two\n");
    const { updates } = checker(copy, { last: { outcome: "went-back", from, to, step: "build" } });
    const status = await updates.checkNow();
    expect(status.problem).toBe(
      m.updateSourceBuildFailed({ from: from.slice(0, 7), to: to.slice(0, 7) }),
    );
    expect(status.install).toEqual({ asksPassword: false, restarts: true });
  });
});

describe("the page comparing two commits", () => {
  it("is GitHub's for a project that lives there, by either address, and none elsewhere", () => {
    for (const remote of [
      "https://github.com/owner/project.git",
      "git@github.com:owner/project.git",
      "ssh://git@github.com/owner/project",
    ])
      expect(compareUrlOf(remote, "aaa", "bbb")).toBe(
        "https://github.com/owner/project/compare/aaa...bbb",
      );
    expect(compareUrlOf("https://gitlab.com/owner/project.git", "aaa", "bbb")).toBeNull();
  });
});
