import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where this computer runs the heavy checks (docs/testing.md, "Where the
 * heavy checks run"; INF-800, the captain's approval: "Only the heavy checks:
 * journeys, the phone check and the replay gate"; INF-2074's ci-gate fix
 * added the typecheck and lint. INF-2273 leaves edited unit-file rounds
 * local for every file; those rounds are not controlled by CI mode.
 *
 * Local by default, so anyone building Infinitary checks on their own
 * computer. `git config --global infinitary.checks ci` sends the journeys,
 * the phone check, the replay gate, the typecheck and the lint through CI
 * instead: each refuses outside CI and names its route on request. Inside CI (`CI` is set) they
 * always run, because the Mac mini's runners read the same user's git
 * settings. `INFINITARY_CHECKS` overrides the git setting for one run.
 */
export type ChecksMode = "local" | "ci";
export type HeavyCheck = "journeys" | "phone" | "replay-gate" | "typecheck" | "lint";

const DISPATCHES = "POST /repos/{owner}/{repo}/actions/workflows";
const PULL_REQUEST_CHECKS =
  "push your branch: its pull request's check \"Pull request · Code, build and affected unit tests (Linux)\" (ci.yml's typecheck-lint-build job) runs it. " +
  `Before a pull request exists, start ci.yml on your branch: ${DISPATCHES}/ci.yml/dispatches with {"ref":"<branch>"}.`;
const ROUTES: Record<HeavyCheck, { name: string; route: string }> = {
  journeys: {
    name: "A committed journey",
    route:
      `start journeys.yml on your branch: ${DISPATCHES}/journeys.yml/dispatches with ` +
      `{"ref":"<branch>","inputs":{"files":"<journey> <journey>"}}. ` +
      "A pull request runs only the critical path (INF-2507), never the others (INF-2139); name only the journeys your change edits, since the journeys it only reaches wait for the swept batch (INF-2576).",
  },
  phone: {
    name: "The phone check",
    route: `start phone.yml on your branch: ${DISPATCHES}/phone.yml/dispatches with {"ref":"<branch>","inputs":{"affected":"true"}}. Every part on a branch also needs task and reason inputs (INF-2576). A pull request does not run it (INF-2139).`,
  },
  "replay-gate": {
    name: "The replay gate",
    route: `start replay.yml on your branch: ${DISPATCHES}/replay.yml/dispatches with {"ref":"<branch>"}.`,
  },
  typecheck: {
    name: "The typecheck",
    route: `run \`pnpm check:changed\` to typecheck here along with the quick lint; the full check is ${PULL_REQUEST_CHECKS}`,
  },
  lint: {
    name: "The lint",
    route: `run \`pnpm check:changed\` to lint your changed files, check the generated files and typecheck here; the full lint is ${PULL_REQUEST_CHECKS}`,
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
  journeyArgs: readonly string[] = [],
): string | undefined {
  if (env.CI) return undefined;
  if (checksMode(env, cwd) !== "ci") return undefined;
  // INF-2259: the project-local native route alone may keep CI mode enabled.
  // The config separately verifies explicit existing file filters. Admission
  // covers its build and the nested launcher, which checks the inherited hold.
  if (check === "journeys" && process.platform === "darwin" &&
      env.INFINITARY_SELECTED_MAC === "1" && env.INFINITARY_LOAD_HOLD &&
      journeyArgs.includes("--no-deps") &&
      journeyArgs[journeyArgs.indexOf("--grep") + 1] === "@mac-only") return undefined;
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
