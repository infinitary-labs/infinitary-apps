import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import electronPath from "electron";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { readInstalled } from "../../src/core/helper/background";
import { helperWords } from "../../src/core/helper/words";
import { WorkingCopies } from "../../src/core/helper/workingCopies";
import { HERE } from "../../src/shared/deviceNames";
import { builtAppDir } from "./launch";
import { endRunWork, home, ME, THIS_MAC, user, work } from "./runWork";
import { seedRetainedAccountDirectory } from "./workFixtures";

/**
 * The app runs work for another Mac's Firstmate with no window
 * (docs/helper.md), as a person starts it from Terminal: the built app
 * itself, started as `<app> work ...` as its own process, joins a home with
 * a link and a typed yes, stays in reach of it, refuses a second run, stops
 * on a signal, and ends when the home removes it. The home here is the
 * real pairing and connection in this test's own process, on loopback, so
 * the app is on the home's own Mac; the home stands in another macOS user
 * for itself, as it is when the work runs as another user here, except
 * where the journey is the refusal to run as the home's own user.
 */

test.afterEach(endRunWork);

/**
 * The home and computer a home starting the work mode over Remote Login
 * names, which it checks before it touches anything: the ones its folder joined.
 */
function expectedHome(dataDir: string): string[] {
  const grant = new JoinedHome(dataDir).read()?.grant;
  if (!grant) throw new Error("Nothing joined there.");
  return ["--home", grant.homeKey, "--device", grant.deviceId];
}

/**
 * The processes Chromium started beside a running app's own, by type:
 * graphics (`gpu-process`), network (`utility`) and the like. Linux's
 * zygote, which Chromium forks at every start to start any page later from,
 * is not one of them.
 */
