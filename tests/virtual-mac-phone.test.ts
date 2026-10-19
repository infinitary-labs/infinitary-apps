import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { scratchDir } from "./helpers/scratchDirs";

// INF-524 (the captain's approved plan INF-517): with PHONE_VIRTUAL_MAC set, both device gates
// run in a fresh clone of the lane's image, return the same results as the Mac mini's gates
// and delete the clone. Exercise the real phone.sh and phone-job.sh against a stand-in tart
// whose "virtual Mac" is a folder and whose exec runs the guest's commands here, and a
// stand-in node and pnpm inside the image, replacing only Xcode's simulator work.
const execute = promisify(execFile);
const IMAGE = "infinitary-lane";
const CLONE = `${IMAGE}-phone`;

const TART = `#!/bin/bash
# Each virtual Mac is a folder under vms/; run records its shared folders and holds
# until stop; exec runs the command with the guest's shared paths mapped to them.
state="$TART_STAND_IN"
echo "$*" >> "$state/calls"
vm="$state/vms/$2"
case "$1" in
  clone)
    [ -d "$state/vms/$2" ] && [ ! -e "$state/vms/$3" ] || exit 1
    cp -R "$state/vms/$2" "$state/vms/$3" ;;
  run)
    [ -d "$vm" ] || exit 1
    shift 2
    : > "$vm/shares"
    for arg; do
      case "$arg" in
        --dir=*) spec="\${arg#--dir=}"; printf '%s\\t%s\\n' "\${spec%%:*}" "$(echo "\${spec#*:}" | sed 's/:ro$//')" >> "$vm/shares" ;;
      esac
    done
    touch "$vm/running"
    while [ -e "$vm/running" ]; do sleep 0.05; done ;;
  exec)
    for _ in $(seq 1 100); do [ -e "$vm/running" ] && break; sleep 0.02; done
    [ -e "$vm/running" ] || exit 1
    shift 2
    args=()
    for arg; do
      while IFS=$'\\t' read -r share path; do arg="\${arg//\\/Volumes\\/My Shared Files\\/$share/$path}"; done < "$vm/shares"
      args+=("$arg")
    done
    HOME="$vm/home" exec "\${args[@]}" ;;
  stop) [ -e "$vm/running" ] || exit 1; rm "$vm/running" ;;
  delete) [ -d "$vm" ] && [ ! -e "$vm/running" ] || exit 1; rm -rf "$vm" ;;
  list) ls "$state/vms" ;;
  *) exit 64 ;;
esac
`;

// scripts/test-phone.ts inside the guest: records how it was run, writes a result where
// --evidence points, fails when told to, and with a peer named waits for it to begin.
const NODE = `#!/bin/bash
state="$TART_STAND_IN"
device=iphone
[ "$2" = --ipad ] && device=ipad
evidence="\${@: -1}"
echo "$PWD $*" >> "$state/gates"
mkdir -p "$evidence/bundle.xcresult"
echo "$device result" > "$evidence/bundle.xcresult/summary"
touch "$state/began-$device"
if [ -e "$state/together" ]; then
  peer=ipad; [ "$device" = ipad ] && peer=iphone
  for _ in $(seq 1 200); do [ -e "$state/began-$peer" ] && break; sleep 0.02; done
  [ -e "$state/began-$peer" ] || { echo "$peer never began"; exit 9; }
fi
echo "$device checked"
[ -e "$state/fail-$device" ] && exit 3
exit 0
`;

const PNPM = `#!/bin/bash
echo "$PWD $* $(cat package.json)" >> "$TART_STAND_IN/installs"
`;

function fixture() {
  const root = scratchDir("infinitary-virtual-phone-");
  const state = join(root, "tart");
  const bin = join(state, "vms", IMAGE, "home", "node", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "node"), NODE, { mode: 0o755 });
  writeFileSync(join(bin, "pnpm"), PNPM, { mode: 0o755 });
  writeFileSync(join(root, "tart.sh"), TART, { mode: 0o755 });
  // A committed working copy holding the lane's scripts, and an edit not yet committed.
  const repo = join(root, "Application Support", "firstmate");
  mkdirSync(join(repo, "scripts", "virtual-mac"), { recursive: true });
  for (const script of ["phone.sh", "phone-job.sh", "vm.sh"])
    copyFileSync(
      join("scripts", "virtual-mac", script),
      join(repo, "scripts", "virtual-mac", script),
    );
  writeFileSync(join(repo, "package.json"), '{"name":"committed"}');
  const env = {
    ...hostEnv(),
    TART: join(root, "tart.sh"),
    TART_STAND_IN: state,
    RUNNER_TEMP: join(root, "runner temp"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  mkdirSync(env.RUNNER_TEMP);
  const results = join(env.RUNNER_TEMP, "phone");
  const phone = async (...args: string[]) => {
    try {
      const { stdout } = await execute(
        "bash",
        [join(repo, "scripts/virtual-mac/phone.sh"), ...args],
        {
          cwd: repo,
          env,
        },
      );
      return { code: 0, stdout };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: `${failed.stdout}${failed.stderr}` };
    }
  };
  return {
    state,
    results,
    phone,
    commit: async () => {
      for (const args of [
        ["init", "-q"],
        ["add", "-A"],
        ["commit", "-q", "-m", "committed"],
      ])
        await execute("git", args, { cwd: repo, env });
      writeFileSync(join(repo, "package.json"), '{"name":"not committed"}');
    },
    calls: () => readFileSync(join(state, "calls"), "utf8").trim().split("\n"),
    read: (file: string) => readFileSync(join(state, file), "utf8"),
    vms: () => readdirSync(join(state, "vms")).sort(),
    // Stops any stand-in virtual Mac a failed case left running.
    close: () => {
      for (const vm of readdirSync(join(state, "vms")))
        rmSync(join(state, "vms", vm, "running"), { force: true });
    },
  };
}

