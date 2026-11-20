import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  earlierRun,
  INSTALLERS_PREFIX,
  inputsKey,
  keptFor,
  type ListedArtifact,
  type ReadRun,
  type TrackedFile,
} from "../scripts/windows-update-builds.ts";

// The captain's pick on INF-5395's velocity review: "Let the Windows update
// check reuse its four built test versions of the app when a run changes no
// app code."

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/windows.yml"), "utf8");

// Real files of this checkout, each named by its content, as git names them.
const PATHS = [
  "src/core/update/windowsInstall.ts",
  "src/core/update/updateChecker.ts",
  "package.json",
  "pnpm-lock.yaml",
  "electron-builder.yml",
  "electron-builder.win.yml",
  "scripts/windows-update-source.ts",
  "tests/windows/updateVersions.ts",
  "tests/windows/updateFeed.ts",
  "tests/windows/windows-update.spec.ts",
  "src/core/update/windowsInstall.test.ts",
  ".github/actions/electron-download/action.yml",
  "docs/windows.md",
];
const FILES: TrackedFile[] = PATHS.map((path) => ({
  path,
  object: createHash("sha1")
    .update(readFileSync(join(ROOT, path)))
    .digest("hex"),
}));

function edited(path: string): TrackedFile[] {
  return FILES.map((file) => (file.path === path ? { path, object: "0".repeat(40) } : file));
}

/** windows.yml with one line added inside the named job's steps. */
function workflowWith(job: string, line: string): string {
  const at = WORKFLOW.indexOf(`\n  ${job}:\n`);
  const steps = WORKFLOW.indexOf("\n    steps:\n", at) + "\n    steps:\n".length;
  return `${WORKFLOW.slice(0, steps)}      - run: ${line}\n${WORKFLOW.slice(steps)}`;
}

describe("the inputs the update check's test installers are built from", () => {
  const key = inputsKey(FILES, WORKFLOW);

  it.each([
    ["the update journey", "tests/windows/windows-update.spec.ts"],
    ["the journey's feed", "tests/windows/updateFeed.ts"],
    ["a unit test beside the app's code", "src/core/update/windowsInstall.test.ts"],
    ["the docs", "docs/windows.md"],
  ])("are the same after a change to %s alone", (_what, path) => {
    expect(inputsKey(edited(path), WORKFLOW)).toBe(key);
  });

  it("are the same after a change to the update job alone", () => {
    expect(inputsKey(FILES, workflowWith("update", "echo update"))).toBe(key);
  });

  it.each([
    ["the app's code", "src/core/update/windowsInstall.ts"],
    ["a package", "pnpm-lock.yaml"],
    ["the shared installer config", "electron-builder.yml"],
    ["the Windows installer config", "electron-builder.win.yml"],
    ["the test versions", "tests/windows/updateVersions.ts"],
    ["what points them at the feed", "scripts/windows-update-source.ts"],
    ["an action the build uses", ".github/actions/electron-download/action.yml"],
  ])("change with %s", (_what, path) => {
    expect(inputsKey(edited(path), WORKFLOW)).not.toBe(key);
  });

  it("change with the build job's steps", () => {
    expect(inputsKey(FILES, workflowWith("build", "echo build"))).not.toBe(key);
  });
});

describe("which earlier run's test installers a run takes", () => {
  const key = "a".repeat(40);
  const now = new Date("2026-11-20T18:00:00Z");
  const repository = 1_087_000_001;
  // As GitHub's list of a repository's artifacts and its read of a run give them.
  function artifact(
    run: number,
    created: string,
    options: Partial<ListedArtifact> = {},
  ): ListedArtifact {
    return {
      name: `${INSTALLERS_PREFIX}${key}`,
      expired: false,
      created_at: created,
      expires_at: new Date(Date.parse(created) + 3 * 24 * 60 * 60 * 1000).toISOString(),
      workflow_run: { id: run, repository_id: repository, head_repository_id: repository },
      ...options,
    };
  }
  const runs = new Map<number, ReadRun>();
  function run(id: number, options: Partial<ReadRun> = {}): void {
    runs.set(id, {
      id,
      path: ".github/workflows/windows.yml",
      event: "workflow_dispatch",
      repository: { id: repository },
      ...options,
    });
  }
  const read = async (id: number) => runs.get(id) as ReadRun;
  run(101);
  run(102);
  run(103, { event: "pull_request" });
  run(104, { path: ".github/workflows/contributors.yml" });
  run(105);

  it("takes the newest dispatched run of this project's windows.yml", async () => {
    const listed = [artifact(101, "2026-11-19T10:00:00Z"), artifact(102, "2026-11-20T09:00:00Z")];
    expect(await earlierRun(key, listed, read, now, keptFor(1), 200)).toBe(102);
  });

  it("refuses an artifact a pull request from another project kept", async () => {
    const fork = artifact(105, "2026-11-20T09:00:00Z", {
      workflow_run: { id: 105, repository_id: repository, head_repository_id: 99 },
    });
    expect(await earlierRun(key, [fork], read, now, keptFor(1), 200)).toBeNull();
  });

  it("refuses an artifact under the name kept by another event or workflow", async () => {
    const listed = [artifact(103, "2026-11-20T09:00:00Z"), artifact(104, "2026-11-20T08:00:00Z")];
    expect(await earlierRun(key, listed, read, now, keptFor(1), 200)).toBeNull();
  });

  it("refuses an artifact under another key", async () => {
    const other = artifact(102, "2026-11-20T09:00:00Z", {
      name: `${INSTALLERS_PREFIX}${"b".repeat(40)}`,
    });
    expect(await earlierRun(key, [other], read, now, keptFor(1), 200)).toBeNull();
  });

  it("refuses an artifact that expires before every update job could read it", async () => {
    // Kept until 21:30, three and a half hours from now: long enough for one round's jobs, not for three rounds one after another.
    const expiring = artifact(101, "2026-11-17T21:30:00Z");
    expect(await earlierRun(key, [expiring], read, now, keptFor(1), 200)).toBe(101);
    expect(await earlierRun(key, [expiring], read, now, keptFor(3), 200)).toBeNull();
    const gone = artifact(102, "2026-11-20T09:00:00Z", { expired: true });
    expect(await earlierRun(key, [gone], read, now, keptFor(1), 200)).toBeNull();
  });
});
