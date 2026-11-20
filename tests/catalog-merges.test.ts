import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG_DIR,
  COMPILED_PATH,
  catalogFile,
  GLOSSARY_DIR,
  PHONE_INFO_PLIST,
  readCatalogs,
} from "../scripts/generate-messages";
import { scratchDir } from "./helpers/scratchDirs";

// INF-4066's direction 1, which the captain started ("only start 1"): two
// changes that each add a different message no longer clash when they are
// combined, and `pnpm check`'s catalog check passes on the combination. Each
// test builds a throwaway project holding the real catalogs, glossaries and
// compiler, and combines branches with real git, as a batch does.

const REPO = process.cwd();
/** Five times the slowest case on the Mac, 3.2 s (docs/test-cohorts.md). */
const BUDGET_MS = 20_000;
/** Each case that also runs the phone's card generator three times: five times the slower one's run on the Linux check, 20.2 s. */
const CARD_BUDGET_MS = 105_000;

/** Two new messages, each in every language, as a change that writes the English must carry them. */
const TEXT_SIZE = {
  en: "Text size",
  ar: "حجم النص",
  de: "Textgröße",
  es: "Tamaño del texto",
  fr: "Taille du texte",
  ja: "文字サイズ",
  ko: "글자 크기",
  "pt-BR": "Tamanho do texto",
  "zh-Hans": "文字大小",
  "zh-Hant": "文字大小",
};
const PAUSED = {
  en: "Paused",
  ar: "متوقف مؤقتًا",
  de: "Angehalten",
  es: "En pausa",
  fr: "En pause",
  ja: "一時停止中",
  ko: "일시 중지됨",
  "pt-BR": "Pausado",
  "zh-Hans": "已暂停",
  "zh-Hant": "已暫停",
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

const node = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, args, { cwd, encoding: "utf8" });

const read = (cwd: string, path: string) => readFileSync(join(cwd, path), "utf8");

function write(cwd: string, path: string, text: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
}

/**
 * What the phone's card generator reads and writes besides the catalogs: the
 * generator and its module loader, the code it bundles, the TypeScript
 * settings that decide how that code compiles, and the hosts and fonts it
 * writes, as the project keeps them.
 */
const PHONE_CARD_FILES = [
  "scripts/generate-phone-cards.ts",
  "scripts/moduleRunner.ts",
  "tsconfig*.json",
  "src",
  "ios/Infinitary/CardRuntime",
  "ios/Infinitary/InfinitaryApp/CardAssets",
];
/** The two hosts the card generator writes, which bundle the whole compiled catalog. */
const PHONE_HOSTS = ["CardHost.generated.js", "PanelHost.generated.js"].map(
  (name) => `ios/Infinitary/InfinitaryApp/CardAssets/${name}`,
);

/**
 * A host as regenerating it with one more message leaves the list of every
 * message: the new name on its own line, where `beside` sorts, as a change
 * adding the message next to `beside` in name order writes it.
 */
function withMessage(host: string, id: string, beside: string): string {
  const lines = host.split("\n");
  const start = lines.indexOf("  const MESSAGES = {");
  const end = lines.indexOf("  };", start);
  const after = lines.findIndex(
    (line, index) => index > start && index < end && line.trim().replace(/,$/, "") > beside,
  );
  expect([start, end, after].every((index) => index > 0)).toBe(true);
  lines.splice(after, 0, `    ${id},`);
  return lines.join("\n");
}

/**
 * A throwaway project holding what the catalog check reads: the compiler,
 * the move script, the language modules, the real catalogs and glossaries
 * and the phone's Info.plist, with the project's packages linked in; with
 * `phoneCards`, also what the phone's card generator reads and writes.
 */
