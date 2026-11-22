import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { FoundTools } from "@shared/connection";
import { CLAUDE_CONTROL_PROFILE } from "../../src/core/claude/claudeQueryCore";
import { DevicePairing } from "../../src/core/devices/pairing";
import { helperWords } from "../../src/core/helper/words";
import { writeLoginShellStub } from "../../src/core/loginShellStub";
import { crewmatePlacedDir, crewmateSessionsDir } from "../../src/core/paths";
import { PI_CONTROL_PROFILE } from "../../src/core/pi/controlProfile";
import { couldNotStartOf, seedTask } from "../../src/core/tasks/seedTask";
import { git } from "../../src/core/workspace/git";
import { keptRefFor } from "../../src/core/workspace/workspaceService";
import { claimedPort } from "../helpers/claimedPort";
import { startPlacedHome } from "../helpers/placedHome";
import { scratchDir } from "../helpers/scratchDirs";
import {
  CLAUDE_CREW_PROMPT_MARKER,
  CLAUDE_STEER_MARKER,
  MOCK_CLAUDE_CARD_TITLE,
  MOCK_CLAUDE_HELD_PROGRESS,
  MOCK_CLAUDE_STEERED_REPORT,
} from "./crewScripts";
import { builtAppDir } from "./launch";
import { startMockProvider } from "./mockProvider";
import { endRunWork, homes, ME, pairings, providers, THIS_MAC, user, work } from "./runWork";
import {
  PLACED_CLAUDE_CONTROL_PROMPT,
  PLACED_CLAUDE_CONTROL_REPORT,
  placedClaudeBedrockFixture,
  placedClaudeControl,
} from "./scenarios/bedrock";
import { GIT_STATUS_PROMPT_MARKER, gitStatus, MOCK_GIT_REPORT_PREFIX } from "./scenarios/gitStatus";
import { MAC_ONLY_TAG } from "./tags";

/**
 * A task the home places on a computer that runs work (docs/helper.md): a
 * crewmate's turn runs there on Claude's boxed client while the home's
 * record and crew hold it, and a task in a project works in a working copy
 * the app cloned there, its unmerged work brought home before that copy is
 * deleted, with the app's own git where the Mac has none.
 */

test.afterEach(endRunWork);

