import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOAD_COMMAND } from "../src/shared/load.ts";
import { needsMac } from "../tests/lint/e2eMacTag.ts";
import { named as namedJourneys } from "./affected-journeys.ts";
import { journeyRunNeeds, LOCAL_JOURNEY_WORKERS } from "./heavy-run-place.ts";

/** INF-2259: a selected native source check owns build through cleanup under
 * one declaration. No development-signing preparation or global CI-setting edit.
 * Rebuilding on every invocation conservatively follows all source/dependency changes.
 */
function main(): void {
  if (process.platform !== "darwin") throw new Error("Selected native proof needs a Mac.");
  const args = process.argv.slice(2);
  const at = args.indexOf("--base");
  const base = at < 0 ? "origin/main" : args[at + 1];
  const named = at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
  const reasons = namedJourneys(named.join(" "));
  const files = [...reasons.keys()];
  if (!files.length || files.some((file) => !needsMac(readFileSync(file, "utf8"), file)))
    throw new Error("Name only explicit journey files holding Mac-required tests.");
  if (!process.env.INFINITARY_LOAD_HOLD) {
    const needs = journeyRunNeeds(LOCAL_JOURNEY_WORKERS);
    const result = spawnSync(LOAD_COMMAND, ["run", "--processors", String(needs.processors), "--memory-mib", String(needs.memoryMib), "--", process.execPath, fileURLToPath(import.meta.url), ...args], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
    return;
  }
  const build = spawnSync("pnpm", ["build"], { stdio: "inherit" });
  if (build.status !== 0) { process.exitCode = build.status ?? 1; return; }
  const run = spawnSync(process.execPath, ["scripts/journey-runs.ts", "--base", base ?? "origin/main", "--files", files.join(" "), "--alone-tag", "@mac-only", "--", "--grep", "@mac-only", "--workers", String(LOCAL_JOURNEY_WORKERS)], {
    stdio: "inherit",
    env: { ...process.env, INFINITARY_SELECTED_MAC: "1" },
  });
  process.exitCode = run.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
