import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TIERED_STORY_HEADINGS } from "@shared/cardHeadings";
import type { ChangePresentationDraft } from "@shared/changePresentation";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { Forge, ForgeChange } from "../forge";
import { presentationMarkdownText } from "../forge/presentation";
import { stageChangePresentation } from "../pi/changePresentation";
import { openDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { ChangePresentations } from "./changePresentations";

/**
 * INF-3749's free-form part, as the captain amended it: "the freeform part
 * should replace the structured content in 'what changed' instead. it should
 * be a freeform expression of what changed, and it should follow the
 * picture-first principle as well". The pictures are the project's own
 * committed release-note pictures, read by the card's own picture reader.
 */

const HEAD = "5ca2d466ee21f9733827383f23df81f3874e0d10";
const TASK = "ab12cd34";
const BRANCH = `fm/task-${TASK}`;
const risk = Object.fromEntries(
  RISK_DIMENSIONS.map((dimension) => [
    dimension,
    { level: "low", why: `The ${dimension} assessment for this fixture.` },
  ]),
) as RiskDeclaration;
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});

/** A crewmate's part: a drawn figure of the change, a picture beside its sentence, the rest folded. */
const PART = [
  '<figure aria-label="Reply line before and after"><svg viewBox="0 0 750 120" width="100%"><rect x="0" y="20" width="300" height="80" fill="var(--bg-2)"/><text x="20" y="64">Before: two lines</text><rect x="420" y="20" width="300" height="80" fill="var(--accent-dim)"/><text x="440" y="64">After: one line</text></svg></figure>',
  "<p>The reply sits on one line under its card.</p>",
  '<img src="part.webp" alt="The reply line under a card, drawn on one line">',
  "<details><summary>Why one line</summary><p>Two lines pushed the card off the stage.</p></details>",
].join("\n");

async function arrange() {
  const root = scratchDir("infinitary-story-part-");
  const media = join(root, "cards");
  const worktree = join(root, "work");
  const evidence = join(root, "evidence");
  for (const dir of [media, worktree, evidence]) mkdirSync(dir);
  for (const [from, to] of [
    ["action-reply-line-dark", "dark.webp"],
    ["action-reply-line-light", "light.webp"],
    ["action-reply-line-light", "part.webp"],
  ] as const)
    copyFileSync(resolve(`release-notes/pictures/${from}.webp`), join(worktree, to));
  const db = openDatabase(join(root, "data"));
  closes.push(() => db.close());
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: TASK,
    title: "Show the change",
    prompt: "Share the evidence",
    branch: BRANCH,
    worktreeDir: worktree,
    repoDir: worktree,
    status: "idle",
  });
  let change: ForgeChange | null = null;
  let uploads = 0;
  const forge: Forge = {
    kind: "github",
    host: "github.com",
    place: "GitHub",
    hasChecks: true,
    attachments: {
      destination: async () => ({
        host: "github.com",
        projectId: 1,
        fullName: "octo/meterlab",
        visibility: "public" as const,
      }),
      upload: vi.fn(async () => ({
        url: `https://github.com/user-attachments/assets/846dced7-16ad-44c0-b6f5-${String(++uploads).padStart(12, "0")}`,
      })),
    },
    branchHead: async () => HEAD,
    changeFor: async () => (change ? { ...change } : null),
    openChange: async (input) => {
      change = {
        ...input,
        headSha: HEAD,
        number: 1,
        url: "https://github.com/octo/meterlab/pull/1",
      };
      return { ...change };
    },
    updateChangeBody: async () => {},
    checks: async () => ({ overall: "green", items: [] }),
    defaultBranch: async () => "main",
    listProjects: async () => [],
    close: async () => {},
    putIn: async () => undefined,
    label: () => "#1",
    url: (value) => value.url,
  };
  const draft: ChangePresentationDraft = {
    title: "fix: keep the reply on one line",
    base: HEAD,
    head: HEAD,
    publishable: true,
    why: ["The reply under a card wrapped onto two lines."],
    whatChanged: ["The reply under a card stays on one line."],
    before: ["The reply wrapped onto two lines."],
    after: ["The reply stays on one line."],
    views: [
      {
        id: "reply",
        caption: "The reply line",
        kind: "changed",
        before: [
          { path: "dark.webp", alt: "The reply line before", captureHead: HEAD, inspected: true },
        ],
        after: [
          {
            path: "light.webp",
            alt: "The reply line after",
            captureHead: HEAD,
            inspected: true,
            faults: [],
          },
        ],
      },
    ],
    checked: [{ check: "Reply line", result: "One line at the smallest window." }],
    verification: ["Photographed the reply line in both themes."],
    risk,
    requiredActions: [],
    unfinished: [],
  };
  const service = new ChangePresentations({ tasks, mediaDir: () => media, head: async () => HEAD });
  const pictureRoot = { taskId: TASK, worktree, dir: media, evidenceDir: evidence };
  return { evidence, draft, forge, service, pictureRoot, uploads: () => uploads };
}

describe("a story's free-form part", () => {
  it("draws on the merge card in place of the What changed bullets, which the pull request keeps", async () => {
    const at = await arrange();
    const file = join(at.evidence, "what-changed.html");
    writeFileSync(file, PART);
    const staged = await stageChangePresentation(
      { ...at.draft, whatChangedPart: file },
      at.pictureRoot,
    );
    await at.service.prepare(TASK, staged, at.forge);
    const change = await at.service.publish(TASK, 1, at.forge, BRANCH, at.draft.title, "pending");
    const card = await at.service.completion(TASK, 1, HEAD);

    // On the card the part sits under What changed, before Before and after, and the bullets are gone.
    const whatChanged = card.body.indexOf(`<h3>${TIERED_STORY_HEADINGS[1]}</h3>`);
    const figure = card.body.indexOf('<figure aria-label="Reply line before and after">');
    expect(whatChanged).toBeGreaterThanOrEqual(0);
    expect(figure).toBeGreaterThan(whatChanged);
    expect(figure).toBeLessThan(card.body.indexOf(`<h3>${TIERED_STORY_HEADINGS[2]}</h3>`));
    expect(card.body).toContain("<summary>Why one line</summary>");
    expect(card.body).not.toContain(`<li>${at.draft.whatChanged[0]}</li>`);
    // Its picture is the card's own copy, which the card carries, never the working-copy path.
    const src = card.body.match(
      /<img src="app-frame:\/\/images\/([^".]+)\.webp" alt="The reply line under a card/,
    )?.[1];
    expect(src).toBeDefined();
    expect(card.pictures?.map((picture) => picture.id)).toContain(src);
    expect(staged.assets.map((asset) => asset.id)).not.toContain(src);
    expect(card.body).not.toContain("part.webp");

    // The pull request keeps the bullets, and uploads only the view's two pictures.
    expect(change.body).toContain(`- ${presentationMarkdownText(at.draft.whatChanged[0] ?? "")}`);
    expect(change.body).not.toContain("Reply line before and after");
    expect(at.uploads()).toBe(2);
  });

  it("refuses a part that asks a question, since the merge card's one answer is the merge", async () => {
    const at = await arrange();
    const file = join(at.evidence, "asks.html");
    writeFileSync(file, `${PART}\n<label><input type="checkbox" name="ok"> Looks right</label>`);
    await expect(
      stageChangePresentation({ ...at.draft, whatChangedPart: file }, at.pictureRoot),
    ).rejects.toThrow(/Story part refused: the part is pictures and words only/);
  });
});
