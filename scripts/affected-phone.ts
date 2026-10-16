import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// INF-79 / INF-136: the captain requested the native gate on phone/shared-contract PRs.
// Include the captain's approved gate setup inputs, not broad shared/core/package changes.
const INPUTS = [
  "ios/", "docs/contract.json", "scripts/generate-phone-contract.ts", "scripts/phone-contract-shapes.ts",
  ".github/workflows/phone.yml", "scripts/test-phone.ts", "tests/helpers/phoneHome.ts",
  "scripts/phone-test-home.ts", "scripts/affected-phone.ts", "scripts/with-mac-check.py",
] as const;

export function phoneDecision(paths: readonly string[] | undefined): { run: boolean; reasons: string[] } {
  if (!paths) return { run: true, reasons: ["The change could not be read; run the native gate."] };
  const reasons = paths.filter((path) => INPUTS.some((input) => input.endsWith("/") ? path.startsWith(input) : path === input));
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
  const decision = phoneDecision(paths);
  console.log(`run=${decision.run}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    ["### Native phone gate", "", ...(decision.run ? decision.reasons.map((reason) => `- ${reason}`) : ["No phone or shared-contract input changed."]), ""].join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
