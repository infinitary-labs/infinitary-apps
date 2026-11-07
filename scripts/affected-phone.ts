import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PHONE_PARTS } from "./phone-test-plan.ts";

// INF-79 / INF-136: the captain requested the native gate on phone/shared-contract PRs.
// Include the captain's approved gate setup inputs, not broad shared/core/package changes.
const INPUTS = [
  "ios/", "scripts/generate-phone-cards.ts", "scripts/generate-phone-contract.ts", "scripts/phone-contract-shapes.ts",
  ".github/workflows/phone.yml", "scripts/test-phone.ts", "tests/helpers/phoneHome.ts", "tests/helpers/phoneKeyboard.ts",
  "scripts/phone-checks.ts", "scripts/phone-failure-logs.ts", "scripts/phone-activity.ts", "scripts/phone-simulator.ts",
  // INF-1645: the one Xcode and iOS simulator every Mac's phone check uses.
  "scripts/phone-pin.json",
  // INF-1596: the sweep of earlier runs' simulators and scratch folders at the gate's start.
  "scripts/phone-leftovers.ts",
  // INF-1066: native geometry generation and the scene journey's real home fixture.
  "scripts/generate-phone-scene.ts", "tests/helpers/phoneScene.ts", "scripts/phone-recording.ts",
  "tests/helpers/phoneLogs.ts", "tests/helpers/phoneStacks.ts", "tests/helpers/phoneWebContent.ts",
  // INF-1936 / INF-2185: edits to the runner's diagnostics must select their simulator consumer too.
  "scripts/phone-guest-observer.ts", "tests/helpers/phoneWebStacks.ts", "tests/helpers/phoneGuestLaunches.ts",
  "tests/helpers/phoneLauncherLog.ts", "tests/helpers/phoneLookupWait.ts", "tests/helpers/phoneProxyLaunches.ts",
  // INF-662: each device's own test home in the one build's test plan.
  "scripts/phone-test-plan.ts",
  // INF-2625: the phone check's test home answers the phone's crewmates and first mate through the journey stand-in,
  // its crew scripts, its models.json and the request readers it answers by.
  "tests/e2e/mockProvider.ts", "tests/e2e/crewScripts.ts", "tests/e2e/mockModels.ts", "tests/e2e/providerRequest.ts",
] as const;
// INF-827 (the captain's "skip changes to unused setup"): the device gates never run this
// chooser or scripts/phone-test-home.ts, so they are not inputs. The chooser runs before the
// gates and is checked on Linux by its own unit tests; the test home is for local work only.
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
// The app-hosted tests run in the rest part, beside the tests no other part names, except a class a part
// names as its `suite` (INF-2989's weak-link), which runs in that part alone.
export const APP_TESTS = "ios/Infinitary/InfinitaryTests/";
// INF-2125 direction C: a part's owned files are its family's, the part name before its first hyphen,
// so each short part split from join, talk, cards or relaunch owns what that part owned.
export const partFamily = (part: string) => part.split("-")[0]!;
export const PART_OWNERS: Record<string, readonly string[]> = {
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
  // INF-1878: INF-1735's relaunch pairs, split from talk, own no file, so talk stays the closest part for its own.
  relaunch: [],
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
  // INF-2095: the pager's menu and the test hook its journey reads.
  pick: ["ios/Infinitary/InfinitaryApp/PhoneCards.swift", "ios/Infinitary/InfinitaryApp/PhoneMenuTapProbe.swift"],
  // INF-2568: Home's column and the card's frame, which the keyboard shortens.
  keyboard: [
    "ios/Infinitary/InfinitaryApp/PhoneCards.swift",
    "ios/Infinitary/InfinitaryApp/PhoneWorkspace.swift",
    "ios/Infinitary/InfinitaryApp/MessageComposer.swift",
  ],
  rest: ["ios/Infinitary/InfinitaryApp/PhoneCharacter.swift"],
};