function project({ phoneCards = false } = {}): string {
  const root = scratchDir("catalog-merges-");
  if (phoneCards)
    for (const path of git(REPO, "ls-files", "-z", "--", ...PHONE_CARD_FILES)
      .split("\0")
      .filter(Boolean)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(REPO, path), join(root, path));
    }
  for (const path of [
    "scripts/generate-messages.ts",
    "scripts/move-catalogs.ts",
    // How the checks print a refusal, which the compiler and the card generator import.
    "scripts/github-errors.ts",
    PHONE_INFO_PLIST,
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPO, path), join(root, path));
  }
  const i18n = "src/shared/i18n";
  mkdirSync(join(root, i18n), { recursive: true });
  for (const name of readdirSync(join(REPO, i18n)))
    if (/^[a-z]+\.ts$/.test(name)) copyFileSync(join(REPO, i18n, name), join(root, i18n, name));
  cpSync(join(REPO, CATALOG_DIR), join(root, CATALOG_DIR), { recursive: true });
  cpSync(join(REPO, GLOSSARY_DIR), join(root, GLOSSARY_DIR), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  write(root, "package.json", '{ "type": "module" }\n');
  write(
    root,
    ".gitignore",
    `node_modules\n/${COMPILED_PATH}\n/src/panels/*/messages.generated.ts\n`,
  );
  git(root, "init", "--quiet", "--initial-branch=main");
  return root;
}

/** Adds a glossary term after the table's last row, where a person adds one. */
function appendTerm(glossary: string, row: string): string {
  const lines = glossary.split("\n");
  const last = lines.findLastIndex((line) => line.startsWith("|"));
  return [...lines.slice(0, last + 1), row, ...lines.slice(last + 1)].join("\n");
}

/**
 * A change on its own branch from main: it adds one message in every
 * language at the end of its area file and one German glossary term at the
 * end of the table, runs the compiler as the project asks, and commits;
 * with `phoneCards`, it also rebuilds the phone's card and panel hosts.
 */
function change(
  root: string,
  branch: string,
  id: string,
  words: Record<string, string>,
  term: string,
  { phoneCards = false } = {},
): void {
  git(root, "checkout", "--quiet", "-b", branch, "main");
  for (const [tag, text] of Object.entries(words)) {
    const path = catalogFile(tag, id);
    const messages = JSON.parse(read(root, path)) as Record<string, unknown>;
    write(root, path, `${JSON.stringify({ ...messages, [id]: text }, null, 2)}\n`);
  }
  const glossary = `${GLOSSARY_DIR}/de.md`;
  write(root, glossary, appendTerm(read(root, glossary), term));
  const compiled = node(root, "scripts/generate-messages.ts");
  expect(compiled.stderr).toBe("");
  if (phoneCards) {
    const built = node(root, "scripts/generate-phone-cards.ts");
    expect(built.stderr).toBe("");
    for (const host of PHONE_HOSTS) expect(read(root, host)).toContain(`function ${id}()`);
  }
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", `feat: ${id}`);
}

/** Merges `branch` into the checked-out branch as the batch combines it, answering git's own output. */
const merge = (root: string, branch: string) =>
  spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "merge",
      "--no-ff",
      "--no-edit",
      branch,
    ],
    { cwd: root, encoding: "utf8" },
  );

describe("two changes adding different messages", () => {
  it("combine with no clash, and the combination passes the catalog check", {
    timeout: BUDGET_MS,
  }, () => {
    const root = project();
    expect(node(root, "scripts/generate-messages.ts").stderr).toBe("");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "base");
    change(
      root,
      "text-size",
      "settingsAppearanceTextSize",
      TEXT_SIZE,
      "| text size | Textgröße | |",
    );
    change(
      root,
      "queue-paused",
      "settingsQueuePaused",
      PAUSED,
      "| paused (the queue) | angehalten | |",
    );

    git(root, "checkout", "--quiet", "main");
    git(root, "merge", "--quiet", "--no-ff", "--no-edit", "text-size");
    const combined = merge(root, "queue-paused");
    expect(combined.stdout).not.toContain("CONFLICT");
    expect(combined.status).toBe(0);

    const check = node(root, "scripts/generate-messages.ts", "--check");
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    const english = JSON.parse(readCatalogs(root).en ?? "{}") as Record<string, unknown>;
    expect([english.settingsAppearanceTextSize, english.settingsQueuePaused]).toEqual([
      "Text size",
      "Paused",
    ]);
    expect(read(root, COMPILED_PATH)).toContain("export function settingsQueuePaused()");
    expect(read(root, `${GLOSSARY_DIR}/de.md`)).toContain("| paused (the queue) | angehalten | |");
    expect(read(root, `${GLOSSARY_DIR}/de.md`)).toContain("| text size | Textgröße | |");
  });

  // INF-4334: the phone's card and panel hosts bundle the whole compiled
  // catalog, and they listed every message on one line, so two changes that
  // each added a message and rebuilt the hosts clashed in them in a batch.
  it("that each rebuild the phone's card and panel hosts combine with no clash in them", {
    timeout: CARD_BUDGET_MS,
  }, () => {
    const root = project({ phoneCards: true });
    expect(node(root, "scripts/generate-messages.ts").stderr).toBe("");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "base");
    change(
      root,
      "text-size",
      "settingsAppearanceTextSize",
      TEXT_SIZE,
      "| text size | Textgröße | |",
      { phoneCards: true },
    );
    change(
      root,
      "queue-paused",
      "settingsQueuePaused",
      PAUSED,
      "| paused (the queue) | angehalten | |",
      { phoneCards: true },
    );

    git(root, "checkout", "--quiet", "main");
    git(root, "merge", "--quiet", "--no-ff", "--no-edit", "text-size");
    const combined = merge(root, "queue-paused");
    expect(combined.stdout).not.toContain("CONFLICT");
    expect(combined.status).toBe(0);

    // The combined hosts are what the generator builds from the combined catalog.
    expect(node(root, "scripts/generate-messages.ts", "--check").stderr).toBe("");
    const check = node(root, "scripts/generate-phone-cards.ts", "--check");
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    for (const host of PHONE_HOSTS) {
      const text = read(root, host);
      expect(text).toContain("function settingsAppearanceTextSize()");
      expect(text).toContain("function settingsQueuePaused()");
    }
  });
});

