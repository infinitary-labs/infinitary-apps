import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { clearPrivateTemp } from "@core/storage/ownerOnly";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { askPersonWord } from "./personWord";
import { PERSON_WORD_ARG, WORD_PROFILES, WORD_TEMP_DIR } from "./personWordArg";

/**
 * The review of INF-5409: a refused window launch hears the person's answer from a copy of the
 * program (`askPersonWord`), so only a press the copy said in full, that its box could say, and
 * ended on cleanly counts, a copy that cannot be made or show its box still settles once, and the
 * copy ends with the launch that asked for it. Its profile is kept in the data folder and used again
 * by every later word: a name holding anything the app would not keep there is left exactly as it
 * is, and nothing is ever moved or removed. Each copy here is a real process standing in for the
 * program: it says what the production copy says (`replyLine`) and ends the way the production copy
 * does when its requester's input closes (`endWithRequester`), loaded from the source. Every
 * profile is made in a data folder of the test's own.
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
    import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import {
      claimWordProfile,
      endWithRequester,
      endWithRequesterOffMain,
      replyLine,
    } from ${sourceUrl("personWordArg.ts")};
    const [mode, marks] = process.argv.slice(2);
    const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16) ?? "";
    const say = (text, code = 0) => process.stdout.write(text, () => process.exit(code));
    // Whether the temporary folder it was given was there before it ran anything.
    const tempAtStart = existsSync(process.env.TEMP ?? "");
    if (!claimWordProfile(process.argv, () => true)) say(replyLine("unshown"));
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
    } else if (mode === "write") {
      // A file of its own in its profile, as a browser profile keeps.
      writeFileSync(join(profile, "kept"), marks);
      writeFileSync(join(process.env.TEMP, "scratch"), marks);
      say(replyLine(0));
    } else if (mode === "blocked") {
      // Its main thread held the way a Mac holds it under a box with no window of its own: neither
      // its input's end nor an ordinary end reaches that thread, and only a bounded wait ends it.
      if (process.platform !== "win32") process.on("SIGTERM", () => {});
      endWithRequesterOffMain();
      writeFileSync(join(marks, "pid"), String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
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

/** A data folder of this test's own, as a refused launch knows its folder. */
const dataFolder = () => scratchDir("person-word-data-");

/** What the data folder holds: the profile the app keeps there and nothing else of its making. */
const kept = (dataDir: string) => readdirSync(dataDir).sort();

/** Lets a waiting copy end, and waits until it has, should a check before that have failed. */
async function release(marks: string): Promise<void> {
  writeFileSync(join(marks, "release"), "");
  if (!existsSync(join(marks, "pid"))) return;
  const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
  await until(() => !alive(copy), "the copy's end");
}

