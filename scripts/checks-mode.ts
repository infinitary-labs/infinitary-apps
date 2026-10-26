import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where this computer runs the heavy checks (docs/testing.md, "Where the
 * heavy checks run"; INF-800, the captain's approval: "Only the heavy checks:
 * journeys, the phone check and the replay gate").
 *
 * Local by default, so anyone building Infinitary checks on their own
 * computer. `git config --global infinitary.checks ci` sends the journeys,
 * the phone check and the replay gate through CI instead: each refuses
 * outside CI and names its route on request. Inside CI (`CI` is set) they
 * always run, because the Mac mini's runners read the same user's git
 * settings. `INFINITARY_CHECKS` overrides the git setting for one run.
 */
export type ChecksMode = "local" | "ci";
export type HeavyCheck = "journeys" | "phone" | "replay-gate";

const DISPATCHES = "POST /repos/{owner}/{repo}/actions/workflows";
const ROUTES: Record<HeavyCheck, { name: string; route: string }> = {
  journeys: {
    name: "A committed journey",
    route:
      `start journeys.yml on your branch: ${DISPATCHES}/journeys.yml/dispatches with ` +
      `{"ref":"<branch>","inputs":{"files":"<journey> <journey>"}}. ` +
      "A pull request runs the journeys its change reaches on its own.",
  },
  phone: {
    name: "The phone check",
    route: `start phone.yml on your branch: ${DISPATCHES}/phone.yml/dispatches with {"ref":"<branch>","inputs":{"affected":"true"}}. Omit affected for every part.`,
  },
  "replay-gate": {
    name: "The replay gate",
    route: `start replay.yml on your branch: ${DISPATCHES}/replay.yml/dispatches with {"ref":"<branch>"}.`,
  },
};

export function checksMode(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ChecksMode {
  let value = env.INFINITARY_CHECKS;
  if (value === undefined || value === "") {
    try {
      value = execFileSync("git", ["config", "--get", "infinitary.checks"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // git exits 1 when the setting is absent.
      value = "";
    }
  }
  if (value === "" || value === "local") return "local";
  if (value === "ci") return "ci";
  throw new Error(`infinitary.checks reads "${value}"; it takes ci or local.`);
}

/** Why this heavy check may not run here, or undefined when it may. */
export function ciModeRefusal(
  check: HeavyCheck,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | undefined {
  if (env.CI) return undefined;
  if (checksMode(env, cwd) !== "ci") return undefined;
  const { name, route } = ROUTES[check];
  return (
    `${name} runs through CI on this computer (git config infinitary.checks = ci). ` +
    `Instead, ${route} An accepted request is not a passing check: find the run and read it.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv[2] as HeavyCheck;
  if (!(check in ROUTES)) {
    console.error(`Usage: node scripts/checks-mode.ts ${Object.keys(ROUTES).join("|")}`);
    process.exit(2);
  }
  const refusal = ciModeRefusal(check);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}
