import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeOnComputer } from "../../../tests/helpers/computerClaude";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createKeyIdentity } from "../devices/identity";
import { JoinedHome } from "../devices/joinedHome";
import { HOME_ARRIVING_DIR } from "../homeMove/arriving";
import { git } from "../workspace/git";
import { type BackgroundContext, readInstalled, startInBackground } from "./background";
import { cleanUp, LEFT_CLAUDE_LOGIN } from "./cleanUp";
import { HomeRoute } from "./route";
import { WorkingCopies } from "./workingCopies";

/**
 * What a computer that runs work takes away once its home removed it
 * (docs/helper.md, "Removed"): everything Firstmate set up - sign-ins,
 * clones, working copies, the conversations, the fetched app and the
 * background agent - and nothing else, but a working copy that still holds
 * unmerged work stays with its clone. What it cannot remove yet stops
 * nothing else, and is kept on the left note with the agent for the next
 * try. Real git on a real project; launchctl is a stand-in that writes down
 * what it was asked.
 */

// Real git: clones and working copies.
vi.setConfig({ testTimeout: 30_000 });

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** Folders a test made read-only, made writable again so their scratch folder can go. */
const readOnly: string[] = [];
afterEach(() => {
  for (const dir of readOnly.splice(0)) if (existsSync(dir)) chmodSync(dir, 0o755);
});

/** The note of the home that removed it, as a removal that has begun writes it. */
function removedBy(dataDir: string): JoinedHome {
  const joinedHome = new JoinedHome(dataDir, () => {});
  joinedHome.leave({ name: "MacBook Pro", reason: "removed", at: 1_000 }, []);
  return joinedHome;
}

/**
 * The home's SSH connection renewing the route from its own process
 * (`work connect --from-home`, `HomeRoute.publish`), caught between reading
 * the route and writing it back: it holds the route's write lock, and writes
 * what it read once the removal returns, or after a second while the removal
 * waits on it, then lets the lock go.
 */
async function renewalUnderWay(dataDir: string) {
  const route = new HomeRoute(dataDir);
  const generation = route.begin();
  route.publish(generation, {
    socket: "/tmp/infinitary-r-test/s",
    homeKey: createKeyIdentity("The home").pin,
    deviceId: "studio",
  });
  const read = readFileSync(join(dataDir, "route.json"), "utf8");
  const removed = new Int32Array(new SharedArrayBuffer(4));
  const renewal = new Worker(
    `const { closeSync, openSync, rmSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { parentPort, workerData } = require("node:worker_threads");
    const lock = join(workerData.dataDir, "route.lock");
    closeSync(openSync(lock, "wx", 0o600));
    parentPort.postMessage("holding");
    Atomics.wait(new Int32Array(workerData.removed), 0, 0, 1_000);
    writeFileSync(join(workerData.dataDir, "route.json"), workerData.read, { mode: 0o600 });
    rmSync(lock, { force: true });`,
    { eval: true, workerData: { dataDir, read, removed: removed.buffer } },
  );
  const ended = once(renewal, "exit");
  await once(renewal, "message");
  return {
    /** Lets it write, once the removal returned, and waits for it to end. */
    finish: async () => {
      Atomics.store(removed, 0, 1);
      Atomics.notify(removed, 0);
      await ended;
    },
  };
}

