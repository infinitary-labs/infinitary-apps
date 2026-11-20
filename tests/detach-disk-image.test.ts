import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { scratchDir } from "./helpers/scratchDirs";

// Alpha run 43373559685: the disk image passed every installer check, then
// its unmount answered this while one of macOS's own scans (XProtect
// Remediator, running as the system) held a file on it, and the check failed
// with that status. The account's lsof saw no holder.
const BUSY = { stderr: 'hdiutil: couldn\'t unmount "disk15" - Resource busy\n', status: 16 };

function detach(answers: { plain: number; force: number }) {
  const root = scratchDir("inf-detach-disk-image-");
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  mkdirSync(bin);
  writeFileSync(calls, "");
  // Stand-ins replay hdiutil's answers in order and record each detach.
  writeFileSync(
    join(bin, "hdiutil"),
    [
      "#!/bin/bash",
      'echo "$*" >> "$CALLS"',
      'if [[ "$2" == -force ]]; then STATUS="$FORCE"; else STATUS="$PLAIN"; fi',
      `[[ "$STATUS" == 0 ]] && { echo '"disk15" ejected.'; exit 0; }`,
      'printf "%s" "$BUSY_STDERR" >&2',
      'exit "$STATUS"',
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "lsof"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  const mount = join(root, "mount");
  const result = spawnSync("bash", ["scripts/detach-disk-image.sh", mount], {
    encoding: "utf8",
    env: {
      ...hostEnv(),
      PATH: `${bin}:${hostEnv().PATH}`,
      CALLS: calls,
      BUSY_STDERR: BUSY.stderr,
      PLAIN: String(answers.plain),
      FORCE: String(answers.force),
    },
  });
  return { ...result, mount, calls: readFileSync(calls, "utf8").trim().split("\n") };
}

it("detaches an image nobody holds without forcing it", () => {
  const result = detach({ plain: 0, force: 0 });
  expect(result.status).toBe(0);
  expect(result.calls).toEqual([`detach ${result.mount}`]);
});

it("forces off a read-only image something outside the check holds, so a passed check passes", () => {
  const result = detach({ plain: BUSY.status, force: 0 });
  expect(result.status).toBe(0);
  expect(result.calls).toEqual([`detach ${result.mount}`, `detach -force ${result.mount}`]);
  expect(result.stderr).toContain(`${result.mount} is busy`);
  expect(result.stderr).toContain(`detached ${result.mount} by force`);
});

it("fails the check when even a forced detach cannot remove the image", () => {
  const result = detach({ plain: BUSY.status, force: BUSY.status });
  expect(result.status).toBe(BUSY.status);
  expect(result.calls).toEqual([`detach ${result.mount}`, `detach -force ${result.mount}`]);
});
