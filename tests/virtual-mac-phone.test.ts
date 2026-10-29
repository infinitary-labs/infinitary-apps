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
// INF-1068: a fresh image must expose Node to setup-node without a download.
// Exercise the archive installer with the distribution's directory layout and
// a version-reporting executable stand-in; the live proof uses the real archive.
it("publishes only a verified Node installation in the runner tool-cache layout", async () => {
  const root = scratchDir("infinitary-node-cache-");
  const version = "24.14.1";
  const name = `node-v${version}-darwin-arm64`;
  const distribution = join(root, name);
  const cache = join(root, "tool cache");
  mkdirSync(join(distribution, "bin"), { recursive: true });
  const binary = join(distribution, "bin/node");
  writeFileSync(binary, `#!/bin/sh\necho v${version}\n`, { mode: 0o755 });
  const archive = join(root, `${name}.tar.xz`);
  const pack = () => execute("tar", ["-cJf", archive, "-C", root, name], { env: hostEnv() });
  const install = () =>
    execute("bash", ["scripts/virtual-mac/cache-node.sh", archive, cache], { env: hostEnv() });
  await pack();
  const destination = join(cache, "node", version, "arm64");
  expect((await install()).stdout.trim()).toBe(destination);
  expect(existsSync(`${destination}.complete`)).toBe(true);
  expect(
    (await execute(join(destination, "bin/node"), ["--version"], { env: hostEnv() })).stdout.trim(),
  ).toBe(`v${version}`);
  // A failed reinstall cannot retain an old completion marker.
  writeFileSync(binary, "#!/bin/sh\necho v22.0.0\n", { mode: 0o755 });
  await pack();
  await expect(install()).rejects.toMatchObject({ code: 1 });
  expect(existsSync(`${destination}.complete`)).toBe(false);
});

const IMAGE = "infinitary-lane";
const CLONE = `${IMAGE}-phone`;

const TART = `#!/bin/bash
# Each virtual Mac is a folder under vms/; run records its shared folders and holds
# until stop; exec runs the command with the guest's shared paths mapped to them.
state="$TART_STAND_IN"
echo "$*" >> "$state/calls"
vm="$state/vms/$2"
case "$1" in
  set) ;;
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
// --evidence points, or with --both one per device beneath it as the real one does, marking
// each device's lines itself, and fails when told to.
const NODE = `#!/bin/bash
state="$TART_STAND_IN"
evidence="\${@: -1}"
echo "$PWD $*" >> "$state/gates"
printf '%s\\n' "\${PHONE_RECORDING:-}" >> "$state/recordings"
devices=iphone
[ "$2" = --ipad ] && devices=ipad
[ "$2" = --both ] && devices="iphone ipad"
code=0
for device in $devices; do
  folder="$evidence"
  prefix=""
  if [ "$2" = --both ]; then folder="$evidence/$device"; prefix="$device: "; fi
  mkdir -p "$folder/bundle.xcresult"
  echo "$device result" > "$folder/bundle.xcresult/summary"
  echo "$prefix$device checked"
  [ -e "$state/fail-$device" ] && code=3
done
exit "$code"
`;

const PNPM = `#!/bin/bash
echo "$PWD $* $(cat package.json)" >> "$TART_STAND_IN/installs"
`;

function fixture(recording = false, placement: "absent" | "borrow" | "ci" = "absent") {
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
  for (const script of ["phone.sh", "phone-job.sh", "vm.sh", "borrow.sh", "run.sh", "image.sh"])
    copyFileSync(
      join("scripts", "virtual-mac", script),
      join(repo, "scripts", "virtual-mac", script),
    );
  writeFileSync(join(repo, "package.json"), '{"name":"committed"}');
  const env = {
    ...hostEnv(),
    CI: placement === "ci" ? "true" : "",
    BORROWED_PLACE: "",
    BORROWED_VM: "",
    BORROW_MINUTES: "25",
    PATH: `${root}:${(hostEnv().PATH ?? "")
      .split(":")
      .filter((dir) => !existsSync(join(dir, "borrow-virtual-mac")))
      .join(":")}`,
    TART: join(root, "tart.sh"),
    TART_STAND_IN: state,
    PHONE_RECORDING: recording ? "1" : "",
    RUNNER_TEMP: join(root, "runner temp"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  if (placement !== "absent") {
    writeFileSync(
      join(root, "borrow-virtual-mac"),
      `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$TART_STAND_IN/borrows"