const STRINGS =
  "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/Resources/en.lproj/Localizable.strings";

/**
 * Lays the project out as it stood before the move, one file per language
 * and the compiled file committed, and commits it on main.
 */
function beforeTheMove(root: string): void {
  for (const [tag, text] of Object.entries(readCatalogs(root)))
    write(root, `${CATALOG_DIR}/${tag}.json`, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  for (const name of readdirSync(join(root, CATALOG_DIR), { withFileTypes: true }))
    if (name.isDirectory()) rmSync(join(root, CATALOG_DIR, name.name), { recursive: true });
  write(root, ".gitignore", "node_modules\n");
  write(root, COMPILED_PATH, read(REPO, COMPILED_PATH));
  write(root, STRINGS, read(REPO, STRINGS));
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "base");
}

/**
 * The waiting change, on its own branch: a message at the end of every
 * language's file and the stored files it rebuilt, plus whatever else
 * `alsoEdits` writes in the same commit.
 */
function waitingChange(root: string, alsoEdits: () => void = () => {}): void {
  git(root, "checkout", "--quiet", "-b", "waiting", "main");
  for (const [tag, text] of Object.entries(PAUSED)) {
    const path = `${CATALOG_DIR}/${tag}.json`;
    write(
      root,
      path,
      `${JSON.stringify({ ...JSON.parse(read(root, path)), settingsQueuePaused: text }, null, 2)}\n`,
    );
  }
  write(
    root,
    COMPILED_PATH,
    `${read(root, COMPILED_PATH)}export function settingsQueuePaused(): string {}\n`,
  );
  write(root, STRINGS, `${read(root, STRINGS)}"settingsQueuePaused" = "Paused";\n`);
  alsoEdits();
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "feat: queue paused");
}

/**
 * Main makes the move, then takes another message in the new layout, with
 * whatever `alsoEdits` writes in that change's own commit.
 */
function mainMoves(root: string, alsoEdits: () => void = () => {}): void {
  git(root, "checkout", "--quiet", "main");
  const moved = node(root, "scripts/move-catalogs.ts");
  expect(moved.stderr).toBe("");
  write(
    root,
    ".gitignore",
    `node_modules\n/${COMPILED_PATH}\n/src/panels/*/messages.generated.ts\n`,
  );
  git(root, "rm", "--quiet", "--cached", COMPILED_PATH);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "refactor: move the catalogs");
  change(root, "text-size", "settingsAppearanceTextSize", TEXT_SIZE, "| text size | Textgröße | |");
  alsoEdits();
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "--amend", "--no-edit");
  git(root, "checkout", "--quiet", "main");
  git(root, "merge", "--quiet", "--ff-only", "text-size");
}