function chromiumProcesses(pid: number | undefined): string[] {
  return execFileSync("ps", ["-A", "-o", "ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((row) => row.trim().match(/^(\d+)\s.*--type=(\S+)/))
    .flatMap((match) => (match && Number(match[1]) === pid ? [match[2] ?? ""] : []))
    .filter((type) => type !== "zygote");
}

test("the app joins a home from Terminal with a typed yes, runs its work with no window, and ends when removed", async () => {
  const at = await home(ME.uid + 1);
  const me = user();

  await test.step("it says its version", async () => {
    const version = work(["version"], me.env);
    expect(await version.exited, version.error()).toBe(0);
    expect(version.lines()).toEqual([
      expect.stringMatching(/^Infinitary \d+\.\d+\.\d+ · contract /),
    ]);
  });

  await test.step("it joins only once the person types yes, as its own macOS user", async () => {
    const no = work(["join", await at.link()], me.env, "no\n");
    expect(await no.exited).toBe(1);
    expect(at.pairing.list()).toEqual([]);

    const yes = work(["join", await at.link()], me.env, "yes\n");
    expect(await yes.exited).toBe(0);
    expect(yes.lines().slice(-2)).toEqual(
      helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
    );
    expect(at.pairing.list()).toEqual([
      expect.objectContaining({ kind: "work", user: ME.name, onThisMac: true }),
    ]);
    expect(new JoinedHome(me.dataDir).read()).toMatchObject({ name: "MacBook Pro" });
  });

  await test.step("it sets itself to run in the background as this user, from this app", async () => {
    const { label, file, holds, started } = me.background;
    expect(me.managerAsked()).toEqual(started);
    expect(readInstalled(me.dataDir)).toEqual({ service: { label, file }, app: null });
    const agent = readFileSync(file, "utf8");
    for (const word of [electronPath as unknown as string, builtAppDir(), "work", "run"])
      expect(agent).toContain(holds(word));
  });

  const running = work(["run"], me.env);
  await test.step("it stays in reach as one process, and a second one is refused", async () => {
    await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
    // Nothing is drawn and the connection is Node's own, so Chromium starts
    // no graphics or network process beside it (docs/helper.md).
    expect(chromiumProcesses(running.child.pid)).toEqual([]);
    const second = work(["run"], me.env);
    expect(await second.exited).toBe(1);
    expect(second.lines()).toEqual(helperWords.busy);
  });

  await test.step("the home removes it, and it ends, forgets the grant and removes what was set up", async () => {
    const [device] = at.pairing.list();
    at.pairing.remove(device?.id ?? "");
    expect(await running.exited).toBe(0);
    expect(running.lines().slice(-3)).toEqual([
      ...helperWords.removed(THIS_MAC, "MacBook Pro"),
      ...helperWords.cleanedUp([]),
    ]);
    expect(new JoinedHome(me.dataDir).read()).toBeNull();
    expect(existsSync(me.background.file)).toBe(false);
    expect(me.managerAsked().slice(-me.background.removed.length)).toEqual(me.background.removed);
  });
});

test("the home's address changes: a new command finds it as the same computer, and after the home removed it joins it anew", async () => {
  const at = await home(ME.uid + 1);
  const me = user();
  /** `<app> work run` as the service manager starts it, which the stand-in's stop ends. */
  const agent = () => {
    const run = work(["run"], me.env);
    writeFileSync(me.agentPid, `${run.child.pid}\n`);
    return run;
  };
  const joined = work(["join", await at.link()], me.env, "yes\n");
  expect(await joined.exited).toBe(0);
  const [device] = at.pairing.list();
  const first = agent();
  await expect.poll(first.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);

  await test.step("stranded where the home was, a new command finds it where it is now", async () => {
    await at.move();
    await expect
      .poll(() => first.lines().at(-1))
      .toBe(helperWords.quit(THIS_MAC, "MacBook Pro")[0]);
    const asked = me.managerAsked().length;
    // It asks nothing: this user already runs that home's work.
    const again = work(["join", await at.link()], me.env);
    expect(await again.exited).toBe(0);
    expect(again.lines()).toEqual(
      helperWords.foundAgain(THIS_MAC, "MacBook Pro", ME.name, "running"),
    );
    // The run the background started stopped first, and the background started again.
    expect(await first.exited).toBe(0);
    expect(me.managerAsked().slice(asked)).toEqual([
      ...me.background.paused,
      ...me.background.started,
    ]);
    // The same computer on the home's list, dialing where the home is now.
    expect(at.pairing.list()).toEqual([device]);
    expect(new JoinedHome(me.dataDir).read()?.grant).toMatchObject({
      at: at.at(),
      deviceId: device?.id,
    });
    const back = agent();
    await expect.poll(back.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  });

  await test.step("removed there while out of reach, a new command removes what was set up here and joins it anew", async () => {
    await at.move();
    at.pairing.remove(device?.id ?? "", { farewell: true });
    const anew = work(["join", await at.link()], me.env, "yes\n");
    expect(await anew.exited).toBe(0);
    expect(anew.lines()).toEqual([
      ...helperWords.removedEarlier(THIS_MAC, "MacBook Pro"),
      ...helperWords.cleanedUp([]),
      ...helperWords.ask(THIS_MAC, ME.name, process.platform),
      `${helperWords.prompt}yes`,
      ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
    ]);
    const [listed] = at.pairing.list();
    expect(listed?.id).not.toBe(device?.id);
    expect(new JoinedHome(me.dataDir).read()?.grant).toMatchObject({
      at: at.at(),
      deviceId: listed?.id,
    });
  });
});

test("its home gone for good, a new home's command asks to leave it, and on a yes leaves as a removal would, keeping unmerged work", async () => {
  const gone = await home(ME.uid + 1);
  const me = user();
  /** `<app> work run` as the service manager starts it, which the stand-in's stop ends. */
  const agent = () => {
    const run = work(["run"], me.env);
    writeFileSync(me.agentPid, `${run.child.pid}\n`);
    return run;
  };
  expect(await work(["join", await gone.link()], me.env, "yes\n").exited).toBe(0);
  const joined = new JoinedHome(me.dataDir).read();
  const copies = new WorkingCopies(me.dataDir, { pool: false });
  const { dir } = await copies.prepare("t-unmerged", undefined);
  writeFileSync(join(dir, "only-copy.txt"), "unique uncommitted work\n");
  seedRetainedAccountDirectory(me.dataDir);
  const first = agent();
  await expect.poll(first.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  await gone.gone();
  await expect.poll(() => first.lines().at(-1)).toBe(helperWords.quit(THIS_MAC, "MacBook Pro")[0]);
  const at = await home(ME.uid + 1);
  // Both homes are on this Mac, so the one it leaves is an earlier Firstmate here.
  const from = helperWords.earlierHome(THIS_MAC);
  const question = [
    ...helperWords.askLeave(from),
    ...helperWords.ask(THIS_MAC, ME.name, process.platform),
  ];

  await test.step("without a yes nothing changes, and its run keeps trying", async () => {
    const no = work(["join", await at.link()], me.env, "no\n");
    expect(await no.exited).toBe(1);
    expect(no.lines()).toEqual([...question, `${helperWords.prompt}no`, ...helperWords.declined]);
    expect(at.pairing.list()).toEqual([]);
    expect(new JoinedHome(me.dataDir).read()).toEqual(joined);
    expect(existsSync(join(me.dataDir, "accounts", "codex"))).toBe(true);
    expect(first.child.exitCode).toBeNull();
  });

  await test.step("on a yes it leaves as a removal would, keeps the unmerged work, and joins the new home", async () => {
    const asked = me.managerAsked().length;
    const yes = work(["join", await at.link()], me.env, "yes\n");
    expect(await yes.exited).toBe(0);
    expect(yes.lines()).toEqual([
      ...question,
      `${helperWords.prompt}yes`,
      ...helperWords.leftHome(from),
      ...helperWords.cleanedUp([dir], [], [], { triesAgain: false }),
      ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
    ]);
    // The old home's run stopped, its agent went with the removal, and the new one's started.
    expect(await first.exited).toBe(0);
    expect(me.managerAsked().slice(asked)).toEqual([
      ...me.background.paused,
      ...me.background.removed,
      ...me.background.started,
    ]);
    expect(readFileSync(join(dir, "only-copy.txt"), "utf8")).toBe("unique uncommitted work\n");
    expect(existsSync(join(me.dataDir, "accounts"))).toBe(false);
    const [listed] = at.pairing.list();
    expect(new JoinedHome(me.dataDir).read()?.grant).toMatchObject({
      at: at.at(),
      deviceId: listed?.id,
    });
    const back = agent();
    await expect.poll(back.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  });
});

test("the app will not run work as the user Firstmate itself runs as", async () => {
  const at = await home(ME.uid);
  const me = user();
  const join = work(["join", await at.link()], me.env, "yes\n");
  expect(await join.exited).toBe(1);
  expect(join.lines().slice(-2)).toEqual(helperWords.sameUser);
  expect(at.pairing.list()).toEqual([]);
  expect(new JoinedHome(me.dataDir).read()).toBeNull();
});

test("an installed build runs the work mode: it answers its version and that it has joined nothing", async () => {
  const me = user();
  const version = work(["version"], me.env, "", true);
  expect(await version.exited, version.error()).toBe(0);
  expect(version.lines()).toEqual([expect.stringMatching(/^Infinitary \S+ · contract \S+$/)]);
  const status = work(["status"], me.env, "", true);
  expect(await status.exited, status.error()).toBe(0);
  expect(status.lines()).toEqual(helperWords.notJoined);
});

for (const removal of ["from-home", "reconnect"] as const) {
  test(`removing a work computer preserves unreadable existing work and reports why it stays (${removal})`, async () => {
    const at = await home(ME.uid + 1);
    const me = user();
    expect(await work(["join", await at.link()], me.env, "yes\n").exited).toBe(0);
    const copies = new WorkingCopies(me.dataDir, { pool: false });
    const { dir } = await copies.prepare("t-protect", undefined);
    writeFileSync(join(dir, "only-copy.txt"), "unique uncommitted work\n");
    const metadata = readFileSync(join(dir, ".git"), "utf8");
    writeFileSync(join(dir, ".git"), `gitdir: ${join(me.homeDir, "missing")}\n`);
    if (removal === "reconnect")
      at.pairing.remove(at.pairing.list()[0]?.id ?? "", { farewell: true });
    const removed = work(
      removal === "from-home" ? ["remove", "--from-home", ...expectedHome(me.dataDir)] : ["run"],
      me.env,
    );
    expect(await removed.exited).toBe(0);
    if (removal === "from-home") {
      const outcome = JSON.parse(removed.lines().at(-1) ?? "{}");
      expect(outcome).toMatchObject({ firstmate: "removed", kept: [dir], unreadable: [dir] });
    } else {
      expect(removed.lines()).toEqual(expect.arrayContaining(helperWords.cleanedUp([dir], [dir])));
    }
    expect(new JoinedHome(me.dataDir).read()).toBeNull();
    expect(readFileSync(join(dir, "only-copy.txt"), "utf8")).toBe("unique uncommitted work\n");
    expect(existsSync(join(me.dataDir, "default-workspace", ".git"))).toBe(true);
    writeFileSync(join(dir, ".git"), metadata);
    expect(await copies.status("t-protect")).toMatchObject({
      present: true,
      dirty: true,
      unlandedCommits: 0,
    });
    console.log(
      JSON.stringify({
        removal,
        output: removed.lines(),
        preservedFile: readFileSync(join(dir, "only-copy.txt"), "utf8"),
        repairedStatus: await copies.status("t-protect"),
      }),
    );
  });
}

for (const removal of ["from-home", "in-reach"] as const) {
  test(`a removal that cannot remove everything goes on with the rest, and its agent's next run finishes it (${removal})`, async () => {
    const at = await home(ME.uid + 1);
    const me = user();
    expect(await work(["join", await at.link()], me.env, "yes\n").exited).toBe(0);
    const agent = readInstalled(me.dataDir).service?.file ?? "";
    const copies = new WorkingCopies(me.dataDir, { pool: false });
    const keep = await copies.prepare("t-keep", undefined);
    writeFileSync(join(keep.dir, "notes.md"), "unmerged\n");
    const clean = await copies.prepare("t-clean", undefined);
    seedRetainedAccountDirectory(me.dataDir);
    // Nothing can leave the working copies' own folder, so the clean copy cannot go yet.
    chmodSync(copies.worktreesDir, 0o555);
    try {
      await test.step("the removal removes everything else, says what stays, and keeps its agent", async () => {
        if (removal === "from-home") {
          const removed = work(["remove", "--from-home", ...expectedHome(me.dataDir)], me.env);
          expect(await removed.exited).toBe(0);
          expect(JSON.parse(removed.lines().at(-1) ?? "{}")).toEqual({
            firstmate: "removed",
            kept: [keep.dir],
            unremoved: [clean.dir],
          });
        } else {
          const running = work(["run"], me.env);
          await expect
            .poll(running.lines)
            .toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
          at.pairing.remove(at.pairing.list()[0]?.id ?? "");
          expect(await running.exited).toBe(0);
          expect(running.lines().slice(-3)).toEqual(
            helperWords.cleanedUp([keep.dir], [], [clean.dir]),
          );
        }
        expect(new JoinedHome(me.dataDir).read()).toBeNull();
        expect(existsSync(join(me.dataDir, "accounts"))).toBe(false);
        expect(existsSync(agent)).toBe(true);
        const status = work(["status"], me.env);
        expect(await status.exited, status.error()).toBe(0);
        expect(status.lines()).toEqual(helperWords.left(`Infinitary on ${HERE.this}`, [clean.dir]));
      });
    } finally {
      chmodSync(copies.worktreesDir, 0o755);
    }

    await test.step("its agent's next run, at the next login, finishes the removal and takes the agent away", async () => {
      const next = work(["run"], me.env);
      expect(await next.exited).toBe(0);
      expect(next.lines()).toEqual(helperWords.cleanedUp([keep.dir]));
      expect(existsSync(clean.dir)).toBe(false);
      expect(readFileSync(join(keep.dir, "notes.md"), "utf8")).toBe("unmerged\n");
      expect(existsSync(agent)).toBe(false);
      expect(me.managerAsked().slice(-me.background.removed.length)).toEqual(me.background.removed);
      const status = work(["status"], me.env);
      expect(await status.exited, status.error()).toBe(0);
      expect(status.lines()).toEqual(helperWords.left(`Infinitary on ${HERE.this}`));
    });
  });
}
