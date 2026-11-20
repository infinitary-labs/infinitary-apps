import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { linuxStartup, systemdRuntime } from "../src/core/helper/linuxStartup.ts";

// INF-1617, captain: hosted systemd and a plain Ubuntu container must exercise
// the production classifier with real readings, not canned service-manager answers.
const expected = process.argv[2] ?? "";
assert.ok(["available", "at-login", "unavailable"].includes(expected));
assert.equal(process.platform, "linux");
const uid = process.getuid!();
console.log(JSON.stringify({ uid, pid1: readFileSync("/proc/1/comm", "utf8").trim(), runtime: systemdRuntime() }));
const actual = await linuxStartup(async (args) => {
  try {
    const output = execFileSync("systemctl", [...args], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    console.log(JSON.stringify({ command: ["systemctl", ...args], ok: true, output: args.includes("show-environment") ? "user manager answered" : output.trim() }));
    return { ok: true, output };
  } catch (error) {
    const failure = error as { status?: number; code?: string; stderr?: Buffer };
    console.log(JSON.stringify({ command: ["systemctl", ...args], ok: false, status: failure.status, code: failure.code, stderr: failure.stderr?.toString().trim() }));
    return { ok: false, output: "" };
  }
}, uid);
console.log(JSON.stringify({ expected, actual }));
assert.equal(actual, expected);
