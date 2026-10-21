import { spawnSync } from "node:child_process";

let virtualMac: boolean | undefined;

/** A virtual Mac, as macOS itself reports it; asked once per process. */
export function inVirtualMac(): boolean {
  if (virtualMac === undefined) {
    virtualMac =
      process.platform === "darwin" &&
      spawnSync("sysctl", ["-n", "kern.hv_vmm_present"], { encoding: "utf8" }).stdout?.trim() ===
        "1";
  }
  return virtualMac;
}

/**
 * The Chromium switches every app a journey starts takes in a virtual Mac:
 * it draws in software (INF-747). The virtual Mac's paravirtualized Metal can
 * leave a frame's completion signal unset, and Chromium's GPU process waits
 * for that signal with no limit, so the app draws nothing until the GPU
 * watchdog ends the process 25 to 50 s later, past a screenshot's 30 s
 * (docs/testing.md, "Drawing in software").
 */
export function virtualMacSwitches(): string[] {
  return inVirtualMac() ? ["--disable-gpu"] : [];
}