describe.skipIf(process.platform === "win32")("the phone check in a virtual Mac", () => {
  it("runs each device in a fresh clone of the lane's image, returns its results and deletes the clone", async () => {
    const f = fixture();
    try {
      await f.commit();
      // A clone an earlier check left behind, which a fresh start must not reuse.
      mkdirSync(join(f.state, "vms", CLONE));
      writeFileSync(join(f.state, "vms", CLONE, "left-behind"), "");
      const start = await f.phone("start", f.results);
      expect(start.code, start.stdout).toBe(0);
      expect(existsSync(join(f.state, "vms", CLONE, "left-behind"))).toBe(false);
      expect(f.calls()).toContain(`clone ${IMAGE} ${CLONE}`);
      const run = f.calls().find((call) => call.startsWith(`run ${CLONE} `)) ?? "";
      expect(run).toContain("--no-graphics");
      expect(run).toContain(`--dir=out:${f.results}`);
      // The guest installs the committed version, never the edit not yet committed.
      const guest = join(f.state, "vms", CLONE, "home", "job", "Application Support", "infinitary");
      expect(f.read("installs")).toBe(`${guest} install --frozen-lockfile {"name":"committed"}\n`);

      const iphone = await f.phone("gate", "iphone");
      expect(iphone.code, iphone.stdout).toBe(0);
      expect(iphone.stdout).toContain("iphone: iphone checked");
      writeFileSync(join(f.state, "fail-ipad"), "");
      const ipad = await f.phone("gate", "ipad");
      expect(ipad.code, ipad.stdout).toBe(3);
      const home = join(f.state, "vms", CLONE, "home");
      expect(f.read("gates")).toBe(
        [
          `${guest} scripts/test-phone.ts --evidence ${home}/phone-results/iphone`,
          `${guest} scripts/test-phone.ts --ipad --evidence ${home}/phone-results/ipad`,
          "",
        ].join("\n"),
      );
      // Each device's results land where the Mac mini's gate writes them, a failed one's too.
      for (const device of ["iphone", "ipad"])
        expect(readFileSync(join(f.results, device, "bundle.xcresult", "summary"), "utf8")).toBe(
          `${device} result\n`,
        );

      const remove = await f.phone("delete");
      expect(remove.code, remove.stdout).toBe(0);
      expect(f.vms()).toEqual([IMAGE]);
      expect(existsSync(join(f.results, "iphone", "bundle.xcresult", "summary"))).toBe(true);
    } finally {
      f.close();
    }
  });
  it("runs both devices at once in one clone and fails when either fails", async () => {
    const f = fixture();
    try {
      await f.commit();
      writeFileSync(join(f.state, "together"), "");
      expect((await f.phone("start", f.results)).code).toBe(0);
      const both = await f.phone("gate", "iphone", "ipad");
      // Each device waited for the other to begin, so they ran at once.
      expect(both.code, both.stdout).toBe(0);
      expect(both.stdout).toContain("iphone: iphone checked");
      expect(both.stdout).toContain("ipad: ipad checked");
      for (const device of ["iphone", "ipad"])
        expect(existsSync(join(f.results, device, "bundle.xcresult", "summary"))).toBe(true);
      writeFileSync(join(f.state, "fail-iphone"), "");
      for (const device of ["iphone", "ipad"]) rmSync(join(f.state, `began-${device}`));
      expect((await f.phone("gate", "iphone", "ipad")).code).toBe(3);
      expect(f.calls().filter((call) => call.startsWith("clone "))).toHaveLength(1);
      expect((await f.phone("delete")).code).toBe(0);
      expect(f.vms()).toEqual([IMAGE]);
    } finally {
      f.close();
    }
  });
});