describe("a refused launch's copy that shows a word", () => {
  it("counts only a press its box could say, said in full by a copy that ended cleanly", async () => {
    const program = copyProgram();
    const dataDir = dataFolder();
    const ask = (word: "dock" | "once-closed", mode: string) =>
      askPersonWord(word, { launcher: launcher(program, mode), dataDir });
    expect(await ask("once-closed", "late")).toBe(1);
    for (const mode of ["malformed", "padded", "crash", "unshown"])
      expect(await ask("once-closed", mode)).toBe("unshown");
    // The Dock word's box has one button: a second is no notice the person dismissed.
    expect(await ask("dock", "late")).toBe("unshown");
    expect(kept(dataDir)).toEqual([WORD_PROFILES[0]]);
  });

  it("settles as unshown when the copy cannot be started or its profile made", async () => {
    expect(
      await askPersonWord("dock", {
        launcher: { execPath: join(scratchDir("person-word-none-"), "infinitary"), args: [] },
        dataDir: dataFolder(),
      }),
    ).toBe("unshown");
    const program = copyProgram();
    // The same copy and word give the person's press where its profile can be made...
    const shown = scratchDir("person-word-marks-");
    expect(
      await askPersonWord("dock", {
        launcher: launcher(program, "zero", shown),
        dataDir: dataFolder(),
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
        dataDir: join(blocked, "data"),
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
        dataDir: null,
      }),
    ).toBe("unshown");
    expect(existsSync(join(marks, "started"))).toBe(false);
  });

  it("keeps one profile in the data folder and uses it again for every word, removing nothing", async () => {
    const dataDir = dataFolder();
    const program = copyProgram();
    for (const said of ["first", "second"]) {
      expect(
        await askPersonWord("dock", { launcher: launcher(program, "write", said), dataDir }),
      ).toBe(0);
      // The same profile each time, with what the copy left there still in it.
      expect(kept(dataDir)).toEqual([WORD_PROFILES[0]]);
      const profile = join(dataDir, WORD_PROFILES[0]);
      expect(readFileSync(join(profile, "kept"), "utf8")).toBe(said);
      expect(readFileSync(join(profile, WORD_TEMP_DIR, "scratch"), "utf8")).toBe(said);
      if (process.platform !== "win32") expect(statSync(profile).mode & 0o777).toBe(0o700);
    }
  });

  it("leaves anything at a profile's name it would not keep there, and uses the next name", async () => {
    const program = copyProgram();
    const ask = (dataDir: string) =>
      askPersonWord("dock", {
        launcher: launcher(program, "zero", scratchDir("person-word-marks-")),
        dataDir,
      });
    // A file at the name, and a profile whose temporary folder's name holds a file.
    const filed = dataFolder();
    writeFileSync(join(filed, WORD_PROFILES[0]), "someone else's\n");
    expect(await ask(filed)).toBe(0);
    expect(readFileSync(join(filed, WORD_PROFILES[0]), "utf8")).toBe("someone else's\n");
    expect(kept(filed)).toEqual([WORD_PROFILES[0], WORD_PROFILES[1]]);
    const tempFiled = dataFolder();
    mkdirSync(join(tempFiled, WORD_PROFILES[0]), { mode: 0o700 });
    writeFileSync(join(tempFiled, WORD_PROFILES[0], WORD_TEMP_DIR), "");
    expect(await ask(tempFiled)).toBe(0);
    expect(readdirSync(join(tempFiled, WORD_PROFILES[0]))).toEqual([WORD_TEMP_DIR]);
    expect(kept(tempFiled)).toEqual([WORD_PROFILES[0], WORD_PROFILES[1]]);
    if (process.platform === "win32") return;
    // A link to somewhere else, followed nowhere, and a folder others may reach, never re-permitted.
    const linked = dataFolder();
    const elsewhere = scratchDir("person-word-elsewhere-");
    symlinkSync(elsewhere, join(linked, WORD_PROFILES[0]));
    expect(await ask(linked)).toBe(0);
    expect(readlinkSync(join(linked, WORD_PROFILES[0]))).toBe(elsewhere);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(kept(linked)).toEqual([WORD_PROFILES[0], WORD_PROFILES[1]]);
    const shared = dataFolder();
    mkdirSync(join(shared, WORD_PROFILES[0]));
    chmodSync(join(shared, WORD_PROFILES[0]), 0o755);
    expect(await ask(shared)).toBe(0);
    expect(statSync(join(shared, WORD_PROFILES[0])).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(shared, WORD_PROFILES[0]))).toEqual([]);
    expect(kept(shared)).toEqual([WORD_PROFILES[0], WORD_PROFILES[1]]);
  });

  it("starts no copy where every name for its profile holds something else", async () => {
    const dataDir = dataFolder();
    for (const name of WORD_PROFILES) writeFileSync(join(dataDir, name), "theirs\n");
    const marks = scratchDir("person-word-marks-");
    expect(
      await askPersonWord("dock", { launcher: launcher(copyProgram(), "zero", marks), dataDir }),
    ).toBe("unshown");
    expect(existsSync(join(marks, "started"))).toBe(false);
    expect(kept(dataDir)).toEqual([...WORD_PROFILES].sort());
    for (const name of WORD_PROFILES)
      expect(readFileSync(join(dataDir, name), "utf8")).toBe("theirs\n");
  });

  it("ends a word taken away, its profile kept for the next", async () => {
    const dataDir = dataFolder();
    const marks = scratchDir("person-word-marks-");
    const taken = new AbortController();
    const asked = askPersonWord("dock", {
      launcher: launcher(copyProgram(), "wait", marks),
      dataDir,
      signal: taken.signal,
    });
    try {
      await until(() => existsSync(join(marks, "pid")), "the copy's start");
      const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
      taken.abort();
      expect(await asked).toBeNull();
      if (process.platform !== "win32") {
        // The copy ignores the ordinary end it was sent, as one whose end failed: its closed input
        // reaches it.
        await until(() => existsSync(join(marks, "requester-gone")), "the copy hearing it");
        expect(alive(copy)).toBe(true);
      }
      writeFileSync(join(marks, "release"), "");
      await until(() => !alive(copy), "the copy's end");
      expect(kept(dataDir)).toEqual([WORD_PROFILES[0]]);
    } finally {
      taken.abort();
      await release(marks);
    }
  });

  it.skipIf(process.platform === "win32")(
    "ends a word taken away even while its box holds the copy's main thread",
    async () => {
      const dataDir = dataFolder();
      const marks = scratchDir("person-word-marks-");
      const taken = new AbortController();
      const asked = askPersonWord("dock", {
        launcher: launcher(copyProgram(), "blocked", marks),
        dataDir,
        signal: taken.signal,
      });
      try {
        await until(() => existsSync(join(marks, "pid")), "the copy's start");
        const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
        taken.abort();
        expect(await asked).toBeNull();
        await until(() => !alive(copy), "the copy's end");
      } finally {
        // A copy left running by a failure ends on its own bounded wait.
        taken.abort();
      }
    },
  );

  it("ends the copy when the launch that asked for it dies, and keeps its files through the next holder's clearing", async () => {
    const dataDir = dataFolder();
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
        dataDir: process.env.DATA_DIR,
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
        DATA_DIR: dataDir,
        LAUNCHER: JSON.stringify(launcher(program, "wait", marks)),
      },
      stdio: "ignore",
    });
    const requesterEnded = new Promise((resolve) => requester.once("close", resolve));
    try {
      await until(() => existsSync(join(marks, "pid")), "the copy's start");
      const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
      requester.kill("SIGKILL");
      await requesterEnded;
      await until(() => existsSync(join(marks, "requester-gone")), "the copy hearing it");
      // Its temporary files are in its own profile, and the next holder's clearing leaves them.
      const temp = readFileSync(join(marks, "temp"), "utf8");
      expect(temp).toBe(join(dataDir, WORD_PROFILES[0], WORD_TEMP_DIR));
      expect(readFileSync(join(marks, "temp-at-start"), "utf8")).toBe("true");
      await clearPrivateTemp(requesterTemp);
      expect(existsSync(join(temp, "in-use"))).toBe(true);
      expect(alive(copy)).toBe(true);
    } finally {
      if (requester.exitCode === null && requester.signalCode === null) {
        requester.kill("SIGKILL");
        await requesterEnded;
      }
      await release(marks);
    }
  });

  it("names the word, the profile kept in the data folder and temporary files there to the copy", async () => {
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
    const dataDir = dataFolder();
    // This launch's own temporary folder, named the way this system reads first, is not the copy's.
    const own = process.env.TMPDIR;
    process.env.TMPDIR = scratchDir("person-word-requester-temp-");
    try {
      expect(
        await askPersonWord("once-closed", {
          launcher: { execPath: process.execPath, args: [file] },
          dataDir,
        }),
      ).toBe(0);
    } finally {
      if (own === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = own;
    }
    const args: string[] = JSON.parse(readFileSync(join(marks, "args"), "utf8"));
    expect(args[0]).toBe(`${PERSON_WORD_ARG}=once-closed`);
    const profile = args[1]?.slice("--user-data-dir=".length) ?? "";
    expect(profile).toBe(join(dataDir, WORD_PROFILES[0]));
    // Its temporary files go in that profile, never where this launch's own go, by every setting
    // that names them and as the copy itself finds its temporary folder.
    const temp = join(profile, WORD_TEMP_DIR);
    expect(JSON.parse(readFileSync(join(marks, "env"), "utf8"))).toEqual([temp, temp, temp, temp]);
  });
});