test("a crewmate's turn runs on the app as a computer that runs work: the home holds it out of reach and catches up with nothing run twice", async () => {
  // The home is the home's own record, crew and connection, in this process;
  // the work is the built app as its own process, on Claude's client.
  const model = await startMockProvider({ scenarios: [gitStatus] });
  providers.push(model);
  const me = user(model);
  const userData = scratchDir("infinitary-run-work-home-");
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  const home = startPlacedHome({
    userData,
    port,
    pairing: () => pairing,
    now: Date.now,
    binding: { backend: "claude", accountId: "claude" },
    profiles: { pi: PI_CONTROL_PROFILE, claude: CLAUDE_CONTROL_PROFILE },
  });
  homes.push(home);
  await home.listen();
  const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
  await home.settled();
  expect(await work(["join", link], me.env, "yes\n").exited).toBe(0);
  const deviceId = pairing.list()[0]?.id ?? "";
  let running = work(["run"], me.env);
  await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  await expect.poll(() => home.placed.ready(deviceId, "none")).toBe(true);
  const progress = () =>
    home.tasks.timeline("t-rivets").filter((event) => event.kind === "progress").length;

  await test.step("a task placed there runs its turn there, and its card is made here", async () => {
    seedTask(home.tasks, {
      id: "t-rivets",
      title: "website",
      prompt: `Count the rivets ${CLAUDE_CREW_PROMPT_MARKER}.`,
      status: "queued",
      deviceId,
    });
    await home.supervisor.starts.dispatchQueuedTask("t-rivets");
    expect(home.tasks.get("t-rivets")).toMatchObject({ status: "active", deviceId });
    // The model's next step is held open there: the turn is mid-way.
    await expect.poll(() => model.heldRequests(), { timeout: 30_000 }).toBe(1);
    expect(home.supervisor.cards.openCardsFor("t-rivets").map((card) => card.title)).toEqual([
      MOCK_CLAUDE_CARD_TITLE,
    ]);
  });

  await test.step("out of reach, the home holds the task and the turn goes on there", async () => {
    await home.drop();
    await expect.poll(() => home.devices.inReach(deviceId)).toBe(false);
    expect(
      await home.supervisor.steer.steerCrewmate("t-rivets", `Please ${CLAUDE_STEER_MARKER}.`),
    ).toBe("recorded-held");
    // The model goes on there; its progress note waits for the home.
    model.releaseHeldCrew();
    await expect.poll(() => model.heldRequests()).toBe(0);
    expect(progress()).toBe(0);
  });

  await test.step("back in reach, it catches up: each callback once, the held words into the running turn", async () => {
    await home.listen();
    // The progress note that waited is answered, and the held words reach
    // the running turn at a next step the model is let take.
    await expect
      .poll(
        () => {
          if (model.heldRequests() > 0) model.releaseHeldCrew();
          return home.tasks.get("t-rivets")?.outcome;
        },
        { timeout: 30_000 },
      )
      .toBe(MOCK_CLAUDE_STEERED_REPORT);
    expect(progress()).toBeGreaterThanOrEqual(1);
    for (const event of home.tasks.timeline("t-rivets").filter((each) => each.kind === "progress"))
      expect(event.text).toBe(MOCK_CLAUDE_HELD_PROGRESS);
    // One effect per callback: every answer the home kept, once.
    const calls = readFileSync(
      join(crewmatePlacedDir(home.paths, "t-rivets"), "calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { callId: string; channel: string });
    expect(new Set(calls.map((call) => call.callId)).size).toBe(calls.length);
    expect(calls.filter((call) => call.channel === "inf:work:progress")).toHaveLength(progress());
    await expect
      .poll(() =>
        readdirSync(crewmateSessionsDir(home.paths, "t-rivets")).some((name) =>
          name.endsWith(".jsonl"),
        ),
      )
      .toBe(true);
  });

  await test.step("stopped once its sign-ins loaded, the app there ends cleanly, restarts, and nothing runs twice", async () => {
    const asked = model.requests();
    const outcome = home.tasks.get("t-rivets")?.outcome;
    const noted = progress();
    // Its own sign-ins loaded there, as a task routed there loads them.
    expect(await home.signIns.signInsOf(deviceId)).not.toBeNull();
    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);
    running = work(["run"], me.env);
    await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
    await expect.poll(() => home.placed.ready(deviceId, "t-rivets")).toBe(true);
    expect(model.requests()).toBe(asked);
    expect(home.tasks.get("t-rivets")?.outcome).toBe(outcome);
    expect(progress()).toBe(noted);
  });
});

test("a closed task with unreadable work history stays present and brings its work home after repair", async () => {
  // Where the project lives is a repository on this disk, and the home's
  // own clone of it is the project the home registered.
  const root = scratchDir("infinitary-run-work-project-");
  const origin = join(root, "origin.git");
  await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const website = join(root, "website");
  await git(root, ["clone", "--quiet", origin, website]);
  writeFileSync(join(website, "README.md"), "# website\n");
  const identity = ["-c", "user.name=Crewmate", "-c", "user.email=crew@localhost"];
  await git(website, ["add", "-A"]);
  await git(website, [...identity, "commit", "-q", "-m", "chore: start the website"]);
  await git(website, ["push", "--quiet", "origin", "HEAD:main"]);
  const main = await git(website, ["rev-parse", "HEAD"]);

  const model = await startMockProvider({ scenarios: [gitStatus] });
  providers.push(model);
  const me = user(model);
  const userData = scratchDir("infinitary-run-work-home-");
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  const home = startPlacedHome({
    userData,
    port,
    pairing: () => pairing,
    now: Date.now,
    binding: { backend: "claude", accountId: "claude" },
    profiles: { pi: PI_CONTROL_PROFILE, claude: CLAUDE_CONTROL_PROFILE },
  });
  homes.push(home);
  await home.listen();
  const { repo } = await home.repos.setup({ kind: "adopt", path: website });
  const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
  await home.settled();
  expect(await work(["join", link], me.env, "yes\n").exited).toBe(0);
  const deviceId = pairing.list()[0]?.id ?? "";
  const running = work(["run"], me.env);
  await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  await expect.poll(() => home.placed.ready(deviceId, "none")).toBe(true);
  const copy = join(me.dataDir, "worktrees", "t-tidy");

  await test.step("the app there clones the project, and the task's turn runs in its own working copy", async () => {
    seedTask(home.tasks, {
      id: "t-tidy",
      title: "website",
      prompt: "Tidy the readme.",
      status: "queued",
      repoId: repo.id,
      deviceId,
    });
    await home.supervisor.starts.dispatchQueuedTask("t-tidy");
    expect(home.tasks.get("t-tidy")).toMatchObject({
      status: "active",
      worktreeDir: "",
      workspaceState: "present",
    });
    const branch = home.tasks.get("t-tidy")?.branch ?? "";
    expect(branch).not.toBe("");
    expect(await git(copy, ["rev-parse", "HEAD"])).toBe(main);
    expect(await git(copy, ["symbolic-ref", "--short", "HEAD"])).toBe(branch);
    await expect.poll(() => home.tasks.get("t-tidy")?.activity, { timeout: 30_000 }).toBe("idle");
  });

  await test.step("unreadable work refuses retirement without changing the record, then recovers after repair", async () => {
    writeFileSync(join(copy, "only-copy.txt"), "unique work\n");
    const metadata = readFileSync(join(copy, ".git"), "utf8");
    writeFileSync(join(copy, ".git"), `gitdir: ${join(me.homeDir, "missing")}\n`);
    await home.supervisor.sessions.interruptCrewmate("t-tidy", "cancel");
    await expect(home.placed.bringHome(deviceId)).rejects.toThrow();
    expect(home.tasks.get("t-tidy")?.workspaceState).toBe("present");
    expect(readFileSync(join(copy, "only-copy.txt"), "utf8")).toBe("unique work\n");
    writeFileSync(join(copy, ".git"), metadata);
    await home.placed.bringHome(deviceId);
    expect(home.tasks.get("t-tidy")?.workspaceState).toBe("removed");
    const kept = await git(website, ["rev-parse", keptRefFor("t-tidy")]);
    const contents = await git(website, ["show", `${kept}:only-copy.txt`]);
    expect(contents).toBe("unique work");
    expect(existsSync(copy)).toBe(false);
    console.log(
      JSON.stringify({
        recovery: "work brought home after metadata repair",
        state: home.tasks.get("t-tidy")?.workspaceState,
        keptFile: contents,
      }),
    );
  });
});

test("a task in a project works in a working copy the app that runs work cloned, and its unmerged work comes home before that copy is deleted", async () => {
  // Where the project lives is a repository on this disk, and the home's
  // own clone of it is the project the home registered.
  const root = scratchDir("infinitary-run-work-project-");
  const origin = join(root, "origin.git");
  await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const website = join(root, "website");
  await git(root, ["clone", "--quiet", origin, website]);
  writeFileSync(join(website, "README.md"), "# website\n");
  const identity = ["-c", "user.name=Crewmate", "-c", "user.email=crew@localhost"];
  await git(website, ["add", "-A"]);
  await git(website, [...identity, "commit", "-q", "-m", "chore: start the website"]);
  await git(website, ["push", "--quiet", "origin", "HEAD:main"]);
  const main = await git(website, ["rev-parse", "HEAD"]);

  const model = await startMockProvider({ scenarios: [gitStatus] });
  providers.push(model);
  const me = user(model);
  const userData = scratchDir("infinitary-run-work-home-");
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  const home = startPlacedHome({
    userData,
    port,
    pairing: () => pairing,
    now: Date.now,
    binding: { backend: "claude", accountId: "claude" },
    profiles: { pi: PI_CONTROL_PROFILE, claude: CLAUDE_CONTROL_PROFILE },
  });
  homes.push(home);
  await home.listen();
  const { repo } = await home.repos.setup({ kind: "adopt", path: website });
  const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
  await home.settled();
  expect(await work(["join", link], me.env, "yes\n").exited).toBe(0);
  const deviceId = pairing.list()[0]?.id ?? "";
  const running = work(["run"], me.env);
  await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  await expect.poll(() => home.placed.ready(deviceId, "none")).toBe(true);
  const copy = join(me.dataDir, "worktrees", "t-tidy");

  await test.step("the app there clones the project, and the task's turn runs in its own working copy", async () => {
    seedTask(home.tasks, {
      id: "t-tidy",
      title: "website",
      prompt: "Tidy the readme.",
      status: "queued",
      repoId: repo.id,
      deviceId,
    });
    await home.supervisor.starts.dispatchQueuedTask("t-tidy");
    expect(home.tasks.get("t-tidy")).toMatchObject({
      status: "active",
      worktreeDir: "",
      workspaceState: "present",
    });
    const branch = home.tasks.get("t-tidy")?.branch ?? "";
    expect(branch).not.toBe("");
    expect(await git(copy, ["rev-parse", "HEAD"])).toBe(main);
    expect(await git(copy, ["symbolic-ref", "--short", "HEAD"])).toBe(branch);
    await expect.poll(() => home.tasks.get("t-tidy")?.activity, { timeout: 30_000 }).toBe("idle");
  });

  await test.step("closed, its work is kept there, comes home, and only then is the copy there deleted", async () => {
    writeFileSync(join(copy, "README.md"), "# website\n\nTidy.\n");
    await git(copy, ["add", "-A"]);
    await git(copy, [...identity, "commit", "-q", "-m", "docs: tidy the readme"]);
    writeFileSync(join(copy, "notes.txt"), "still thinking\n");
    await home.supervisor.sessions.interruptCrewmate("t-tidy", "cancel");
    await expect
      .poll(() => home.tasks.get("t-tidy")?.workspaceState, { timeout: 30_000 })
      .toBe("removed");
    expect(existsSync(copy)).toBe(false);
    const kept = await git(website, ["rev-parse", keptRefFor("t-tidy")]);
    expect(await git(website, ["show", `${kept}:notes.txt`])).toBe("still thinking");
    expect(await git(website, ["show", `${kept}:README.md`])).toContain("Tidy.");
  });
});

test("a Mac with no git of its own runs a project's work with the app's own git, and tells the home it has git", {
  tag: MAC_ONLY_TAG,
}, async () => {
  // Only the Mac app brings its own git (docs/forge.md, "The app's own git").
  test.skip(process.platform !== "darwin", "the app's own git is the Mac's");
  // A search path that holds no git at all - the system folders without
  // /usr/bin, whose `git` is Apple's prompt to install the developer tools -
  // and a login shell that adds nothing, as on a Mac that never had them.
  const NO_GIT_PATH = "/bin:/usr/sbin:/sbin";
  for (const dir of NO_GIT_PATH.split(":")) expect(existsSync(join(dir, "git"))).toBe(false);
  // The tree `pnpm install` vendored for this Mac (scripts/ensure-bundled-git.ts).
  const vendoredVersion = execFileSync(
    join(builtAppDir(), "vendor", "git", `darwin-${process.arch}`, "bin", "git"),
    ["--version"],
    { encoding: "utf8" },
  ).trim();
  const root = scratchDir("infinitary-run-work-project-");
  const origin = join(root, "origin.git");
  await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const website = join(root, "website");
  await git(root, ["clone", "--quiet", origin, website]);
  writeFileSync(join(website, "README.md"), "# website\n");
  const identity = ["-c", "user.name=Crewmate", "-c", "user.email=crew@localhost"];
  await git(website, ["add", "-A"]);
  await git(website, [...identity, "commit", "-q", "-m", "chore: start the website"]);
  await git(website, ["push", "--quiet", "origin", "HEAD:main"]);
  const main = await git(website, ["rev-parse", "HEAD"]);

  const model = await startMockProvider({ scenarios: [gitStatus] });
  providers.push(model);
  const me = user(model);
  const { shell } = writeLoginShellStub(scratchDir("infinitary-login-shell-"), {});
  const env = { ...me.env, PATH: NO_GIT_PATH, SHELL: shell };
  const userData = scratchDir("infinitary-run-work-home-");
  const port = await claimedPort();
  const found: (FoundTools | undefined)[] = [];
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    onJoined: (_device, tools) => found.push(tools),
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  const home = startPlacedHome({
    userData,
    port,
    pairing: () => pairing,
    now: Date.now,
    binding: { backend: "claude", accountId: "claude" },
    profiles: { pi: PI_CONTROL_PROFILE, claude: CLAUDE_CONTROL_PROFILE },
  });
  homes.push(home);
  await home.listen();
  const { repo } = await home.repos.setup({ kind: "adopt", path: website });

  await test.step("it joins and tells the home it has git", async () => {
    const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
    await home.settled();
    expect(await work(["join", link], env, "yes\n").exited).toBe(0);
    expect(found).toEqual([expect.objectContaining({ git: true })]);
  });

  const deviceId = pairing.list()[0]?.id ?? "";
  const running = work(["run"], env);
  await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  await expect.poll(() => home.placed.ready(deviceId, "none")).toBe(true);

  await test.step("it clones the project with its own git, and the crewmate's shell runs that git", async () => {
    seedTask(home.tasks, {
      id: "t-git",
      title: "website",
      prompt: `${GIT_STATUS_PROMPT_MARKER} in website.`,
      status: "queued",
      repoId: repo.id,
      deviceId,
    });
    await home.supervisor.starts.dispatchQueuedTask("t-git");
    expect(home.tasks.get("t-git")).toMatchObject({ status: "active" });
    const branch = home.tasks.get("t-git")?.branch ?? "";
    expect(branch).not.toBe("");
    const copy = join(me.dataDir, "worktrees", "t-git");
    expect(await git(copy, ["rev-parse", "HEAD"])).toBe(main);
    await expect
      .poll(() => home.tasks.get("t-git")?.outcome, { timeout: 45_000 })
      .toMatch(new RegExp(`^${MOCK_GIT_REPORT_PREFIX} ${vendoredVersion} on ## ${branch}`));
  });

  await test.step("closed, its unmerged work comes home through its own git", async () => {
    const copy = join(me.dataDir, "worktrees", "t-git");
    writeFileSync(join(copy, "README.md"), "# website\n\nWhich git.\n");
    await git(copy, ["add", "-A"]);
    await git(copy, [...identity, "commit", "-q", "-m", "docs: say which git"]);
    await home.supervisor.sessions.interruptCrewmate("t-git", "cancel");
    await expect
      .poll(() => home.tasks.get("t-git")?.workspaceState, { timeout: 30_000 })
      .toBe("removed");
    expect(existsSync(copy)).toBe(false);
    const kept = await git(website, ["rev-parse", keptRefFor("t-git")]);
    expect(await git(website, ["show", `${kept}:README.md`])).toContain("Which git.");
  });
});

test("placed Claude strips ambient AWS settings and refuses managed Bedrock (INF-3451)", async () => {
  const model = await startMockProvider({ scenarios: [placedClaudeControl] });
  providers.push(model);
  const me = user(model);
  const client = me.env.INFINITARY_CLAUDE_CLI;
  if (!client) throw new Error("Claude stand-in was not configured");
  const fixture = placedClaudeBedrockFixture(client);
  const env = { ...me.env, ...fixture.env };
  const userData = scratchDir("placed-bedrock-home-");
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  const home = startPlacedHome({
    userData,
    port,
    pairing: () => pairing,
    now: Date.now,
    binding: { backend: "claude", accountId: "claude" },
    profiles: { pi: PI_CONTROL_PROFILE, claude: CLAUDE_CONTROL_PROFILE },
  });
  homes.push(home);
  await home.listen();
  const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
  await home.settled();
  expect(await work(["join", link], env, "yes\n").exited).toBe(0);
  const deviceId = pairing.list()[0]?.id ?? "";
  const withWork = async (run: () => Promise<void>) => {
    const running = work(["run"], env);
    try {
      await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
      await expect.poll(() => home.placed.ready(deviceId, "none")).toBe(true);
      await run();
    } finally {
      model.releaseHeldCrew();
      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
    }
    await expect.poll(() => home.devices.inReach(deviceId)).toBe(false);
  };
  const start = async (id: string) => {
    seedTask(home.tasks, {
      id,
      title: id,
      prompt: PLACED_CLAUDE_CONTROL_PROMPT,
      status: "queued",
      deviceId,
    });
    await home.supervisor.starts.dispatchQueuedTask(id);
  };
  await withWork(async () => {
    await start("ambient-aws");
    await expect.poll(fixture.launches).toEqual([[]]);
    await expect
      .poll(() => home.tasks.get("ambient-aws")?.outcome)
      .toBe(PLACED_CLAUDE_CONTROL_REPORT);
    await expect.poll(() => home.tasks.get("ambient-aws")?.activity).toBe("idle");
  });
  for (const [mode, reason] of [
    ["bedrock", "send work to Amazon Bedrock"],
    ["unreadable-helper", "could not confirm"],
  ] as const) {
    fixture.setManaged(mode);
    await withWork(async () => {
      const requests = model.requests();
      const id = `managed-${mode}`;
      await start(id);
      await expect.poll(() => couldNotStartOf(home.tasks.get(id))).toContain(reason);
      expect(home.tasks.get(id)).toMatchObject({ status: "open", startedAt: null });
      expect(fixture.launches()).toEqual([[]]);
      expect(model.requests()).toBe(requests);
    });
  }
});
