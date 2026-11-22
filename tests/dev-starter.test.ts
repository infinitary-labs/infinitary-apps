import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type DevStarterDeps, runDevStarter } from "../scripts/dev-starter.ts";
import {
  markStarted,
  readStarterSession,
  requestSourceUpdate,
  type StarterSession,
} from "../src/core/update/devStarter.ts";
import { scratchDir } from "./helpers/scratchDirs";

// INF-5635's approved plan, piece 2: pnpm dev's starter moves the copy
// forward to the commit the app asked for, runs pnpm install only when the
// packages changed, starts the app again, and goes back to the commit
// before when the new one does not install, build or start.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();

/** A copy on its first commit, with main's next commit already fetched, as the app's check leaves it. */
function copyBehind(nextChangesPackages: boolean) {
  const copy = join(scratchDir("infinitary-dev-starter-"), "copy");
  run(process.cwd(), "init", "--quiet", "--initial-branch=main", copy);
  writeFileSync(join(copy, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(copy, "README.md"), "one\n");
  run(copy, "add", ".");
  run(copy, "commit", "--quiet", "-m", "first");
  const from = run(copy, "rev-parse", "HEAD");
  run(copy, "checkout", "--quiet", "-b", "next");
  writeFileSync(join(copy, "README.md"), "two\n");
  if (nextChangesPackages)
    writeFileSync(join(copy, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");
  run(copy, "commit", "--quiet", "-am", "second");
  const to = run(copy, "rev-parse", "HEAD");
  run(copy, "checkout", "--quiet", "main");
  return { copy, from, to };
}

type App = (session: string, seen: StarterSession) => number;

/** The starter over a real copy, with stand-ins for the app, pnpm install and predev. */
async function starter(
  copy: string,
  apps: App[],
  steps: { install?: number[]; prepare?: number[] } = {},
) {
  const session = scratchDir("infinitary-dev-session-");
  const seen: StarterSession[] = [];
  const ran: string[] = [];
  const said: string[] = [];
  const install = [...(steps.install ?? [])];
  const prepare = [...(steps.prepare ?? [])];
  const deps: DevStarterDeps = {
    root: copy,
    session,
    git: async (args) =>
      (await promisify(execFile)("git", ["-C", copy, ...args], { env: GIT_ENV })).stdout,
    install: async () => {
      ran.push("install");
      return install.shift() ?? 0;
    },
    prepare: async () => {
      ran.push("prepare");
      return prepare.shift() ?? 0;
    },
    start: async () => {
      const read = readStarterSession(session);
      if (!read) throw new Error("the app started without a session to read");
      seen.push(read);
      ran.push("start");
      const app = apps.shift();
      if (!app) throw new Error("the starter started the app more often than the test expects");
      return app(session, read);
    },
    say: (line) => said.push(line),
    stopping: () => false,
  };
  const code = await runDevStarter(deps);
  return { code, seen, ran, said, head: run(copy, "rev-parse", "HEAD") };
}

/** An app that reaches its main process and asks for an update to `to`. */
const asksUpdate =
  (to: string): App =>
  (session, seen) => {
    markStarted(session);
    requestSourceUpdate(session, { from: seen.commit, to });
    return 0;
  };
/** An app that reaches its main process and is closed by the person. */
const closes: App = (session) => {
  markStarted(session);
  return 0;
};
/** A build that fails before the app's main process loads. */
const failsToBuild: App = () => 1;

describe("pnpm dev's starter", () => {
  it("ends with the app's own code when the app asks for no update", async () => {
    const { copy, from } = copyBehind(false);
    const ended = await starter(copy, [() => 3]);
    expect(ended).toMatchObject({ code: 3, ran: ["start"], head: from });
    expect(ended.seen[0]).toMatchObject({ root: copy, commit: from, edited: false });
    expect(ended.seen[0]?.last).toBeUndefined();
  });

  it("moves forward and starts again without installing when the packages did not change", async () => {
    const { copy, to } = copyBehind(false);
    const ended = await starter(copy, [asksUpdate(to), closes]);
    expect(ended).toMatchObject({ code: 0, ran: ["start", "prepare", "start"], head: to });
    expect(ended.seen[1]).toMatchObject({
      commit: to,
      last: { outcome: "updated", to, installed: false },
    });
  });

  it("runs pnpm install when the lockfile changed, and the next start sees its new digest", async () => {
    const { copy, to } = copyBehind(true);
    const ended = await starter(copy, [asksUpdate(to), closes]);
    expect(ended).toMatchObject({ ran: ["start", "install", "prepare", "start"], head: to });
    expect(ended.seen[1]?.last).toMatchObject({ outcome: "updated", installed: true });
    expect(ended.seen[1]?.lockDigest).not.toBe(ended.seen[0]?.lockDigest);
  });

  it("goes back to the commit before when the new one does not start, and says why on the next start", async () => {
    const { copy, from, to } = copyBehind(true);
    const ended = await starter(copy, [asksUpdate(to), failsToBuild, closes]);
    expect(ended).toMatchObject({
      code: 0,
      // Going back reinstalls the old commit's packages and prepares it again.
      ran: ["start", "install", "prepare", "start", "install", "prepare", "start"],
      head: from,
    });
    expect(ended.seen[2]).toMatchObject({
      commit: from,
      last: { outcome: "went-back", from, to, step: "build" },
    });
  });

  it("goes back when the new commit's packages do not install", async () => {
    const { copy, from, to } = copyBehind(true);
    const ended = await starter(copy, [asksUpdate(to), closes], { install: [1, 0] });
    expect(ended).toMatchObject({ head: from });
    expect(ended.seen[1]?.last).toEqual({ outcome: "went-back", from, to, step: "install" });
  });

  it("goes back when preparing the new commit's build fails", async () => {
    const { copy, from, to } = copyBehind(false);
    const ended = await starter(copy, [asksUpdate(to), closes], { prepare: [1, 0] });
    expect(ended).toMatchObject({ ran: ["start", "prepare", "prepare", "start"], head: from });
    expect(ended.seen[1]?.last).toEqual({ outcome: "went-back", from, to, step: "build" });
  });

  it("moves nothing when the copy was edited after the update was offered", async () => {
    const { copy, from, to } = copyBehind(false);
    const editsThenAsks: App = (session, seen) => {
      writeFileSync(join(copy, "README.md"), "my own edit\n");
      return asksUpdate(to)(session, seen);
    };
    const ended = await starter(copy, [editsThenAsks, closes]);
    expect(ended).toMatchObject({ ran: ["start", "start"], head: from });
    expect(ended.seen[1]).toMatchObject({
      edited: true,
      last: { outcome: "went-back", from, to, step: "move" },
    });
  });

  it("starts an app that crashes after it started again on the new commit, without going back", async () => {
    const { copy, to } = copyBehind(false);
    const crashesAfterStart: App = (session) => {
      markStarted(session);
      return 1;
    };
    const ended = await starter(copy, [asksUpdate(to), crashesAfterStart]);
    expect(ended).toMatchObject({ code: 1, head: to });
  });
});