async function project(): Promise<string> {
  const root = scratchDir("infinitary-cleanup-project-");
  const origin = join(root, "origin.git");
  await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const seed = join(root, "seed");
  await git(root, ["clone", "--quiet", origin, seed]);
  writeFileSync(join(seed, "README.md"), "# website\n");
  // Its build folder is ignored, as most projects' is.
  writeFileSync(join(seed, ".gitignore"), "build/\n");
  await commitAll(seed, "chore: start");
  await git(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  return origin;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ["add", "-A"]);
  await git(dir, [
    "-c",
    "user.name=Crewmate",
    "-c",
    "user.email=crew@localhost",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

/** A computer's data folder holding what Firstmate set up there, with its agent and a fetched app. */
async function computer() {
  const dataDir = scratchDir("infinitary-cleanup-");
  const asked: string[][] = [];
  const background: BackgroundContext = {
    flavor: "dev",
    dataDir,
    homeDir: scratchDir("infinitary-cleanup-home-"),
    uid: 502,
    launchctl: async (args) => {
      asked.push([...args]);
      return { ok: true, output: "" };
    },
  };
  const app = join(dataDir, "app", "Firstmate 3000.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  await startInBackground(background, {
    launcher: { executable: join(app, "Contents", "MacOS", "Firstmate 3000"), args: [] },
    env: {},
    app,
  });
  for (const folder of ["accounts", "forges", "pi-agent", "tasks", "bundles", HOME_ARRIVING_DIR])
    mkdirSync(join(dataDir, folder, "inside"), { recursive: true });
  for (const file of ["home.json", "left.json", "work.log", "service.log", "route.json"])
    writeFileSync(join(dataDir, file), "{}\n");
  mkdirSync(join(dataDir, "chromium"));
  writeFileSync(join(dataDir, "chromium", "Local State"), "{}");
  // A file the person put here is not Firstmate's to take.
  writeFileSync(join(dataDir, "notes.txt"), "kept\n");
  return { dataDir, background, asked, app, copies: new WorkingCopies(dataDir, { pool: false }) };
}

describe("removing what Firstmate set up on a computer that runs work", () => {
  it("takes away its sign-ins, clones, working copies, the fetched app and the agent, and nothing else", async () => {
    const origin = await project();
    const at = await computer();
    await at.copies.prepare("t-clean", { origin });
    const service = readInstalled(at.dataDir).service;
    expect(service && existsSync(service.file)).toBe(true);
    at.asked.length = 0;

    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [],
    });
    expect(readdirSync(at.dataDir).sort()).toEqual(["notes.txt"]);
    expect(readFileSync(join(at.dataDir, "notes.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(at.app)).toBe(false);
    expect(existsSync(service?.file ?? "")).toBe(false);
    expect(at.asked).toEqual([["bootout", `gui/502/${service?.label}`]]);
  });

  it("removes the route between the home's SSH connection's writes, so a renewal under way never writes it back", async () => {
    const at = await computer();
    const service = readInstalled(at.dataDir).service;
    const renewal = await renewalUnderWay(at.dataDir);

    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [],
    });
    await renewal.finish();
    // The renewal wrote first; the removal took the route after it.
    expect(readdirSync(at.dataDir).sort()).toEqual(["notes.txt"]);
    expect(existsSync(service?.file ?? "")).toBe(false);
  });

  it("leaves the route, with the agent, for the next try while a writer holds its lock past the wait, and that try finishes", async () => {
    const at = await computer();
    const joinedHome = removedBy(at.dataDir);
    const service = readInstalled(at.dataDir).service;
    // A writer that has not let go yet: a fresh lock, not one a dead writer left.
    const lock = join(at.dataDir, "route.lock");
    writeFileSync(lock, "");
    const route = join(at.dataDir, "route.json");

    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [],
      unremoved: [route],
    });
    expect(existsSync(route)).toBe(true);
    expect(existsSync(service?.file ?? "")).toBe(true);
    expect(joinedHome.unfinished()).toEqual([route]);

    rmSync(lock);
    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [],
    });
    expect(readdirSync(at.dataDir).sort()).toEqual(["notes.txt"]);
    expect(existsSync(service?.file ?? "")).toBe(false);
  });

  it("keeps the working-copy area and its clones when the area cannot be listed, and removes the rest", async () => {
    const at = await computer();
    const service = readInstalled(at.dataDir).service;
    writeFileSync(at.copies.worktreesDir, "not a directory\n");
    mkdirSync(join(at.dataDir, "repos"));
    writeFileSync(join(at.dataDir, "repos", "only-copy.txt"), "kept\n");
    expect(() => at.copies.has("t-protect")).toThrow();
    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [at.copies.worktreesDir],
      unreadable: [at.copies.worktreesDir],
    });
    expect(readFileSync(join(at.dataDir, "repos", "only-copy.txt"), "utf8")).toBe("kept\n");
    // Its sign-ins, the fetched app and the agent go all the same.
    for (const gone of ["accounts", "forges", "tasks", "app", "installed.json"])
      expect(existsSync(join(at.dataDir, gone)), gone).toBe(false);
    expect(existsSync(service?.file ?? "")).toBe(false);
  });

  it("removes a clean working copy holding a folder a build left read-only", async () => {
    const origin = await project();
    const at = await computer();
    const copy = await at.copies.prepare("t-clean", { origin });
    const cache = join(copy.dir, "build", "cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "artifact.bin"), "built\n");
    chmodSync(cache, 0o555);
    readOnly.push(cache);

    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [],
    });
    expect(existsSync(at.copies.worktreesDir)).toBe(false);
    expect(existsSync(join(at.dataDir, "repos"))).toBe(false);
  });

  it("goes on past what it cannot remove, keeps the agent and its copy for the next try, and that try finishes", async () => {
    const origin = await project();
    const at = await computer();
    const joinedHome = removedBy(at.dataDir);
    const busy = await at.copies.prepare("t-busy", { origin });
    writeFileSync(join(busy.dir, "notes.md"), "unmerged\n");
    const clean = await at.copies.prepare("t-clean", { origin });
    const service = readInstalled(at.dataDir).service;
    // Nothing can leave the working copies' own folder: the clean copy cannot go.
    chmodSync(at.copies.worktreesDir, 0o555);
    readOnly.push(at.copies.worktreesDir);
    at.asked.length = 0;

    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [busy.dir],
      unremoved: [clean.dir],
    });
    // Everything else went, its sign-ins too.
    for (const gone of ["accounts", "forges", "pi-agent", "tasks", "bundles"])
      expect(existsSync(join(at.dataDir, gone)), gone).toBe(false);
    // The agent, the copy it starts and their record stay, for its next run to finish it.
    expect(existsSync(at.app)).toBe(true);
    expect(existsSync(service?.file ?? "")).toBe(true);
    expect(readInstalled(at.dataDir)).toEqual({ service, app: at.app });
    expect(at.asked).toEqual([]);
    expect(joinedHome.unfinished()).toEqual([clean.dir]);

    // The folder is mended; the next try removes the copy it began on without
    // reading it again, and the agent last.
    chmodSync(at.copies.worktreesDir, 0o755);
    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [busy.dir],
    });
    expect(existsSync(clean.dir)).toBe(false);
    expect(readFileSync(join(busy.dir, "notes.md"), "utf8")).toBe("unmerged\n");
    expect(existsSync(at.app)).toBe(false);
    expect(existsSync(service?.file ?? "")).toBe(false);
    expect(existsSync(join(at.dataDir, "installed.json"))).toBe(false);
    expect(at.asked).toEqual([["bootout", `gui/502/${service?.label}`]]);
    expect(joinedHome.unfinished()).toBeNull();
    expect(joinedHome.left()).toEqual({ name: "MacBook Pro", reason: "removed", at: 1_000 });
  });

  it("removes a copy an earlier try began on, whole, though it can no longer be read", async () => {
    const origin = await project();
    const at = await computer();
    const busy = await at.copies.prepare("t-busy", { origin });
    writeFileSync(join(busy.dir, "notes.md"), "unmerged\n");
    const clean = await at.copies.prepare("t-clean", { origin });
    // What a try cut off part-way left: the copy without its history.
    new JoinedHome(at.dataDir, () => {}).leave(
      { name: "MacBook Pro", reason: "removed", at: 1_000 },
      [clean.dir],
    );
    writeFileSync(join(clean.dir, ".git"), `gitdir: ${join(at.dataDir, "missing")}\n`);

    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [busy.dir],
    });
    expect(existsSync(clean.dir)).toBe(false);
  });

  it("keeps unreadable work and its clone, reports why, and removes only the proven clean copy", async () => {
    const origin = await project();
    const at = await computer();
    await at.copies.prepare("t-clean", { origin });
    const copy = await at.copies.prepare("t-protect", { origin });
    writeFileSync(join(copy.dir, "only-copy.txt"), "only copy\n");
    const metadata = readFileSync(join(copy.dir, ".git"), "utf8");
    writeFileSync(join(copy.dir, ".git"), `gitdir: ${join(at.dataDir, "missing")}\n`);
    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [copy.dir],
      unreadable: [copy.dir],
    });
    expect(readFileSync(join(copy.dir, "only-copy.txt"), "utf8")).toBe("only copy\n");
    expect(existsSync(join(at.dataDir, "repos"))).toBe(true);
    expect(existsSync(at.copies.dir("t-clean"))).toBe(false);
    writeFileSync(join(copy.dir, ".git"), metadata);
    expect(await at.copies.status("t-protect")).toMatchObject({
      present: true,
      dirty: true,
      unlandedCommits: 0,
    });
    expect(await cleanUp({ dataDir: at.dataDir, background: null })).toEqual({ kept: [copy.dir] });
    expect(readFileSync(join(copy.dir, "only-copy.txt"), "utf8")).toBe("only copy\n");
  });

  it("keeps a working copy holding work that never came home, with its clone, and says where", async () => {
    const origin = await project();
    const at = await computer();
    await at.copies.prepare("t-clean", { origin });
    const busy = await at.copies.prepare("t-busy", { origin });
    writeFileSync(join(busy.dir, "notes.md"), "unmerged\n");
    await commitAll(busy.dir, "feat: notes");

    const { kept } = await cleanUp({ dataDir: at.dataDir, background: at.background });
    expect(kept).toEqual([busy.dir]);
    expect(existsSync(join(busy.dir, "notes.md"))).toBe(true);
    expect(existsSync(at.copies.dir("t-clean"))).toBe(false);
    expect(existsSync(join(at.dataDir, "repos"))).toBe(true);
    expect(existsSync(join(at.dataDir, "accounts"))).toBe(false);
    expect(existsSync(at.app)).toBe(false);
    // The kept copy is still a working copy of its clone.
    expect(await git(busy.dir, ["log", "-1", "--format=%s"])).toBe("feat: notes");
  });
  it("signs out the Claude login Firstmate made here, then removes the agent", async () => {
    const at = await computer();
    const claude = claudeOnComputer(at.dataDir, "made");
    await claude.signIn;
    const service = readInstalled(at.dataDir).service;

    expect(
      await cleanUp({
        dataDir: at.dataDir,
        background: at.background,
        signOutClaude: claude.signOutClaude,
      }),
    ).toEqual({ kept: [], claude: "signed-out" });
    expect(claude.seen.logouts).toBe(1);
    expect(claude.signedIn()).toBe(false);
    expect(existsSync(join(at.dataDir, LEFT_CLAUDE_LOGIN))).toBe(false);
    expect(existsSync(service?.file ?? "")).toBe(false);
  });

  it("leaves a Claude login that was here before Firstmate signed in to Claude", async () => {
    const at = await computer();
    const claude = claudeOnComputer(at.dataDir, "adopted");
    await claude.signIn;

    expect(
      await cleanUp({
        dataDir: at.dataDir,
        background: at.background,
        signOutClaude: claude.signOutClaude,
      }),
    ).toEqual({ kept: [], claude: "kept" });
    expect(claude.seen.logouts).toBe(0);
    expect(claude.signedIn()).toBe(true);
    expect(existsSync(join(at.dataDir, "accounts"))).toBe(false);
  });

  it("leaves the Claude login it made to the work's own run when it runs outside it, and that run signs it out and finishes", async () => {
    const at = await computer();
    const joinedHome = removedBy(at.dataDir);
    const claude = claudeOnComputer(at.dataDir, "made");
    await claude.signIn;
    const service = readInstalled(at.dataDir).service;
    at.asked.length = 0;

    // A command over Remote Login, outside this user's login session.
    expect(await cleanUp({ dataDir: at.dataDir, background: at.background })).toEqual({
      kept: [],
      claude: "later",
    });
    expect(claude.seen.logouts).toBe(0);
    expect(claude.signedIn()).toBe(true);
    // Its sign-ins are gone, but the record of the login and the agent stay for the run.
    expect(existsSync(join(at.dataDir, "accounts"))).toBe(false);
    const left = join(at.dataDir, LEFT_CLAUDE_LOGIN);
    expect(existsSync(left)).toBe(true);
    expect(existsSync(service?.file ?? "")).toBe(true);
    expect(at.asked).toEqual([]);
    expect(joinedHome.unfinished()).toEqual([left]);

    // The agent's run, in this user's login session, signs it out and finishes.
    expect(
      await cleanUp({
        dataDir: at.dataDir,
        background: at.background,
        signOutClaude: claude.signOutClaude,
      }),
    ).toEqual({ kept: [], claude: "signed-out" });
    expect(claude.seen.logouts).toBe(1);
    expect(claude.signedIn()).toBe(false);
    expect(existsSync(left)).toBe(false);
    expect(existsSync(service?.file ?? "")).toBe(false);
    expect(joinedHome.unfinished()).toBeNull();
  });
});
