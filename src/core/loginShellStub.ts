import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in for the person's `$SHELL`, for tests of the host search path
 * (`hostEnv.ts`). It answers `-ilc <command>` and `-lc <command>` the way a
 * real shell does after its startup files ran: `interactive` / `login` are
 * the startup files' own shell text for each mode (set PATH, print a
 * banner, hang), then the command runs under /bin/sh, then
 * `afterInteractive` (what an interactive shell prints on its way out). Every invocation is
 * logged, one mode per line, so a test can count asks.
 */
export function writeLoginShellStub(
  dir: string,
  startup: { interactive?: string; login?: string; afterInteractive?: string },
): { shell: string; log: string } {
  mkdirSync(dir, { recursive: true });
  const shell = join(dir, "stub-shell");
  const log = join(dir, "stub-shell.log");
  writeFileSync(
    shell,
    `#!/bin/sh
echo "$1" >> '${log}'
case "$1" in
  -ilc)
${startup.interactive ?? ":"}
  ;;
  -lc)
${startup.login ?? ":"}
  ;;
esac
/bin/sh -c "$2"
status=$?
if [ "$1" = -ilc ]; then
${startup.afterInteractive ?? ":"}
fi
exit $status
`,
  );
  chmodSync(shell, 0o755);
  return { shell, log };
}

/** A program named `name` in `dir` that prints `output`, as an installer would leave it. */
export function plantProgram(dir: string, name: string, output: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho '${output}'\n`);
  chmodSync(path, 0o755);
  return path;
}
