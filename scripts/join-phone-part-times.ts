/**
 * INF-7175: the part-times.json of a phone check of every part that was dealt into jobs, joined from its jobs.
 *
 * Each dealt job runs only some parts on its own phone Mac, the phone release's call among them (INF-7079's fix 5),
 * so no job's gate writes the whole record. Each gate keeps its ordinary passes' minutes as pass-times.json and its
 * job uploads it; phone.yml's `part-times` job downloads them, one folder per job, and runs
 * `node scripts/join-phone-part-times.ts --jobs <the dealt jobs> --from <that folder> --out <part-times.json>`.
 * It writes the record only when every part on every dealt device has its time, and otherwise names in a warning
 * each pass with none and writes nothing; either way it passes, since the record never holds a check.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { joinPhonePassTimes, PHONE_DEVICES, PHONE_PASS_TIMES, type PhonePassTimes, readPhonePlan } from "./phone-test-plan.ts";

const { values } = parseArgs({ options: { jobs: { type: "string" }, from: { type: "string" }, out: { type: "string" } } });
if (!values.jobs || !values.from || !values.out) throw new Error("Pass --jobs, --from and --out");
const dealt = (JSON.parse(values.jobs) as { passes: unknown }[]).flatMap((job) => readPhonePlan(JSON.stringify(job.passes)));
const devices = PHONE_DEVICES.filter((device) => dealt.some((pass) => pass.device === device));
// download-artifact puts each artifact of a pattern in a folder of its name; a pattern that matched none makes no folder.
const from = values.from;
const kept = (existsSync(from) ? readdirSync(from, { withFileTypes: true }) : [])
  .filter((entry) => entry.isDirectory() && existsSync(join(from, entry.name, PHONE_PASS_TIMES)))
  .map((entry) => JSON.parse(readFileSync(join(from, entry.name, PHONE_PASS_TIMES), "utf8")) as PhonePassTimes);
const { times, missing } = joinPhonePassTimes(devices, kept);
if (missing.length) {
  console.log(`::warning title=Phone part times::The dealt jobs kept no time for ${missing.join(", ")}, so this check keeps no part-times.json`);
} else {
  writeFileSync(values.out, `${JSON.stringify(times, null, 2)}\n`);
  console.log(`Joined every part's time on the ${devices.join(", ")} from ${kept.length} jobs into ${values.out}`);
}
