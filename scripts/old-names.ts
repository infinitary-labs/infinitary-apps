/**
 * The old-name ledger of the Infinitary rename (step 8 of FI3-1780's plan;
 * docs/infinitary-rename.md). Every name the rename leaves behind in the
 * files git sees - a name with 3000 in it, Firstmate 3000 spelled with a
 * space, a hyphen or neither, and Firstmate 3000's code names the captain had
 * renamed (`fm:` channels, `data-fm-*` hooks, `window.firstmate`,
 * `@firstmate/*`, `fm-<tool>-axi` and the rest) - is classified here as one
 * of four things, so a new one cannot slip in unclassified:
 *
 *   reader    code that reads an old name, so what an older version wrote,
 *             saved or sent still works (and the tests that hold it);
 *   identity  a name a system outside the code holds - Firstmate 3000's
 *             bundle id, data folders, packages, casks, tags and signer, which
 *             step 10 renamed and the move, the old-cask switch and the Linux
 *             packages still name; Firstmate 3000 itself, the app still
 *             installed on a computer that the move takes over from;
 *             Firstmate 3000's repository, which step 11 moved to the
 *             archive; and
 *             names other programs keep (an Ollama alias, a Diagnostics series);
 *   words     the product's old name kept on purpose in words: the
 *             vocabulary's never-say column (step 9 renamed the rest);
 *   history   what was published or recorded: release notes, the changelog,
 *             contract revisions, recorded fixtures, cited design records.
 *
 * A name renamed to Infinitary's is no longer here. Plain Node type
 * stripping, no install; `pnpm check` runs it.
 *
 *   node scripts/old-names.ts            exits 1 naming each unclassified old name
 *   node scripts/old-names.ts --counts   counts by family and class
 *   node scripts/old-names.ts --list     every old name with its class and where it is
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type OldNameClass = "reader" | "identity" | "words" | "history";

/** One family of old names, by what it is. */
type Family = { id: string; pattern: RegExp };

export const FAMILIES: readonly Family[] = [
  { id: "3000", pattern: /[A-Za-z0-9_]*(?:fm-?3000|firstmate[- ]?3000)[A-Za-z0-9_]*/gi },
  { id: "channel", pattern: /(?<![A-Za-z0-9_.-])fm:[a-z][a-z0-9-]*(?::[a-z0-9-]+)*/g },
  {
    id: "card-hook",
    pattern:
      /data-fm-[a-z-]+|(?<![A-Za-z0-9_-])fm-(?:mono|muted|row|grid|panel|pictures|facts?|fact-[a-z]+|followups?|followup-[a-z]+|call(?:-[a-z]+)?)(?![A-Za-z0-9_-])|(?<![A-Za-z0-9_.])fm\.(?:action|stage|subscribe|fetch|store|state|theme|onTheme|onState|onStore|birthState)\b|\bwindow\.fm\b|\bfmAction\b/g,
  },
  { id: "preload-api", pattern: /\bwindow\.firstmate\b|__firstmateHost/g },
  { id: "panel-module", pattern: /@firstmate\/(?:ui|contracts)|firstmate-env\.d\.ts/g },
  { id: "task-command", pattern: /\bfm-(?:[a-z]+|<tool>)-axi\b/g },
  { id: "tool-server", pattern: /mcp__firstmate__/g },
  { id: "artifacts", pattern: /\.firstmate-artifacts/g },
];

/** A rule: the first that matches an old name classifies it. */
type Rule = {
  class: OldNameClass;
  why: string;
  /** The file's path, from the repository root. */
  path?: RegExp;
  /** The old name itself. */
  name?: RegExp;
  /** The whole line it is on. */
  line?: RegExp;
  families?: readonly string[];
};

const ANY_TEST = /(\.test\.tsx?|\.spec\.ts)$|^tests\//;

