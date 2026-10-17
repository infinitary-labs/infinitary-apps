import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { scratchDir } from "./helpers/scratchDirs";

// INF-79 review-cap choice: parallel desktop jobs, exclusive phone commands,
// no stranded lease after cancellation. Exercise the real workflow commands
// and kernel locks, replacing only the expensive build/test work with held Node processes.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml");
const execute = promisify(execFile);
const queued = (access: string) => `Mac checks: ${access} waiting for active checks`;
type Work = {
  wait(line: string): Promise<void>;
  release(): void;
  stop(): void;
  result: Promise<number | null>;
};

function fixture() {
  const root = scratchDir("infinitary-mac-check-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const workload = `#!${process.execPath}
const { basename } = require('node:path');
if (process.env.CHECK_FAIL) process.exit(7);
if (basename(process.argv[1]) === 'pnpm' && process.argv[2] !== 'build') process.exit(0);
console.log('started:' + process.env.CHECK_NAME);
process.stdin.once('data', () => process.exit(0));
`;
  for (const name of ["node", "pnpm"]) writeFileSync(join(bin, name), workload, { mode: 0o755 });
  const env = {
    ...hostEnv(),
    HOME: home,
    CFFIXED_USER_HOME: home,
    INFINITARY_LOCAL_CODESIGN_DIR: join(home, "unused-signing"),
    PATH: `${bin}:${hostEnv().PATH}`,
    FILES: "tests/e2e/activity-runs.spec.ts",
    RUNNER_TEMP: root,
  };
  const trace: string[] = [];
  const children: Work[] = [];
  function launch(
    name: string,
    kind: "desktop" | "iphone" | "ipad" | "package",
    fail = false,
    args = "",
  ): Work {
    const command =
      kind === "package"
        ? `${JSON.parse(readFileSync("package.json", "utf8")).scripts["test:phone"]} ${args}`
        : yaml
            .load(
              readFileSync(
                kind === "desktop"
                  ? ".github/workflows/journeys.yml"
                  : ".github/workflows/phone.yml",
                "utf8",
              ),
            )
            .jobs[kind === "desktop" ? "affected-journeys" : "native-phone"].steps.find(
              (step: { id?: string }) => step.id === (kind === "desktop" ? "e2e" : kind),
            ).run;
    const child = spawn("bash", ["-e", "-c", command], {
      cwd: resolve("."),
      env: {
        ...env,
        CHECK_NAME: name,
        CHECK_FAIL: fail ? "yes" : "",
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    const waiting = new Set<(line: string | null) => void>();
    let ended = false;
    let errors = "";
    child.stderr.setEncoding("utf8").on("data", (part) => {
      errors += part;
    });
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      lines.push(line);
      trace.push(`${name}: ${line}`);
      for (const hear of waiting) hear(line);
    });
    const result = new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        trace.push(`${name}: exited ${signal ?? code}`);
        ended = true;
        reader.close();
        for (const hear of waiting) hear(null);
        done(code);
      });
    });
    const work = {
      wait: (wanted: string) =>
        new Promise<void>((done, reject) => {
          if (lines.includes(wanted)) return done();
          if (ended) return reject(new Error(`${name} exited before ${wanted}: ${errors}`));
          const hear = (line: string | null) => {
            if (line !== wanted && line !== null) return;
            waiting.delete(hear);
            if (line === wanted) done();
            else reject(new Error(`${name} exited before ${wanted}: ${errors}`));
          };
          waiting.add(hear);
        }),
      release: () => {
        trace.push(`${name}: releasing`);
        child.stdin.end("release\n");
      },
      stop: () => {
        if (!ended && child.pid) {
          try {
            trace.push(`${name}: canceling`);
            process.kill(-child.pid, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      },
      result,
    };
    children.push(work);
    return work;
  }
  return {
    launch,
    trace,
    probe: async (access: "shared" | "exclusive", entry = false) => {
      const path = join(
        home,
        "Library/Caches/infinitary-ci",
        entry ? "checks.lock.entry" : "checks.lock",
      );
      const { stdout } = await execute(
        "python3",
        [
          "-c",
          `
import fcntl, sys
with open(sys.argv[1], 'rb') as f:
    try:
        fcntl.flock(f, (fcntl.LOCK_SH if sys.argv[2] == 'shared' else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        print('free')
    except BlockingIOError:
        print('busy')
`,
          path,
          access,
        ],
        { env: hostEnv() },
      );
      trace.push(`kernel ${entry ? "entry " : ""}${access}: ${stdout.trim()}`);
      return stdout.trim();
    },
    close: async () => {
      for (const child of children) child.stop();
      await Promise.all(children.map((child) => child.result));
    },
  };
}

describe.skipIf(process.platform === "win32")("the Mac check command leases", () => {
  it("overlaps desktop PRs, drains them for a phone, then admits the next waiting work", async () => {
    const f = fixture();
    try {
      const a = f.launch("desktop-a", "desktop");
      await a.wait("started:desktop-a");
      expect(await f.probe("shared")).toBe("free");
      expect(await f.probe("exclusive")).toBe("busy");
      const b = f.launch("desktop-b", "desktop");
      await b.wait("started:desktop-b");
      const phone = f.launch("phone-a", "iphone");
      await phone.wait(queued("exclusive"));
      expect(await f.probe("exclusive", true)).toBe("busy");
      a.release();
      expect(await a.result).toBe(0);
      expect(await f.probe("exclusive", true)).toBe("busy");
      b.release();
      expect(await b.result).toBe(0);
      await phone.wait("started:phone-a");
      expect(await f.probe("shared")).toBe("busy");
      const next = f.launch("phone-b", "ipad");
      await next.wait(queued("exclusive"));
      phone.stop();
      await phone.result;
      await next.wait("started:phone-b");
      expect(await f.probe("shared")).toBe("busy");
      const c = f.launch("desktop-c", "desktop");
      await c.wait(queued("shared"));
      next.release();
      expect(await next.result).toBe(0);
      await c.wait("started:desktop-c");
      c.release();
      expect(await c.result).toBe(0);
      console.info("Mac check admission proof", JSON.stringify(f.trace));
    } finally {
      await f.close();
    }
  });
  it("releases a canceled phone's pending entry lock without stopping active desktops", async () => {
    const f = fixture();
    try {
      const a = f.launch("desktop-a", "desktop");
      await a.wait("started:desktop-a");
      const phone = f.launch("waiting-phone", "iphone");
      await phone.wait(queued("exclusive"));
      expect(await f.probe("exclusive", true)).toBe("busy");
      phone.stop();
      await phone.result;
      const b = f.launch("desktop-b", "desktop");
      await b.wait("started:desktop-b");
      a.release();
      b.release();
      expect(await a.result).toBe(0);
      expect(await b.result).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("preserves a command failure and leaves no lease behind", async () => {
    const f = fixture();
    try {
      const phone = f.launch("failed-phone", "iphone", true);
      expect(await phone.result).toBe(7);
      const desktop = f.launch("after-failure", "desktop");
      await desktop.wait("started:after-failure");
      desktop.release();
      expect(await desktop.result).toBe(0);
    } finally {
      await f.close();
    }
  });
  // SCR-410: the documented local `pnpm test:phone` waits on the lease CI's phone checks take.
  it("makes the documented pnpm test:phone wait for a running desktop check, then run", async () => {
    const f = fixture();
    try {
      const desktop = f.launch("desktop-a", "desktop");
      await desktop.wait("started:desktop-a");
      const local = f.launch("local-phone", "package", false, "--ipad --evidence /tmp/x");
      await local.wait(queued("exclusive"));
      expect(await f.probe("shared")).toBe("free");
      desktop.release();
      expect(await desktop.result).toBe(0);
      await local.wait("started:local-phone");
      expect(await f.probe("shared")).toBe("busy");
      local.release();
      expect(await local.result).toBe(0);
    } finally {
      await f.close();
    }
  });
});
