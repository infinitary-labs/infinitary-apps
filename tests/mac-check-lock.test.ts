import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { scratchDir } from "./helpers/scratchDirs";

// INF-869: remove command admission after the tests tolerate heavy load.
// Execute real workflow/package commands, holding only their expensive workload.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml");
type Kind = "desktop" | "phone" | "package" | "placed-phone" | "virtual-phone" | "release-phone";
function fixture() {
  const root = scratchDir("infinitary-mac-check-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const workload = `#!${process.execPath}
if (process.env.CHECK_FAIL) process.exit(7);
if (require('node:path').basename(process.argv[1]) === 'pnpm' && process.argv[2] !== 'build') process.exit(0);
console.log('args:' + JSON.stringify(process.argv.slice(2)));
console.log('started:' + process.env.CHECK_NAME);
process.stdin.once('data', () => process.exit(0));
// INF-2259 adds a runner after the build: releasing the command also releases
// later workloads inheriting its now-closed input, not just the first stage.
process.stdin.once('end', () => process.exit(0));
setInterval(() => {}, 60000);
`;
  for (const name of ["pnpm", "tart"]) writeFileSync(join(bin, name), workload, { mode: 0o755 });
  writeFileSync(join(root, "workload"), workload);
  writeFileSync(
    join(bin, "sysctl"),
    '#!/bin/bash\n[ "$*" = "-n kern.hv_vmm_present" ] || exit 1\necho "${CHECK_VMM:-0}"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "node"),
    `#!/bin/bash
if [ "$1" = scripts/checks-mode.ts ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "workload"))} "$@"
`,
    { mode: 0o755 },
  );
  const events: string[] = [];
  const children: { stop(): void; result: Promise<number | null> }[] = [];
  function launch(name: string, kind: Kind, fail = false, parts = "") {
    // INF-2202: release checks now call the combined unsigned gate, not host steps.
    const release = kind === "release-phone";
    const phoneWorkflow = release
      ? yaml.load(readFileSync(".github/workflows/ios-release.yml", "utf8")).jobs.phone.uses
      : ".github/workflows/phone.yml";
    const command =
      kind === "package"
        ? JSON.parse(readFileSync("package.json", "utf8")).scripts["test:phone"]
        : yaml
            .load(
              readFileSync(
                kind === "desktop" ? ".github/workflows/journeys.yml" : phoneWorkflow,
                "utf8",
              ),
            )
            .jobs[kind === "desktop" ? "affected-journeys" : "native-phone"].steps.find(
              (step: { id?: string }) => step.id === (kind === "desktop" ? "e2e" : "both"),
            ).run;
    const child = spawn("bash", ["-e", "-c", command], {
      cwd: resolve("."),
      env: {
        ...hostEnv(),
        HOME: home,
        CFFIXED_USER_HOME: home,
        INFINITARY_LOCAL_CODESIGN_DIR: join(home, "unused-signing"),
        PATH: `${bin}:${hostEnv().PATH}`,
        RUNNER_TEMP: root,
        INFINITARY_CHECKS: "local",
        FILES: "tests/e2e/activity-runs.spec.ts",
        CHECK_NAME: name,
        CHECK_FAIL: fail ? "yes" : "",
        CHECK_VMM: kind === "placed-phone" ? "1" : "0",
        PHONE_VIRTUAL_MAC: kind === "virtual-phone" ? "together" : "",
        PHONE_PARTS: parts,
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
      events.push(`${name}: ${line}`);
      for (const hear of waiting) hear(line);
    });
    const result = new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        ended = true;
        events.push(`${name}: exited ${signal ?? code}`);
        reader.close();
        for (const hear of waiting) hear(null);
        done(code);
      });
    });
    const work = {
      wait(wanted: string | RegExp): Promise<string> {
        const matches = (line: string) =>
          typeof wanted === "string" ? line === wanted : wanted.test(line);
        return new Promise((done, reject) => {
          const seen = lines.find(matches);
          if (seen !== undefined) return done(seen);
          if (ended) return reject(new Error(`${name} exited before ${wanted}: ${errors}`));
          const hear = (line: string | null) => {
            if (line !== null && !matches(line)) return;
            waiting.delete(hear);
            if (line === null) reject(new Error(`${name} exited before ${wanted}: ${errors}`));
            else done(line);
          };
          waiting.add(hear);
        });
      },
      release() {
        child.stdin.end("release\n");
      },
      stop() {
        if (!ended && child.pid) {
          try {
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
    events,
    async close() {
      for (const work of children) work.stop();
      await Promise.all(children.map((work) => work.result));
    },
  };
}

describe.skipIf(process.platform === "win32")("Mac check commands without admission locks", () => {
  it.each(["phone", "package", "placed-phone", "virtual-phone", "release-phone"] as const)(
    "starts %s beside held journeys without waiting for them to exit",
    async (kind) => {
      const f = fixture();
      try {
        const desktop = f.launch("journeys", "desktop");
        await desktop.wait("started:journeys");
        const phone = f.launch("phone", kind);
        await phone.wait("started:phone");
        const second = f.launch("other-journeys", "desktop");
        await second.wait("started:other-journeys");
        expect(f.events.filter((line) => line.includes("started:"))).toEqual([
          "journeys: started:journeys",
          "phone: started:phone",
          "other-journeys: started:other-journeys",
        ]);
        expect(f.events.some((line) => line.includes("exited"))).toBe(false);
        if (kind !== "package") {
          const args = JSON.parse((await phone.wait(/^args:/)).slice(5));
          expect(args).toContain("--both");
          // INF-2202: ordinary and release calls both check both devices in the guest,
          // even with a stale clone switch or a host-looking sysctl reading.
          expect(
            args.slice(args.indexOf("--simulators"), args.indexOf("--simulators") + 2),
          ).toEqual(["--simulators", "1"]);
          expect(args).not.toContain("--part");
          console.info(
            "Phone workflow invocation (stand-in workload):",
            kind,
            JSON.stringify(args),
          );
        }
        for (const work of [desktop, phone, second]) work.release();
        expect(await Promise.all([desktop.result, phone.result, second.result])).toEqual([0, 0, 0]);
      } finally {
        await f.close();
      }
    },
  );
  // INF-2101: changing the VM default preserves requests for named parts, not just full gates.
  // Run the same real workflow command used above, with the Cards/rest request the sampler reaches.
  it.each(["phone", "placed-phone"] as const)("preserves selected parts on %s", async (kind) => {
    const f = fixture();
    try {
      const phone = f.launch("selected", kind, false, "cards rest");
      const args = JSON.parse((await phone.wait(/^args:/)).slice(5)) as string[];
      expect(args.flatMap((arg, index) => (arg === "--part" ? [args[index + 1]] : []))).toEqual([
        "cards",
        "rest",
      ]);
      expect(args).toContain("--both");
      phone.release();
      expect(await phone.result).toBe(0);
    } finally {
      await f.close();
    }
  });
  it.each([
    "desktop",
    "phone",
    "package",
    "placed-phone",
    "virtual-phone",
    "release-phone",
  ] as const)("preserves a failing %s command's status", async (kind) => {
    const f = fixture();
    try {
      expect(await f.launch("failed", kind, true).result).toBe(7);
    } finally {
      await f.close();
    }
  });
  it("cancels both held checks", async () => {
    const f = fixture();
    try {
      const desktop = f.launch("journeys", "desktop");
      const phone = f.launch("phone", "phone");
      await Promise.all([desktop.wait("started:journeys"), phone.wait("started:phone")]);
      desktop.stop();
      phone.stop();
      for (const code of await Promise.all([desktop.result, phone.result])) {
        expect(code).not.toBe(0);
      }
    } finally {
      await f.close();
    }
  });
});
