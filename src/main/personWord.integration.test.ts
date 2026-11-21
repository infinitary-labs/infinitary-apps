import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { askPersonWord } from "./personWord";
import { PERSON_WORD_ARG } from "./personWordArg";

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

/** A stand-in copy: its mode is its first word, its profile the one the requester made for it. */
function copyProgram(): string {
  const file = join(scratchDir("person-word-copy-"), "copy.mts");
  writeFileSync(
    file,
    `
    import { existsSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { endWithRequester, replyLine } from ${sourceUrl("personWordArg.ts")};
    const [mode, marks] = process.argv.slice(2);
    const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16) ?? "";
    const say = (text, code = 0) => process.stdout.write(text, () => process.exit(code));
    if (mode === "late") {
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
    } else if (mode === "wait") {
      // Shows its box until its requester goes; where an ordinary end can be ignored, only that
      // requester's going ends it, and then only once the test lets it, so its profile can be seen
      // kept while it still runs.
      if (process.platform !== "win32") process.on("SIGTERM", () => {});
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

/** A profiles' folder of this test's own. */
const profilesFolder = () => join(scratchDir("person-word-profiles-"), "word-profiles");

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
    expect(wordProfiles(profiles)).toEqual([]);
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
      ).toBe("unshown");
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(existsSync(join(marks, "started"))).toBe(false);
    },
  );

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
        expect(wordProfiles(profiles)).toHaveLength(1);
      } finally {
        // The scratch folder goes at the run's end, so its kept profile is made removable again.
        for (const kept of wordProfiles(profiles)) chmodSync(join(profiles, kept), 0o700);
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
    await until(() => existsSync(join(marks, "pid")), "the copy's start");
    const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
    taken.abort();
    expect(await asked).toBeNull();
    if (process.platform !== "win32") {
      // The copy ignores the ordinary end it was sent, as one whose end failed: its closed input
      // reaches it, and its profile stays while it still runs.
      await until(() => existsSync(join(marks, "requester-gone")), "the copy hearing it");
      expect(alive(copy)).toBe(true);
      expect(wordProfiles(profiles)).toHaveLength(1);
    }
    writeFileSync(join(marks, "release"), "");
    await until(() => !alive(copy), "the copy's end");
    await until(() => wordProfiles(profiles).length === 0, "the profile's removal");
  });

  it("ends the copy when the launch that asked for it dies, and a later ask removes its profile", async () => {
    const profiles = profilesFolder();
    const marks = scratchDir("person-word-marks-");
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
      // Nobody is left to remove its profile, and while the copy still runs a later ask keeps it.
      expect(alive(copy)).toBe(true);
      await later();
      expect(wordProfiles(profiles)).toHaveLength(1);
      // Once the copy has ended, the next ask removes it.
      writeFileSync(join(marks, "release"), "");
      await until(() => !alive(copy), "the copy's end");
      await later();
      expect(wordProfiles(profiles)).toEqual([]);
    } finally {
      writeFileSync(join(marks, "release"), "");
      if (requester.exitCode === null && requester.signalCode === null) {
        requester.kill("SIGKILL");
        await requesterEnded;
      }
    }
  });

  it("removes only profiles whose copy, or launch where no copy started, has positively ended", async () => {
    const profiles = profilesFolder();
    mkdirSync(profiles, { recursive: true, mode: 0o700 });
    const ended = await endedPid();
    const owner = "infinitary-word.pid";
    const profile = (name: string, said?: string) => {
      mkdirSync(join(profiles, name));
      if (said !== undefined) writeFileSync(join(profiles, name, owner), said);
    };
    // A launch that died before its copy started, and a copy that ended after its launch died.
    profile("infinitary-word-early", String(ended));
    profile("infinitary-word-ended", `${ended} ${ended}`);
    // A copy still running (this test's own process) whose launch has gone, and a launch still
    // running whose copy has not started.
    profile("infinitary-word-live-copy", `${ended} ${process.pid}`);
    profile("infinitary-word-live-launch", String(process.pid));
    // One still being made, one unreadable, one too long to be an owner file of ours, and one
    // whose owner file is a folder.
    profile("infinitary-word-making");
    profile("infinitary-word-garbled", "not a number");
    profile("infinitary-word-long", `${" ".repeat(80)}${ended}`);
    profile("infinitary-word-folder");
    mkdirSync(join(profiles, "infinitary-word-folder", owner));
    profile("other-folder", String(ended));
    // A link to a folder elsewhere, named as a profile, which is never followed.
    const elsewhere = scratchDir("person-word-elsewhere-");
    writeFileSync(join(elsewhere, owner), String(ended));
    const linked = process.platform !== "win32";
    if (linked) symlinkSync(elsewhere, join(profiles, "infinitary-word-link"));
    const marks = scratchDir("person-word-marks-");
    expect(
      await askPersonWord("dock", { launcher: launcher(copyProgram(), "zero", marks), profiles }),
    ).toBe(0);
    expect(readdirSync(profiles).sort()).toEqual(
      [
        "infinitary-word-folder",
        "infinitary-word-garbled",
        ...(linked ? ["infinitary-word-link"] : []),
        "infinitary-word-live-copy",
        "infinitary-word-live-launch",
        "infinitary-word-long",
        "infinitary-word-making",
        "other-folder",
      ].sort(),
    );
    expect(readdirSync(elsewhere)).toEqual([owner]);
  });

  it("names the word and a throwaway profile in its folder to the copy", async () => {
    const marks = scratchDir("person-word-marks-");
    const file = join(scratchDir("person-word-copy-"), "args.mjs");
    writeFileSync(
      file,
      `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(join(marks, "args"))}, JSON.stringify(process.argv.slice(2)));
      process.stdout.write("pressed:0\\n", () => process.exit(0));`,
    );
    const profiles = profilesFolder();
    expect(
      await askPersonWord("once-closed", {
        launcher: { execPath: process.execPath, args: [file] },
        profiles,
      }),
    ).toBe(0);
    const args: string[] = JSON.parse(readFileSync(join(marks, "args"), "utf8"));
    expect(args[0]).toBe(`${PERSON_WORD_ARG}=once-closed`);
    expect(args[1].startsWith(`--user-data-dir=${join(profiles, "infinitary-word-")}`)).toBe(true);
  });
});
