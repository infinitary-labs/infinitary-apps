import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ChangePresentationDraft,
  PresentationRecovery,
  StoryAround,
} from "@shared/changePresentation";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import type { WorkShape } from "@shared/routingPolicy";
import { onTestFinished, vi } from "vitest";
import type { Forge, ForgeChange } from "../../src/core/forge";
import { ChangePresentations } from "../../src/core/orchestrator/changePresentations";
import { stageChangePresentation } from "../../src/core/pi/changePresentation";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { bundledRunbooks } from "./crewHarness";
import { scratchDir } from "./scratchDirs";

// INF-92 / accepted INF-132 owns the upload barrier, saved story parity and recovery.
// Real, already committed app photographs exercise the existing media reader.
export const HEAD = "5ca2d466ee21f9733827383f23df81f3874e0d10";
export const TASK = "ab12cd34";
export const BRANCH = `fm/task-${TASK}`;
export const risk = Object.fromEntries(
  RISK_DIMENSIONS.map((dimension) => [
    dimension,
    { level: "low", why: `The ${dimension} assessment for this fixture.` },
  ]),
) as RiskDeclaration;
export async function arrange(options: { shape?: WorkShape } = {}) {
  const root = scratchDir("infinitary-presentation-");
  const media = join(root, "cards");
  const worktree = join(root, "work");
  mkdirSync(media);
  mkdirSync(worktree);
  for (const theme of ["dark", "light"])
    copyFileSync(
      resolve(`release-notes/pictures/action-reply-line-${theme}.webp`),
      join(worktree, `${theme}.webp`),
    );
  let db = openDatabase(join(root, "data"));
  let tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: TASK,
    title: "Show the change",
    prompt: "Share the evidence",
    branch: BRANCH,
    worktreeDir: worktree,
    repoDir: worktree,
    status: "idle",
    ...(options.shape ? { shape: options.shape } : {}),
  });
  // The unit pool shares module caches; register cleanup for each fixture's actual test.
  onTestFinished(() => {
    db.close();
  });
  let head = HEAD;
  let change: ForgeChange | null = null;
  let destination = {
    host: "github.com",
    projectId: 1422452335,
    fullName: "example-studio/evidence-sample",
    visibility: "public" as "public" | "private",
  };
  const order: string[] = [];
  const upload = vi.fn(async () => {
    order.push("upload");
    return {
      url: `https://github.com/user-attachments/assets/846dced7-16ad-44c0-b6f5-${String(upload.mock.calls.length).padStart(12, "0")}`,
    };
  });
  const open = vi.fn(async (input: { branch: string; title: string; body: string }) => {
    order.push("open");
    change = {
      ...input,
      headSha: head,
      number: 1,
      url: "https://github.com/example-studio/evidence-sample/pull/1",
    };
    return { ...change };
  });
  const update = vi.fn(async (_current: ForgeChange, body: string, title?: string) => {
    order.push("update");
    if (!change) throw new Error("No open change");
    change = { ...change, body, headSha: head, ...(title === undefined ? {} : { title }) };
  });
  const forge: Forge = {
    kind: "github",
    host: "github.com",
    place: "GitHub",
    hasChecks: true,
    attachments: { destination: async () => ({ ...destination }), upload },
    branchHead: async () => head,
    changeFor: async () => (change ? { ...change } : null),
    openChange: open,
    updateChangeBody: update,
    checks: async () => ({ overall: "green", items: [] }),
    defaultBranch: async () => "main",
    listProjects: async () => [],
    close: async () => {},
    putIn: async () => undefined,
    label: () => "#1",
    url: (value) => value.url,
  };
  const draft: ChangePresentationDraft = {
    title: "feat: share the change story",
    base: HEAD,
    head: HEAD,
    publishable: true,
    why: ["The pull request should tell the same story as the merge card."],
    whatChanged: ["The description carries the selected photographs."],
    before: ["The earlier description contained text alone."],
    after: ["Both views show the same evidence."],
    views: [
      {
        id: "completion",
        caption: "Completion story",
        kind: "changed",
        before: [
          {
            path: "dark.webp",
            alt: "The existing dark completion view",
            captureHead: HEAD,
            inspected: true,
          },
        ],
        after: [
          {
            path: "light.webp",
            alt: "The inspected light completion view",
            captureHead: HEAD,
            inspected: true,
            faults: [],
          },
        ],
      },
    ],
    checked: [{ check: "Publication", result: "The selected story and evidence agree." }],
    verification: ["Opened both pictures and read the description back."],
    risk,
    requiredActions: [],
    unfinished: [],
    projectText: "Closes #24",
  };
  const staged = await stageChangePresentation(draft, { taskId: TASK, worktree, dir: media });
  const readHead = vi.fn(async () => head);
  // The map part and naming rule the app ships, read as the app reads them.
  const runbooks = bundledRunbooks();
  const create = () =>
    new ChangePresentations({
      tasks,
      mediaDir: () => media,
      head: readHead,
      mapPart: () => runbooks.mapPart(),
      namingRule: () => runbooks.naming(),
    });
  let service = create();
  return {
    root,
    media,
    worktree,
    draft,
    staged,
    forge,
    order,
    readHead,
    upload,
    open,
    update,
    get service() {
      return service;
    },
    get tasks() {
      return tasks;
    },
    get cards() {
      return new CardStore(db);
    },
    get change() {
      return change;
    },
    set change(value: ForgeChange | null) {
      change = value;
    },
    setHead(value: string) {
      head = value;
    },
    setVisibility(value: "public" | "private") {
      destination = { ...destination, visibility: value };
    },
    restart() {
      db.close();
      db = openDatabase(join(root, "data"));
      tasks = new TaskService({ db, strict: true });
      service = create();
    },
    prepare: () => service.prepare(TASK, staged, forge),
    publish: (revision = 1, recovery?: PresentationRecovery, around?: StoryAround) =>
      service.publish(
        TASK,
        revision,
        forge,
        BRANCH,
        "feat: share the change story",
        "pending",
        recovery,
        around,
      ),
  };
}
