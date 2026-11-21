import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostPlatform } from "@core/platform";
import { clearPrivateTemp } from "@core/storage/ownerOnly";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { askPersonWord, ownProfilesFolder } from "./personWord";
import {
  PERSON_WORD_ARG,
  WORD_OWNER_FILE,
  WORD_PROFILES_RESERVED,
  WORD_REMOVING_PREFIX,
  WORD_TEMP_DIR,
  wordProfilesMark,
  wordProfilesMarked,
} from "./personWordArg";

/**
 * The review of INF-5409: a refused window launch hears the person's answer from a copy of the
 * program (`askPersonWord`), so only a press the copy said in full, that its box could say, and
 * ended on cleanly counts, a copy that cannot be made or show its box still settles once, the copy
 * ends with the launch that asked for it, and its profile goes once the copy has ended, by that
 * launch or a later one's ask, which touches nothing else. Each copy here is a real process standing
 * in for the program: it says what the production copy says (`replyLine`) and ends the way the
 * production copy does when its requester's input closes (`endWithRequester`), loaded from the
 * source. Every profile is made in a profiles' folder of the test's own.
 */
vi.setConfig({ testTimeout: 10_000 });

const PRELOAD = join(__dirname, "..", "..", "tests", "helpers", "sourceImports.preload.mjs");
const NODE_SOURCE = [
  "--no-warnings",
  "--experimental-transform-types",
  "--import",
  pathToFileURL(PRELOAD).href,
];
const sourceUrl = (file: string) => JSON.stringify(pathToFileURL(join(__dirname, file)).href);

/** A stand-in copy: its mode is its first word, its profile the one its requester named for it. */
function copyProgram(): string {
  const file = join(scratchDir("person-word-copy-"), "copy.mts");
  writeFileSync(
    file,
    `
    import { existsSync, mkdirSync, chmodSync, renameSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { claimWordProfile, endWithRequester, replyLine } from ${sourceUrl("personWordArg.ts")};
    const [mode, marks] = process.argv.slice(2);
    const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16) ?? "";
    const say = (text, code = 0) => process.stdout.write(text, () => process.exit(code));
    // Whether the temporary folder it was given was there before it ran anything.
    const tempAtStart = existsSync(process.env.TEMP ?? "");
    if (!claimWordProfile(process.argv)) say(replyLine("unshown"));
    else if (mode === "late") {
      // The reply in two pieces, the last just before the copy ends.
      process.stdout.write("pressed:");
      setTimeout(() => say("1\\n"), 300);
    } else if (mode === "malformed") say("pressed:yes\\n");
    else if (mode === "padded") say("pressed:01\\n");
    else if (mode === "crash") say(replyLine(1), 3);
    else if (mode === "unshown") say(replyLine("unshown"));
    else if (mode === "zero") {
      // The first button, which every box has, from a copy that says it started.
      writeFileSync(join(marks, "started"), "");
      say(replyLine(0));
    } else if (mode === "kept-profile") {
      // A profile its requester cannot remove: a folder inside one this account may not write.
      mkdirSync(join(profile, "inside"));
      chmodSync(profile, 0o500);
      say(replyLine(1));
    } else if (mode === "replace") {
      // Its profile moved away and another folder made at its path before it ends.
      renameSync(profile, join(marks, "moved"));
      mkdirSync(profile);
      writeFileSync(join(profile, "theirs"), "");
      writeFileSync(join(marks, "profile"), profile);
      say(replyLine(0));
    } else if (mode === "wait") {
      // Shows its box until its requester goes; where an ordinary end can be ignored, only that
      // requester's going ends it, and then only once the test lets it, so its profile can be seen
      // kept while it still runs.
      if (process.platform !== "win32") process.on("SIGTERM", () => {});
      // Never outliving the run that started it, whatever the test does.
      setTimeout(() => process.exit(0), 30_000);
      // A temporary file it still uses, where its requester said its temporary files go.
      writeFileSync(join(process.env.TEMP, "in-use"), "");
      writeFileSync(join(marks, "temp"), process.env.TEMP);
      writeFileSync(join(marks, "temp-at-start"), String(tempAtStart));
      writeFileSync(join(marks, "pid"), String(process.pid));
      endWithRequester(process.stdin, () => {
        writeFileSync(join(marks, "requester-gone"), "");
        setInterval(() => {
          if (existsSync(join(marks, "release"))) process.exit(0);
        }, 25);
      });
    }
    `,
  );
  return file;
}