[ "$1" = --label ] && [ "$3" = --minutes ] && [ "$4" = 25 ] && [ "$5" = -- ] || exit 64
shift 5
export BORROWED_PLACE=mini-vm2 BORROWED_VM=borrowed-mini-vm2 BORROWED_CPUS=4 BORROWED_MEMORY_MB=16384
set +e
"$@"
status=$?
printf 'released\\n' >> "$TART_STAND_IN/borrows"
exit "$status"
`,
      { mode: 0o755 },
    );
  }
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
    root,
    env,
    repo,
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

// INF-1823 approved plan: borrow a virtual place once for the entire VM
// lifecycle; retain immediate startup when absent and CI's existing placement.
describe.skipIf(process.platform === "win32")("local virtual Mac borrowing", () => {
  it.each(["absent", "borrow", "ci"] as const)(
    "owns the phone lifecycle with placement=%s",
    async (placement) => {
      const f = fixture(false, placement);
      try {
        await f.commit();
        writeFileSync(join(f.state, "fail-ipad"), "");
        if (placement === "borrow") {
          const split = await f.phone("start", f.results);
          expect(split.code).toBe(2);
          expect(f.vms()).toEqual([IMAGE]);
        }
        const run = await f.phone("run", f.results, "iphone", "ipad");
        expect(run.code, run.stdout).toBe(3);
        expect(f.vms()).toEqual([IMAGE]);
        for (const device of ["iphone", "ipad"])
          expect(readFileSync(join(f.results, device, "bundle.xcresult", "summary"), "utf8")).toBe(
            `${device} result\n`,
          );
        const name = placement === "borrow" ? "borrowed-mini-vm2" : CLONE;
        expect(f.calls()).toContain(`clone ${IMAGE} ${name}`);
        expect(f.calls()).toContain(`delete ${name}`);
        if (placement === "borrow") {
          expect(f.calls()).toContain(`set ${name} --cpu 4 --memory 16384`);
          const borrows = f.read("borrows").trim().split("\n");
          expect(borrows).toHaveLength(2);
          expect(borrows[0]).toContain("--label Infinitary phone check --minutes 25 -- /bin/bash");
          expect(borrows[1]).toBe("released");
        } else expect(existsSync(join(f.state, "borrows"))).toBe(false);
      } finally {
        f.close();
      }
    },
  );

  it.each(["absent", "borrow", "ci"] as const)(
    "journeys return their result and delete the clone with placement=%s",
    async (placement) => {
      const f = fixture(false, placement);
      writeFileSync(
        join(f.repo, "scripts/virtual-mac/job.sh"),
        '#!/bin/bash\nprintf 7 > "$OUT/exit"\necho "journey completed"\n',
      );
      try {
        await f.commit();
        await expect(
          execute("bash", [join(f.repo, "scripts/virtual-mac/run.sh"), "example.spec.ts"], {
            env: { ...f.env, OUT: f.results },
          }),
        ).rejects.toMatchObject({ code: 7, stdout: expect.stringContaining("journey completed") });
        expect(readFileSync(join(f.results, "exit"), "utf8")).toBe("7");
        expect(f.vms()).toEqual([IMAGE]);
        const name =
          placement === "borrow"
            ? "borrowed-mini-vm2"
            : f
                .calls()
                .find((call) => call.startsWith("clone "))
                ?.split(" ")[2];
        expect(f.calls()).toContain(`delete ${name}`);
        if (placement === "borrow") {
          expect(f.calls()).toContain(`set ${name} --cpu 4 --memory 16384`);
          expect(f.read("borrows").trim().split("\n")).toHaveLength(2);
        } else expect(existsSync(join(f.state, "borrows"))).toBe(false);
      } finally {
        f.close();
      }
    },
  );

  it.each(["run.sh", "image.sh"])(
    "%s enters the borrow before doing any VM work, and returns its refusal",
    async (script) => {
      const f = fixture(false, "borrow");
      writeFileSync(
        join(f.root, "borrow-virtual-mac"),
        '#!/bin/sh\necho "waiting for a virtual place" >&2\nexit 37\n',
        { mode: 0o755 },
      );
      await expect(
        execute("bash", [join(f.repo, "scripts/virtual-mac", script), "example"], { env: f.env }),
      ).rejects.toMatchObject({ code: 37, stderr: "waiting for a virtual place\n" });
      expect(existsSync(join(f.state, "calls"))).toBe(false);
    },
  );
});

describe.skipIf(process.platform === "win32")("the phone check in a virtual Mac", () => {
  // INF-1066: opt-in simulator evidence reaches the same isolated launcher on either CI route.
  it.each([false, true])("passes recording=%s into the actual guest command", async (recording) => {
    const f = fixture(recording);
    try {
      await f.commit();
      const start = await f.phone("start", f.results);
      expect(start.code, start.stdout).toBe(0);
      const gate = await f.phone("gate", "iphone", "ipad");
      expect(gate.code, gate.stdout).toBe(0);
      expect(f.read("recordings")).toBe(recording ? "1\n" : "\n");
      expect((await f.phone("delete")).code).toBe(0);
    } finally {
      f.close();
    }
  });
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
  // INF-662 piece 1 (the captain's "Approve and build"): one gate builds once and runs both.
  it("runs both devices as one gate from one build and fails when either fails", async () => {
    const f = fixture();
    try {
      await f.commit();
      expect((await f.phone("start", f.results)).code).toBe(0);
      const both = await f.phone("gate", "iphone", "ipad");
      expect(both.code, both.stdout).toBe(0);
      expect(both.stdout).toContain("iphone: iphone checked");
      expect(both.stdout).toContain("ipad: ipad checked");
      const guest = join(f.state, "vms", CLONE, "home", "job", "Application Support", "infinitary");
      const home = join(f.state, "vms", CLONE, "home");
      // One run of the gate for both devices, not one per device, two simulators at a time (INF-662 piece 2).
      expect(f.read("gates")).toBe(
        `${guest} scripts/test-phone.ts --both --simulators 2 --evidence ${home}/phone-results/both\n`,
      );
      // Each device's results land where the Mac mini's gate writes them.
      for (const device of ["iphone", "ipad"])
        expect(readFileSync(join(f.results, device, "bundle.xcresult", "summary"), "utf8")).toBe(
          `${device} result\n`,
        );
      writeFileSync(join(f.state, "fail-iphone"), "");
      const failed = await f.phone("gate", "iphone", "ipad");
      expect(failed.code, failed.stdout).toBe(3);
      expect(failed.stdout).toContain("ipad: ipad checked");
      expect(f.calls().filter((call) => call.startsWith("clone "))).toHaveLength(1);
      expect((await f.phone("delete")).code).toBe(0);
      expect(f.vms()).toEqual([IMAGE]);
    } finally {
      f.close();
    }
  });
});

// INF-719 and INF-621: preserve the responsible agents, but configure both
// services as Interactive and verify their disk AND loaded launchd settings.
// The plist keys and launchctl line follow U12's real guest readings.
describe.skipIf(process.platform === "win32")("the image's guest services", () => {
  it("configures both services and refuses missing, unsaved or unloaded Interactive settings", async () => {
    const root = scratchDir("infinitary-guest-services-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const labels = ["org.cirruslabs.tart-guest-daemon", "org.cirruslabs.tart-guest-agent"];
    const services = labels.map((label, index) => ({
      label,
      domain: index === 0 ? "system" : `gui/${process.getuid?.()}`,
      plist: {
        EnvironmentVariables: { PATH: "/usr/bin:/bin" },
        ...(index === 0 ? { ProcessType: "Background" } : {}),
      },
      loaded: "background",
    }));
    const state = join(root, "services.json");
    writeFileSync(state, JSON.stringify(services));
    // Stand in only for privileged system reads/writes, never run host sudo.
    writeFileSync(
      join(bin, "sudo"),
      `#!/usr/bin/env python3