/** Brings the waiting change up to date with main, which stops on the move. */
function rebaseStops(root: string): void {
  git(root, "checkout", "--quiet", "waiting");
  expect(() => git(root, "rebase", "main")).toThrow();
}

const unmerged = (root: string) =>
  git(root, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);

describe("a change written before the move", () => {
  it("is brought up to date by the move script, its message carried into the area files", {
    timeout: BUDGET_MS,
  }, () => {
    const root = project();
    beforeTheMove(root);
    waitingChange(root);
    mainMoves(root);
    rebaseStops(root);

    const resolved = node(root, "scripts/move-catalogs.ts", "resolve");
    expect(resolved.stderr).toBe("");
    expect(resolved.status).toBe(0);
    git(root, "-c", "core.editor=true", "rebase", "--continue");

    expect(node(root, "scripts/generate-messages.ts", "--check").stderr).toBe("");
    const english = JSON.parse(readCatalogs(root).en ?? "{}") as Record<string, unknown>;
    expect([english.settingsAppearanceTextSize, english.settingsQueuePaused]).toEqual([
      "Text size",
      "Paused",
    ]);
    expect(existsSync(join(root, CATALOG_DIR, "en.json"))).toBe(false);
    expect(git(root, "ls-files", COMPILED_PATH)).toBe("");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  // INF-4091: the resolve step staged the phone's card host with three sets of
  // conflict marks and answered that nothing was left. The hosts bundle the
  // whole compiled catalog, so a change that adds a message regenerates them,
  // and so does main's next change that adds one. The waiting change's name
  // goes where main's sorts, so the hosts clash as two neighboring names do.
  it("rebuilds the phone's card and panel hosts the change regenerated", {
    timeout: CARD_BUDGET_MS,
  }, () => {
    const root = project({ phoneCards: true });
    beforeTheMove(root);
    waitingChange(root, () => {
      for (const host of PHONE_HOSTS) {
        const regenerated = withMessage(
          read(root, host),
          "settingsQueuePaused",
          "settingsAppearanceTextSize",
        );
        expect(regenerated).not.toBe(read(root, host));
        write(root, host, regenerated);
      }
    });
    mainMoves(root, () => {
      const built = node(root, "scripts/generate-phone-cards.ts");
      expect(built.stderr).toBe("");
    });
    rebaseStops(root);
    expect(unmerged(root)).toEqual(expect.arrayContaining(PHONE_HOSTS));

    const resolved = node(root, "scripts/move-catalogs.ts", "resolve");
    expect(resolved.stderr).toBe("");
    expect(resolved.status).toBe(0);
    git(root, "-c", "core.editor=true", "rebase", "--continue");

    for (const host of PHONE_HOSTS) {
      const text = read(root, host);
      expect(text.match(/^(<{7}|={7}|>{7})( .*)?$/gm)).toBeNull();
      expect(text).toContain("function settingsQueuePaused()");
      expect(text).toContain("function settingsAppearanceTextSize()");
    }
    const check = node(root, "scripts/generate-phone-cards.ts", "--check");
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("leaves a phone file it does not rebuild unmerged, and names it", {
    timeout: BUDGET_MS,
  }, () => {
    const root = project();
    const view = "ios/Infinitary/InfinitaryApp/CardLogView.swift";
    const comment = "/// INF-3887: the phone's log reader, the twin of the desktop's.";
    write(root, view, read(REPO, view));
    expect(read(root, view)).toContain(comment);
    beforeTheMove(root);
    waitingChange(root, () =>
      write(
        root,
        view,
        read(root, view).replace(comment, "/// INF-3887: the phone's log reader, as on the Mac."),
      ),
    );
    mainMoves(root, () =>
      write(
        root,
        view,
        read(root, view).replace(comment, "/// INF-3887: the phone's proof log reader."),
      ),
    );
    rebaseStops(root);

    const resolved = node(root, "scripts/move-catalogs.ts", "resolve");
    expect(resolved.stderr).toBe(`resolve these by hand, then continue:\n${view}\n`);
    expect(resolved.status).toBe(1);
    expect(unmerged(root)).toEqual([view]);
    expect(read(root, view)).toMatch(/^<{7} /m);
    // Everything else the stop needed is carried and staged.
    expect(git(root, "diff", "--cached", "--name-only")).toContain(
      catalogFile("en", "settingsQueuePaused"),
    );
  });
});
