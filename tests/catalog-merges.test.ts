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
// compiler, and combines branches with real git, as the merge queue does.

const REPO = process.cwd();
/** Five times the slowest case on the Mac, 3.2 s (docs/test-cohorts.md). */
const BUDGET_MS = 20_000;

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
 * A throwaway project holding what the catalog check reads: the compiler,
 * the move script, the language modules, the real catalogs and glossaries
 * and the phone's Info.plist, with the project's packages linked in.
 */
function project(): string {
  const root = scratchDir("catalog-merges-");
  for (const path of [
    "scripts/generate-messages.ts",
    "scripts/move-catalogs.ts",
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
 * end of the table, runs the compiler as the project asks, and commits.
 */
function change(
  root: string,
  branch: string,
  id: string,
  words: Record<string, string>,
  term: string,
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
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", `feat: ${id}`);
}

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
    const combined = spawnSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "merge",
        "--no-ff",
        "--no-edit",
        "queue-paused",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
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
});

describe("a change written before the move", () => {
  it("is brought up to date by the move script, its message carried into the area files", {
    timeout: BUDGET_MS,
  }, () => {
    const root = project();
    // The project as it stood before the move: one file per language, and the compiled file committed.
    for (const [tag, text] of Object.entries(readCatalogs(root)))
      write(root, `${CATALOG_DIR}/${tag}.json`, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    for (const name of readdirSync(join(root, CATALOG_DIR), { withFileTypes: true }))
      if (name.isDirectory()) rmSync(join(root, CATALOG_DIR, name.name), { recursive: true });
    write(root, ".gitignore", "node_modules\n");
    write(root, COMPILED_PATH, read(REPO, COMPILED_PATH));
    const strings =
      "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/Resources/en.lproj/Localizable.strings";
    write(root, strings, read(REPO, strings));
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "base");

    // The waiting change: a message at the end of every language's file, and the stored files it rebuilt.
    git(root, "checkout", "--quiet", "-b", "waiting");
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
    write(root, strings, `${read(root, strings)}"settingsQueuePaused" = "Paused";\n`);
    git(root, "commit", "--quiet", "-am", "feat: queue paused");

    // Main makes the move, then takes another message in the new layout.
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
    change(
      root,
      "text-size",
      "settingsAppearanceTextSize",
      TEXT_SIZE,
      "| text size | Textgröße | |",
    );
    git(root, "checkout", "--quiet", "main");
    git(root, "merge", "--quiet", "--ff-only", "text-size");

    git(root, "checkout", "--quiet", "waiting");
    expect(() => git(root, "rebase", "main")).toThrow();
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
});