const launcher = (program: string, ...words: string[]) => ({
  execPath: process.execPath,
  args: [...NODE_SOURCE, program, ...words],
});

/** Waits until a condition holds. */
async function until(holds: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Whether a process with this number still runs; a probe, never an end. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const wordProfiles = (dir: string) =>
  readdirSync(dir).filter((name) => name.startsWith("infinitary-word-"));

/** A profiles' folder of this test's own, named by its resolved place as the app keeps it. */
const profilesFolder = () =>
  join(realpathSync(scratchDir("person-word-profiles-")), "word-profiles");

/** A mark as the app writes one, naming a folder no test made. */
const someMark = () => wordProfilesMark(randomUUID(), { dev: 1n, ino: 1n, birthtimeNs: 0n });

/**
 * A folder put at a path just made, before the launch opens it to hold it: `swap.opening`, while
 * set, runs before each path this module opens is opened.
 */
const swap = vi.hoisted(() => ({ opening: null as ((path: string) => void) | null }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const openSync = ((...args: Parameters<typeof fs.openSync>) => {
    swap.opening?.(String(args[0]));
    return fs.openSync(...args);
  }) as typeof fs.openSync;
  return { ...fs, default: { ...fs, openSync }, openSync };
});

/**
 * The profiles' folder a name reserves: the folder beside it its mark names, whose own mark is the
 * very file at the name, by device and number read whole.
 */
function keptAt(root: string): string {
  const said = wordProfilesMarked(readFileSync(root, "utf8"));
  if (said === null) throw new Error("no profiles' folder is reserved there");
  const folder = `${root}.${said.id}`;
  const made = lstatSync(folder, { bigint: true });
  if (made.dev !== said.dev || made.ino !== said.ino || made.birthtimeNs !== said.birthtimeNs)
    throw new Error("the mark names another folder than the one at its path");
  const mark = lstatSync(root, { bigint: true });
  const inside = lstatSync(join(folder, WORD_PROFILES_RESERVED), { bigint: true });
  if (inside.dev !== mark.dev || inside.ino !== mark.ino)
    throw new Error("the name's mark is not the folder's own");
  return folder;
}

/** The folders beside a name made for its reservation, reserved or not. */
const foldersFor = (root: string) =>
  readdirSync(dirname(root)).filter((name) => name.startsWith(`${basename(root)}.`));

/** What a removal set aside and could not remove. */
const setAside = (dir: string) =>
  readdirSync(dir).filter((name) => name.startsWith(WORD_REMOVING_PREFIX));

/** Lets a waiting copy end, and waits until it has, should a check before that have failed. */
async function release(marks: string): Promise<void> {
  writeFileSync(join(marks, "release"), "");
  if (!existsSync(join(marks, "pid"))) return;
  const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
  await until(() => !alive(copy), "the copy's end");
}

/** The number of a process that has ended: a real one, started and waited for. */
async function endedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("close", resolve));
  if (child.pid === undefined) throw new Error("the ended process never started");
  return child.pid;
}

