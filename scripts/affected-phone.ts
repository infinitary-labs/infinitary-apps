import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PHONE_PARTS, type PhonePart } from "./phone-test-plan.ts";

// INF-79 / INF-136: the captain requested the native gate on phone/shared-contract PRs.
// Include the captain's approved gate setup inputs, not broad shared/core/package changes.
const INPUTS = [
  "ios/", "scripts/generate-phone-cards.ts", "scripts/generate-phone-contract.ts", "scripts/phone-contract-shapes.ts",
  ".github/workflows/phone.yml", "scripts/test-phone.ts", "tests/helpers/phoneHome.ts", "tests/helpers/phoneKeyboard.ts",
  "scripts/phone-checks.ts", "scripts/phone-activity.ts",
  // INF-1596: the sweep of earlier runs' simulators and scratch folders at the gate's start.
  "scripts/phone-leftovers.ts",
  // INF-1066: native geometry generation and the scene journey's real home fixture.
  "scripts/generate-phone-scene.ts", "tests/helpers/phoneScene.ts", "scripts/phone-recording.ts",
  "tests/helpers/phoneLogs.ts", "tests/helpers/phoneStacks.ts",
  // INF-662: each device's own test home in the one build's test plan.
  "scripts/phone-test-plan.ts",
] as const;
// INF-827 (the captain's "skip changes to unused setup"): the device gates never run this
// chooser, scripts/replaced-phone-runs.ts or scripts/phone-test-home.ts, so they are not inputs.
// The chooser and the replacement script run on Linux under their own unit tests; the test
// home is for local work only.
// INF-524: the device gates' virtual Mac path, used only while PHONE_VIRTUAL_MAC switches it on.
const VIRTUAL_MAC = ["scripts/virtual-mac/phone.sh", "scripts/virtual-mac/phone-job.sh", "scripts/virtual-mac/vm.sh"] as const;

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

const matches = (inputs: readonly string[], path: string) =>
  inputs.some((input) => input.endsWith("/") ? path.startsWith(input) : path === input);

export function phoneDecision(
  paths: readonly string[] | undefined,
  generatedDiff?: string,
  { virtualMac = false }: { virtualMac?: boolean } = {},
): { run: boolean; reasons: string[] } {
  if (!paths) return { run: true, reasons: ["The change could not be read; run the native gate."] };
  const inputs = virtualMac ? [...INPUTS, ...VIRTUAL_MAC] : INPUTS;
  const reasons = paths.filter((path) =>
    path === GENERATED_CONTRACT && versionOnly(generatedDiff) ? false : matches(inputs, path));
  return { run: reasons.length > 0, reasons };
}

// INF-827 (the captain's approved INF-828 plan): which of the phone journey's parts a change
// reaches, and how close. 0: it edits test code the part runs; 1: a file the part owns;
// 2: any other phone input, which reaches every part.
export const UI_TESTS = "ios/Infinitary/InfinitaryUITests/";
// The app-hosted tests run in the rest part, beside the tests no other part names.
export const APP_TESTS = "ios/Infinitary/InfinitaryTests/";
export const PART_OWNERS: Record<PhonePart, readonly string[]> = {
  join: [
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/JoinLink.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneIdentity.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PinnedTransport.swift",
    "ios/Infinitary/InfinitaryApp/CodeScanner.swift",
    "ios/Infinitary/InfinitaryApp/NearbyMacs.swift",
    "ios/Infinitary/InfinitaryApp/PhoneComputerSheet.swift",
  ],
  talk: [
    "ios/Infinitary/InfinitaryApp/PhoneTasks.swift",
    "ios/Infinitary/InfinitaryApp/MessageComposer.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneWork.swift",
  ],
  cards: [
    "ios/Infinitary/CardRuntime/",
    "ios/Infinitary/InfinitaryApp/CardAssets/",
    "ios/Infinitary/InfinitaryApp/CardWebView.swift",
    "ios/Infinitary/InfinitaryApp/CardMediaView.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCards.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/CardValues.swift",
    "scripts/generate-phone-cards.ts",
  ],
  address: [
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/SSHJoin.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneSSHKey.swift",
    "ios/Infinitary/InfinitaryApp/PhoneAddressSheet.swift",
  ],
  rest: ["ios/Infinitary/InfinitaryApp/PhoneCharacter.swift"],
};

