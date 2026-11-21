import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { askPersonWord } from "./personWord";
import { PERSON_WORD_ARG } from "./personWordArg";

/**
 * The review of INF-5409: a refused window launch hears the person's answer from a copy of the
 * program (`askPersonWord`), so only a press the copy said in full and ended on cleanly counts, a
 * copy that cannot be made or show its box still settles once, and the copy ends with the launch
 * that asked for it. Each copy here is a real process standing in for the program: it says what
 * the production copy says (`replyLine`) and ends the way the production copy does when its
 * requester's input closes (`endWithRequester`), loaded from the source.
 */
vi.setConfig({ testTimeout: 10_000 });

const PRELOAD = join(__dirname, "..", "..", "tests", "helpers", "sourceImports.preload.mjs");
const NODE_SOURCE = ["--no-warnings", "--experimental-transform-types", "--import", PRELOAD];

/** A stand-in copy: its mode is its first word, its profile the one the requester made for it. */
function copyProgram(): string {
  const file = join(scratchDir("person-word-copy-"), "copy.mts");
  writeFileSync(
    file,
    `
    import { mkdirSync, chmodSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { endWithRequester, replyLine } from ${JSON.stringify(join(__dirname, "personWordArg.ts"))};
    const [mode, marks] = process.argv.slice(2);
    const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16) ?? "";
    const say = (text, code = 0) => process.stdout.write(text, () => process.exit(code));
    if (mode === "late") {
      // The reply in two pieces, the last just before the copy ends.
      process.stdout.write("pressed:");
      setTimeout(() => say("1\\n"), 300);
    } else if (mode === "malformed") say("pressed:yes\\n");
    else if (mode === "crash") say(replyLine(1), 3);
    else if (mode === "unshown") say(replyLine("unshown"));
    else if (mode === "kept-profile") {
      // A profile its requester cannot remove: a folder inside one this account may not write.
      mkdirSync(join(profile, "inside"));
      chmodSync(profile, 0o500);
      say(replyLine(1));
    } else if (mode === "wait") {
      // Shows its box until its requester goes, ignoring an ordinary end so only that can end it.
      process.on("SIGTERM", () => {});
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

/** Waits for a file the copy writes. */
async function fileAppears(file: string): Promise<void> {
  const until = Date.now() + 8_000;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error(`${file} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const wordProfiles = (dir: string) =>
  readdirSync(dir).filter((name) => name.startsWith("infinitary-word-"));

describe("a refused launch's copy that shows a word", () => {
  it("counts only a press said in full by a copy that ended cleanly", async () => {
    const program = copyProgram();
    expect(await askPersonWord("once-closed", { launcher: launcher(program, "late") })).toBe(1);
    for (const mode of ["malformed", "crash", "unshown"])
      expect(await askPersonWord("once-closed", { launcher: launcher(program, mode) })).toBe(
        "unshown",
      );
  });

  it("settles as unshown when the copy cannot be started or its profile made", async () => {
    expect(
      await askPersonWord("dock", { launcher: { execPath: "/nonexistent/infinitary", args: [] } }),
    ).toBe("unshown");
    const program = copyProgram();
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = join(scratchDir("person-word-tmp-"), "missing");
    try {
      expect(await askPersonWord("dock", { launcher: launcher(program, "late") })).toBe("unshown");
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the person's press when the copy's profile cannot be removed",
    async () => {
      const tmp = process.env.TMPDIR;
      const dir = scratchDir("person-word-tmp-");
      process.env.TMPDIR = dir;
      try {
        expect(
          await askPersonWord("once-closed", { launcher: launcher(copyProgram(), "kept-profile") }),
        ).toBe(1);
        expect(wordProfiles(dir)).toHaveLength(1);
      } finally {
        if (tmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = tmp;
        // The scratch folder goes at the run's end, so its kept profile is made removable again.
        for (const kept of wordProfiles(dir)) chmodSync(join(dir, kept), 0o700);
      }
    },
  );

  it("ends a word taken away by closing its input, even where its end is ignored", async () => {
    const tmp = process.env.TMPDIR;
    const dir = scratchDir("person-word-tmp-");
    process.env.TMPDIR = dir;
    const marks = scratchDir("person-word-marks-");
    try {
      const taken = new AbortController();
      const asked = askPersonWord("dock", {
        launcher: launcher(copyProgram(), "wait", marks),
        signal: taken.signal,
      });
      await fileAppears(join(marks, "pid"));
      taken.abort();
      expect(await asked).toBeNull();
      await fileAppears(join(marks, "requester-gone"));
      // Its profile goes once the copy has ended, not at the word's withdrawal.
      const until = Date.now() + 8_000;
      while (wordProfiles(dir).length > 0 && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(wordProfiles(dir)).toEqual([]);
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
  });

  it("ends the copy when the launch that asked for it dies", async () => {
    const marks = scratchDir("person-word-marks-");
    const requesterFile = join(scratchDir("person-word-requester-"), "requester.mts");
    writeFileSync(
      requesterFile,
      `
      import { askPersonWord } from ${JSON.stringify(join(__dirname, "personWord.ts"))};
      void askPersonWord("dock", { launcher: JSON.parse(process.env.LAUNCHER) });
      setInterval(() => {}, 1000);
      `,
    );
    const requester = spawn(process.execPath, [...NODE_SOURCE, requesterFile], {
      env: {
        PATH: process.env.PATH ?? "",
        LAUNCHER: JSON.stringify(launcher(copyProgram(), "wait", marks)),
      },
      stdio: "ignore",
    });
    try {
      await fileAppears(join(marks, "pid"));
      const copy = Number(readFileSync(join(marks, "pid"), "utf8"));
      requester.kill("SIGKILL");
      await fileAppears(join(marks, "requester-gone"));
      const until = Date.now() + 8_000;
      const alive = () => {
        try {
          process.kill(copy, 0);
          return true;
        } catch {
          return false;
        }
      };
      while (alive() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(alive()).toBe(false);
    } finally {
      if (requester.exitCode === null && requester.signalCode === null) requester.kill("SIGKILL");
    }
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
    expect(
      await askPersonWord("once-closed", {
        launcher: { execPath: process.execPath, args: [file] },
      }),
    ).toBe(0);
    const args: string[] = JSON.parse(readFileSync(join(marks, "args"), "utf8"));
    expect(args[0]).toBe(`${PERSON_WORD_ARG}=once-closed`);
    expect(args[1]).toMatch(/^--user-data-dir=.*infinitary-word-/);
  });
});