export const RULES: readonly Rule[] = [
  {
    class: "reader",
    why: "the phone bundles the shared bridge that reads older cards' hooks and action names",
    path: /^ios\/Infinitary\/InfinitaryApp\/CardAssets\/CardHost\.generated\.js$/,
    families: ["card-hook"],
  },
  // --- history: published or recorded, never rewritten ----------------------
  {
    class: "history",
    why: "published: the changelog, release notes and their records",
    path: /^(CHANGELOG\.md|release-notes\/)/,
  },
  {
    class: "history",
    why: "the Firstmate contract's revisions, each kept as it was written",
    path: /^src\/core\/prompts\/contract-revisions\//,
  },
  {
    class: "history",
    why: "recorded sessions, tables and corpora the replay and scorers read as they were",
    path: /^tests\/fixtures\/(replay|kind-classifier|dispatch|supervision|corpus|missed|duplicates)\//,
  },
  {
    class: "history",
    why: "a past design record, scout or plan, cited by its name",
    line: /(?:fm|firstmate)-?3000-[a-z0-9-]*-(s|r|m|p|rev-s)\d+|fm3000-firstmate-empty-turn-instruction|fm3000-ui-plugin-system-reconcile-state|`fm3000d` daemon/i,
    families: ["3000"],
  },
  {
    class: "history",
    why: "a past design record, cited by its folder",
    line: /(data|fm-homes\/[a-z-]+\/data)\/fm3000-|firstmate\/data\/fm3000-/,
  },
  {
    class: "history",
    why: "the captain's own words, quoted",
    line: /i need fm3000 to 'just work'|to fm3000's instructions|for fm3000's plan cards/,
  },
  {
    class: "history",
    why: "a conversation as the replay reads one recorded before the rename",
    path: /^tests\/replay-[a-z-]+\.test\.ts$/,
    families: ["tool-server", "card-hook"],
  },
  // --- readers named by the old name itself, or by the sentence around it ---
  {
    class: "reader",
    why: "this ledger, which names the old names to find them, and its test",
    path: /^(scripts\/old-names\.ts|tests\/old-names\.test\.ts)$/,
  },
  {
    class: "reader",
    why: "the update and download orders (FROZEN_CHANNELS) and the /firstmate route keep one name in every spelling",
    name: /^fm:firstmate:update(-download|-progress)?$/,
  },
  {
    class: "reader",
    why: "a setting under its Firstmate 3000 name still reads (src/shared/envSettings.ts)",
    families: ["3000"],
    name: /^FM3000_/,
    path: /^(src\/shared\/envSettings\.ts|src\/core\/devices\/farSystems\.ts|scripts\/local-codesign\.mjs|electron\.vite\.config\.ts|resources\/|\.github\/workflows\/)|(\.test\.tsx?|\.spec\.ts)$/,
  },
  {
    class: "reader",
    why: "a sentence that says how an old name still reads",
    line: /Firstmate 3000's|before the (Infinitary )?rename|older name|older `|the older|still read|either (spelling|scheme|name)|under either|in either|its name before/,
    families: ["channel", "card-hook", "preload-api", "panel-module", "task-command", "tool-server", "artifacts", "3000"],
  },
  {
    class: "reader",
    why: "a line of the docs that names an old name beside Infinitary's, saying how both read",
    path: /^docs\/.*\.md$/,
    line: /infinitary|\binf\b|inf:|inf-|data-inf-|before 8\.4/i,
  },
  {
    class: "reader",
    why: "the published contract's schemas, which take an old ref or link too",
    path: /^docs\/contract\.json$/,
    families: ["3000"],
  },
  {
    class: "reader",
    why: "the build and the type checker resolve a panel's older module names too",
    path: /^(vitest\.config\.ts|electron\.vite\.config\.ts|tsconfig\.(web|node)\.json)$/,
    families: ["panel-module"],
  },
  // --- words: the old name kept on purpose (step 9 renamed the rest) --------
  {
    class: "words",
    why: "the vocabulary's never-say column, which names Firstmate 3000's names so nobody says them",
    path: /^\.claude\/skills\/infinitary-design\/copy\/Vocabulary\.prompt\.md$/,
    line: /^\| Firstmate 3000, FM3000/,
  },
  // --- identity: names systems outside the code hold ------------------------
  {
    class: "identity",
    why: "Firstmate 3000's bundle id and background label, which the background move and a Homebrew upgrade still name",
    line: /com\.kunchenguid\.firstmate3000/i,
  },
  {
    class: "identity",
    why: "Firstmate 3000's repository, which step 11 moved to infinitary-labs/firstmate-3000-archive and GitHub forwards there",
    line: /kunchenguid\/firstmate-3000|kunchenguid%2Ffirstmate-3000|work\/firstmate-3000\/firstmate-3000|FI3 \(firstmate-3000\)/,
  },
  {
    class: "identity",
    why: "Firstmate 3000's tap, tags, casks, update files and download, which the old-cask switch writes and an installation through the old cask reads",
    line: /firstmate-3000-(alpha-)?v|firstmate-3000-(updates|builds)\.json|Casks\/firstmate-3000|tap\/firstmate-3000|firstmate-3000@alpha|Firstmate-3000-(\$|\{|<|[0-9])|Firstmate-3000\.zip|CASK_TOKEN|TAP_TAG_PREFIX|[Cc]ask|firstmate-3000 casks|publish firstmate-3000/,
  },
  {
    class: "identity",
    why: "Firstmate 3000's data folders and work folder, which the one-time move reads",
    line: /firstmate-3000-dev|Application Support\/firstmate-3000|appData[^\n]*firstmate-3000|<appData>\/firstmate-3000|firstmate-3000\/(work|fleet|devices|crewmates|update-channel)|USER_DATA_FOLDER|userDataFolder|another folder's sessions|starts with `firstmate-3000-`|\.config\/firstmate-3000|Support\/firstmate-3000|"firstmate-3000"\)?,?$|firstmate-3000[`'"]? (folder|data folder)/,
  },
  {
    class: "identity",
    why: "Firstmate 3000's Linux package, command and paths, which Infinitary's packages replace, conflict with, provide and link",
    line: /\/opt\/firstmate-3000|\/usr\/bin\/firstmate-3000|firstmate-3000(-alpha)?-bin|firstmate-3000\.(deb|rpm|AppImage|desktop)|firstmate-3000-\$\{version\}|LINUX_|apparmor|executableName|productName|desktopName|StartupWMClass|mainProgram|provides=|dpkg-query|lib\/firstmate-3000|PACKAGE_NAMES|linux|Linux|nix|pacman|out\/(bin|lib|share)/,
  },
  {
    class: "identity",
    why: "Firstmate 3000's development signer, which stays for a rollback and which crewmates keep off",
    line: /\.firstmate-3000\/local-codesign|firstmate-3000-local\.keychain-db|Firstmate 3000 Local Dev|Firstmate 3000 Unlock/,
  },
  {
    class: "identity",
    why: "Firstmate 3000's casks, tap and Linux packages, as the release tooling, the old-cask switch and the update reader name them",
    path: /^(scripts\/(resolve-release\.sh|publish-tap\.sh|publish-release-asset\.sh|generate-cask\.sh|tap-publication\.ts|linux-recipes\.ts|check-linux-package\.sh|check-user-data-dir\.sh|verify-app\.sh)|src\/core\/devices\/(ubuntuPackage|publishedBuilds|farSystems|remoteLogin)\.ts|src\/core\/update\/(linuxInstall|updateChannels|tapPublication)\.ts|packaging\/|electron-builder\.linux\.yml|\.github\/workflows\/(release|republish-casks|linux-packages)\.yml)/,
    families: ["3000"],
  },
  {
    class: "identity",
    why: "Firstmate 3000's Mac app, its bundle and its executable, which the background move and a Homebrew upgrade name",
    line: /Firstmate 3000( Dev)?\.app|MacOS\/Firstmate|Firstmate 3000 Dev|APP_NAME|EXPECTED_EXECUTABLE|app: \{ release: "Firstmate 3000"/,
  },
  {
    class: "identity",
    why: "what Diagnostics reports the app as, a series the captain's dashboard keeps (docs/sharing.md)",
    line: /app:\/\/firstmate-3000|DEFAULT_APP|DEFAULT_TITLE|"?title"?: "Firstmate 3000"|firstmate-3000\/<version> telemetry|firstmate-3000\/\$\{/,
  },
  {
    class: "identity",
    why: "Firstmate 3000 itself, the app still installed on a computer, which the one-time move, its hand-over and the old-cask switch take over from",
    line: /installed Firstmate 3000|Firstmate 3000 (run|version)\b|`from` Firstmate 3000|Firstmate 3000 never opens|after Firstmate 3000 -/,
    families: ["3000"],
  },
  {
    class: "reader",
    why: "the persona's opening before the rename, which Observe still redacts from a session recorded then",
    path: /^src\/core\/observe\/redact\.ts$/,
    line: /"You are (Firstmate 3000|a crewmate: a background worker aboard Firstmate 3000)/,
  },
  {
    class: "reader",
    why: "a pairing link in Firstmate 3000's scheme, which a computer from before the rename built and this build still reads",
    line: /firstmate3000:\/\/(join\?|\*)?|`firstmate3000:` scheme/,
  },
  {
    class: "identity",
    why: "a name another program or a saved hash keeps: the Ollama alias, placement salts, an exported corpus's format",
    line: /fm3000-context-|fm3000-linux-machine-v1|fm3000-physical-v1|fm3000\.human-supervision/,
  },
  // --- readers: the files that read what an older version wrote, and their tests
  {
    class: "reader",
    why: "the one owner of both spellings of the code names",
    path: /^src\/shared\/codeNames(\.test)?\.ts$/,
  },
  {
    class: "reader",
    why: "a reader of an old name, beside its Infinitary twin",
    path: /^(src\/core\/workspace\/(workspaceService|artifacts)\.ts|src\/shared\/work\.ts|src\/core\/placed\/(placedCopies|placedSessions)\.ts|src\/core\/storage\/sessionReader\.ts|src\/core\/tasks\/(taskTemp|taskExport|taskLeftovers)\.ts|src\/shared\/userDataFolders\.ts|src\/main\/userDataDir\.ts|scripts\/ensure-bundled-git\.ts|src\/renderer\/src\/design\/fixtures\/index\.tsx|src\/shared\/devices\.ts|src\/core\/devices\/ownKey\.ts|src\/shared\/plugins\/bridge\.ts|src\/shared\/personal\/manifest\.ts|src\/renderer\/src\/personal\/hostModules\.ts|src\/preload\/index\.ts|src\/renderer\/src\/env\.d\.ts|tests\/e2e\/global\.d\.ts|scripts\/generate-personal-env\.ts|src\/core\/personal\/seed\/infinitaryEnv\.generated\.ts|src\/core\/personal\/workspace\.ts|src\/core\/axi\/names\.ts|scripts\/app-runtime-version\.mjs|scripts\/windows-feasibility\/browser\.ts|scripts\/bench\/attempt\.ts|scripts\/local-codesign\.mjs|electron\.vite\.config\.ts|src\/core\/devices\/farSystems\.ts|src\/shared\/envSettings\.ts|resources\/axi-bin\/infinitary-axi|resources\/git-bin\/git|resources\/git-askpass|src\/core\/plugins\/pluginLint\.ts)$/,
  },
  {
    class: "reader",
    why: "the release workflows read the repository variables under their older names too",
    path: /^\.github\/workflows\//,
    name: /^FM3000_UMAMI_/,
  },
  {
    class: "reader",
    why: "every task command, Firstmate 3000's among them, is a copy of the same launcher",
    path: /^resources\/axi-bin\/(fm|infinitary)-[a-z]+-axi$/,
  },
  {
    class: "reader",
    why: "a test that holds an old name's reader: an older peer, link, panel, card or record",
    path: /^(src\/shared\/(envSettings|devices|cardPictures|cards)\.test\.ts|src\/core\/(observe\/gate|orchestrator\/localOrchestrator|forge\/providers\/github\/(githubForge|oauth)|forge\/providers\/gitlab\/projects|devices\/(computerName|farSystems|homeLink|ownKey)|connection\/connection|telemetry|pi\/(cardImages|cardLint)|storage\/sessionReader|tasks\/(taskTemp|taskExport)|helper\/workingCopies|personal\/(compiler|personalExtensions|workspace|infinitaryEnv|appPanels)|plugins\/(pluginLint|pluginInstaller)|core|placed\/placedInstructions|personal\/skillText)\.test\.ts|src\/main\/userDataDir\.test\.ts|src\/renderer\/src\/personal\/hostModules\.test\.ts|src\/shared\/plugins\/bridge\.test\.ts|tests\/e2e\/(past-card-frame|card-action-feedback|phase0-guardrails)\.spec\.ts|tests\/(install-clones|release-contract)\.test\.ts|tests\/fixtures\/(personal|personal-skills|personal-lint|panel-cards|frame-realm)\/)/,
    families: ["3000", "card-hook", "preload-api", "panel-module", "channel", "tool-server", "task-command"],
  },
  {
    class: "identity",
    why: "a test's stand-in named as Firstmate 3000's: an older install, folder, project or record",
    path: ANY_TEST,
    line: /firstmate-3000|Firstmate 3000|firstmate3000/i,
    families: ["3000"],
  },
  {
    class: "reader",
    why: "the design skill's folder before the rename, which a workspace seed takes away",
    path: /^(src\/core\/personal\/workspaceSkills(\.test)?\.ts|resources\/personal-workspace\/retired-skills\.json)$/,
    line: /firstmate-3000-design/,
  },
];

/** Every old name in one line, with its family. */
export function oldNamesIn(line: string): { family: string; name: string }[] {
  const found: { family: string; name: string; at: number }[] = [];
  for (const family of FAMILIES) {
    for (const match of line.matchAll(family.pattern))
      found.push({ family: family.id, name: match[0], at: match.index ?? 0 });
  }
  // A name inside a longer one of another family counts once, as the longer.
  return found
    .filter(
      (one) =>
        !found.some(
          (other) =>
            other !== one &&
            other.name.length > one.name.length &&
            other.at <= one.at &&
            other.at + other.name.length >= one.at + one.name.length,
        ),
    )
    .sort((a, b) => a.at - b.at)
    .map(({ family, name }) => ({ family, name }));
}

/** The class of one old name where it stands, or null when no rule takes it. */
export function classify(
  path: string,
  line: string,
  oldName: { family: string; name: string },
): { class: OldNameClass; why: string } | null {
  for (const rule of RULES) {
    if (rule.families && !rule.families.includes(oldName.family)) continue;
    if (rule.path && !rule.path.test(path)) continue;
    if (rule.name && !rule.name.test(oldName.name.replace(/^[^A-Za-z_.@/<]+/, ""))) continue;
    if (rule.line && !rule.line.test(line)) continue;
    return { class: rule.class, why: rule.why };
  }
  return null;
}

export type LedgerRow = {
  path: string;
  line: number;
  family: string;
  name: string;
  class: OldNameClass | null;
  why: string | null;
};

/**
 * A loose first pass for git's own grep, which has no lookbehind: every line
 * any family could match. The families' own patterns decide.
 */
const GREP =
  "fm-?3000|firstmate[- ]?3000|fm:[a-z]|data-fm-|fm-[a-z<]|fm\\.|fmAction|window\\.firstmate|__firstmateHost|@firstmate/|firstmate-env|mcp__firstmate__|firstmate-artifacts";

/**
 * Every old name at `root`, classified: in its tracked files and in new ones
 * git does not ignore, so a file not yet committed is read as CI will read it.
 */
export function ledger(root: string): LedgerRow[] {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "--untracked", "-n", "-I", "-i", "-E", GREP], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    // No match at all exits 1.
    if ((error as { status?: number }).status !== 1) throw error;
  }
  const rows: LedgerRow[] = [];
  for (const raw of out.split("\n")) {
    const first = raw.indexOf(":");
    const second = raw.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const path = raw.slice(0, first);
    const number = Number(raw.slice(first + 1, second));
    const text = raw.slice(second + 1);
    for (const oldName of oldNamesIn(text)) {
      const found = classify(path, text, oldName);
      rows.push({
        path,
        line: number,
        ...oldName,
        class: found?.class ?? null,
        why: found?.why ?? null,
      });
    }
  }
  return rows;
}

function main(argv: string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const rows = ledger(root);
  if (argv.includes("--list")) {
    for (const row of rows)
      console.log(`${row.class ?? "UNCLASSIFIED"}\t${row.family}\t${row.name}\t${row.path}:${row.line}`);
    return 0;
  }
  if (argv.includes("--counts")) {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.family}\t${row.class ?? "UNCLASSIFIED"}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of [...counts].sort())
      console.log(`${String(count).padStart(6)}  ${key}`);
    console.log(`${String(rows.length).padStart(6)}  every old name`);
    return 0;
  }
  const unclassified = rows.filter((row) => row.class === null);
  if (unclassified.length === 0) {
    console.log(`old-names: ${rows.length} old name(s), every one classified`);
    return 0;
  }
  for (const row of unclassified)
    console.error(
      `${row.path}:${row.line}: ${row.name} (${row.family}) is an old name no rule classifies; rename it to Infinitary's, or add the rule that says why it stays (scripts/old-names.ts, docs/infinitary-rename.md)`,
    );
  console.error(`old-names: ${unclassified.length} unclassified of ${rows.length}`);
  return 1;
}

// An exit code, not process.exit: on macOS a pipe takes the list as it is
// written, and exiting at once would cut it short.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));