describe("a refused launch's copy that shows a word", () => {
  it("counts only a press its box could say, said in full by a copy that ended cleanly", async () => {
    const program = copyProgram();
    const profiles = profilesFolder();
    const ask = (word: "dock" | "once-closed", mode: string) =>
      askPersonWord(word, { launcher: launcher(program, mode), profiles });
    expect(await ask("once-closed", "late")).toBe(1);
    for (const mode of ["malformed", "padded", "crash", "unshown"])
      expect(await ask("once-closed", mode)).toBe("unshown");
    // The Dock word's box has one button: a second is no notice the person dismissed.
    expect(await ask("dock", "late")).toBe("unshown");
    expect(wordProfiles(keptAt(profiles))).toEqual([]);
  });

  it("settles as unshown when the copy cannot be started or its profile made", async () => {
    expect(
      await askPersonWord("dock", {
        launcher: { execPath: join(scratchDir("person-word-none-"), "infinitary"), args: [] },
        profiles: profilesFolder(),
      }),
    ).toBe("unshown");
    const program = copyProgram();
    // The same copy and word give the person's press where its profile can be made...
    const shown = scratchDir("person-word-marks-");
    expect(
      await askPersonWord("dock", {
        launcher: launcher(program, "zero", shown),
        profiles: profilesFolder(),
      }),
    ).toBe(0);
    expect(existsSync(join(shown, "started"))).toBe(true);
    // ...and start nothing where it cannot: its folder would sit inside a plain file.
    const blocked = join(scratchDir("person-word-blocked-"), "file");
    writeFileSync(blocked, "");
    const marks = scratchDir("person-word-marks-");
    expect(
      await askPersonWord("dock", {
        launcher: launcher(program, "zero", marks),
        profiles: join(blocked, "word-profiles"),
      }),
    ).toBe("unshown");
    expect(existsSync(join(marks, "started"))).toBe(false);
  });

  it("makes no profile and starts no copy where its profile would not stay private", async () => {
    const program = copyProgram();
    const marks = scratchDir("person-word-marks-");
    expect(
      await askPersonWord("once-closed", {
        launcher: launcher(program, "zero", marks),
        profiles: null,
      }),
    ).toBe("unshown");
    expect(existsSync(join(marks, "started"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "makes no profile in a profiles' folder that is a link to somewhere else",
    async () => {
      const elsewhere = scratchDir("person-word-elsewhere-");
      const profiles = join(scratchDir("person-word-profiles-"), "word-profiles");
      symlinkSync(elsewhere, profiles);
      const marks = scratchDir("person-word-marks-");
      expect(
        await askPersonWord("dock", { launcher: launcher(copyProgram(), "zero", marks), profiles }),
      ).toBe(0);
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(readlinkSync(profiles)).toBe(elsewhere);
      expect(readdirSync(keptAt(`${profiles}-2`))).toEqual([WORD_PROFILES_RESERVED]);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "makes no profile where another account could put a folder in its place",
    async () => {
      const shared = scratchDir("person-word-shared-");
      chmodSync(shared, 0o777);
      const marks = scratchDir("person-word-marks-");
      expect(
        await askPersonWord("dock", {
          launcher: launcher(copyProgram(), "zero", marks),
          profiles: join(shared, "word-profiles"),
        }),
      ).toBe("unshown");
      expect(existsSync(join(marks, "started"))).toBe(false);
      expect(readdirSync(shared)).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "makes no profile where another account could replace a folder above its place",
    async () => {
      // Its own folder is private, but the one above it lets anyone rename it away; one above
      // that only lets each entry's owner move it, as /tmp does, and is trusted.
      const above = realpathSync(scratchDir("person-word-above-"));
      const own = join(above, "own");
      mkdirSync(own, { mode: 0o700 });
      const marks = scratchDir("person-word-marks-");
      const ask = () =>
        askPersonWord("dock", {
          launcher: launcher(copyProgram(), "zero", marks),
          profiles: join(own, "word-profiles"),
        });
      chmodSync(above, 0o777);
      expect(await ask()).toBe("unshown");
      expect(existsSync(join(marks, "started"))).toBe(false);
      expect(readdirSync(own)).toEqual([]);
      chmodSync(above, 0o1777);
      expect(await ask()).toBe(0);
      expect(readdirSync(keptAt(join(own, "word-profiles")))).toEqual([WORD_PROFILES_RESERVED]);
      chmodSync(above, 0o700);
    },
  );

  it("uses only a profiles' folder it reserved, and leaves anything already at the name alone", async () => {
    // One it makes is marked whole and reserved at the name, and used again by the next ask.
    const made = profilesFolder();
    const marks = scratchDir("person-word-marks-");
    const ask = (profiles: string) =>
      askPersonWord("dock", { launcher: launcher(copyProgram(), "zero", marks), profiles });
    expect(await ask(made)).toBe(0);
    const kept = keptAt(made);
    expect(readdirSync(kept)).toEqual([WORD_PROFILES_RESERVED]);
    expect(await ask(made)).toBe(0);
    expect(foldersFor(made)).toHaveLength(1);
    expect(existsSync(`${made}-2`)).toBe(false);
    // A copy of that folder beside it that kept its mark's link is never used for it, nor once the
    // folder itself is gone.
    const copy = `${made}.0-copy`;
    mkdirSync(copy, { mode: 0o700 });
    linkSync(join(kept, WORD_PROFILES_RESERVED), join(copy, WORD_PROFILES_RESERVED));
    expect(await ask(made)).toBe(0);
    expect(keptAt(made)).toBe(kept);
    expect(readdirSync(copy)).toEqual([WORD_PROFILES_RESERVED]);
    rmSync(kept, { recursive: true });
    expect(await ask(made)).toBe(0);
    expect(readdirSync(copy)).toEqual([WORD_PROFILES_RESERVED]);
    expect(readdirSync(keptAt(`${made}-2`))).toEqual([WORD_PROFILES_RESERVED]);
    // A folder at that name the app never made - empty, holding a mark however it reads, or
    // holding another's work - never scanned, changed or used, and the next name is.
    for (const said of [undefined, null, "", `${someMark()}more`, "someone else's\n"]) {
      const found = profilesFolder();
      mkdirSync(found, { recursive: true, mode: 0o700 });
      if (typeof said === "string") writeFileSync(join(found, WORD_PROFILES_RESERVED), said);
      if (said !== undefined) {
        mkdirSync(join(found, "infinitary-word-theirs"));
        writeFileSync(
          join(found, "infinitary-word-theirs", WORD_OWNER_FILE),
          `${await endedPid()}\n`,
        );
      }
      const before = statSync(found);
      const names = readdirSync(found).sort();
      expect(await ask(found)).toBe(0);
      expect(readdirSync(found).sort()).toEqual(names);
      const after = statSync(found);
      expect([after.ino, after.mode]).toEqual([before.ino, before.mode]);
      expect(readdirSync(keptAt(`${found}-2`))).toEqual([WORD_PROFILES_RESERVED]);
    }
    // A file at the name saying a mark whose folder is not there, or whose folder holds only a copy
    // of it: no reservation of the app's, left as it is.
    for (const copied of [false, true]) {
      const found = profilesFolder();
      const said = someMark();
      writeFileSync(found, said, { mode: 0o600 });
      const beside = `${found}.${wordProfilesMarked(said)?.id}`;
      if (copied) {
        mkdirSync(beside, { mode: 0o700 });
        writeFileSync(join(beside, WORD_PROFILES_RESERVED), said);
      }
      const before = statSync(found);
      expect(await ask(found)).toBe(0);
      expect(statSync(found).ino).toBe(before.ino);
      expect(readFileSync(found, "utf8")).toBe(said);
      if (copied) expect(readdirSync(beside)).toEqual([WORD_PROFILES_RESERVED]);
      expect(readdirSync(keptAt(`${found}-2`))).toEqual([WORD_PROFILES_RESERVED]);
    }
  });

  it.skipIf(process.platform === "win32")(
    "leaves a reservation whose folder was put back at its path, or whose mark others may write",
    async () => {
      const marks = scratchDir("person-word-marks-");
      const ask = (root: string) =>
        askPersonWord("dock", { launcher: launcher(copyProgram(), "zero", marks), profiles: root });
      // A folder put back at the reserved folder's path holding the same mark, as a restore that
      // keeps hard links would leave it: not the folder the mark was written in, so it is neither
      // used nor read for ended profiles, and the next name is reserved.
      const restored = profilesFolder();
      expect(await ask(restored)).toBe(0);
      const kept = keptAt(restored);
      renameSync(kept, `${kept}-was`);
      mkdirSync(kept, { mode: 0o700 });
      linkSync(join(`${kept}-was`, WORD_PROFILES_RESERVED), join(kept, WORD_PROFILES_RESERVED));
      mkdirSync(join(kept, "infinitary-word-theirs"));
      writeFileSync(join(kept, "infinitary-word-theirs", WORD_OWNER_FILE), `${await endedPid()}\n`);
      expect(await ask(restored)).toBe(0);
      expect(readdirSync(kept).sort()).toEqual([WORD_PROFILES_RESERVED, "infinitary-word-theirs"]);
      expect(readdirSync(join(kept, "infinitary-word-theirs"))).toEqual([WORD_OWNER_FILE]);
      expect(readdirSync(keptAt(`${restored}-2`))).toEqual([WORD_PROFILES_RESERVED]);
      // A mark another account may write through its name is no longer one only this account could
      // have written: it is left as it is, and the next name is reserved.
      const writable = profilesFolder();
      expect(await ask(writable)).toBe(0);
      const folder = keptAt(writable);
      chmodSync(writable, 0o622);
      expect(await ask(writable)).toBe(0);
      expect(statSync(writable).mode & 0o777).toBe(0o622);
      expect(readdirSync(folder)).toEqual([WORD_PROFILES_RESERVED]);
      expect(readdirSync(keptAt(`${writable}-2`))).toEqual([WORD_PROFILES_RESERVED]);
    },
  );

  it.runIf(process.platform === "darwin")(
    "leaves a Mac reservation whose folder or mark an access list opens to others",
    async () => {
      // Modes alone do not show a Mac access list entry: one that lets everyone read the reserved
      // folder, or its mark, makes it no longer this account's alone, and the next name is used.
      const marks = scratchDir("person-word-marks-");
      for (const opened of ["folder", "mark"] as const) {
        const root = profilesFolder();
        const ask = () =>
          askPersonWord("dock", {
            launcher: launcher(copyProgram(), "zero", marks),
            profiles: root,
          });
        expect(await ask()).toBe(0);
        const kept = keptAt(root);
        const target = opened === "folder" ? kept : root;
        execFileSync("/bin/chmod", ["+a", "everyone allow read", target]);
        const listed = () => execFileSync("/bin/ls", ["-lde", target], { encoding: "utf8" });
        const before = listed();
        expect(before).toMatch(/: .* allow /);
        expect(await ask()).toBe(0);
        expect(listed()).toBe(before);
        expect(readdirSync(kept)).toEqual([WORD_PROFILES_RESERVED]);
        expect(readdirSync(keptAt(`${root}-2`))).toEqual([WORD_PROFILES_RESERVED]);
      }
    },
  );

  it("starts no copy where every name for its profiles' folder is taken", async () => {
    // Folders the app never made, holding another's files, or empty and this account's alone as
    // the app would make one: neither is ever taken for the app's.
    for (const theirs of [true, false]) {
      const found = profilesFolder();
      const names = [found, `${found}-2`, `${found}-3`];
      for (const path of names) {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        if (theirs) writeFileSync(join(path, "theirs"), "");
      }
      const before = names.map((path) => statSync(path));
      const marks = scratchDir("person-word-marks-");
      expect(
        await askPersonWord("dock", {
          launcher: launcher(copyProgram(), "zero", marks),
          profiles: found,
        }),
      ).toBe("unshown");
      expect(existsSync(join(marks, "started"))).toBe(false);
      names.forEach((path, index) => {
        expect(readdirSync(path)).toEqual(theirs ? ["theirs"] : []);
        const after = statSync(path);
        expect([after.ino, after.mode]).toEqual([before[index]?.ino, before[index]?.mode]);
      });
      expect(names.flatMap((path) => foldersFor(path))).toEqual([]);
    }
  });

  it("reserves the name itself after a launch ended part way, leaving that launch's folder as it was", async () => {
    // A launch ended before its link went in leaves only its own folder beside the name: empty, as
    // one ended before its mark, or with its mark cut short.
    for (const left of [null, "cut"]) {
      const root = profilesFolder();
      const id = randomUUID();
      const ended = `${root}.${id}`;
      mkdirSync(ended, { mode: 0o700 });
      if (left !== null)
        writeFileSync(
          join(ended, WORD_PROFILES_RESERVED),
          wordProfilesMark(id, lstatSync(ended, { bigint: true })).slice(0, -2),
        );
      const names = readdirSync(ended);
      const before = statSync(ended);
      const marks = scratchDir("person-word-marks-");
      expect(
        await askPersonWord("dock", {
          launcher: launcher(copyProgram(), "zero", marks),
          profiles: root,
        }),
      ).toBe(0);
      expect(keptAt(root)).not.toBe(ended);
      expect(readdirSync(ended)).toEqual(names);
      expect(statSync(ended).ino).toBe(before.ino);
      expect(existsSync(`${root}-2`)).toBe(false);
    }
    // Launches reserving at once: one reservation, and no folder left over by the one that lost.
    const root = profilesFolder();
    const marks = scratchDir("person-word-marks-");
    const ask = () =>
      askPersonWord("dock", { launcher: launcher(copyProgram(), "zero", marks), profiles: root });
    expect(await Promise.all([ask(), ask(), ask()])).toEqual([0, 0, 0]);
    expect(foldersFor(root)).toEqual([basename(keptAt(root))]);
  });

  it("keeps the press and leaves a folder that replaced the copy's profile", async () => {
    const profiles = profilesFolder();
    const marks = scratchDir("person-word-marks-");
    expect(
      await askPersonWord("dock", {
        launcher: launcher(copyProgram(), "replace", marks),
        profiles,
      }),
    ).toBe(0);
    const profile = readFileSync(join(marks, "profile"), "utf8");
    expect(existsSync(join(profile, "theirs"))).toBe(true);
    expect(existsSync(join(marks, "moved", WORD_OWNER_FILE))).toBe(true);
  });

  it("never holds, uses or removes a folder put at its new profile's name before it is held", async () => {
    const profiles = profilesFolder();
    const marks = scratchDir("person-word-marks-");
    // The folder the profiles' folder reserves is made first, by an ask whose copy shows nothing.
    await askPersonWord("dock", { launcher: launcher(copyProgram(), "zero", marks), profiles });
    const folder = keptAt(profiles);
    let theirs: string | null = null;
    swap.opening = (path) => {
      if (
        theirs !== null ||
        dirname(path) !== folder ||
        !basename(path).startsWith("infinitary-word-")
      )
        return;
      theirs = path;
      renameSync(path, join(folder, "made-aside"));
      mkdirSync(path);
      writeFileSync(join(path, "theirs"), "kept");
    };
    try {
      expect(
        await askPersonWord("dock", { launcher: launcher(copyProgram(), "zero", marks), profiles }),
      ).toBe("unshown");
    } finally {
      swap.opening = null;
    }
    expect(theirs).not.toBeNull();
    expect(readdirSync(theirs ?? "")).toEqual(["theirs"]);
    expect(readFileSync(join(theirs ?? "", "theirs"), "utf8")).toBe("kept");
  });

  it("removes the profile it made when the copy cannot even be started", async () => {
    const profiles = profilesFolder();
    // A program name no process can start with, refused before anything runs.
    const refused = { execPath: `${process.execPath}\0`, args: [] };
    expect(await askPersonWord("dock", { launcher: refused, profiles })).toBe("unshown");
    expect(readdirSync(keptAt(profiles))).toEqual([WORD_PROFILES_RESERVED]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the person's press when the copy's profile cannot be removed",
    async () => {
      const profiles = profilesFolder();
      try {
        expect(
          await askPersonWord("once-closed", {
            launcher: launcher(copyProgram(), "kept-profile"),
            profiles,
          }),
        ).toBe(1);
        // What could not go stays set aside, never back at a name something else may now hold.
        expect(wordProfiles(keptAt(profiles))).toEqual([]);
        expect(setAside(keptAt(profiles))).toHaveLength(1);
      } finally {
        // The scratch folder goes at the run's end, so its kept profile is made removable again.
        const folder = keptAt(profiles);
        for (const kept of setAside(folder)) chmodSync(join(folder, kept), 0o700);
      }
    },
  );

  it("ends a word taken away, and removes its profile only once the copy has ended", async () => {
    const profiles = profilesFolder();
    const marks = scratchDir("person-word-marks-");
    const taken = new AbortController();
    const asked = askPersonWord("dock", {
      launcher: launcher(copyProgram(), "wait", marks),
      profiles,
      signal: taken.signal,
    });
    try {
      await until(() => existsSync(join(marks, "pid")), "the copy's start");
      const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
      taken.abort();
      expect(await asked).toBeNull();
      if (process.platform !== "win32") {
        // The copy ignores the ordinary end it was sent, as one whose end failed: its closed input
        // reaches it, and its profile stays while it still runs.
        await until(() => existsSync(join(marks, "requester-gone")), "the copy hearing it");
        expect(alive(copy)).toBe(true);
        expect(wordProfiles(keptAt(profiles))).toHaveLength(1);
      }
      writeFileSync(join(marks, "release"), "");
      await until(() => !alive(copy), "the copy's end");
      await until(() => wordProfiles(keptAt(profiles)).length === 0, "the profile's removal");
    } finally {
      taken.abort();
      await release(marks);
    }
  });

  it("ends the copy when the launch that asked for it dies, keeps its files through the next holder's clearing, and a later ask removes its profile", async () => {
    const profiles = profilesFolder();
    const marks = scratchDir("person-word-marks-");
    // The temporary folder the requester itself was given, which the launch holding the folder
    // after it clears at its start (`clearPrivateTemp`).
    const requesterTemp = scratchDir("person-word-private-temp-");
    const program = copyProgram();
    const requesterFile = join(scratchDir("person-word-requester-"), "requester.mts");
    writeFileSync(
      requesterFile,
      `
      import { askPersonWord } from ${sourceUrl("personWord.ts")};
      void askPersonWord("dock", {
        launcher: JSON.parse(process.env.LAUNCHER),
        profiles: process.env.PROFILES,
      });
      setInterval(() => {}, 1000);
      `,
    );
    const requester = spawn(process.execPath, [...NODE_SOURCE, requesterFile], {
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        TEMP: requesterTemp,
        TMP: requesterTemp,
        PROFILES: profiles,
        LAUNCHER: JSON.stringify(launcher(program, "wait", marks)),
      },
      stdio: "ignore",
    });
    const requesterEnded = new Promise((resolve) => requester.once("close", resolve));
    const later = async () => {
      const shown = scratchDir("person-word-marks-");
      expect(
        await askPersonWord("dock", { launcher: launcher(program, "zero", shown), profiles }),
      ).toBe(0);
    };
    try {
      await until(() => existsSync(join(marks, "pid")), "the copy's start");
      const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
      requester.kill("SIGKILL");
      await requesterEnded;
      await until(() => existsSync(join(marks, "requester-gone")), "the copy hearing it");
      // Its temporary files are in its own profile, and the next holder's clearing leaves them.
      const temp = readFileSync(join(marks, "temp"), "utf8");
      const folder = keptAt(profiles);
      const [named] = wordProfiles(folder);
      expect(temp).toBe(join(folder, named ?? "", WORD_TEMP_DIR));
      expect(readFileSync(join(marks, "temp-at-start"), "utf8")).toBe("true");
      await clearPrivateTemp(requesterTemp);
      expect(existsSync(join(temp, "in-use"))).toBe(true);
      // Nobody is left to remove its profile, and while the copy still runs a later ask keeps it.
      expect(alive(copy)).toBe(true);
      expect(readFileSync(join(folder, named ?? "", WORD_OWNER_FILE), "utf8")).toBe(`${copy}\n`);
      await later();
      expect(wordProfiles(folder)).toEqual([named]);
      // Once the copy has ended, the next ask removes it.
      writeFileSync(join(marks, "release"), "");
      await until(() => !alive(copy), "the copy's end");
      await later();
      expect(wordProfiles(folder)).toEqual([]);
    } finally {
      if (requester.exitCode === null && requester.signalCode === null) {
        requester.kill("SIGKILL");
        await requesterEnded;
      }
      await release(marks);
    }
  });

  it("removes only profiles whose copy named itself and has positively ended", async () => {
    // The profiles' folder as the app keeps it, made and reserved by the app itself on this system.
    const root = profilesFolder();
    const profiles = (await ownProfilesFolder(root, hostPlatform()))?.path;
    if (profiles === undefined) throw new Error("the app kept no profiles' folder");
    const ended = await endedPid();
    const profile = (name: string, said?: string) => {
      mkdirSync(join(profiles, name));
      if (said !== undefined) writeFileSync(join(profiles, name, WORD_OWNER_FILE), said);
    };
    // A copy that ended after the launch that asked for it died: its whole record, number and
    // line's end.
    profile("infinitary-word-ended", `${ended}\n`);
    // A copy still running (this test's own process) whose launch has gone, and one that has not
    // named itself yet, as a copy just starting, or never will, as one ended before it could.
    profile("infinitary-word-live", `${process.pid}\n`);
    profile("infinitary-word-unnamed");
    // A record not yet written whole, as a copy stopped while it named itself.
    profile("infinitary-word-partial", String(ended));
    // Owner files not in the copy's own words: garbled, padded, two numbers, too long, a folder.
    profile("infinitary-word-garbled", "not a number\n");
    profile("infinitary-word-padded", `0${ended}\n`);
    profile("infinitary-word-two", `${ended}\n${ended}\n`);
    profile("infinitary-word-long", `${"0".repeat(80)}${ended}`);
    profile("infinitary-word-folder");
    mkdirSync(join(profiles, "infinitary-word-folder", WORD_OWNER_FILE));
    profile("other-folder", `${ended}\n`);
    // Where links and pipes exist: a link to a folder elsewhere named as a profile, and an owner
    // file that links to a record elsewhere, never followed, and an owner file that is a pipe
    // nothing writes, never waited on.
    const elsewhere = scratchDir("person-word-elsewhere-");
    writeFileSync(join(elsewhere, WORD_OWNER_FILE), `${ended}\n`);
    const posix = process.platform !== "win32";
    if (posix) {
      symlinkSync(elsewhere, join(profiles, "infinitary-word-link"));
      profile("infinitary-word-linked-owner");
      symlinkSync(
        join(elsewhere, WORD_OWNER_FILE),
        join(profiles, "infinitary-word-linked-owner", WORD_OWNER_FILE),
      );
      profile("infinitary-word-pipe");
      const made = spawnSync("mkfifo", [join(profiles, "infinitary-word-pipe", WORD_OWNER_FILE)]);
      expect(made.status).toBe(0);
    }
    const marks = scratchDir("person-word-marks-");
    expect(
      await askPersonWord("dock", {
        launcher: launcher(copyProgram(), "zero", marks),
        profiles: root,
      }),
    ).toBe(0);
    expect(readdirSync(profiles).sort()).toEqual(
      [
        "infinitary-word-folder",
        "infinitary-word-garbled",
        "infinitary-word-live",
        "infinitary-word-long",
        "infinitary-word-padded",
        "infinitary-word-partial",
        "infinitary-word-two",
        "infinitary-word-unnamed",
        ...(posix
          ? ["infinitary-word-link", "infinitary-word-linked-owner", "infinitary-word-pipe"]
          : []),
        "other-folder",
        WORD_PROFILES_RESERVED,
      ].sort(),
    );
    expect(readdirSync(elsewhere)).toEqual([WORD_OWNER_FILE]);
  });

  it("names the word, a throwaway profile in its folder and temporary files there to the copy", async () => {
    const marks = scratchDir("person-word-marks-");
    const file = join(scratchDir("person-word-copy-"), "args.mjs");
    writeFileSync(
      file,
      `import { writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      writeFileSync(${JSON.stringify(join(marks, "args"))}, JSON.stringify(process.argv.slice(2)));
      writeFileSync(${JSON.stringify(join(marks, "env"))}, JSON.stringify([process.env.TEMP, process.env.TMP, process.env.TMPDIR, tmpdir()]));
      process.stdout.write("pressed:0\\n", () => process.exit(0));`,
    );
    const profiles = profilesFolder();
    // This launch's own temporary folder, named the way this system reads first, is not the copy's.
    const own = process.env.TMPDIR;
    process.env.TMPDIR = scratchDir("person-word-requester-temp-");
    try {
      expect(
        await askPersonWord("once-closed", {
          launcher: { execPath: process.execPath, args: [file] },
          profiles,
        }),
      ).toBe(0);
    } finally {
      if (own === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = own;
    }
    const args: string[] = JSON.parse(readFileSync(join(marks, "args"), "utf8"));
    expect(args[0]).toBe(`${PERSON_WORD_ARG}=once-closed`);
    const profile = args[1]?.slice("--user-data-dir=".length) ?? "";
    expect(profile.startsWith(join(keptAt(profiles), "infinitary-word-"))).toBe(true);
    // Its temporary files go in that profile, never where this launch's own go, by every setting
    // that names them and as the copy itself finds its temporary folder.
    const temp = join(profile, WORD_TEMP_DIR);
    expect(JSON.parse(readFileSync(join(marks, "env"), "utf8"))).toEqual([temp, temp, temp, temp]);
  });
});
