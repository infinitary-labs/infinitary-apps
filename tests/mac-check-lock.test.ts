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
const lined = (access: string) => `Mac checks: ${access} waiting for checks queued ahead`;
type Work = {
  wait(line: string | RegExp): Promise<string>;
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
console.log('process:' + process.env.CHECK_NAME + ':' + process.pid + ':' + process.ppid);
if (process.env.CHECK_RECORDS) {
  // INF-692: the process groups the lease's records named as this command started.
  const { readdirSync, readFileSync } = require('node:fs');
  const folder = process.env.CHECK_RECORDS;
  const groups = readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(folder + '/' + name, 'utf8')).group);
  console.log('records:' + process.env.CHECK_NAME + ':' + JSON.stringify(groups));
}
console.log('started:' + process.env.CHECK_NAME);
// Like a real build or gate, it runs until released or signalled, even if its input closes.
process.stdin.once('data', () => process.exit(0));
setInterval(() => {}, 60000);
`;
  // tart stands in for the virtual Mac a switched-on phone gate runs in (INF-524).
  for (const name of ["pnpm", "tart"]) writeFileSync(join(bin, name), workload, { mode: 0o755 });
  // sysctl answers whether the job runs in a virtual Mac, as macOS reports it (INF-658).
  writeFileSync(
    join(bin, "sysctl"),
    `#!/bin/bash\n[ "$*" = "-n kern.hv_vmm_present" ] || exit 1\necho "\${CHECK_VMM:-0}"\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(root, "workload"), workload);
  // INF-648: INF-599's script started node scripts/phone-test-home.ts in the background from
  // a shell, and the helper outlived the run. The node stand-in can do the same.
  writeFileSync(
    join(bin, "node"),
    `#!/bin/bash
# INF-800: the package script asks where the phone check runs before it waits; real Node answers.
if [ "$1" = scripts/checks-mode.ts ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi
if [ -n "$CHECK_LEAVE" ]; then
  ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 60000)' </dev/null >/dev/null 2>&1 &
  echo "left:$!"
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "workload"))} "$@"
`,
    { mode: 0o755 },
  );
  // INF-692: a ps that answers as slowly as on the loaded hosted runner, so a holder reads its
  // processes well after its command could have started.
  const slow = join(root, "slow");
  mkdirSync(slow);
  writeFileSync(
    join(slow, "ps"),
    `#!/bin/bash\nsleep 0.25\nPATH=${JSON.stringify(hostEnv().PATH)} exec ps "$@"\n`,
    { mode: 0o755 },
  );
  const records = join(home, "Library/Caches/infinitary-ci/checks.lock.holders");
  const env = {
    ...hostEnv(),
    HOME: home,
    CFFIXED_USER_HOME: home,
    INFINITARY_LOCAL_CODESIGN_DIR: join(home, "unused-signing"),
    PATH: `${bin}:${hostEnv().PATH}`,
    FILES: "tests/e2e/activity-runs.spec.ts",
    RUNNER_TEMP: root,
    PHONE_VIRTUAL_MAC: "",
  };
  const trace: string[] = [];
  const children: Work[] = [];
  function launch(
    name: string,
    kind: "desktop" | "phone" | "package" | "virtual-phone" | "placed-phone",
    {
      fail = false,
      args = "",
      extra = {},
      limit,
      slowHolder = false,
    }: {
      fail?: boolean;
      args?: string;
      extra?: Record<string, string>;
      limit?: string;
      slowHolder?: boolean;
    } = {},
  ): Work {
    // A virtual Mac gate is the same step with the repository switch set.
    const virtual = kind === "virtual-phone" ? "together" : "";
    const step = kind === "desktop" ? "e2e" : "both";
    const written =
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
              (item: { id?: string }) => item.id === step,
            ).run;
    // A short limit stands in for an hours-long one; the rest of the command is the real one.
    const command = limit ? written.replace(/--max-hold \S+/, `--max-hold ${limit}`) : written;
    if (limit && command === written) throw new Error(`${kind} names no --max-hold to shorten`);
    const child = spawn("bash", ["-e", "-c", command], {
      cwd: resolve("."),
      env: {
        ...env,
        CHECK_NAME: name,
        CHECK_FAIL: fail ? "yes" : "",
        PHONE_VIRTUAL_MAC: virtual,
        // A placed phone is the same step on a runner inside a virtual Mac.
        CHECK_VMM: kind === "placed-phone" ? "1" : "0",
        ...(slowHolder ? { PATH: `${slow}:${env.PATH}`, CHECK_RECORDS: records } : {}),
        ...extra,
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
    const matches = (line: string, wanted: string | RegExp) =>
      typeof wanted === "string" ? line === wanted : wanted.test(line);
    const work = {
      wait: (wanted: string | RegExp) =>
        new Promise<string>((done, reject) => {
          const seen = lines.find((line) => matches(line, wanted));
          if (seen !== undefined) return done(seen);
          if (ended) return reject(new Error(`${name} exited before ${wanted}: ${errors}`));
          const hear = (line: string | null) => {
            if (line !== null && !matches(line, wanted)) return;
            waiting.delete(hear);
            if (line !== null) done(line);
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

// The stand-in's own process and the process that started it, from its first line.
async function processOf(work: Work, name: string) {
  const [, , command, parent] = (await work.wait(new RegExp(`^process:${name}:`))).split(":");
  return { command: Number(command), parent: Number(parent) };
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
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
      const phone = f.launch("phone-a", "phone");
      await phone.wait(queued("exclusive"));
      expect(await f.probe("exclusive", true)).toBe("busy");
      a.release();
      expect(await a.result).toBe(0);
      expect(await f.probe("exclusive", true)).toBe("busy");
      b.release();
      expect(await b.result).toBe(0);
      await phone.wait("started:phone-a");
      expect(await f.probe("shared")).toBe("busy");
      const next = f.launch("phone-b", "phone");
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
      const phone = f.launch("waiting-phone", "phone");
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
      const phone = f.launch("failed-phone", "phone", { fail: true });
      expect(await phone.result).toBe(7);
      const desktop = f.launch("after-failure", "desktop");
      await desktop.wait("started:after-failure");
      desktop.release();
      expect(await desktop.result).toBe(0);
    } finally {
      await f.close();
    }
  });
  // INF-648: two journeys jobs queued behind waiting phones printed nothing after their
  // step header for 80 minutes, so they looked frozen rather than waiting.
  it("prints that a check queued behind a waiting phone is waiting", async () => {
    const f = fixture();
    try {
      const a = f.launch("desktop-a", "desktop");
      await a.wait("started:desktop-a");
      const phone = f.launch("phone-a", "phone");
      await phone.wait(queued("exclusive"));
      const b = f.launch("desktop-b", "desktop");
      await b.wait(lined("shared"));
      // It waits for the line, not for the lease: a shared lease is still free.
      expect(await f.probe("shared")).toBe("free");
      a.release();
      expect(await a.result).toBe(0);
      await phone.wait("started:phone-a");
      await b.wait(queued("shared"));
      phone.release();
      expect(await phone.result).toBe(0);
      await b.wait("started:desktop-b");
      b.release();
      expect(await b.result).toBe(0);
    } finally {
      await f.close();
    }
  });
  // INF-649, from INF-648: six node scripts/phone-test-home.ts helpers a finished phone run
  // left behind kept its exclusive lease for hours, so two journeys jobs held both runner slots.
  it("frees the lease when its command ends, though a process the command left keeps running", async () => {
    const f = fixture();
    let left = 0;
    try {
      const phone = f.launch("leaving-phone", "package", { extra: { CHECK_LEAVE: "yes" } });
      left = Number((await phone.wait(/^left:\d+$/)).slice("left:".length));
      await phone.wait("started:leaving-phone");
      phone.release();
      expect(await phone.result).toBe(0);
      expect(alive(left)).toBe(true);
      expect(await f.probe("exclusive")).toBe("free");
      const desktop = f.launch("desktop-after", "desktop");
      await desktop.wait("started:desktop-after");
      desktop.release();
      expect(await desktop.result).toBe(0);
    } finally {
      if (left && alive(left)) process.kill(left, "SIGKILL");
      await f.close();
    }
  });
  // INF-692: on the loaded hosted runner a command started before its holder had recorded the
  // lease, so a check that found that holder killed or stopped had no record to act on.
  it("starts a command only once its lease is recorded, however slowly the holder reads its processes", async () => {
    const f = fixture();
    try {
      const phone = f.launch("slow-holder", "package", { slowHolder: true });
      const { command } = await processOf(phone, "slow-holder");
      const named = await phone.wait(/^records:slow-holder:/);
      expect(JSON.parse(named.slice("records:slow-holder:".length))).toContain(command);
      phone.release();
      expect(await phone.result).toBe(0);
    } finally {
      await f.close();
    }
  });
  // The captain's ask on INF-649: a lease whose holder is gone is freed on the next attempt,
  // with no human step, and the command it covered does not run on without it.
  it("frees a killed holder's lease for the next check and stops the command it left", async () => {
    const f = fixture();
    try {
      const phone = f.launch("killed-phone", "package");
      const { command, parent: holder } = await processOf(phone, "killed-phone");
      await phone.wait("started:killed-phone");
      expect(holder).not.toBe(process.pid);
      process.kill(holder, "SIGKILL");
      const desktop = f.launch("desktop-next", "desktop");
      await desktop.wait(/^Mac checks: stopping .+, whose holder pid \d+ is gone$/);
      await desktop.wait("started:desktop-next");
      expect(alive(command)).toBe(false);
      expect(await phone.result).not.toBe(0);
      desktop.release();
      expect(await desktop.result).toBe(0);
    } finally {
      await f.close();
    }
  });
  // The captain's ask on INF-649: a lease whose holder's command is gone is freed on the next attempt.
  it("takes the lease back from a holder that outlived its command", async () => {
    const f = fixture();
    let holder = 0;
    try {
      const phone = f.launch("stopped-phone", "package");
      const { parent } = await processOf(phone, "stopped-phone");
      await phone.wait("started:stopped-phone");
      expect(parent).not.toBe(process.pid);
      holder = parent;
      // A stopped holder cannot see its command end, so it keeps the lease.
      process.kill(holder, "SIGSTOP");
      phone.release();
      const desktop = f.launch("desktop-next", "desktop");
      await desktop.wait(
        /^Mac checks: taking the lease back from pid \d+ .*: its command has ended$/,
      );
      await desktop.wait("started:desktop-next");
      expect(alive(holder)).toBe(false);
      desktop.release();
      expect(await desktop.result).toBe(0);
      expect(await phone.result).not.toBe(0);
    } finally {
      if (holder && alive(holder)) process.kill(holder, "SIGKILL");
      await f.close();
    }
  });
  // The captain's ask on INF-649: past its maximum hold, a waiting check takes the lease back
  // and says why; the overdue command stops and its job fails rather than holding a slot.
  it("lets a waiting check take back a lease held past its limit, saying why on both sides", async () => {
    const f = fixture();
    try {
      const phone = f.launch("overdue-phone", "package", { limit: "1s" });
      const { command } = await processOf(phone, "overdue-phone");
      await phone.wait("started:overdue-phone");
      const desktop = f.launch("desktop-next", "desktop");
      await desktop.wait(queued("shared"));
      await desktop.wait(
        /^Mac checks: taking the lease back from pid \d+ .*: held \d+s, over its 1s limit$/,
      );
      await phone.wait(
        /^Mac checks: a waiting check took this lease back: held \d+s, over its 1s limit$/,
      );
      expect(await phone.result).toBe(124);
      await desktop.wait("started:desktop-next");
      // The lease passed on only after the overdue command had stopped.
      expect(alive(command)).toBe(false);
      desktop.release();
      expect(await desktop.result).toBe(0);
    } finally {
      await f.close();
    }
  });
  // INF-517, the captain's answer on INF-79's rule: in a virtual Mac a phone check waits only
  // for a free virtual place, never for running journeys.
  it("starts a virtual Mac's device gate beside running journeys, taking no lease", async () => {
    const f = fixture();
    try {
      const desktop = f.launch("desktop-a", "desktop");
      await desktop.wait("started:desktop-a");
      const both = f.launch("virtual-phone", "virtual-phone");
      await both.wait("started:virtual-phone");
      // Journeys still hold their shared lease, and no phone waits at the entry lock.
      expect(await f.probe("exclusive")).toBe("busy");
      expect(await f.probe("exclusive", true)).toBe("free");
      const next = f.launch("desktop-b", "desktop");
      await next.wait("started:desktop-b");
      for (const work of [both, desktop, next]) work.release();
      expect(await both.result).toBe(0);
      expect(await desktop.result).toBe(0);
      expect(await next.result).toBe(0);
      const failed = f.launch("failed-virtual-phone", "virtual-phone", { fail: true });
      expect(await failed.result).toBe(7);
    } finally {
      await f.close();
    }
  });
  // INF-658 (captain: "Move phone checks off the Mac check lock once the virtual Mac runner
  // works"): a phone job placed in a fresh virtual Mac shares it with no journeys, so its gate
  // starts beside running journeys and takes no lease; on the real Mac it still waits.
  it("starts a placed virtual Mac's device gate beside running journeys, taking no lease", async () => {
    const f = fixture();
    try {
      const desktop = f.launch("desktop-a", "desktop");
      await desktop.wait("started:desktop-a");
      const placed = f.launch("placed-phone", "placed-phone");
      await placed.wait("started:placed-phone");
      expect(await f.probe("exclusive")).toBe("busy");
      expect(await f.probe("exclusive", true)).toBe("free");
      const real = f.launch("real-phone", "phone");
      await real.wait(queued("exclusive"));
      for (const work of [placed, desktop]) work.release();
      expect(await placed.result).toBe(0);
      expect(await desktop.result).toBe(0);
      await real.wait("started:real-phone");
      real.release();
      expect(await real.result).toBe(0);
      const failed = f.launch("failed-placed-phone", "placed-phone", { fail: true });
      expect(await failed.result).toBe(7);
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
      const local = f.launch("local-phone", "package", { args: "--ipad --evidence /tmp/x" });
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
