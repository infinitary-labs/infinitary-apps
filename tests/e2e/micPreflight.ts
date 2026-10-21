import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { inVirtualMac } from "./virtualMac";

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

/**
 * The run's switch for this check: "1" asks for it on any Mac, and "0" turns
 * it off for a run whose specs open no microphone.
 */
export const MIC_PREFLIGHT = "INFINITARY_E2E_MIC_PREFLIGHT";

/**
 * Whether the run checks the microphone: in a virtual Mac or when asked with
 * "1", unless the run turned it off with "0" (INF-726: the run-evidence
 * fixture runs booted Electron for it before their first spec).
 */
export function micPreflightAsked(setting: string | undefined, virtualMac: boolean): boolean {
  if (setting === "0") return false;
  return virtualMac || setting === "1";
}

export function probeMicrophone(): Promise<MicProbe> {
  return new Promise((resolve) => {
    // Playwright loads this as an ES module, where there is no __dirname.
    const probe = fileURLToPath(new URL("./micProbe.cjs", import.meta.url));
    const child = spawn(String(electronPath), [probe], {
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
  if (!micPreflightAsked(process.env[MIC_PREFLIGHT], inVirtualMac())) return;
  const failure = micPreflightFailure(await probeMicrophone());
  if (failure) throw new Error(failure);
}