/** Swift source with comments blanked and string contents replaced, keeping every line break. */
export function blankSwift(source: string): string {
  let out = "";
  let at = 0;
  const keep = (text: string, fill: string) => text.replace(/[^\n]/g, fill);
  while (at < source.length) {
    const rest = source.slice(at, at + 3);
    if (rest.startsWith("//")) {
      const end = source.indexOf("\n", at);
      const stop = end < 0 ? source.length : end;
      out += keep(source.slice(at, stop), " ");
      at = stop;
    } else if (rest.startsWith("/*")) {
      // Swift block comments nest.
      let depth = 0;
      let index = at;
      do {
        if (source.startsWith("/*", index)) { depth++; index += 2; }
        else if (source.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      } while (depth > 0 && index < source.length);
      out += keep(source.slice(at, index), " ");
      at = index;
    } else if (/^#*"/.test(source.slice(at, at + 8))) {
      const hashes = /^#*/.exec(source.slice(at))![0];
      const multi = source.startsWith('"""', at + hashes.length);
      const open = hashes + (multi ? '"""' : '"');
      const close = (multi ? '"""' : '"') + hashes;
      let index = at + open.length;
      while (index < source.length && !source.startsWith(close, index)) {
        if (!multi && source[index] === "\n") break;
        index += source[index] === "\\" && !hashes ? 2 : 1;
      }
      const stop = Math.min(source.length, index + close.length);
      out += open + keep(source.slice(at + open.length, index), "x") + source.slice(index, stop);
      at = stop;
    } else {
      out += source[at];
      at++;
    }
  }
  return out;
}

export type SwiftFunction = { name: string; start: number; end: number; body: string };

/** Each function with a body, by its 1-based first and last lines; undefined when the braces do not balance. */
export function swiftFunctions(source: string): SwiftFunction[] | undefined {
  const code = blankSwift(source);
  const lineAt = (index: number) => code.slice(0, index).split("\n").length;
  const functions: SwiftFunction[] = [];
  for (const declared of code.matchAll(/\bfunc\s+([A-Za-z_]\w*)/g)) {
    let index = declared.index + declared[0].length;
    let parens = 0;
    while (index < code.length && !(parens === 0 && (code[index] === "{" || code[index] === "}"))) {
      if (code[index] === "(") parens++;
      if (code[index] === ")") parens--;
      index++;
    }
    // A requirement with no body ends at its type's closing brace.
    if (code[index] !== "{") continue;
    const open = index;
    let depth = 0;
    do {
      if (code[index] === "{") depth++;
      if (code[index] === "}") depth--;
      index++;
    } while (depth > 0 && index < code.length);
    if (depth !== 0) return undefined;
    functions.push({ name: declared[1]!, start: lineAt(declared.index), end: lineAt(index - 1), body: code.slice(open, index) });
  }
  return functions;
}

export type Hunk = { oldStart: number; removed: string[]; newStart: number; added: number };

/** Each file's hunks in a zero-context diff, by the path it had: its new one, or its old one when removed. */
export function diffHunks(diff: string): Map<string, Hunk[]> {
  const files = new Map<string, Hunk[]>();
  let hunks: Hunk[] | undefined;
  let hunk: Hunk | undefined;
  let removedFrom = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { hunks = undefined; hunk = undefined; continue; }
    if (!hunk && line.startsWith("--- ")) { removedFrom = line.slice(4).replace(/^a\//, ""); continue; }
    if (!hunk && line.startsWith("+++ ")) {
      const path = line.slice(4);
      hunks = [];
      files.set(path === "/dev/null" ? removedFrom : path.replace(/^b\//, ""), hunks);
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && hunks) {
      // With no added lines, the new side names the line the removed ones followed.
      const added = header[3] === undefined ? 1 : Number(header[3]);
      hunk = { oldStart: Number(header[1]), removed: [], newStart: Number(header[2]) + (added === 0 ? 1 : 0), added };
      hunks.push(hunk);
      continue;
    }
    if (hunk && line.startsWith("-")) hunk.removed.push(line.slice(1));
  }
  return files;
}

/** The file as it stood before the change, from the file after it and its zero-context hunks. */
export function before(after: string | undefined, hunks: Hunk[]): string {
  const lines = after === undefined || after === "" ? [] : after.split("\n");
  for (const hunk of [...hunks].sort((a, b) => b.newStart - a.newStart))
    lines.splice(hunk.newStart - 1, hunk.added, ...hunk.removed);
  return lines.join("\n");
}

export type PartReach = { part: PhonePart; distance: 0 | 1 | 2; why: string };
const EVERY = PHONE_PARTS.map((part) => part.name);

/**
 * The test functions each part runs, by name, from its test and the calls it makes. The rest
 * part also starts from every test no other part names.
 */
export function partFunctions(functions: SwiftFunction[]): Map<PhonePart, Set<string>> {
  const names = new Set(functions.map((each) => each.name));
  const calls = new Map<string, Set<string>>();
  for (const each of functions) {
    const called = calls.get(each.name) ?? new Set<string>();
    for (const call of each.body.matchAll(/(?:(?<![.\w])|\bself\.)([A-Za-z_]\w*)\s*\(/g))
      if (names.has(call[1]!)) called.add(call[1]!);
    calls.set(each.name, called);
  }
  const named = new Set<string>(PHONE_PARTS.slice(0, -1).map((part) => part.test));
  const reached = new Map<PhonePart, Set<string>>();
  for (const part of PHONE_PARTS) {
    const roots = part.name === "rest"
      ? [part.test, ...[...names].filter((name) => /^test/.test(name) && !named.has(name))]
      : [part.test];
    const seen = new Set<string>(roots);
    const frontier = [...roots];
    while (frontier.length) for (const call of calls.get(frontier.pop()!) ?? []) {
      if (!seen.has(call)) { seen.add(call); frontier.push(call); }
    }
    reached.set(part.name, seen);
  }
  return reached;
}

/**
 * How close the change is to each part. `testDiff` is the zero-context diff of the UI tests,
 * `testFiles` every UI test file the change leaves and `read` reads one as the change leaves it.
 * Added lines are read in the new version and removed ones in the old, each with its own calls;
 * a file it cannot read or parse counts every part edited.
 */
export function partReach(
  reasons: readonly string[],
  testDiff: string | undefined,
  testFiles: readonly string[],
  read: (path: string) => string | undefined,
): PartReach[] {
  const edited = new Map<PhonePart, Set<string>>(EVERY.map((part) => [part, new Set()]));
  const everyPart = (why: string) => { for (const part of EVERY) edited.get(part)!.add(why); };
  const tests = reasons.filter((path) => path.startsWith(UI_TESTS));
  const changed = testDiff === undefined ? undefined : diffHunks(testDiff);
  if (tests.length && (!changed || tests.some((path) => !changed.has(path))))
    everyPart("the UI test change could not be read");
  else if (tests.length) {
    const after = new Map<string, string>();
    for (const path of testFiles) {
      const text = read(path);
      if (text !== undefined) after.set(path, text);
    }
    const beforeFiles = new Map(after);
    for (const path of tests) {
      if (!after.has(path) && testFiles.includes(path)) everyPart(`${path} could not be read`);
      beforeFiles.set(path, before(after.get(path), changed!.get(path)!));
      if (!after.has(path)) after.set(path, "");
    }
    const parse = (files: Map<string, string>) => {
      const parsed = new Map([...files].map(([path, text]) => [path, swiftFunctions(text)] as const));
      return [...parsed.values()].every(Boolean) ? { parsed, reached: partFunctions([...parsed.values()].flatMap((each) => each!)) } : undefined;
    };
    const sides = [parse(after), parse(beforeFiles)] as const;
    if (!sides[0] || !sides[1]) everyPart("a UI test file could not be parsed");
    else for (const path of tests) for (const [side, lines] of [
      [sides[0], changed!.get(path)!.flatMap((hunk) => Array.from({ length: hunk.added }, (_, at) => hunk.newStart + at))],
      [sides[1], changed!.get(path)!.flatMap((hunk) => hunk.removed.map((_, at) => hunk.oldStart + at))],
    ] as const) {
      const code = blankSwift((side === sides[0] ? after : beforeFiles).get(path)!).split("\n");
      const functions = side.parsed.get(path)!;
      for (const line of lines) {
        // A blank or comment-only line counts for nothing.
        if (!code[line - 1]?.trim()) continue;
        const around = functions.filter((each) => each.start <= line && each.end >= line);
        if (!around.length) everyPart(`${path} line ${line}${side === sides[1] ? " (removed)" : ""}, outside any test function`);
        for (const each of around) for (const part of EVERY)
          if (side.reached.get(part)!.has(each.name)) edited.get(part)!.add(each.name);
      }
    }
  }
  const appTests = reasons.filter((path) => path.startsWith(APP_TESTS));
  if (appTests.length) edited.get("rest")!.add(`the app-hosted tests (${appTests.join(", ")})`);
  return EVERY.map((part): PartReach => {
    const own = [...edited.get(part)!];
    if (own.length) return { part, distance: 0, why: `edits test code it runs: ${own.join(", ")}` };
    const owned = reasons.filter((path) => matches(PART_OWNERS[part], path));
    if (owned.length) return { part, distance: 1, why: `edits a file it owns: ${owned.join(", ")}` };
    return { part, distance: 2, why: `another phone input changed: ${reasons.join(", ")}` };
  });
}

// INF-827: the captain chose six minutes, the same as the Mac journeys' (scripts/journey-budget.ts).
export const PHONE_BUDGET_MS = 6 * 60 * 1000;
export const LEFT_FOR = "the nightly check of main";

/** Each part's longer device time, in milliseconds, from a full gate's part-times.json. */
export function partTimes(text: string | undefined): Map<PhonePart, number> | undefined {
  if (text === undefined) return undefined;
  try {
    const read = JSON.parse(text) as Record<string, Record<string, number>>;
    const times = new Map<PhonePart, number>();
    for (const part of EVERY) {
      const devices = Object.values(read[part] ?? {}).filter((ms) => typeof ms === "number" && ms > 0);
      if (devices.length) times.set(part, Math.max(...devices));
    }
    return times.size ? times : undefined;
  } catch {
    return undefined;
  }
}

export type Placement = PartReach & { minutes?: number; kept: boolean; reason: string };

/**
 * The closest part runs, every part whose test code changed runs even past the budget, and
 * others join while the kept minutes stay within it; ties go to the shorter part. With no
 * readable times, or with the virtual Mac switch on, every part the change reaches runs.
 */
export function placeParts(
  reach: PartReach[],
  times: Map<PhonePart, number> | undefined,
  { virtualMac = false }: { virtualMac?: boolean } = {},
): Placement[] {
  const minutes = (part: PhonePart) => times?.get(part) === undefined ? undefined : times.get(part)! / 60_000;
  if (!times || virtualMac) {
    const reason = virtualMac ? "the virtual Mac switch runs every part" : "no part times could be read, so every part it reaches runs";
    return reach.map((each) => ({ ...each, minutes: minutes(each.part), kept: true, reason }));
  }
  // A part with no time yet costs the slowest measured one.
  const cost = (part: PhonePart) => times.get(part) ?? Math.max(...times.values());
  const ordered = [...reach].sort((a, b) => a.distance - b.distance || cost(a.part) - cost(b.part));
  let kept = 0;
  return ordered.map((each, index): Placement => {
    const placed = { ...each, minutes: cost(each.part) / 60_000 };
    if (index === 0 || each.distance === 0) {
      kept += cost(each.part);
      return { ...placed, kept: true, reason: each.distance === 0 ? "its test code changed" : "the closest part" };
    }
    if (kept + cost(each.part) <= PHONE_BUDGET_MS) {
      kept += cost(each.part);
      return { ...placed, kept: true, reason: "fits in the 6-minute budget" };
    }
    return { ...placed, kept: false, reason: `over the 6-minute budget; left for ${LEFT_FOR}` };
  });
}

/** Requested checks run every directly reached part; shared or unreadable inputs run all. */
export function requestedParts(reasons: readonly string[], reach: PartReach[]): PartReach[] {
  const unknown = reasons.some((path) =>
    !path.startsWith(UI_TESTS) && !path.startsWith(APP_TESTS) &&
    !EVERY.some((part) => matches(PART_OWNERS[part], path)));
  return unknown ? reach : reach.filter((each) => each.distance < 2);
}

function main(): void {
  const { values } = parseArgs({ options: {
    base: { type: "string", default: "origin/main" },
    head: { type: "string", default: "HEAD" },
    // The newest passing on-request check of main's part-times.json.
    times: { type: "string" },
    placement: { type: "string" },
    request: { type: "boolean", default: false },
  } });
  const root = fileURLToPath(new URL("..", import.meta.url));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const virtualMac = Boolean(process.env.PHONE_VIRTUAL_MAC);
  let paths: string[] | undefined;
  try {
    paths = git(["diff", "--name-only", "-z", `${values.base}...${values.head}`, "--"]).split("\0").filter(Boolean);
  } catch { /* An unreadable comparison must not silently omit the gate. */ }
  let generatedDiff: string | undefined;
  if (paths?.includes(GENERATED_CONTRACT)) {
    try {
      generatedDiff = git(["diff", "-U0", `${values.base}...${values.head}`, "--", GENERATED_CONTRACT]);
    } catch { /* An unreadable file comparison selects the gate. */ }
  }
  const decision = phoneDecision(paths, generatedDiff, { virtualMac });
  const readFile = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };
  let placement: Placement[] = [];
  if (decision.run) {
    let testDiff: string | undefined;
    try {
      testDiff = git(["diff", "-U0", "--no-renames", `${values.base}...${values.head}`, "--", UI_TESTS]);
    } catch { /* Counted as every part edited. */ }
    // The working tree is the change's head.
    const read = (path: string) => readFile(join(root, path));
    let testFiles: string[] = [];
    try {
      testFiles = readdirSync(join(root, UI_TESTS)).filter((name) => name.endsWith(".swift")).map((name) => UI_TESTS + name);
    } catch { /* No UI tests left: an edited one counts every part. */ }
    // An unreadable comparison counts every part edited.
    const reach = paths ? partReach(decision.reasons, testDiff, testFiles, read)
      : EVERY.map((part): PartReach => ({ part, distance: 0, why: "the change could not be read" }));
    placement = values.request
      ? (values.request && paths && !virtualMac ? requestedParts(decision.reasons, reach) : reach)
        .map((each) => ({ ...each, kept: true, reason: "requested affected parts" }))
      : placeParts(reach, partTimes(values.times ? readFile(values.times) : undefined), { virtualMac });
  }
  const kept = placement.filter((each) => each.kept).map((each) => each.part);
  console.log(`run=${decision.run}`);
  console.log(`parts=${kept.join(" ")}`);
  if (values.placement) writeFileSync(values.placement, `${JSON.stringify({ run: decision.run, inputs: decision.reasons, parts: placement }, null, 2)}\n`);
  const row = (each: Placement) =>
    `- ${each.kept ? "Runs" : "Left"}: ${each.part}, distance ${each.distance}, ${each.minutes === undefined ? "no time" : `${each.minutes.toFixed(1)} minutes`}: ${each.reason}; ${each.why}`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    ["### Native phone gate", "",
      ...(decision.run ? decision.reasons.map((reason) => `- ${reason}`) : ["No phone input the gate uses changed beyond the contract version number."]),
      "", ...(placement.length ? ["#### Parts", "", ...placement.map(row), ""] : [])].join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
