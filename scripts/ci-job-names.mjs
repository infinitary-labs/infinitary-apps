/**
 * The CI job names' one reader (INF-2413, piece 2 of INF-2410's approved
 * plan; the captain: "i want to distinguish what triggered the job and what
 * they check", scheme "A. Trigger first"). Every job is named
 * `Trigger · Purpose (platform or device; group or round)`, and a job a
 * reusable workflow runs carries its caller's trigger on every level of
 * GitHub's full name: `Main push · Desktop checks / Main push · Linux journeys
 * / Main push · App journeys (Linux; serial group 3/4)`.
 *
 * The readers that judge a run by its jobs (the alpha's proof, stable
 * promotion, the phone's order and cancellation, installer reuse, journey
 * timing) read runs named before and after the rename, so they compare
 * `legacyJobName(name)`, which turns a trigger-first name into the name the
 * same job had before. A name whose every level does not lead with a known
 * trigger is returned unchanged, so a partly renamed or unknown name never
 * passes for a known job. Workflow files, job ids, run titles and artifact
 * names did not change; docs/testing.md, "CI job names", says the scheme.
 */

/** What started the run, as each job name leads with it (docs/testing.md, "CI job names"). */
export const TRIGGERS = Object.freeze([
  "Pull request",
  "Pull request comment",
  "New issue",
  "Branch push",
  "Main push",
  "Manual request",
  "Merge batch",
  "Automatic alpha",
  "Requested alpha",
  "Requested stable",
  "Requested alpha rehearsal",
  "Requested stable rehearsal",
  "Requested TestFlight",
  "Requested TestFlight status",
]);

const LEAD = " · ";

export function splitLevel(level) {
  const at = level.indexOf(LEAD);
  if (at < 0) return null;
  const trigger = level.slice(0, at);
  const purpose = level.slice(at + LEAD.length);
  return TRIGGERS.includes(trigger) && purpose.trim() !== "" ? { trigger, purpose } : null;
}

// The purposes whose jobs a reader judges, each with the name it had before.
// A job added since keeps its purpose as its name: verify.yml's Linux code
// checks and build and its test groups (INF-2646), which together check what
// its one `linux-checks` job did, and its three Mac lanes (INF-2779), which
// together check what its one `mac` job did, so no new name reads as that one.
const LEGACY = new Map([
  ["Desktop checks", "verify"],
  ["Code, build and all test groups (Linux)", "linux-checks"],
  ["Native tests, journeys, replay and package (Mac)", "mac"],
  ["Every app journey (Mac)", "mac"],
  ["Linux journeys", "linux-e2e"],
  ["Signed installer checks", "Verify signed installer and updater"],
  ["Build signed test copies (Mac)", "Build signed verification copies"],
  ["Install and update (Mac; Apple silicon)", "Apple silicon"],
  ["Install and update (Mac; Intel)", "Intel"],
  ["Published-alpha update check", "Update from the last published alpha"],
  ["Apply published-alpha update (Mac; Apple silicon)", "Apple silicon"],
  ["Check release notes", "Check the release notes"],
  ["Phone checks (iPhone and iPad)", "native-phone"],
  ["Wait-clock tests (iPhone and iPad)", "native-phone"],
  // INF-2970's fix 1: a request's iPad and iPhone run as two jobs of native-phone.
  ["Phone checks (iPad)", "native-phone"],
  ["Phone checks (iPhone)", "native-phone"],
  ["Wait-clock tests (iPad)", "native-phone"],
  ["Wait-clock tests (iPhone)", "native-phone"],
  ["Confirm TestFlight availability", "availability"],
]);

const LEGACY_PATTERNS = [
  [/^App journeys \(Linux; (parallel|serial) group (\d+)\/(\d+)\)$/,
    (lane, shard, total) => `journeys (${lane === "serial" ? "desktop" : lane} ${shard}/${total})`],
  [/^Fresh-start app journeys \(Linux; group (\d+)\/(\d+)\)$/,
    (shard, total) => `journeys (run alone ${shard}/${total})`],
  [/^(?:Starter|Selected) app journeys \(Linux; (parallel|serial)(?:; part \d+\/\d+)?\)$/,
    (lane) => `source-desktop (${lane === "serial" ? "desktop" : lane})`],
  [/^Covered by batch run (\d+)$/, (run) => `covered by batch ${run}`],
  [/^Batch verdict \(tree ([0-9a-f]+)\)$/, (tree) => `verdict (tree ${tree})`],
];

function legacyPurpose(purpose) {
  if (LEGACY.has(purpose)) return LEGACY.get(purpose);
  for (const [pattern, legacy] of LEGACY_PATTERNS) {
    const match = pattern.exec(purpose);
    if (match) return legacy(...match.slice(1));
  }
  return purpose;
}

/**
 * The name `name`'s job had before the rename, level by level; the batch's
 * sweep, which called verify.yml as `sweep`, reads as `verify` like main's.
 * An older name comes back as it was, apart from that.
 */
export function legacyJobName(name) {
  const levels = name.split(" / ");
  const split = levels.map(splitLevel);
  if (split.every(Boolean)) return split.map((level) => legacyPurpose(level.purpose)).join(" / ");
  return levels.map((level, index) => (index === 0 && level === "sweep" ? "verify" : level)).join(" / ");
}