import json, os, sys
path = os.environ["GUEST_SERVICES_STATE"]
with open(path) as f: services = json.load(f)
args = sys.argv[2:]
if args[0] == "/usr/libexec/PlistBuddy":
    service = next(s for s in services if args[-1].endswith(s["label"] + ".plist"))
    command = args[2].split(" ", 2)
    action, key = command[:2]
    target = service["plist"]
    keys = key.strip(":").split(":")
    for part in keys[:-1]: target = target[part]
    key = keys[-1]
    if action == "Print":
        if key not in target: sys.exit(1)
        print(target[key])
    else:
        if action == "Set" and key not in target: sys.exit(1)
        target[key] = command[2].removeprefix("string ") if action == "Add" else command[2]
        with open(path, "w") as f: json.dump(services, f)
elif args[:2] == ["/bin/launchctl", "print"]:
    service = next(s for s in services if args[2] == s["domain"] + "/" + s["label"])
    print("\\tspawn type = " + service["loaded"])
else: sys.exit(64)
`,
      { mode: 0o755 },
    );
    const run = async (mode: string) =>
      execute("bash", ["scripts/virtual-mac/guest-services.sh", mode], {
        env: {
          ...hostEnv(),
          PATH: `${bin}:${hostEnv().PATH}`,
          HOME: root,
          GUEST_SERVICES_STATE: state,
        },
      });
    await expect(run("verify")).rejects.toMatchObject({ code: 1 });
    await run("configure");
    await run("configure"); // Existing keys must be safely updated too.
    const configured = JSON.parse(readFileSync(state, "utf8")) as typeof services;
    for (const service of configured) {
      expect(service.plist.ProcessType).toBe("Interactive");
      expect(service.plist.EnvironmentVariables.PATH).toBe(
        `${root}/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      );
    }
    await expect(run("verify")).rejects.toMatchObject({ code: 1 });
    // A fresh boot loads the saved properties; editing files alone is not enough.
    for (const service of configured)
      service.loaded = service.plist.ProcessType?.toLowerCase() ?? "background";
    writeFileSync(state, JSON.stringify(configured));
    await run("verify");
    const [daemon, agent] = configured;
    if (!daemon || !agent) throw new Error("Both guest services must remain in the fixture");
    agent.loaded = "background";
    writeFileSync(state, JSON.stringify(configured));
    await expect(run("verify")).rejects.toMatchObject({ code: 1 });
    agent.loaded = "interactive";
    daemon.plist.ProcessType = "Background";
    writeFileSync(state, JSON.stringify(configured));
    await expect(run("verify")).rejects.toMatchObject({ code: 1 });
    daemon.plist.ProcessType = "Interactive";
    delete agent.plist.ProcessType;
    writeFileSync(state, JSON.stringify(configured));
    await expect(run("verify")).rejects.toMatchObject({ code: 1 });
  });

  it.each([0, 7])("only publishes after a clean VM process exit (exit %i)", async (exit) => {
    const root = scratchDir("infinitary-guest-shutdown-");
    const tart = join(root, "tart");
    await execute("mkfifo", [join(root, "booted"), join(root, "shutdown")], { env: hostEnv() });
    writeFileSync(
      tart,
      `#!/bin/bash
case "$1" in
  run)
    touch "$SHUTDOWN_STATE/running"
    printf 'ready\\n' > "$SHUTDOWN_STATE/booted"
    read -r shutdown < "$SHUTDOWN_STATE/shutdown"
    rm "$SHUTDOWN_STATE/running"
    exit "$VM_EXIT" ;;
  exec)
    shift 2
    if [ "$1" = test ]; then
      # The owning fake VM publishes readiness, with no clock or retry.
      read -r ready < "$SHUTDOWN_STATE/booted"
      test "$ready" = ready; exit
    fi
    test "$*" = '/bin/bash -c sudo -n /sbin/shutdown -h now' || exit 64
    touch "$SHUTDOWN_STATE/requested"
    printf 'shutdown\\n' > "$SHUTDOWN_STATE/shutdown"
    exit 1 ;; # The guest connection closed during shutdown.
  stop)
    touch "$SHUTDOWN_STATE/forced"
    if [ -e "$SHUTDOWN_STATE/running" ]; then printf 'stop\\n' > "$SHUTDOWN_STATE/shutdown"; fi ;;
  *) exit 64 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = await execute(
      "bash",
      [
        "-c",
        `set -euo pipefail
source scripts/virtual-mac/vm.sh
trap 'stop_vm image' EXIT
start_vm image "$SHUTDOWN_STATE/run.log" /ready
shutdown_vm image
touch "$SHUTDOWN_STATE/published"
`,
      ],
      { env: { ...hostEnv(), TART: tart, SHUTDOWN_STATE: root, VM_EXIT: String(exit) } },
    ).then(
      () => 0,
      (error: { code: number }) => error.code,
    );
    expect(existsSync(join(root, "requested"))).toBe(true);
    expect(result).toBe(exit);
    expect(existsSync(join(root, "published"))).toBe(exit === 0);
    expect(existsSync(join(root, "running"))).toBe(false);
  });
});

// INF-621: the shared image must supply the iOS 26.1 fixture sshhip's full
// suite explicitly requests. These runtime fields and available-runtime lines
// follow simctl's real readings from the build Mac and the Xcode 26.4 guest.
describe.skipIf(process.platform === "win32")("the shared image's pinned iOS runtime", () => {
  function runtimeFixture() {
    const root = scratchDir("infinitary-image-runtime-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const disk = join(root, "Apple runtime.dmg");
    writeFileSync(disk, "runtime disk boundary");
    writeFileSync(
      join(root, "available"),
      "iOS 26.4 (26.4 - 23E244) - com.apple.CoreSimulator.SimRuntime.iOS-26-4\n",
    );
    const runtime = {
      version: "26.1",
      platformIdentifier: "com.apple.platform.iphonesimulator",
      state: "Ready",
      signatureState: "Verified",
      path: disk,
    };
    writeFileSync(
      join(root, "installed"),
      JSON.stringify({ current: { ...runtime, version: "26.4" }, required: runtime }),
    );
    writeFileSync(
      join(bin, "xcrun"),
      `#!/bin/bash
set -eu
case "$*" in
  'simctl runtime list -j') cat "$RUNTIME_FIXTURE/installed" ;;
  'simctl list runtimes available') cat "$RUNTIME_FIXTURE/available" ;;
  *)
    [ "$1 $2 $3" = 'simctl runtime add' ] || exit 64
    printf '%s\\n' "$4" >> "$RUNTIME_FIXTURE/imports"
    if [ ! -e "$RUNTIME_FIXTURE/import-without-runtime" ]; then
      echo 'iOS 26.1 (26.1 - 23B86) - com.apple.CoreSimulator.SimRuntime.iOS-26-1' >> "$RUNTIME_FIXTURE/available"
    fi ;;
