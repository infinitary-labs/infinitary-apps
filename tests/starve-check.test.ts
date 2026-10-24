import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";

const execute = promisify(execFile);

// INF-886 / INF-965: starve the actual app, including detached descendants,
// resume stopped-at-exec children, and bound/cancel an experiment without leaks.
function experiment(mode: "complete" | "hold", timeout: number, env?: NodeJS.ProcessEnv) {
  const root = scratchDir("infinitary-starvation-tree-");
  const marker = join(root, "completed");
  const child = spawn(
    "python3",
    [
      "scripts/starve-check.py",
      "--timeout",
      String(timeout),
      "--run-seconds",
      "0.05",
      "--pause-seconds",
      "0.1",
      "--stall-every",
      "0.2",
      "--stall-seconds",
      "0.4",
      "--",
      "python3",
      "tests/fixtures/starve-process-tree.py",
      mode,
      "root",
      marker,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env },
  );
  const lines: string[] = [];
  const pending = new Set<() => void>();
  let ended = false;
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += data.toString();
  });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    lines.push(line);
    for (const check of pending) check();
  });
  const result = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      ended = true;
      for (const check of pending) check();
      reader.close();
      console.log(lines.join("\n"));
      if (errors) reject(new Error(errors));
      else resolve(code);
    });
  });
  const wait = (prefix: string, matches = (_line: string) => true) =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        const line = lines.find((value) => value.startsWith(prefix) && matches(value));
        if (line || ended) {
          pending.delete(check);
          if (line) resolve(line);
          else reject(new Error(`Experiment ended before ${prefix}: ${lines.join("\n")}`));
        }
      };
      pending.add(check);
      check();
    });
  return { child, result, lines, wait, marker };
}

async function assertStopped(lines: string[]) {
  const pids = lines
    .filter((line) => line.startsWith("fixture "))
    .map((line) => line.split(" ")[2]);
  expect(pids).toHaveLength(3);
  for (const pid of pids) {
    const state = await execute("ps", ["-o", "stat=", "-p", String(pid)]).then(
      ({ stdout }) => stdout.trim(),
      () => "",
    );
    // A zombie has exited; only its parent's OS reaping remains.
    expect(state === "" || state.startsWith("Z")).toBe(true);
  }
}

it("resumes detached children stopped at birth and observes their real completed work", async () => {
  const work = experiment("complete", 15);
  expect(await work.result).toBe(0);
  expect(readFileSync(work.marker, "utf8")).toBe("detached work completed");
  await assertStopped(work.lines);
}, 20_000);

// INF-982: a system-wide process listing can wait on an unrelated process in exec.
// Keep exercising real detached children when that global reader is unavailable.
it("completes owned work without depending on the system-wide process listing", async () => {
  const tools = scratchDir("infinitary-starvation-no-ps-");
  writeFileSync(
    join(tools, "ps"),
    "#!/bin/sh\necho 'System-wide process listing is unavailable' >&2\nexit 1\n",
    {
      mode: 0o755,
    },
  );
  const work = experiment("complete", 15, {
    ...process.env,
    PATH: `${tools}${delimiter}${process.env.PATH ?? ""}`,
  });
  expect(await work.result).toBe(0);
  expect(readFileSync(work.marker, "utf8")).toBe("detached work completed");
  await assertStopped(work.lines);
}, 20_000);

// INF-886's paired native load runs: a fresh inspection stalled during resume.
// The captured pause must be released even when discovery cannot answer.
it("resumes its observed pause set without requiring another process inspection", async () => {
  const marker = join(scratchDir("infinitary-starvation-resume-"), "completed");
  await execute("python3", ["-B", "tests/fixtures/resume-without-snapshot.py", marker]);
  expect(readFileSync(marker, "utf8")).toBe("resumed work completed");
});

it.each(["signal", "deadline"] as const)(
  "cleans up detached descendants on %s without touching a sibling",
  async (ending) => {
    const sentinel = spawn("python3", ["-c", "import signal; signal.pause()"], { stdio: "ignore" });
    const sentinelExit = new Promise((resolve) => sentinel.once("close", resolve));
    const work = experiment("hold", ending === "signal" ? 20 : 3);
    try {
      const grandchild = (await work.wait("fixture grandchild ")).split(" ")[2];
      const paused = await work.wait("Starvation: stall", (line) =>
        line.includes(`${grandchild}:T`),
      );
      for (const line of work.lines.filter((value) => value.startsWith("fixture ")))
        expect(paused).toContain(`${line.split(" ")[2]}:T`);
      if (ending === "signal") work.child.kill("SIGTERM");
      expect(await work.result).toBe(ending === "signal" ? 143 : 124);
      await assertStopped(work.lines);
      expect(sentinel.exitCode).toBeNull();
      expect(sentinel.signalCode).toBeNull();
      if (!sentinel.pid) throw new Error("The sibling process did not start");
      process.kill(sentinel.pid, 0);
    } finally {
      work.child.kill("SIGTERM");
      try {
        await work.result;
      } finally {
        sentinel.kill("SIGKILL");
        await sentinelExit;
      }
    }
  },
  20_000,
);

// INF-1083: a journey's quit ran the Mac's set-user-ID `ps`, a process of another
// user that this one may neither read nor signal; the experiment crashed on it.
it.skipIf(process.platform !== "darwin")(
  "leaves a descendant of another user running and completes the owned work",
  async () => {
    // `top` is set-user-ID root on macOS, like `ps`, and lives long enough to be seen.
    const { stdout } = await execute("python3", [
      "scripts/starve-check.py",
      "--timeout",
      "15",
      "--run-seconds",
      "0.05",
      "--pause-seconds",
      "0.1",
      "--stall-every",
      "0.2",
      "--stall-seconds",
      "0.4",
      "--",
      "/usr/bin/top",
      "-l",
      "3",
      "-s",
      "1",
    ]);
    expect(stdout).toContain("command exited 0");
  },
  20_000,
);
