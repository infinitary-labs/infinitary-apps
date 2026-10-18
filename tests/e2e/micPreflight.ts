import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import electronPath from "electron";

/**
 * Whether the fake microphone opens, asked once before the journeys start
 * (INF-391). Chromium's fake device keeps the app from asking for the
 * microphone, but coreaudiod still asks macOS for it on behalf of the
 * responsible process. In a virtual Mac that process is the lane's guest
 * agent: with no grant macOS raises a prompt nobody answers and
 * getUserMedia never settles, so every voice journey fails late and one at
 * a time. This fails the run at once, saying what to grant.
 */
export type MicProbe = "opened" | "refused" | "no-answer";

const PROBE_BUDGET_MS = 20_000;

export function micPreflightFailure(probe: MicProbe): string | null {
  if (probe === "opened") return null;
  return (
    `The fake microphone did not open (${probe}). On a virtual Mac, macOS asks for microphone ` +
    "access for the process that started the run, usually the lane's guest agent, and a prompt " +
    "nobody answers holds getUserMedia forever. Grant kTCCServiceMicrophone to that process in " +
    'the image (docs/testing.md, "The runner\'s microphone access").'
  );
}

/** A virtual Mac, as macOS itself reports it. */
export function inVirtualMac(): boolean {
  if (process.platform !== "darwin") return false;
  const read = spawnSync("sysctl", ["-n", "kern.hv_vmm_present"], { encoding: "utf8" });
  return read.stdout.trim() === "1";
}

export function probeMicrophone(): Promise<MicProbe> {
  return new Promise((resolve) => {
    const child = spawn(String(electronPath), [join(__dirname, "micProbe.cjs")], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("no-answer");
    }, PROBE_BUDGET_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "opened" : "refused");
    });
  });
}

/** Throws before any test when this runner cannot open the microphone. */
export async function checkMicrophone(): Promise<void> {
  if (!inVirtualMac() && process.env.INFINITARY_E2E_MIC_PREFLIGHT !== "1") return;
  const failure = micPreflightFailure(await probeMicrophone());
  if (failure) throw new Error(failure);
}
