import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { scratchDir } from "./helpers/scratchDirs";

// Journeys run 44472083618's part 5 on the PC's job image, whose packages
// already held every one of the Linux desktop's: the step still refreshed the
// package lists (12.4 MB at 33 kB/s) and upgraded libgbm1, pulling 28.5 MB of
// Mesa's graphics libraries, and the step's ten minutes ran out before any
// test ran (docs/testing.md, "The runner's automatic updates").
const DESKTOP = ["xvfb", "xdotool", "libgtk-3-0", "libnss3", "libasound2t64", "libgbm1"];

// apt-get's simulated install of those packages with --no-upgrade on that
// image, in the C locale: every package is there, so its plan has no step.
const ALL_THERE = [
  "NOTE: This is only a simulation!",
  "Reading package lists...",
  "Building dependency tree...",
  "Reading state information...",
  "Note, selecting 'libgtk-3-0t64' instead of 'libgtk-3-0'",
  "Skipping xvfb, it is already installed and upgrade is not set.",
  "Skipping libgbm1, it is already installed and upgrade is not set.",
  "0 upgraded, 0 newly installed, 0 to remove and 7 not upgraded.",
].join("\n");

// The same plan on an image without xdotool: it unpacks two packages.
const XDOTOOL_MISSING = [
  "NOTE: This is only a simulation!",
  "The following NEW packages will be installed:",
  "  libxdo3 xdotool",
  "0 upgraded, 2 newly installed, 0 to remove and 7 not upgraded.",
  "Inst libxdo3 (1:3.20160805.1-5build1 Ubuntu:24.04/noble [amd64])",
  "Inst xdotool (1:3.20160805.1-5build1 Ubuntu:24.04/noble [amd64])",
  "Conf libxdo3 (1:3.20160805.1-5build1 Ubuntu:24.04/noble [amd64])",
  "Conf xdotool (1:3.20160805.1-5build1 Ubuntu:24.04/noble [amd64])",
].join("\n");

function install(args: string[], plan: { output: string; status: number }) {
  const root = scratchDir("inf-apt-install-");
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  mkdirSync(bin);
  writeFileSync(calls, "");
  // Stand-ins record each command. sudo writes no system file and takes the
  // daily lock at once; apt-get replays the simulated plan, refreshes the
  // lists with one line and installs nothing.
  writeFileSync(
    join(bin, "sudo"),
    [
      "#!/bin/bash",
      'case "$1" in',
      '  tee) echo "sudo $*" >> "$CALLS"; cat > /dev/null ;;',
      '  flock) echo "sudo $*" >> "$CALLS" ;;',
      '  *) echo "sudo $1" >> "$CALLS"; exec "$@" ;;',
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "apt-get"),
    [
      "#!/bin/bash",
      'echo "apt-get $*" >> "$CALLS"',
      'case " $* " in',
      '  *" --simulate "*) printf "%s\\n" "$PLAN"; exit "$PLAN_STATUS" ;;',
      '  *" update "*) echo "Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease" ;;',
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["scripts/apt-install.sh", ...args], {
    encoding: "utf8",
    env: {
      ...hostEnv(),
      PATH: `${bin}:${hostEnv().PATH}`,
      CALLS: calls,
      PLAN: plan.output,
      PLAN_STATUS: String(plan.status),
    },
  });
  return { ...result, calls: readFileSync(calls, "utf8").trim().split("\n") };
}

const TURN_OFF = "sudo tee /etc/apt/apt.conf.d/99-runner-no-automatic-updates";
const REFRESH = "apt-get -o DPkg::Lock::Timeout=-1 update";

it("downloads and installs nothing when the machine already has every package named", () => {
  const result = install(DESKTOP, { output: ALL_THERE, status: 0 });
  expect(result.status).toBe(0);
  // The plan is apt's own, read before the network and without root, and the
  // helper neither waits for the daily lock nor refreshes or installs.
  expect(result.calls).toEqual([
    TURN_OFF,
    `apt-get --simulate --no-upgrade install ${DESKTOP.join(" ")}`,
  ]);
  expect(result.stdout).toContain("already has every package named");
});

it("refreshes the lists and installs only what is missing, upgrading nothing already there", () => {
  const result = install(DESKTOP, { output: XDOTOOL_MISSING, status: 0 });
  expect(result.status).toBe(0);
  expect(result.calls).toEqual([
    TURN_OFF,
    `apt-get --simulate --no-upgrade install ${DESKTOP.join(" ")}`,
    "sudo flock --nonblock /var/lib/apt/daily_lock true",
    "sudo apt-get",
    REFRESH,
    "sudo apt-get",
    `apt-get -o DPkg::Lock::Timeout=-1 install -y --no-upgrade ${DESKTOP.join(" ")}`,
  ]);
});

it("refreshes the lists when the machine's own lists cannot plan the install", () => {
  const result = install(["--no-install-recommends", "file"], {
    output: "E: Unable to locate package file",
    status: 100,
  });
  expect(result.status).toBe(0);
  expect(result.calls.slice(-3)).toEqual([
    REFRESH,
    "sudo apt-get",
    "apt-get -o DPkg::Lock::Timeout=-1 install -y --no-upgrade --no-install-recommends file",
  ]);
});

it("always installs a .deb file, over an older copy too", () => {
  const deb = "dist/infinitary_1.0.0_amd64.deb";
  const result = install([deb], { output: ALL_THERE, status: 0 });
  expect(result.status).toBe(0);
  // The file names the build to install, so no plan can skip it.
  expect(result.calls).not.toContain(`apt-get --simulate --no-upgrade install ${deb}`);
  expect(result.calls.slice(-3)).toEqual([
    REFRESH,
    "sudo apt-get",
    `apt-get -o DPkg::Lock::Timeout=-1 install -y ${deb}`,
  ]);
});
