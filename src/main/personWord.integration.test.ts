import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { askPersonWord, reclaimWordProfiles } from "./personWord";
import { PERSON_WORD_ARG } from "./personWordArg";

/**
 * The review of INF-5409: a refused window launch hears the person's answer from a copy of the
 * program (`askPersonWord`), so only a press the copy said in full, that its box could say, and
 * ended on cleanly counts, a copy that cannot be made or show its box still settles once, the copy
 * ends with the launch that asked for it, and its profile goes once the copy has ended, by that
 * launch or a later one. Each copy here is a real process standing in for the program: it says
 * what the production copy says (`replyLine`) and ends the way the production copy does when its
 * requester's input closes (`endWithRequester`), loaded from the source. Every profile is made in
 * a temporary folder of the test's own.
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
    import { mkdirSync, chmodSync, writeFileSync } from "node:fs";
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
    else if (mode === "kept-profile") {
      // A profile its requester cannot remove: a folder inside one this account may not write.
      mkdirSync(join(profile, "inside"));
      chmodSync(profile, 0o500);
      say(replyLine(1));
    } else if (mode === "wait") {
      // Shows its box until its requester goes; where an ordinary end can be ignored, only that
      // requester's going ends it.
      if (process.platform !== "win32") process.on("SIGTERM", () => {});
      writeFileSync(join(marks, "pid"), String(process.pid));
      endWithRequester(process.stdin, () => {
        writeFileSync(join(marks, "requester-gone"), "");
        process.exit(0);
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

/** The temporary folder every platform reads, for this run alone. */
const TEMP_NAMES = ["TMPDIR", "TEMP", "TMP"] as const;
const tempEnv = (dir: string) => Object.fromEntries(TEMP_NAMES.map((name) => [name, dir]));
async function inTemp<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const before = TEMP_NAMES.map((name) => process.env[name]);
  for (const name of TEMP_NAMES) process.env[name] = dir;
  try {
    return await body();
  } finally {
    TEMP_NAMES.forEach((name, index) => {
      const was = before[index];
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    });
  }
}

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

