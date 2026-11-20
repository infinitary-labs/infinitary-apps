import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { phoneActivityDirectory } from "../scripts/phone-activity";
import { hostEnv } from "../src/core/hostEnv";
import { scratchDir } from "./helpers/scratchDirs";

// INF-869: the captain's exact phone-activity contract protects standalone gates
// from the watchdog without serializing checks or expiring slow activity.
function liveRun(root: string, folder: string, name: string) {
  const env = {
    ...hostEnv(),
    HOME: join(root, "disposable-home"),
    CFFIXED_USER_HOME: join(root, "disposable-home"),
    IDLE_REBOOT_PHONE_ACTIVITY_DIR: folder,
    TZ: "America/Los_Angeles",
  };
  const module = pathToFileURL(resolve("scripts/phone-activity.ts")).href;
  const scratchModule = pathToFileURL(resolve("tests/helpers/scratchDirs.ts")).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir, removeScratchDirs } from ${JSON.stringify(scratchModule)};
import { startPhoneActivity } from ${JSON.stringify(module)};
const owned = scratchDir('phone-owned-work-');
writeFileSync(join(owned, 'work'), 'owned phone fixture');
const activity = startPhoneActivity(process.env);
console.log(JSON.stringify({path: activity.path, pid: process.pid, owned}));
process.stdin.once('data', () => {
  removeScratchDirs();
  writeFileSync(${JSON.stringify(join(root, `${name}-teardown`))}, 'cleanup completed');
  activity.close();
});
`,
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (part) => {
    errors += part;
  });
  const reader = createInterface({ input: child.stdout });
  const result = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      reader.close();
      done(code);
    });
  });
  const ready = new Promise<{ path: string; pid: number; owned: string }>((done, reject) => {
    reader.once("line", (line) => {
      try {
        done(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    result.then(
      () => reject(new Error(`Activity supervisor exited before ready: ${errors}`)),
      reject,
    );
  });
  let finishing = false;
  const finish = async () => {
    if (!finishing && !child.stdin.destroyed) {
      finishing = true;
      child.stdin.end("cleanup\n");
    }
    return result;
  };
  return { ready, finish, env };
}

describe.skipIf(process.platform === "win32")("standalone phone activity", () => {
  it("publishes UTC identities from non-UTC live supervisors and removes only its own record after teardown", async () => {
    const root = scratchDir("infinitary-phone-activity-");
    const folder = join(root, "phone-activity");
    const first = liveRun(root, folder, "first");
    const second = liveRun(root, folder, "second");
    try {
      const [a, b] = await Promise.all([first.ready, second.ready]);
      expect(a.path).not.toBe(b.path);
      expect(existsSync(a.owned)).toBe(true);
      expect(existsSync(b.owned)).toBe(true);
      console.info(
        "Live phone activity records",
        JSON.stringify([a, b].map(({ path }) => JSON.parse(readFileSync(path, "utf8")))),
      );
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      for (const record of [a, b]) {
        const metadata = JSON.parse(readFileSync(record.path, "utf8"));
        const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(record.pid)], {
          env: { ...hostEnv(), LC_ALL: "C", TZ: "UTC" },
          encoding: "utf8",
        })
          .trim()
          .replace(/\s+/g, " ");
        const localStarted = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(record.pid)], {
          env: { ...hostEnv(), LC_ALL: "C", TZ: "America/Los_Angeles" },
          encoding: "utf8",
        })
          .trim()
          .replace(/\s+/g, " ");
        expect(localStarted).not.toBe(started);
        expect(metadata).toEqual({ schemaVersion: 1, pid: record.pid, processStartedAt: started });
        console.info(
          "Cross-time-zone phone identity",
          JSON.stringify({
            invokingTimeZone: first.env.TZ,
            stored: metadata.processStartedAt,
            utc: started,
            local: localStarted,
          }),
        );
        expect(statSync(record.path).mode & 0o777).toBe(0o600);
      }
      expect(readdirSync(folder).sort()).toEqual(
        [a.path, b.path].map((path) => path.slice(folder.length + 1)).sort(),
      );
      expect(await first.finish()).toBe(0);
      expect(readFileSync(join(root, "first-teardown"), "utf8")).toBe("cleanup completed");
      expect(existsSync(a.path)).toBe(false);
      expect(existsSync(a.owned)).toBe(false);
      expect(existsSync(b.owned)).toBe(true);
      expect(existsSync(b.path)).toBe(true);
      console.info("After first supervisor teardown", JSON.stringify(readdirSync(folder)));
      expect(await second.finish()).toBe(0);
      expect(readFileSync(join(root, "second-teardown"), "utf8")).toBe("cleanup completed");
      expect(readdirSync(folder)).toEqual([]);
      expect(existsSync(b.owned)).toBe(false);
      console.info("After both supervisor teardowns", JSON.stringify(readdirSync(folder)));
    } finally {
      await Promise.all([first.finish(), second.finish()]);
    }
  });
  it("uses the real account home rather than a disposable app or test HOME by default", () => {
    const root = scratchDir("infinitary-phone-home-");
    expect(phoneActivityDirectory({ HOME: root, CFFIXED_USER_HOME: root })).toBe(
      join(userInfo().homedir, "Library", "Caches", "infinitary-ci", "phone-activity"),
    );
    expect(phoneActivityDirectory({ IDLE_REBOOT_PHONE_ACTIVITY_DIR: root })).toBe(root);
  });
});