esac
`,
      { mode: 0o755 },
    );
    const env = hostEnv();
    return {
      root,
      disk,
      runtime,
      run: (...args: string[]) =>
        execute("bash", ["scripts/virtual-mac/runtime.sh", ...args], {
          env: { ...env, PATH: `${bin}:${env.PATH}`, RUNTIME_FIXTURE: root },
        }),
    };
  }

  it("locates the requested verified disk and refuses an unverified copy", async () => {
    const f = runtimeFixture();
    expect((await f.run("locate", "26.1")).stdout.trim()).toBe(f.disk);
    writeFileSync(
      join(f.root, "installed"),
      JSON.stringify({ required: { ...f.runtime, signatureState: "Unverified" } }),
    );
    await expect(f.run("locate", "26.1")).rejects.toMatchObject({ code: 1 });
  });

  it("imports the exact shared disk, verifies availability and leaves an installed runtime alone", async () => {
    const f = runtimeFixture();
    await f.run("install", "26.1", f.disk);
    expect(readFileSync(join(f.root, "imports"), "utf8")).toBe(`${f.disk}\n`);
    await f.run("install", "26.1", f.disk);
    expect(readFileSync(join(f.root, "imports"), "utf8")).toBe(`${f.disk}\n`);
  });

  it("refuses to publish an image when a successful import leaves the required runtime absent", async () => {
    const f = runtimeFixture();
    writeFileSync(join(f.root, "import-without-runtime"), "");
    await expect(f.run("install", "26.1", f.disk)).rejects.toMatchObject({ code: 1 });
  });
});
