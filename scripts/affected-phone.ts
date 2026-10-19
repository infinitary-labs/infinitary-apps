import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// INF-79 / INF-136: the captain requested the native gate on phone/shared-contract PRs.
// Include the captain's approved gate setup inputs, not broad shared/core/package changes.
const INPUTS = [
  "ios/", "scripts/generate-phone-cards.ts", "scripts/generate-phone-contract.ts", "scripts/phone-contract-shapes.ts",
  ".github/workflows/phone.yml", "scripts/test-phone.ts", "tests/helpers/phoneHome.ts", "tests/helpers/phoneKeyboard.ts",
  "scripts/phone-test-home.ts", "scripts/affected-phone.ts", "scripts/with-mac-check.py",
  "scripts/replaced-phone-runs.ts",
  // INF-524: the device gates' virtual Mac path, which PHONE_VIRTUAL_MAC switches on.
  "scripts/virtual-mac/phone.sh", "scripts/virtual-mac/phone-job.sh", "scripts/virtual-mac/vm.sh",
] as const;

// INF-496: the phone and the computer come from the same pull request, so a new contract
// version number (a first-number change included) reaches the phone only as this one line.
// docs/contract.json alone is not an input; its other effects arrive as other lines here.
export const GENERATED_CONTRACT = "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneContract.generated.swift";
const VERSION_LINE = /^[+-]\s*public static let version = /;

/** True when a zero-context diff of the generated file changes only its version line. */
export function versionOnly(diff: string | undefined): boolean {
  if (diff === undefined) return false;
  const changed = diff.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
  return changed.length > 0 && changed.every((line) => VERSION_LINE.test(line));
}

export function phoneDecision(
  paths: readonly string[] | undefined,
  generatedDiff?: string,
): { run: boolean; reasons: string[] } {
  if (!paths) return { run: true, reasons: ["The change could not be read; run the native gate."] };
  const reasons = paths.filter((path) =>
    path === GENERATED_CONTRACT && versionOnly(generatedDiff) ? false
    : INPUTS.some((input) => input.endsWith("/") ? path.startsWith(input) : path === input));
  return { run: reasons.length > 0, reasons };
}

function main(): void {
  const { values } = parseArgs({ options: { base: { type: "string", default: "origin/main" }, head: { type: "string", default: "HEAD" } } });
  let paths: string[] | undefined;
  try {
    paths = execFileSync("git", ["diff", "--name-only", "-z", `${values.base}...${values.head}`, "--"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).split("\0").filter(Boolean);
  } catch { /* An unreadable comparison must not silently omit the gate. */ }
  let generatedDiff: string | undefined;
  if (paths?.includes(GENERATED_CONTRACT)) {
    try {
      generatedDiff = execFileSync("git", ["diff", "-U0", `${values.base}...${values.head}`, "--", GENERATED_CONTRACT], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { /* An unreadable file comparison selects the gate. */ }
  }
  const decision = phoneDecision(paths, generatedDiff);
  console.log(`run=${decision.run}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    ["### Native phone gate", "", ...(decision.run ? decision.reasons.map((reason) => `- ${reason}`) : ["No phone input changed beyond the contract version number."]), ""].join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
