import { expect, it } from "vitest";
import { isCheckedFile, ledgerProblems, RAW_WORDS_LEDGER, rawWordsIn } from "../scripts/raw-words";
import { FOLLOWS_COMPUTER } from "../src/shared/i18n/start";

// The approved plan (INF-3674, "What done looks like"): pnpm check refuses
// raw words outside the ledger, and the ledger only shrinks until it is
// empty when the window's words have moved into the catalog.

const COMPONENT = `
import * as m from "@shared/i18n/messages.generated";
export function Strip({ count, onKey }: { count: number; onKey: (key: string) => void }) {
  const press = (event: KeyboardEvent) => { if (event.key === "Escape") onKey("close"); };
  console.warn("a log line stays English");
  return (
    <div className="inf-row fm-strip" data-strip="open" style={{ padding: "3px 8px", transition: "opacity var(--dur-fast) ease" }}>
      <button type="button" aria-label="Close the strip" onKeyDown={press}>×</button>
      <span title={m.fileAdd()}>{m.composerLines({ count })}</span>
      Nothing to show yet
      {count > 1 ? \`\${count} tasks waiting\` : "Ready"}
      {/* i18n-exempt: a product name */}
      <span>Claude Code</span>
    </div>
  );
}
`;

it("finds the words a person reads typed into a component, and nothing that names code", () => {
  expect(
    rawWordsIn("src/renderer/src/app/Strip.tsx", COMPONENT).map((words) => words.text),
  ).toEqual(["Close the strip", "Nothing to show yet", "`${count} tasks waiting`", "Ready"]);
});

// The captain's ask: "Make the words check read shared, core and system code
// too, with a list that only shrinks, so new English there is refused." Text
// served only to a model - the prompt and the tools' definitions - stays English.
it("reads the window, the app's own panels and the shared, core, main and preload code, never tests, developer-only views or served text", () => {
  expect(isCheckedFile("src/renderer/src/cards/CardThread.tsx")).toBe(true);
  expect(isCheckedFile("src/panels/now/panel.tsx")).toBe(true);
  expect(isCheckedFile("src/shared/keyboard.ts")).toBe(true);
  expect(isCheckedFile("src/renderer/src/plugins/builtin/record/record.frame.js")).toBe(true);
  expect(isCheckedFile("src/renderer/src/cards/CardThread.test.tsx")).toBe(false);
  expect(isCheckedFile("src/renderer/src/design/fixtures/UiKitGallery.tsx")).toBe(false);
  expect(isCheckedFile("src/renderer/src/plugins/builtin/observe/observe.frame.js")).toBe(false);
  expect(isCheckedFile("src/core/orchestrator/settleWords.ts")).toBe(true);
  expect(isCheckedFile("src/shared/secrets.ts")).toBe(true);
  expect(isCheckedFile("src/main/index.ts")).toBe(true);
  expect(isCheckedFile("src/preload/index.ts")).toBe(true);
  expect(isCheckedFile("src/core/prompts/cardContract.ts")).toBe(false);
  expect(isCheckedFile("src/core/pi/crewTools.ts")).toBe(false);
  expect(isCheckedFile("src/core/orchestrator/settleWords.test.ts")).toBe(false);
});

it("refuses raw words outside the ledger, a listed file that gains some, and a ledger that does not shrink", () => {
  const ledger = {
    "src/renderer/src/a.tsx": 3,
    "src/renderer/src/b.tsx": 2,
    "src/renderer/src/c.tsx": 1,
  };
  expect(
    ledgerProblems(
      {
        "src/renderer/src/a.tsx": 4,
        "src/renderer/src/b.tsx": 1,
        "src/renderer/src/c.tsx": 0,
        "src/renderer/src/d.tsx": 2,
      },
      ledger,
    ),
  ).toEqual([
    "src/renderer/src/a.tsx: 4 run(s) of raw words, more than the ledger's 3; put the new words in the catalog (docs/i18n.md), the ledger only shrinks",
    "scripts/raw-words.ts: src/renderer/src/b.tsx now holds 1 run(s) of raw words; lower its entry to 1",
    "src/renderer/src/d.tsx: 2 run(s) of words typed in for a person to read; put them in the catalog (docs/i18n.md), or say why one stays with i18n-exempt",
    "scripts/raw-words.ts: src/renderer/src/c.tsx holds no raw words now; remove its entry, and the ledger shrinks",
  ]);
  expect(ledgerProblems({ "src/renderer/src/a.tsx": 3 }, { "src/renderer/src/a.tsx": 3 })).toEqual(
    [],
  );
});

// The captain's answer to the review of the first languages (INF-3850):
// English stays the default until the ledger is empty. The pull request that
// empties it turns on following the computer's language in the same change.
it("keeps English the default exactly while the ledger still lists raw words", () => {
  const left = Object.values(RAW_WORDS_LEDGER).some((count) => count > 0);
  expect(FOLLOWS_COMPUTER).toBe(!left);
});