describe("a refused launch's copy that shows a word", () => {
  it("counts only a press its box could say, said in full by a copy that ended cleanly", async () => {
    const program = copyProgram();
    await inTemp(scratchDir("person-word-tmp-"), async () => {
      const ask = (word: "dock" | "once-closed", mode: string) =>
        askPersonWord(word, { launcher: launcher(program, mode), privateTemp: true });
      expect(await ask("once-closed", "late")).toBe(1);
      for (const mode of ["malformed", "padded", "crash", "unshown"])
        expect(await ask("once-closed", mode)).toBe("unshown");
      // The Dock word's box has one button: a second is no notice the person dismissed.
      expect(await ask("dock", "late")).toBe("unshown");
    });
  });

  it("settles as unshown when the copy cannot be started or its profile made", async () => {
    await inTemp(scratchDir("person-word-tmp-"), async () => {
      expect(
        await askPersonWord("dock", {
          launcher: { execPath: join(scratchDir("person-word-none-"), "infinitary"), args: [] },
          privateTemp: true,
        }),
      ).toBe("unshown");
    });
    const program = copyProgram();
    await inTemp(join(scratchDir("person-word-tmp-"), "missing"), async () => {
      expect(
        await askPersonWord("dock", { launcher: launcher(program, "late"), privateTemp: true }),
      ).toBe("unshown");
    });
  });

  it("makes no profile and starts no copy where its profile would not stay private", async () => {
    const dir = scratchDir("person-word-tmp-");
    const marks = scratchDir("person-word-marks-");
    await inTemp(dir, async () => {
      expect(
        await askPersonWord("once-closed", {
          launcher: launcher(copyProgram(), "wait", marks),
          privateTemp: false,
        }),
      ).toBe("unshown");
    });
    expect(wordProfiles(dir)).toEqual([]);
    expect(existsSync(join(marks, "pid"))).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the person's press when the copy's profile cannot be removed",
    async () => {
      const dir = scratchDir("person-word-tmp-");
      try {
        await inTemp(dir, async () => {
          expect(
            await askPersonWord("once-closed", {
              launcher: launcher(copyProgram(), "kept-profile"),
              privateTemp: true,
            }),
          ).toBe(1);
        });
        expect(wordProfiles(dir)).toHaveLength(1);
      } finally {
        // The scratch folder goes at the run's end, so its kept profile is made removable again.
        for (const kept of wordProfiles(dir)) chmodSync(join(dir, kept), 0o700);
      }
    },
  );

  it("ends a word taken away, and removes its profile once the copy has ended", async () => {
    const dir = scratchDir("person-word-tmp-");
    const marks = scratchDir("person-word-marks-");
    await inTemp(dir, async () => {
      const taken = new AbortController();
      const asked = askPersonWord("dock", {
        launcher: launcher(copyProgram(), "wait", marks),
        privateTemp: true,
        signal: taken.signal,
      });
      await until(() => existsSync(join(marks, "pid")), "the copy's start");
      const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
      taken.abort();
      expect(await asked).toBeNull();
      // Where the copy ignores an ordinary end, its closed input alone ends it.
      if (process.platform !== "win32")
        await until(() => existsSync(join(marks, "requester-gone")), "the copy hearing it");
      await until(() => !alive(copy), "the copy's end");
      // Its profile goes once the copy has ended, not at the word's withdrawal.
      await until(() => wordProfiles(dir).length === 0, "the profile's removal");
    });
  });

  it("ends the copy when the launch that asked for it dies, and a later ask removes its profile", async () => {
    const dir = scratchDir("person-word-tmp-");
    const marks = scratchDir("person-word-marks-");
    const requesterFile = join(scratchDir("person-word-requester-"), "requester.mts");
    writeFileSync(
      requesterFile,
      `
      import { askPersonWord } from ${sourceUrl("personWord.ts")};
      void askPersonWord("dock", { launcher: JSON.parse(process.env.LAUNCHER), privateTemp: true });
      setInterval(() => {}, 1000);
      `,
    );
    const requester = spawn(process.execPath, [...NODE_SOURCE, requesterFile], {
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        ...tempEnv(dir),
        LAUNCHER: JSON.stringify(launcher(copyProgram(), "wait", marks)),
      },
      stdio: "ignore",
    });
    const requesterEnded = new Promise((resolve) => requester.once("close", resolve));
    try {
      await until(() => existsSync(join(marks, "pid")), "the copy's start");
      const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
      await until(
        () => wordProfiles(dir).some((name) => readdirSync(join(dir, name)).length > 0),
        "the copy being named in its profile",
      );
      requester.kill("SIGKILL");
      await requesterEnded;
      await until(() => existsSync(join(marks, "requester-gone")), "the copy hearing it");
      await until(() => !alive(copy), "the copy's end");
      // Nobody was left to remove its profile: the next ask's reclaiming does.
      expect(wordProfiles(dir)).toHaveLength(1);
      reclaimWordProfiles(dir);
      expect(wordProfiles(dir)).toEqual([]);
    } finally {
      if (requester.exitCode === null && requester.signalCode === null) {
        requester.kill("SIGKILL");
        await requesterEnded;
      }
    }
  });

  it("reclaims only profiles whose copy has positively ended", () => {
    const dir = scratchDir("person-word-tmp-");
    const profile = (name: string, pid?: string) => {
      mkdirSync(join(dir, name));
      if (pid !== undefined) writeFileSync(join(dir, name, "infinitary-word-copy.pid"), pid);
    };
    // A copy still running (this test's own process), one still being made, and one unreadable.
    profile("infinitary-word-live", String(process.pid));
    profile("infinitary-word-making");
    profile("infinitary-word-garbled", "not a number");
    // A process number no process can have.
    profile("infinitary-word-ended", "2147483646");
    profile("other-folder", "2147483646");
    reclaimWordProfiles(dir);
    expect(readdirSync(dir).sort()).toEqual([
      "infinitary-word-garbled",
      "infinitary-word-live",
      "infinitary-word-making",
      "other-folder",
    ]);
  });

  it("names the word and a throwaway profile to the copy", async () => {
    const marks = scratchDir("person-word-marks-");
    const file = join(scratchDir("person-word-copy-"), "args.mjs");
    writeFileSync(
      file,
      `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(join(marks, "args"))}, JSON.stringify(process.argv.slice(2)));
      process.stdout.write("pressed:0\\n", () => process.exit(0));`,
    );
    await inTemp(scratchDir("person-word-tmp-"), async () => {
      expect(
        await askPersonWord("once-closed", {
          launcher: { execPath: process.execPath, args: [file] },
          privateTemp: true,
        }),
      ).toBe(0);
    });
    const args: string[] = JSON.parse(readFileSync(join(marks, "args"), "utf8"));
    expect(args[0]).toBe(`${PERSON_WORD_ARG}=once-closed`);
    expect(args[1]).toMatch(/^--user-data-dir=.*infinitary-word-/);
  });
});
