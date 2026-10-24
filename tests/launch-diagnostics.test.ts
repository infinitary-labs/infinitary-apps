import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { launchDiagnostics } from "./e2e/launchDiagnostics";
import { scratchDir } from "./helpers/scratchDirs";

it("INF-909 keeps separate launch logs and session diagnostics after disposable userData is removed", () => {
  const root = scratchDir("journey-diagnostics-");
  const userData = join(root, "userData");
  const sessions = join(userData, "crewmates", "task", "sessions");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(userData, "accounts"));
  writeFileSync(join(userData, "accounts", "credentials.json"), "not diagnostic data");
  const note = "[claude] the client stopped: process exited with code 1\n";
  writeFileSync(join(sessions, "client.log"), note);
  const output = join(root, "uploaded-run");
  const first = launchDiagnostics(userData, undefined, output);
  const second = launchDiagnostics(userData, undefined, output);
  expect(first.dir).not.toBe(second.dir);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  first.watch({ stdout, stderr });
  stdout.write("crew started\n");
  stderr.write(note);
  first.snapshot();
  rmSync(userData, { recursive: true });
  first.snapshot();
  first.stop();
  expect(readFileSync(join(first.dir, "main.stdout.log"), "utf8")).toBe("crew started\n");
  expect(readFileSync(join(first.dir, "main.stderr.log"), "utf8")).toBe(note);
  expect(readFileSync(join(first.dir, "crewmates", "task", "sessions", "client.log"), "utf8")).toBe(
    note,
  );
  expect(existsSync(join(first.dir, "accounts"))).toBe(false);
  expect(readFileSync(join(second.dir, "main.stderr.log"), "utf8")).toBe("");
});
