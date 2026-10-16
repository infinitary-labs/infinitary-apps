import { execFileSync, spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { atUtilityQos } from "./utilityQos";

describe("atUtilityQos", () => {
  it("runs a command through taskpolicy's utility clamp on a Mac that has it", () => {
    const mac = { platform: "darwin" as const, hasTaskpolicy: () => true };
    expect(atUtilityQos("git", ["-C", "/repo", "status"], mac)).toEqual({
      file: "/usr/sbin/taskpolicy",
      args: ["-c", "utility", "git", "-C", "/repo", "status"],
    });
  });

  it("leaves the command alone elsewhere, and on a Mac without the tool", () => {
    for (const host of [
      { platform: "linux" as const, hasTaskpolicy: () => true },
      { platform: "darwin" as const, hasTaskpolicy: () => false },
    ]) {
      expect(atUtilityQos("pnpm", ["install"], host)).toEqual({ file: "pnpm", args: ["install"] });
    }
  });

  it("passes the program's output and exit status through unchanged", () => {
    const command = atUtilityQos("/bin/sh", ["-c", 'printf "%s" "$0-$1"; exit 3', "one", "two"]);
    const run = spawnSync(command.file, command.args, { encoding: "utf8" });
    expect(run.stdout).toBe("one-two");
    expect(run.status).toBe(3);
    const missing = atUtilityQos("infinitary-no-such-program", []);
    expect(() => execFileSync(missing.file, missing.args, { stdio: "ignore" })).toThrow();
  });

  it.runIf(process.platform === "darwin")(
    "execs the program in place, so its pid and signals are the program's own",
    async () => {
      const command = atUtilityQos("/bin/sleep", ["30"]);
      const child = spawn(command.file, command.args, { stdio: "ignore" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const name = execFileSync("ps", ["-o", "comm=", "-p", String(child.pid)], {
          encoding: "utf8",
        }).trim();
        expect(name).toMatch(/sleep$/);
      } finally {
        child.kill("SIGTERM");
      }
      const signal = await new Promise((resolve) => child.on("exit", (_code, sig) => resolve(sig)));
      expect(signal).toBe("SIGTERM");
    },
  );
});
