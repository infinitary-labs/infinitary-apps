import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Like the git launcher: built for both Mac chips; Linux builds its own executable. */
export function compileLoadSupervisor(out: string, universal = false): void {
  mkdirSync(dirname(out), { recursive: true });
  const minimum = /^\s+minimumSystemVersion:\s*"([\d.]+)"/m.exec(
    readFileSync(resolve(root, "electron-builder.yml"), "utf8"),
  )?.[1];
  const command = universal ? "/usr/bin/xcrun" : "cc";
  const flags = universal
    ? ["clang", "-arch", "arm64", "-arch", "x86_64", `-mmacosx-version-min=${minimum}`]
    : [];
  // Apple's clang leaves an empty folder in TMPDIR for each chip's compile
  // and link of a two-chip build, so the compiler gets a temp folder of its
  // own that goes with it; a test run's temp root must end empty.
  const scratch = mkdtempSync(join(tmpdir(), "load-supervisor-build-"));
  try {
    const result = spawnSync(command, [
      ...flags, "-O2", "-Wall", "-Wextra", "-Werror", "-o", out,
      resolve(root, "scripts/load-supervisor.c"),
    ], { encoding: "utf8", env: { ...process.env, TMPDIR: scratch } });
    if (result.status !== 0)
      throw new Error(`Could not build the load supervisor: ${result.error?.message ?? result.stderr}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function buildLoadSupervisor(): void {
  // Windows has no fork or process groups: a heavy run there runs its program
  // in a Windows job of its own with no supervisor (docs/heavy-runs.md, "On Windows").
  if (process.platform === "win32") return;
  const out = resolve(root, "vendor/load-bin/infinitary-load-supervisor");
  const stamp = `${out}.source`;
  const want = createHash("sha256")
    .update(readFileSync(resolve(root, "scripts/load-supervisor.c")))
    .update(readFileSync(resolve(root, "scripts/build-load-supervisor.ts")))
    .update(readFileSync(resolve(root, "electron-builder.yml")))
    .update(process.platform).digest("hex");
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8") === want) return;
  const partial = `${out}.${process.pid}.partial`;
  try {
    compileLoadSupervisor(partial, process.platform === "darwin");
    renameSync(partial, out);
    writeFileSync(stamp, want);
  } finally {
    rmSync(partial, { force: true });
  }
}