/** Swift source with comments blanked and string contents replaced, keeping every line break. */
export function blankSwift(source: string, keepStrings = false, onInvalid?: () => void): string {
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
      if (depth > 0) onInvalid?.();
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
      if (!source.startsWith(close, index)) onInvalid?.();
      const stop = Math.min(source.length, index + close.length);
      out += keepStrings ? source.slice(at, stop) : open + keep(source.slice(at + open.length, index), "x") + source.slice(index, stop);
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
    let depth = 0;
    do {
      if (code[index] === "{") depth++;
      if (code[index] === "}") depth--;
      index++;
    } while (depth > 0 && index < code.length);
    if (depth !== 0) return undefined;
    functions.push({ name: declared[1]!, start: lineAt(declared.index), end: lineAt(index - 1), body: blankSwift(source.slice(declared.index, index), true) });
  }
  return functions;
}

/** INF-2257: a deliberately small declaration reader, not a Swift name resolver.
 * Only top-level value types and literal constants have a known lazy owner.
 * Everything else remains outside a declaration and therefore selects every part when edited.
 */
function swiftDeclarations(source: string): SwiftFunction[] | undefined {
  const functions = swiftFunctions(source);
  if (!functions) return undefined;
  let valid = true;
  const code = blankSwift(source, false, () => { valid = false; });
  if (!valid) return undefined;
  if (/^\s*#(?:if|elseif|else|endif)\b/m.test(code)) return undefined;
  const lines = code.split("\n");
  const raw = blankSwift(source, true).split("\n");
  const declarations = [...functions];
  const types: SwiftFunction[] = [];
  let depth = 0;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    if (depth === 0) {
      const type = /^(?:private\s+|fileprivate\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)\b[^{]*\{/.exec(line);
      const constant = /^(?:private\s+|fileprivate\s+)?let\s+([A-Za-z_]\w*)(?:\s*:\s*[\w.]+)?\s*=\s*(?:true|false|nil|-?\d+(?:\.\d+)?|#*"[^"\n]*"#*)\s*$/.exec(line);
      const match = type ?? constant;
      if (match && !lines[at - 1]?.trim().startsWith("@")) {
        let end = at;
        if (type) {
          let braces = 0;
          do {
            for (const char of lines[end] ?? "") braces += char === "{" ? 1 : char === "}" ? -1 : 0;
            end++;
          } while (braces > 0 && end < lines.length);
          if (braces !== 0) return undefined;
          end--;
        }
        const body = raw.slice(at, end + 1).join("\n");
        // Conditional compilation, attributes, interpolation and executable initializers
        // need more than this reader can prove. Keep their existing full-selection fallback.
        if (!/^[ \t]*[@#]/m.test(lines.slice(at, end + 1).join("\n")) &&
          !(constant && /\\#*\(/.test(body))) {
          const declaration = { name: match[1]!, start: at + 1, end: end + 1, body };
          declarations.push(declaration);
          if (type) types.push(declaration);
        }
      }
    }
    for (const char of line) {
      depth += char === "{" ? 1 : char === "}" ? -1 : 0;
      if (depth < 0) return undefined;
    }
  }
  // A helper type owns its methods too; a common method name such as `read` is
  // not a free function shared with every other type declaring a `read` method.
  return depth === 0 ? declarations.filter((each) =>
    !types.some((type) => type !== each && type.start <= each.start && type.end >= each.end)) : undefined;
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

export type PartReach = { part: string; distance: 0 | 1 | 2; why: string };
/** A part table: each part's name and the journey test it runs, or the whole test class it names as its
 * `suite`, the last part running every test no other names. The gate's own is PHONE_PARTS; a recorded change
 * replays against the table of its own time. */
export type PartTable = readonly ({ name: string; test: string } | { name: string; suite: string })[];
/** The test file a part's `suite` class is declared in, which Xcode names for the class. */
const suiteFile = (part: PartTable[number]) => "suite" in part ? `ios/Infinitary/${part.suite}.swift` : undefined;
const names = (parts: PartTable) => parts.map((part) => part.name);
/** The gate's own parts, in order. */
const EVERY = names(PHONE_PARTS);
const owners = (part: string) => PART_OWNERS[partFamily(part)] ?? [];

/**
 * The declarations each part runs, by name, from its test and identifier references. The rest
 * part also starts from every test no other part names.
 */
export function partFunctions(functions: SwiftFunction[], parts: PartTable = PHONE_PARTS): Map<string, Set<string>> {
  const names = new Set(functions.map((each) => each.name));
  const calls = new Map<string, Set<string>>();
  for (const each of functions) {
    const called = calls.get(each.name) ?? new Set<string>();
    for (const call of each.body.matchAll(/\b([A-Za-z_]\w*)\b/g))
      if (names.has(call[1]!)) called.add(call[1]!);
    calls.set(each.name, called);
  }
  const named = new Set<string>(parts.slice(0, -1).flatMap((part) => "test" in part ? [part.test] : []));
  const reached = new Map<string, Set<string>>();
  for (const part of parts) {
    // A part that runs an app-hosted class of its own runs no UI test code; a UI test class of its own is
    // read as running every UI test declaration, since this reader does not know which class a declaration is in.
    if (!("test" in part)) { reached.set(part.name, new Set(suiteFile(part)!.startsWith(APP_TESTS) ? [] : names)); continue; }
    const setup = [...names].filter((name) => /^(?:setUp|tearDown|testCase)/.test(name));
    const roots = [...setup, ...(part === parts.at(-1)
      ? [part.test, ...[...names].filter((name) => /^test/.test(name) && !named.has(name))]
      : [part.test])];
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
 * Added lines are read in the new version and removed ones in the old, each with its own references;
 * a file it cannot read or parse counts every part edited.
 */
export function partReach(
  reasons: readonly string[],
  testDiff: string | undefined,
  testFiles: readonly string[],
  read: (path: string) => string | undefined,
  parts: PartTable = PHONE_PARTS,
): PartReach[] {
  const every = names(parts);
  const edited = new Map<string, Set<string>>(every.map((part) => [part, new Set()]));
  const everyPart = (why: string) => { for (const part of every) edited.get(part)!.add(why); };
  const tests = reasons.filter((path) => path.startsWith(UI_TESTS));
  const changed = testDiff === undefined ? undefined : diffHunks(testDiff);
  if (tests.length && (!changed || tests.some((path) => !changed.has(path))))
    everyPart("the UI test change could not be read");
  else if (tests.length) {
    if (!testFiles.length) everyPart("the UI test dependencies could not be enumerated");
    const after = new Map<string, string>();
    for (const path of testFiles) {
      const text = read(path);
      if (text !== undefined) after.set(path, text);
      else everyPart(`${path} could not be read`);
    }
    const beforeFiles = new Map(after);
    for (const path of tests) {
      if (!after.has(path) && (testFiles.includes(path) || changed!.get(path)!.some((hunk) => hunk.added > 0))) everyPart(`${path} could not be read`);
      beforeFiles.set(path, before(after.get(path), changed!.get(path)!));
      if (!after.has(path)) after.set(path, "");
    }
    const parse = (files: Map<string, string>) => {
      const parsed = new Map([...files].map(([path, text]) => [path, swiftDeclarations(text)] as const));
      if (![...parsed.values()].every(Boolean)) return undefined;
      const declarations = [...parsed.values()].flatMap((each) => each!);
      const reached = partFunctions(declarations, parts);
      const counts = new Map<string, number>();
      for (const each of declarations) counts.set(each.name, (counts.get(each.name) ?? 0) + 1);
      // A reference outside any known declaration may run at global setup, not just in a test.
      const global = new Set<string>();
      for (const [path, text] of files) for (const [at, line] of blankSwift(text, true).split("\n").entries()) {
        if (parsed.get(path)!.some((each) => each.start <= at + 1 && each.end >= at + 1)) continue;
        for (const token of line.matchAll(/\b[A-Za-z_]\w*\b/g)) global.add(token[0]);
      }
      const globalReach = new Set(global);
      const frontier = [...global];
      while (frontier.length) {
        const name = frontier.pop()!;
        for (const each of declarations.filter((each) => each.name === name))
          for (const token of each.body.matchAll(/\b[A-Za-z_]\w*\b/g))
            if (!globalReach.has(token[0])) { globalReach.add(token[0]); frontier.push(token[0]); }
      }
      return { parsed, reached, counts, globalReach };
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
        if (!around.length) everyPart(`${path} line ${line}${side === sides[1] ? " (removed)" : ""}, outside any supported declaration`);
        for (const each of around) {
          if (side.counts.get(each.name)! > 1 || side.globalReach.has(each.name))
            everyPart(`${each.name}: ambiguous name or global setup reference`);
          for (const part of every)
            if (side.reached.get(part)!.has(each.name)) edited.get(part)!.add(each.name);
        }
      }
    }
  }
  const appTests = reasons.filter((path) => path.startsWith(APP_TESTS));
  // An app-hosted test file runs in the part whose class it declares, any other test class in the rest part,
  // and anything else beside them, such as a shared helper, in every part that runs app-hosted tests.
  const suites = parts.filter((part) => suiteFile(part)?.startsWith(APP_TESTS));
  for (const path of appTests) {
    const own = suites.filter((part) => suiteFile(part) === path).map((part) => part.name);
    const runs = own.length ? own : /Tests\.swift$/.test(path) ? [every.at(-1)!] : [every.at(-1)!, ...suites.map((part) => part.name)];
    for (const part of runs) edited.get(part)!.add(`the app-hosted tests (${path})`);
  }
  return every.map((part): PartReach => {
    const own = [...edited.get(part)!];
    if (own.length) return { part, distance: 0, why: `edits test code it runs: ${own.join(", ")}` };
    const owned = reasons.filter((path) => matches(owners(part), path));
    if (owned.length) return { part, distance: 1, why: `edits a file it owns: ${owned.join(", ")}` };
    return { part, distance: 2, why: `another phone input changed: ${reasons.join(", ")}` };
  });
}

// INF-827: the captain chose six minutes, the same as the Mac journeys' (scripts/journey-budget.ts).
export const PHONE_BUDGET_MS = 6 * 60 * 1000;
export const LEFT_FOR = "the nightly check of main";

/** Each part's longer device time, in milliseconds, from a full gate's part-times.json. */
export function partTimes(text: string | undefined, parts: PartTable = PHONE_PARTS): Map<string, number> | undefined {
  if (text === undefined) return undefined;
  try {
    const read = JSON.parse(text) as Record<string, Record<string, number>>;
    const times = new Map<string, number>();
    for (const part of names(parts)) {
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
  times: Map<string, number> | undefined,
  { virtualMac = false }: { virtualMac?: boolean } = {},
): Placement[] {
  const minutes = (part: string) => times?.get(part) === undefined ? undefined : times.get(part)! / 60_000;
  if (!times || virtualMac) {
    const reason = virtualMac ? "the virtual Mac switch runs every part" : "no part times could be read, so every part it reaches runs";
    return reach.map((each) => ({ ...each, minutes: minutes(each.part), kept: true, reason }));
  }
  // A part with no time yet costs the slowest measured one.
  const cost = (part: string) => times.get(part) ?? Math.max(...times.values());
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
    !Object.values(PART_OWNERS).some((owned) => matches(owned, path)));
  return unknown ? reach : reach.filter((each) => each.distance < 2);
}

/** INF-2259: ordinary proof is round one, and each kept part whose test code changed takes two more
 * passes on the iPhone in the same request. INF-2811: a proper subset repeats its edited parts too, since a
 * computer in CI mode cannot run a local phone check; `full` still says the selection covers every live part. */
export function phoneRepeatPlan(parts: readonly string[], reach: readonly PartReach[]): {
  full: boolean; repeatParts: string[];
} {
  const full = EVERY.every((part) => parts.includes(part));
  return { full, repeatParts: EVERY.filter((part) => parts.includes(part) && reach.some((each) => each.part === part && each.distance === 0)) };
}

/** INF-2582 (the captain's "iPhone only; iPad waits for the release check"): on an affected request, a kept
 * part the change only reaches runs on the iPhone alone, and a part whose test code changed, or a change
 * that could not be read, runs on both devices. The release check runs every part on both. */
export function iphoneOnlyParts(parts: readonly string[], reach: readonly PartReach[]): string[] {
  return parts.filter((part) => !reach.some((each) => each.part === part && each.distance === 0));
}

function main(): void {
  const { values } = parseArgs({ options: {
    base: { type: "string", default: "origin/main" },
    head: { type: "string", default: "HEAD" },
    // The newest passing on-request check of main's part-times.json.
    times: { type: "string" },
    placement: { type: "string" },
    request: { type: "boolean", default: false },
    // Explicit ordinary coverage, including an empty string for every live part.
    coverage: { type: "string" },
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
      : names(PHONE_PARTS).map((part): PartReach => ({ part, distance: 0, why: "the change could not be read" }));
    placement = values.request
      ? (values.request && paths && !virtualMac ? requestedParts(decision.reasons, reach) : reach)
        .map((each) => ({ ...each, kept: true, reason: "requested affected parts" }))
      : placeParts(reach, partTimes(values.times ? readFile(values.times) : undefined), { virtualMac });
  }
  let kept = placement.filter((each) => each.kept).map((each) => each.part);
  if (values.coverage !== undefined) {
    const named = values.coverage.split(/\s+/).filter(Boolean);
    for (const part of named) if (!EVERY.includes(part)) throw new Error(`Unknown phone part: ${part}`);
    kept = named.length ? EVERY.filter((part) => named.includes(part)) : [...EVERY];
  }
  const repeats = phoneRepeatPlan(kept, placement);
  // Named parts and every-part requests run on both devices, as asked.
  const iphoneOnly = values.request && values.coverage === undefined ? iphoneOnlyParts(kept, placement) : [];
  console.log(`full=${repeats.full}`);
  console.log(`repeat_parts=${repeats.repeatParts.join(" ")}`);
  console.log(`iphone_parts=${iphoneOnly.join(" ")}`);
  const run = values.coverage === undefined ? decision.run : kept.length > 0;
  console.log(`run=${run}`);
  console.log(`parts=${kept.join(" ")}`);
  if (values.placement) writeFileSync(values.placement, `${JSON.stringify({ run, inputs: decision.reasons, parts: placement, coverage: kept, iphoneOnly, repeats }, null, 2)}\n`);
  const row = (each: Placement) =>
    `- ${each.kept ? "Runs" : "Left"}: ${each.part}, distance ${each.distance}, ${each.minutes === undefined ? "no time" : `${each.minutes.toFixed(1)} minutes`}: ${each.reason}; ${each.why}`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    ["### Native phone gate", "",
      ...(decision.run ? decision.reasons.map((reason) => `- ${reason}`) : ["No phone input the gate uses changed beyond the contract version number."]),
      "", `Ordinary coverage: ${kept.join(" ") || "none"}; complete live selection: ${repeats.full}.`,
      `On the iPhone only (the iPad waits for the release check): ${iphoneOnly.join(" ") || "none"}.`,
      `Two additional passes on the iPhone, in the same job (the iPad runs each once): ${repeats.repeatParts.join(" ") || "none"}.`,
      "", ...(placement.length ? ["#### Parts", "", ...placement.map(row), ""] : [])].join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
