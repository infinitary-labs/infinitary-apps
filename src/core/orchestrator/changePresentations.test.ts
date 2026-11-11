import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type ChangePresentationDraft,
  type PresentationRecovery,
  presentationRecoverySchema,
  type StoryAround,
} from "@shared/changePresentation";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_POSTER, DEMO_RECORDING, GIF_DEMO_RECORDING } from "../../../tests/e2e/demoFixtures";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import {
  AttachmentUploadError,
  type Forge,
  type ForgeChange,
  ForgeWriteError,
  NO_MISTAKES_ATTESTATION_PREFIX,
  NO_MISTAKES_SIGNATURE,
  presentationMarkdown,
  presentationRegionMarkers,
  readPresentationRegion,
} from "../forge";
import { presentationMarkdownText } from "../forge/presentation";
import { stageChangePresentation } from "../pi/changePresentation";
import { CardStore } from "../storage/cardStore";
import { openDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { ChangePresentations, GITHUB_STORY_BODY_LIMIT } from "./changePresentations";

// INF-92 / accepted INF-132 owns the upload barrier, saved story parity and recovery.
// Real, already committed app photographs exercise the existing media reader.
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

async function arrange() {
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
  });
  closes.push(() => db.close());
  let head = HEAD;
  let change: ForgeChange | null = null;
  let destination = {
    host: "github.com",
    projectId: 1422452335,
    fullName: "kunchenguid/infinitary-evidence-test-public",
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
      url: "https://github.com/kunchenguid/infinitary-evidence-test-public/pull/1",
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
  const create = () => new ChangePresentations({ tasks, mediaDir: () => media, head: readHead });
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

describe("saved change publication", () => {
  // INF-467 submitted answers: short typed parts, with instruction-only version hygiene.
  it("keeps selected item counts typed and prose judgments with the author (INF-467, captain reach ruling)", async () => {
    const at = await arrange();
    const root = { taskId: TASK, worktree: at.worktree, dir: at.media };
    await expect(stageChangePresentation({ ...at.draft, checked: [] }, root)).rejects.toThrow();
    await expect(
      stageChangePresentation({ ...at.draft, checked: Array(7).fill(at.draft.checked[0]) }, root),
    ).rejects.toThrow();
    // The captain's 2026-10-19 reach ruling leaves brevity to the author,
    // not a character threshold the host invented for a sentence.
    const why = [
      "The pull request and its completion card should present the same inspected evidence, without asking the reader to work through repeated command transcripts. The shorter reading should keep the comparison visible while leaving the full verification available for a reader who opens the details.",
    ];
    const staged = await stageChangePresentation(
      { ...at.draft, why, verification: [`The inspected code is ${HEAD}.`] },
      root,
    );
    expect(staged.verification).toEqual([`The inspected code is ${HEAD}.`]);
    await expect(at.service.prepare(TASK, staged, at.forge)).resolves.toBe(1);
    expect(at.tasks.delivery.changePresentation(TASK)?.revisions[0]?.why).toEqual(why);
    await expect(
      at.service.publish(TASK, 1, at.forge, BRANCH, "fix: a different name"),
    ).rejects.toThrow("saved title");
    expect(at.upload).not.toHaveBeenCalled();
  });

  it("INF-125: preserves an approved prerequisite draft through the saved-story publisher", async () => {
    const at = await arrange();
    const revision = await at.prepare();
    const beforePublish = vi.fn((head: string) => {
      expect(head).toBe(HEAD);
      at.order.push("authority");
    });
    const change = await at.service.publish(
      TASK,
      revision,
      at.forge,
      BRANCH,
      "feat: share the change story",
      "pending",
      undefined,
      undefined,
      { draft: true, beforePublish },
    );
    expect(beforePublish).toHaveBeenCalledTimes(1);
    expect(at.order[0]).toBe("authority");
    expect(at.open).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
    expect(change.draft).toBe(true);
    expect(at.tasks.delivery.changePresentation(TASK)?.published?.revision).toBe(revision);
  });

  it("INF-125: an expired prerequisite permission stops the story before any upload or opening", async () => {
    const at = await arrange();
    const revision = await at.prepare();
    await expect(
      at.service.publish(
        TASK,
        revision,
        at.forge,
        BRANCH,
        "feat: share the change story",
        "pending",
        undefined,
        undefined,
        {
          draft: true,
          beforePublish: () => {
            throw new Error("The prerequisite permission expired.");
          },
        },
      ),
    ).rejects.toThrow("permission expired");
    expect(at.upload).not.toHaveBeenCalled();
    expect(at.open).not.toHaveBeenCalled();
    expect(at.tasks.delivery.changePresentation(TASK)?.publication).toBeUndefined();
  });

  // INF-285 F3: the complete rendered description must fit before any upload.
  it("refuses a valid story whose escaped Markdown exceeds GitHub's body limit before uploading", async () => {
    const at = await arrange();
    const staged = await stageChangePresentation(
      {
        ...at.draft,
        verification: Array.from(
          { length: 12 },
          (_, index) => `${index + 1}. ${"Compare <before> & <after> in [the view]. ".repeat(90)}`,
        ),
      },
      { taskId: TASK, worktree: at.worktree, dir: at.media },
    );
    await at.service.prepare(TASK, staged, at.forge);
    await expect(at.publish()).rejects.toThrow(/65,536/);
    expect(at.upload).not.toHaveBeenCalled();
    expect(at.open).not.toHaveBeenCalled();
    expect(at.tasks.delivery.changePresentation(TASK)?.publication).toBeUndefined();
  });

  it.each([false, true])(
    "counts surrounding human text before replacement uploads (edited markers: %s)",
    async (editedMarkers) => {
      const at = await arrange();
      await at.prepare();
      const previous = await at.publish();
      const poster = DEMO_POSTER.bytes;
      if (!poster) throw new Error("The fixture needs its inspected poster");
      writeFileSync(join(at.worktree, "next.png"), poster);
      const next = await stageChangePresentation(
        {
          ...at.draft,
          verification: Array.from({ length: 3 }, () =>
            "The next view includes the inspected recording poster. ".repeat(50),
          ),
          views: at.draft.views.map((view) => ({
            ...view,
            after: view.after.map((media) => ({ ...media, path: "next.png" })),
          })),
        },
        { taskId: TASK, worktree: at.worktree, dir: at.media },
      );
      const revision = await at.service.prepare(TASK, next, at.forge);
      const oldBody = previous.body ?? "";
      const note = `Human release notes: ${"Keep this detail. ".repeat(3300)}`;
      const body = `${note}\n${editedMarkers ? oldBody.replace(presentationRegionMarkers(TASK).end, "") : oldBody}`;
      // The already-published description fits; adding the replacement story does not.
      expect(body.length).toBeLessThanOrEqual(GITHUB_STORY_BODY_LIMIT);
      at.change = { ...previous, body };
      at.upload.mockClear();
      await expect(
        at.publish(revision, editedMarkers ? { replaceRegion: body } : undefined),
      ).rejects.toThrow(/65,536/);
      expect(at.upload).not.toHaveBeenCalled();
      expect(at.update).not.toHaveBeenCalled();
      expect(at.change.body).toBe(body);
      expect(at.tasks.delivery.changePresentation(TASK)?.published?.revision).toBe(1);
    },
  );

  // INF-285 F3: count project text and actual Markdown expansion at the exact host boundary.
  it.each([0, 1])(
    "checks the complete rendered opening at the body limit plus %s characters",
    async (extra) => {
      const at = await arrange();
      const staged = {
        ...at.staged,
        verification: Array.from({ length: 10 }, () =>
          "Compare <before> & <after> in [the view]. ".repeat(90),
        ),
        projectText: "",
      };
      await at.service.prepare(TASK, staged, at.forge);
      const story = at.tasks.delivery.changePresentation(TASK)?.revisions[0];
      if (!story) throw new Error("Missing prepared story");
      const url = "https://github.com/user-attachments/assets/846dced7-16ad-44c0-b6f5-f0e5581165b2";
      const region = presentationMarkdown(
        story,
        new Map(story.assets.map((asset) => [asset.id, url])),
        "pending",
      );
      const projectText = "Release notes: ".padEnd(
        GITHUB_STORY_BODY_LIMIT - region.length - 2 + extra,
        ".",
      );
      const revision = await at.service.prepare(TASK, { ...staged, projectText }, at.forge);
      if (extra) {
        await expect(at.publish(revision)).rejects.toThrow(/65,536/);
        expect(at.upload).not.toHaveBeenCalled();
        expect(at.open).not.toHaveBeenCalled();
      } else {
        const published = await at.publish(revision);
        expect(published.body).toHaveLength(GITHUB_STORY_BODY_LIMIT);
        expect(published.body?.startsWith(projectText)).toBe(true);
        for (const upload of at.upload.mock.results) {
          const receipt = await upload.value;
          expect(published.body).toContain(receipt.url);
        }
        expect(at.tasks.delivery.changePresentation(TASK)?.published?.revision).toBe(revision);
      }
    },
  );

  it("rechecks the description when a person adds text during upload (INF-285 F3)", async () => {
    const at = await arrange();
    await at.prepare();
    const previous = await at.publish();
    const poster = DEMO_POSTER.bytes;
    if (!poster) throw new Error("The fixture needs its inspected poster");
    writeFileSync(join(at.worktree, "next.png"), poster);
    const next = await stageChangePresentation(
      {
        ...at.draft,
        views: at.draft.views.map((view) => ({
          ...view,
          after: view.after.map((media) => ({ ...media, path: "next.png" })),
        })),
      },
      { taskId: TASK, worktree: at.worktree, dir: at.media },
    );
    const revision = await at.service.prepare(TASK, next, at.forge);
    const send = at.upload.getMockImplementation();
    if (!send) throw new Error("Missing upload implementation");
    at.upload.mockImplementationOnce(async () => {
      at.change = {
        ...previous,
        body: `${"A person's new notes. ".repeat(3300)}\n${previous.body}`,
      };
      return send();
    });
    await expect(at.publish(revision)).rejects.toThrow(/65,536/);
    expect(at.update).not.toHaveBeenCalled();
    expect(at.change?.body).toContain("A person's new notes.");
    expect(at.tasks.delivery.changePresentation(TASK)?.published?.revision).toBe(1);
  });

  it("opens only after every upload and uses the same ordered views, words and risks on the card", async () => {
    const at = await arrange();
    expect(await at.prepare()).toBe(1);
    await expect(at.service.completion(TASK, 1, HEAD)).rejects.toThrow(/must be published/);
    const change = await at.publish();
    expect(at.order).toEqual(["upload", "upload", "open"]);
    const card = await at.service.completion(TASK, 1, HEAD);
    for (const heading of ["Why", "What changed", "Before and after", "Checked"]) {
      expect(change.body).toContain(`## ${heading}`);
      expect(card.body).toContain(`<h3>${heading}</h3>`);
    }
    expect(change.body).not.toContain("Checks are pending");
    expect(change.body).not.toContain("Story 1");
    expect(card.body).not.toContain("Story 1");
    expect(card.riskDeclaration).toEqual(at.draft.risk);
    expect(card.requiredActions).toEqual(at.draft.requiredActions);
    expect(card.pictures.map((picture) => picture.alt)).toEqual(
      at.draft.views.flatMap((view) => [...view.before, ...view.after].map((entry) => entry.alt)),
    );
    expect(change.body).not.toContain(at.root);
    expect(change.body).not.toContain("app-frame:");
    const headings = ["Why", "What changed", "Before and after", "Checked"];
    expect(headings.map((heading) => change.body?.indexOf(`## ${heading}`))).toEqual(
      headings
        .map((heading) => change.body?.indexOf(`## ${heading}`))
        .sort((a, b) => Number(a) - Number(b)),
    );
    expect(headings.map((heading) => card.body.indexOf(`<h3>${heading}</h3>`))).toEqual(
      headings.map((heading) => card.body.indexOf(`<h3>${heading}</h3>`)).sort((a, b) => a - b),
    );
    for (const words of [
      ...at.draft.why,
      ...at.draft.whatChanged,
      ...at.draft.before,
      ...at.draft.after,
      ...at.draft.verification,
    ]) {
      expect(card.body).toContain(words);
      expect(change.body).toContain(words.replaceAll(".", "\\."));
    }
    for (const dimension of RISK_DIMENSIONS) {
      expect(change.body).toContain(at.draft.risk[dimension].why.replaceAll(".", "\\."));
      expect(card.riskDeclaration[dimension]).toEqual(at.draft.risk[dimension]);
    }
  });

  it("carries adjacent New pictures, requirements and unfinished work in both outputs", async () => {
    const at = await arrange();
    const view = at.draft.views[0];
    if (!view) throw new Error("No comparison fixture");
    const requirement = {
      id: "update-computer",
      target: "The work computer",
      title: "Update Infinitary",
      consequence: "The new story needs the matching app version.",
      instructions: ["Install the matching app."],
      criterion: "The computer shows the new version.",
      prerequisites: [],
      completion: { kind: "manual" as const, label: "Updated" },
    };
    const staged = await stageChangePresentation(
      {
        ...at.draft,
        views: [
          {
            ...view,
            kind: "new",
            layout: "adjacent",
            before: [],
            after: [...view.before, ...view.after],
          },
        ],
        requiredActions: [requirement],
        unfinished: ["GitLab follows separately."],
      },
      { taskId: TASK, worktree: at.worktree, dir: at.media },
    );
    await at.service.prepare(TASK, staged, at.forge);
    const change = await at.publish();
    const card = await at.service.completion(TASK, 1, HEAD);
    expect(change.body?.match(/<td width="50%">/g)).toHaveLength(2);
    // INF-706: the adjacent new view is one table headed New, its two pictures in one row.
    expect(card.body.match(/<th [^>]*colspan="2">.*?New<\/span><\/th>/g)).toHaveLength(1);
    expect(card.body.match(/<td /g)).toHaveLength(2);
    expect(change.body).toContain("### New: Completion story");
    expect(card.requiredActions).toEqual([requirement]);
    expect(change.body).toContain(requirement.title);
    expect(change.body).toContain(requirement.criterion.replaceAll(".", "\\."));
    expect(change.body).toContain("GitLab follows separately");
    expect(card.body).toContain("GitLab follows separately");
    expect(at.upload).toHaveBeenCalledTimes(2);
  });

  it("checks complete receipts, retained evidence, human edits and audience again before completion", async () => {
    const at = await arrange();
    await at.prepare();
    const change = await at.publish();
    await expect(at.service.assertPublished(TASK, change, at.forge)).resolves.toEqual({
      ...change,
      squashMessage: at.draft.whatChanged.join("\n\n"),
    });
    // INF-228 F2: a person's conventional footer outside our region reaches the squash too.
    const footer =
      "BREAKING CHANGE: update the work computer.\nOlder computers cannot prepare this story.";
    await expect(
      at.service.assertPublished(
        TASK,
        { ...change, body: `${change.body}\n\n${footer}` },
        at.forge,
      ),
    ).resolves.toMatchObject({
      squashMessage: `${at.draft.whatChanged.join("\n\n")}\n\n${footer}`,
    });
    await expect(
      at.service.assertPublished(
        TASK,
        { ...change, body: change.body?.replace("## Why", "## Human edit") },
        at.forge,
      ),
    ).rejects.toThrow(/Someone edited/);
    at.setVisibility("private");
    await expect(at.service.assertPublished(TASK, change, at.forge)).rejects.toThrow(
      /audience changed/,
    );
    at.setVisibility("public");
    at.tasks.delivery.updateChangePresentation(TASK, (record) => {
      if (!record) throw new Error("Missing ledger");
      return { ...record, receipts: [] };
    });
    await expect(at.service.assertPublished(TASK, change, at.forge)).rejects.toThrow(
      /missing a confirmed attachment/,
    );
  });

  it("keeps successful receipts through a real database reopen after partial failure", async () => {
    const at = await arrange();
    await at.prepare();
    at.upload.mockImplementationOnce(async () => ({
      url: "https://github.com/user-attachments/assets/846dced7-16ad-44c0-b6f5-000000000001",
    }));
    at.upload.mockRejectedValueOnce(new AttachmentUploadError("failed", "permission", "No access"));
    await expect(at.publish()).rejects.toThrow("No access");
    expect(at.open).not.toHaveBeenCalled();
    at.restart();
    await at.publish();
    expect(at.upload).toHaveBeenCalledTimes(3);
    expect(
      at.tasks.delivery.changePresentation(TASK)?.receipts.map((receipt) => receipt.state),
    ).toEqual(["confirmed", "confirmed"]);
  });

  it("never resends an uncertain attachment after restart and never opens a partial PR", async () => {
    const at = await arrange();
    await at.prepare();
    at.upload.mockRejectedValueOnce(
      new AttachmentUploadError("uncertain", "refused", "Lost reply"),
    );
    await expect(at.publish()).rejects.toThrow("Lost reply");
    at.restart();
    await expect(at.publish()).rejects.toThrow(/may already exist/);
    expect(at.upload).toHaveBeenCalledTimes(1);
    expect(at.open).not.toHaveBeenCalled();
  });

  it("reconciles a possibly successful PR write by reading it, not by opening another", async () => {
    const at = await arrange();
    await at.prepare();
    const send = at.open.getMockImplementation();
    at.open.mockImplementationOnce(async (input) => {
      await send?.(input);
      throw new Error("Reply lost after opening");
    });
    await expect(at.publish()).rejects.toThrow(/Reply lost/);
    at.restart();
    const found = await at.publish();
    expect(found.number).toBe(1);
    expect(at.open).toHaveBeenCalledTimes(1);
    expect(at.upload).toHaveBeenCalledTimes(2);
    expect(at.tasks.delivery.changePresentation(TASK)?.published?.state).toBe("confirmed");
  });

  it("reconciles an earlier write after a later push without treating its story as current (INF-92)", async () => {
    const at = await arrange();
    await at.prepare();
    const send = at.open.getMockImplementation();
    at.open.mockImplementationOnce(async (input) => {
      await send?.(input);
      throw new Error("Reply lost after opening");
    });
    await expect(at.publish()).rejects.toThrow("Reply lost");
    const nextHead = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
    if (!at.change) throw new Error("The first write did not reach the host");
    at.change = { ...at.change, headSha: nextHead };
    at.setHead(nextHead);
    at.restart();
    await expect(at.publish()).resolves.toMatchObject({ headSha: nextHead, number: 1 });
    expect(at.tasks.delivery.changePresentation(TASK)?.published?.head).toBe(HEAD);
    await expect(at.service.completion(TASK, 1, nextHead)).rejects.toThrow(/must be published/);
    await at.service.prepare(
      TASK,
      {
        ...at.staged,
        head: nextHead,
        views: at.staged.views.map((view) => ({
          ...view,
          after: view.after.map((media) => ({
            ...media,
            applicability: "The captured view is unchanged by this publication-only correction.",
          })),
        })),
      },
      at.forge,
    );
    await at.publish(2);
    expect(at.open).toHaveBeenCalledTimes(1);
    expect(at.upload).toHaveBeenCalledTimes(2);
    expect(at.update).toHaveBeenCalledTimes(1);
    expect(at.tasks.delivery.changePresentation(TASK)?.published?.head).toBe(nextHead);
  });

  it("reuses confirmed uploads after a definite PR refusal without pretending it was an uncertain send", async () => {
    const at = await arrange();
    await at.prepare();
    at.open.mockRejectedValueOnce(
      new ForgeWriteError("failed", "permission", "GitHub refused the opening."),
    );
    await expect(at.publish()).rejects.toThrow(/refused the opening/);
    expect(at.tasks.delivery.changePresentation(TASK)?.publication).toBeUndefined();
    at.restart();
    await at.publish();
    expect(at.open).toHaveBeenCalledTimes(2);
    expect(at.upload).toHaveBeenCalledTimes(2);
  });

  it("does not treat an absent PR as proof that an uncertain write failed", async () => {
    const at = await arrange();
    await at.prepare();
    at.open.mockRejectedValueOnce(new Error("Lost response"));
    await expect(at.publish()).rejects.toThrow();
    at.restart();
    await expect(at.publish()).rejects.toThrow(/absence is not proof/);
    expect(at.open).toHaveBeenCalledTimes(1);
  });

  it("keeps surrounding human text during a whole-story replacement and refuses edits inside it", async () => {
    const at = await arrange();
    await at.prepare();
    await at.publish();
    if (!at.change) throw new Error("Missing opened change");
    at.change = { ...at.change, body: `Human introduction\n\n${at.change.body}\n\nHuman footnote` };
    const next = {
      ...at.staged,
      after: ["The revised description keeps the human introduction and footnote."],
    };
    await at.service.prepare(TASK, next, at.forge);
    await at.publish(2);
    expect(at.change?.body).toMatch(/^Human introduction/);
    expect(at.change?.body).toMatch(/Human footnote$/);
    expect(at.tasks.delivery.changePresentation(TASK)?.published?.revision).toBe(2);
    expect(at.change?.body).not.toContain("Story 1");
    expect(at.upload).toHaveBeenCalledTimes(2);
    if (!at.change) throw new Error("Missing updated change");
    at.change = { ...at.change, body: at.change.body?.replace("## Why", "## My edits") };
    await at.service.prepare(TASK, next, at.forge);
    await expect(at.publish(3)).rejects.toThrow(/Someone edited/);
    expect(at.update).toHaveBeenCalledTimes(1);
  });

  it("keeps the last complete story while replacement evidence is unavailable", async () => {
    const at = await arrange();
    await at.prepare();
    await at.publish();
    const previous = at.change?.body;
    await at.service.prepare(TASK, { ...at.staged, after: ["A revised account."] }, at.forge);
    const asset = at.staged.assets[0];
    if (!asset) throw new Error("No fixture asset");
    rmSync(join(at.media, asset.file));
    await expect(at.publish(2)).rejects.toThrow();
    expect(at.change?.body).toBe(previous);
    await expect(at.service.completion(TASK, 2, HEAD)).rejects.toThrow(/must be published/);
  });

  it("refuses changed code or audience before publishing, including a change during upload", async () => {
    const at = await arrange();
    await at.prepare();
    at.setVisibility("private");
    await expect(at.publish()).rejects.toThrow(/audience changed/);
    expect(at.upload).not.toHaveBeenCalled();
    at.setVisibility("public");
    at.upload.mockImplementationOnce(async () => {
      at.setHead("c".repeat(40));
      return {
        url: "https://github.com/user-attachments/assets/846dced7-16ad-44c0-b6f5-000000000001",
      };
    });
    await expect(at.publish()).rejects.toThrow(/code changed/);
    expect(at.open).not.toHaveBeenCalled();
  });

  it("refuses altered retained bytes even when the path still exists", async () => {
    const at = await arrange();
    await at.prepare();
    const asset = at.staged.assets[0];
    if (!asset) throw new Error("No fixture asset");
    writeFileSync(join(at.media, asset.file), "changed bytes");
    // INF-125: a refused preflight must not consume prerequisite authority.
    const beforePublish = vi.fn();
    await expect(
      at.service.publish(
        TASK,
        1,
        at.forge,
        BRANCH,
        "feat: share the change story",
        "pending",
        undefined,
        undefined,
        { draft: true, beforePublish },
      ),
    ).rejects.toThrow(/changed after inspection/);
    expect(beforePublish).not.toHaveBeenCalled();
    expect(at.upload).not.toHaveBeenCalled();
  });

  it.each(["remote picture", "GIF recording"] as const)(
    "removes only new staging copies after rejecting a %s (INF-228 F3)",
    async (kind) => {
      const at = await arrange();
      const selected = at.draft.views[0]?.after[0];
      if (!selected || !DEMO_POSTER.bytes) throw new Error("Missing fixture media");
      mkdirSync(join(at.worktree, "shots"), { recursive: true });
      writeFileSync(join(at.worktree, GIF_DEMO_RECORDING.path), GIF_DEMO_RECORDING.bytes);
      writeFileSync(join(at.worktree, DEMO_POSTER.path), DEMO_POSTER.bytes);
      const previous = readdirSync(at.media).sort();
      const after =
        kind === "remote picture"
          ? [
              selected,
              {
                ...selected,
                path: "https://github.com/user-attachments/assets/8cd18b3d-4c7d-469b-bf18-0db749213313",
              },
            ]
          : [{ ...selected, path: GIF_DEMO_RECORDING.path, poster: DEMO_POSTER.path }];
      await expect(
        stageChangePresentation(
          {
            ...at.draft,
            views: [
              { id: "refused", caption: "Selected evidence", kind: "new", before: [], after },
            ],
          },
          { taskId: TASK, worktree: at.worktree, dir: at.media },
        ),
      ).rejects.toThrow(kind === "remote picture" ? /contained local files/ : /inspected MP4/);
      expect(readdirSync(at.media).sort()).toEqual(previous);
      expect(readFileSync(join(at.worktree, GIF_DEMO_RECORDING.path))).toEqual(
        GIF_DEMO_RECORDING.bytes,
      );
      expect(readFileSync(join(at.worktree, DEMO_POSTER.path))).toEqual(DEMO_POSTER.bytes);
    },
  );

  it("permits a no-picture story only with its explicit reason", async () => {
    const at = await arrange();
    await expect(
      stageChangePresentation(
        { ...at.draft, views: [] },
        { taskId: TASK, worktree: at.worktree, dir: at.media },
      ),
    ).rejects.toThrow(/no-picture reason/);
    const noPicture = await stageChangePresentation(
      {
        ...at.draft,
        views: [],
        noPicture: "This change affects internal upload recovery, not a visible view.",
      },
      { taskId: TASK, worktree: at.worktree, dir: at.media },
    );
    await at.service.prepare(TASK, noPicture, at.forge);
    await at.publish();
    expect(at.upload).not.toHaveBeenCalled();
    expect((await at.service.completion(TASK, 1, HEAD)).body).toContain("data-inf-no-picture");
  });
});

// INF-497 (the captain on INF-100's PR #138): correct only the words around the
// published story, leave the story unchanged, and refuse a concurrent edit.
// INF-1793: Careful counts as no-mistakes; the app writes the one live attestation.
describe("no-mistakes' attestation on a Careful story", () => {
  const attested = (body: string | undefined) => {
    const text = body ?? "";
    const start = text.indexOf(NO_MISTAKES_ATTESTATION_PREFIX);
    if (start < 0) return undefined;
    const from = start + NO_MISTAKES_ATTESTATION_PREFIX.length;
    return JSON.parse(text.slice(from, text.indexOf(" -->", from))) as { head_sha: string };
  };
  const publish = (at: Awaited<ReturnType<typeof arrange>>, revision: number, covered: string[]) =>
    at.service.publish(
      TASK,
      revision,
      at.forge,
      BRANCH,
      "feat: share the change story",
      "pending",
      undefined,
      undefined,
      { attests: (head) => covered.includes(head) },
    );

  it("makes a quoted attestation in the project's words inert, so the check reads the app's own", async () => {
    const at = await arrange();
    // A contributor template that quotes another PR's attestation, as no-mistakes' own docs do.
    const quoted = `Closes #24\n\n${NO_MISTAKES_ATTESTATION_PREFIX}{"head_sha":"0000000000000000000000000000000000000000","steps":[]} -->`;
    const staged = await stageChangePresentation(
      { ...at.draft, projectText: quoted },
      { taskId: TASK, worktree: at.worktree, dir: at.media },
    );
    await at.service.prepare(TASK, staged, at.forge);
    await publish(at, 1, [HEAD]);
    const body = at.change?.body ?? "";
    expect(body).toContain(NO_MISTAKES_SIGNATURE);
    expect(body.split(NO_MISTAKES_ATTESTATION_PREFIX)).toHaveLength(2);
    expect(attested(body)?.head_sha).toBe(HEAD);
    expect(body).toContain("Closes #24");
    expect(readPresentationRegion(body, TASK)).toBe(
      at.tasks.delivery.changePresentation(TASK)?.published?.region,
    );
  });

  it("leaves both lines off until Careful's records cover a later push, then names that version", async () => {
    const at = await arrange();
    await at.prepare();
    await publish(at, 1, [HEAD]);
    expect(attested(at.change?.body)?.head_sha).toBe(HEAD);
    const pushed = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
    at.setHead(pushed);
    at.change = { ...(at.change as ForgeChange), headSha: pushed };
    // A CI repair that leaves the view as captured.
    const repaired = {
      ...at.staged,
      head: pushed,
      views: at.staged.views.map((view) => ({
        ...view,
        after: view.after.map((media) => ({
          ...media,
          applicability: "The CI repair leaves the captured view unchanged.",
        })),
      })),
    };
    await at.service.prepare(TASK, repaired, at.forge);
    await publish(at, 2, [HEAD]);
    expect(at.change?.body).not.toContain(NO_MISTAKES_SIGNATURE);
    expect(attested(at.change?.body)).toBeUndefined();
    await at.service.prepare(TASK, repaired, at.forge);
    await publish(at, 3, [HEAD, pushed]);
    expect(attested(at.change?.body)?.head_sha).toBe(pushed);
  });
});

describe("the words around a published story", () => {
  const obsolete =
    "This first publication advances the published protocol to 9.0.0. One Linux integration failure remains open and is tracked separately.";
  const corrected =
    "The published protocol advances to 10.0.0; every check on this version passed.";
  const footer =
    "BREAKING CHANGE: The published protocol advances to 10.0.0 for the live-validation and paired-evidence contract.";
  async function published() {
    const at = await arrange();
    const staged = await stageChangePresentation(
      { ...at.draft, projectText: `${obsolete}\n\n${footer}` },
      { taskId: TASK, worktree: at.worktree, dir: at.media },
    );
    await at.service.prepare(TASK, staged, at.forge);
    const opened = await at.publish();
    return { at, opened, region: readPresentationRegion(opened.body ?? "", TASK) };
  }

  it("changes one passage in place and keeps the story, its files and the squash footer", async () => {
    const { at, region } = await published();
    if (!at.change) throw new Error("Missing opened change");
    at.change = { ...at.change, body: `${at.change.body}\n\nA person's closing note.` };
    const changed = await at.publish(1, undefined, { from: obsolete, to: corrected });
    expect(changed.body).toBe(`${corrected}\n\n${footer}\n\n${region}\n\nA person's closing note.`);
    expect(at.upload).toHaveBeenCalledTimes(2);
    expect(at.update).toHaveBeenCalledTimes(1);
    expect(at.tasks.delivery.changePresentation(TASK)?.published).toMatchObject({
      revision: 1,
      state: "confirmed",
      region,
    });
    await expect(at.service.assertPublished(TASK, changed, at.forge)).resolves.toMatchObject({
      squashMessage: [...at.draft.whatChanged, footer].join("\n\n"),
    });
  });

  it("sends nothing when a person changed the passage after it was read", async () => {
    const { at } = await published();
    if (!at.change) throw new Error("Missing opened change");
    const theirs = at.change.body?.replace(obsolete, "The captain's own sentence.");
    at.change = { ...at.change, body: theirs };
    await expect(at.publish(1, undefined, { from: obsolete, to: corrected })).rejects.toThrow(
      /no longer hold around\.from exactly[\s\S]*The captain's own sentence\./,
    );
    expect(at.update).not.toHaveBeenCalled();
    expect(at.change?.body).toBe(theirs);
    expect(at.tasks.delivery.changePresentation(TASK)?.publication?.state).toBe("confirmed");
  });

  it("keeps the existing refusal for an edit inside the story", async () => {
    const { at } = await published();
    if (!at.change) throw new Error("Missing opened change");
    at.change = { ...at.change, body: at.change.body?.replace("## Why", "## My edits") };
    await expect(at.publish(1, undefined, { from: obsolete, to: corrected })).rejects.toThrow(
      /Someone edited/,
    );
    expect(at.update).not.toHaveBeenCalled();
  });

  it("refuses to change words around a story that has no open pull request yet", async () => {
    const at = await arrange();
    await at.prepare();
    await expect(at.publish(1, undefined, { from: "", to: corrected })).rejects.toThrow(
      /projectText/,
    );
    expect(at.upload).not.toHaveBeenCalled();
    expect(at.open).not.toHaveBeenCalled();
  });

  it("says so when the host shows other words around the story after the write", async () => {
    const { at, region } = await published();
    at.update.mockImplementationOnce(async (_current, body) => {
      if (!at.change) throw new Error("No open change");
      at.change = { ...at.change, body: `A simultaneous line.\n\n${body}` };
    });
    await expect(at.publish(1, undefined, { from: obsolete, to: corrected })).rejects.toThrow(
      /shows different words around it than you sent/,
    );
    expect(at.tasks.delivery.changePresentation(TASK)?.published).toMatchObject({
      state: "confirmed",
      region,
    });
  });
});

// INF-717: republishing keeps the change's title the story's, or says a person's rename.
// The stand-in journeys own the ordinary rename and refusal; these own the races and old records.
describe("the title of a republished story", () => {
  const BREAKING = "feat!: share the change story";
  async function republish(at: Awaited<ReturnType<typeof arrange>>, title = BREAKING) {
    const revision = await at.service.prepare(TASK, { ...at.staged, title }, at.forge);
    return at.service.publish(TASK, revision, at.forge, BRANCH, title);
  }

  /** What a publication before INF-717 left on record: no title it set. */
  function forgetTitles(at: Awaited<ReturnType<typeof arrange>>) {
    at.tasks.delivery.updateChangePresentation(TASK, (record) => {
      if (!record?.published) throw new Error("Missing publication");
      const { title: _kept, ...published } = record.published;
      return { ...record, publication: published, published };
    });
  }

  it("renames a title published before the app kept titles, from that story's own title", async () => {
    const at = await arrange();
    await at.prepare();
    await at.publish();
    forgetTitles(at);
    await republish(at);
    expect(at.update).toHaveBeenCalledWith(expect.anything(), expect.any(String), BREAKING);
    expect(at.change?.title).toBe(BREAKING);
    expect(at.tasks.delivery.changePresentation(TASK)?.published).toMatchObject({
      revision: 2,
      title: BREAKING,
    });
  });

  it("says it has no record of an older title PR #138 kept, and publishes once the title is set", async () => {
    const at = await arrange();
    await at.prepare();
    await at.publish();
    const opened = at.change?.title;
    await republish(at);
    // Before INF-717 the breaking story was published and the opening's title kept.
    if (!at.change || !opened) throw new Error("No open change");
    at.change = { ...at.change, title: opened };
    forgetTitles(at);
    at.update.mockClear();
    await expect(republish(at)).rejects.toThrow(
      `Nothing was sent: the pull request's title on GitHub reads "${opened}", not the story's "${BREAKING}". The app has no record of setting that title.`,
    );
    expect(at.update).not.toHaveBeenCalled();
    // The crewmate set the story's title alone, after asking the captain.
    at.change = { ...at.change, title: BREAKING };
    await republish(at);
    expect(at.tasks.delivery.changePresentation(TASK)?.published).toMatchObject({
      revision: 4,
      title: BREAKING,
    });
  });

  it("writes nothing when a person renames the pull request during the uploads", async () => {
    const at = await arrange();
    await at.prepare();
    await at.publish();
    // A fresh After picture: the republished story has a file to send.
    copyFileSync(
      resolve("release-notes/pictures/risk-note-title-row-dark.webp"),
      join(at.worktree, "fresh.webp"),
    );
    const [view] = at.draft.views;
    const [after] = view?.after ?? [];
    if (!view || !after) throw new Error("The fixture needs a view");
    const next = await at.service.prepare(
      TASK,
      await stageChangePresentation(
        {
          ...at.draft,
          title: BREAKING,
          views: [{ ...view, after: [{ ...after, path: "fresh.webp" }] }],
        },
        { taskId: TASK, worktree: at.worktree, dir: at.media },
      ),
      at.forge,
    );
    at.upload.mockImplementationOnce(async () => {
      if (!at.change) throw new Error("No open change");
      at.change = { ...at.change, title: "feat: the captain's own title" };
      return {
        url: "https://github.com/user-attachments/assets/846dced7-16ad-44c0-b6f5-0000000000aa",
      };
    });
    await expect(at.service.publish(TASK, next, at.forge, BRANCH, BREAKING)).rejects.toThrow(
      `Nothing was sent: the pull request's title on GitHub reads "feat: the captain's own title", not the story's "${BREAKING}". The app last left "feat: share the change story" there, so someone renamed it.`,
    );
    expect(at.update).not.toHaveBeenCalled();
    expect(at.upload).toHaveBeenCalledTimes(3);
    expect(at.tasks.delivery.changePresentation(TASK)?.published?.revision).toBe(1);
  });

  it("says so when the pull request reads another title right after the write", async () => {
    const at = await arrange();
    await at.prepare();
    await at.publish();
    at.update.mockImplementationOnce(async (_current, body) => {
      if (!at.change) throw new Error("No open change");
      at.change = { ...at.change, body, title: "feat: a simultaneous rename" };
    });
    await expect(republish(at)).rejects.toThrow(
      `The story is published, but GitHub shows the title "feat: a simultaneous rename" rather than "${BREAKING}"`,
    );
    // The story landed; the next publication names that rename as a person's.
    expect(at.tasks.delivery.changePresentation(TASK)?.published).toMatchObject({
      revision: 2,
      state: "confirmed",
      title: BREAKING,
    });
    await expect(republish(at)).rejects.toThrow(/so someone renamed it/);
  });
});

// INF-169 F1–F6/F13 and the captain's recovery choices own these regressions.
describe("deliberate publication recovery", () => {
  it("restores a still-published old region after an uncertain replacement, then retries intentionally", async () => {
    const at = await arrange();
    await at.prepare();
    await at.publish();
    await at.service.prepare(TASK, { ...at.staged, after: ["A revised explanation."] }, at.forge);
    at.update.mockRejectedValueOnce(new Error("Lost PATCH response"));
    await expect(at.publish(2)).rejects.toThrow("Lost PATCH");
    at.restart();
    await expect(at.publish(2)).rejects.toThrow("last confirmed story is still");
    expect(at.tasks.delivery.changePresentation(TASK)?.publication).toMatchObject({
      state: "confirmed",
      revision: 1,
    });
    await at.publish(2);
    expect(at.tasks.delivery.changePresentation(TASK)?.published?.revision).toBe(2);
    expect(at.update).toHaveBeenCalledTimes(2);
    expect(at.upload).toHaveBeenCalledTimes(2);
  });

  it("can deliberately retry a missing uncertain opening without re-uploading its confirmed files", async () => {
    const at = await arrange();
    await at.prepare();
    at.open.mockRejectedValueOnce(new Error("Lost POST response"));
    await expect(at.publish()).rejects.toThrow("Lost POST");
    at.restart();
    await expect(at.publish()).rejects.toThrow("retryOpening");
    expect(at.open).toHaveBeenCalledTimes(1);
    await at.publish(1, { retryOpening: true });
    expect(at.open).toHaveBeenCalledTimes(2);
    expect(at.upload).toHaveBeenCalledTimes(2);
  });

  it("requires the exact uncertain digest for an orphan-disclosed upload retry", async () => {
    const at = await arrange();
    await at.prepare();
    at.upload.mockRejectedValueOnce(
      new AttachmentUploadError("uncertain", "refused", "Lost upload reply"),
    );
    await expect(at.publish()).rejects.toThrow("Lost upload");
    at.restart();
    await expect(at.publish()).rejects.toThrow("possible orphan");
    const digest = at.staged.assets[0]?.uploadSha256 as string;
    await at.publish(1, { retryUploads: [digest] });
    expect(at.upload).toHaveBeenCalledTimes(3);
    expect(
      at.tasks.delivery
        .changePresentation(TASK)
        ?.receipts.find((receipt) => receipt.digest === digest),
    ).toMatchObject({ state: "confirmed", possibleOrphan: true });
  });

  it("binds a deliberate republish to the exact human edit shown, preserving surrounding words and CRLF edits", async () => {
    const at = await arrange();
    await at.prepare();
    const published = await at.publish();
    const body = `Human introduction\n\n${published.body}\n\nHuman closing words`.replaceAll(
      "\n",
      "\r\n",
    );
    at.change = { ...published, body };
    await expect(at.service.assertPublished(TASK, at.change, at.forge)).resolves.toEqual({
      ...at.change,
      squashMessage: at.draft.whatChanged.join("\n\n"),
    });
    at.change = { ...at.change, body: body.replace("## Why", "## A person's edit") };
    const observed = readPresentationRegion(at.change.body ?? "", TASK);
    await expect(at.publish()).rejects.toThrow("Show the captain");
    at.change = { ...at.change, body: at.change.body?.replace("person's edit", "newer edit") };
    await expect(at.publish(1, { replaceRegion: observed })).rejects.toThrow("Show the captain");
    const current = readPresentationRegion(at.change.body ?? "", TASK);
    const revised = await at.publish(1, { replaceRegion: current });
    expect(revised.body).toMatch(/^Human introduction\n/);
    expect(revised.body).toMatch(/Human closing words$/);
    await expect(at.service.assertPublished(TASK, revised, at.forge)).resolves.toEqual({
      ...revised,
      squashMessage: at.draft.whatChanged.join("\n\n"),
    });
  });

  it("stops on a closed published PR instead of opening another", async () => {
    const at = await arrange();
    await at.prepare();
    await at.publish();
    at.change = null;
    await expect(at.publish(1, { retryOpening: true })).rejects.toThrow("no longer open");
    expect(at.open).toHaveBeenCalledTimes(1);
  });

  it("checks a published head for merge without consulting a sleeping work computer", async () => {
    const at = await arrange();
    await at.prepare();
    const change = await at.publish();
    at.readHead.mockRejectedValue(new Error("Work computer is asleep"));
    at.readHead.mockClear();
    await at.service.assertPublished(TASK, change, at.forge);
    expect(at.readHead).not.toHaveBeenCalled();
    await expect(
      at.service.assertPublished(
        TASK,
        { ...change, headSha: "c40687d8d4f738056e62db6ab98b90f7f7d17497" },
        at.forge,
      ),
    ).rejects.toThrow("must be published");
  });

  it("refreshes only unchanged story content for an accepted conflict repair without waking the computer", async () => {
    const at = await arrange();
    await at.prepare();
    const change = await at.publish();
    const next = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
    at.change = { ...change, headSha: next };
    at.setHead(next);
    at.readHead.mockRejectedValue(new Error("Work computer is asleep"));
    at.readHead.mockClear();
    await at.service.refreshConflictOnly(
      TASK,
      HEAD,
      next,
      at.forge,
      BRANCH,
      "feat: share the change story",
    );
    const record = at.tasks.delivery.changePresentation(TASK);
    expect(record?.published).toMatchObject({ head: next, revision: 2 });
    expect(record?.revisions[0]).toMatchObject({
      why: at.draft.why,
      whatChanged: at.draft.whatChanged,
      risk: at.draft.risk,
      requiredActions: at.draft.requiredActions,
    });
    expect(at.readHead).not.toHaveBeenCalled();
    expect(at.upload).toHaveBeenCalledTimes(2);
    expect(at.update).toHaveBeenCalledTimes(1);
    await at.service.assertPublished(TASK, at.change as ForgeChange, at.forge);
  });

  // INF-2509, INF-1868's answer 5, the captain: "The host republishes the declared story at the
  // new head itself and refuses nothing; the merge still carries the story you saw."
  it("republishes the published story at a pushed version with its words unchanged (INF-2509)", async () => {
    const at = await arrange();
    await at.prepare();
    const change = await at.publish();
    const approved = at.tasks.delivery.changePresentation(TASK)?.published?.contentHash;
    const squash = (await at.service.assertPublished(TASK, change, at.forge, 1)).squashMessage;
    const pushed = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
    at.change = { ...change, headSha: pushed };
    at.setHead(pushed);
    expect(await at.service.atPushedVersion(TASK, 1, at.change, at.forge)).toBe(2);
    const record = at.tasks.delivery.changePresentation(TASK);
    expect(record?.published).toMatchObject({
      revision: 2,
      head: pushed,
      refreshOf: 1,
      contentHash: approved,
    });
    expect(record?.revisions.at(-1)).toMatchObject({
      revision: 2,
      head: pushed,
      title: at.draft.title,
      why: at.draft.why,
      checked: at.draft.checked,
      verification: at.draft.verification,
    });
    expect(record?.revisions.at(-1)?.views[0]?.after[0]?.applicability).toBe(
      "Captured on an earlier version of this pull request; the story's words did not change.",
    );
    // The confirmed attachments are reused, not sent again.
    expect(at.upload).toHaveBeenCalledTimes(2);
    expect(at.update).toHaveBeenCalledTimes(1);
    expect(
      (await at.service.assertPublished(TASK, at.change as ForgeChange, at.forge, 2)).squashMessage,
    ).toBe(squash);
    // The author's revision still names it, on the card and on open_change, and nothing is sent again.
    expect(await at.service.atPushedVersion(TASK, 1, at.change as ForgeChange, at.forge)).toBe(2);
    await at.publish(1);
    expect(at.update).toHaveBeenCalledTimes(1);

    // A newer story its author prepared is theirs to publish: nothing is republished over it.
    const newer = await stageChangePresentation(
      {
        ...at.draft,
        head: pushed,
        why: ["The pull request tells the newer story."],
        views: at.draft.views.map((view) => ({
          ...view,
          after: view.after.map((media) => ({ ...media, captureHead: pushed })),
        })),
      },
      { taskId: TASK, worktree: at.worktree, dir: at.media },
    );
    expect(await at.service.prepare(TASK, newer, at.forge)).toBe(3);
    const later = "9b1f2e3d4c5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
    at.change = { ...(at.change as ForgeChange), headSha: later };
    at.setHead(later);
    await at.service.republishMoved(TASK, at.change, at.forge);
    expect(await at.service.atPushedVersion(TASK, 1, at.change, at.forge)).toBe(1);
    expect(at.tasks.delivery.changePresentation(TASK)?.revisions.at(-1)).toMatchObject({
      revision: 3,
      head: pushed,
    });
    expect(at.tasks.delivery.changePresentation(TASK)?.published).toMatchObject({
      revision: 2,
      head: pushed,
    });
    expect(at.update).toHaveBeenCalledTimes(1);
  });

  it("keeps an older Before picture's own version beside the original base once it says why (INF-2660)", async () => {
    const at = await arrange();
    const root = { taskId: TASK, worktree: at.worktree, dir: at.media };
    // The base is the story's comparison; the Before picture was taken on an earlier version.
    const base = "d36b25daf7f2691e67da7734fd9d675ae25c877b";
    const taken = "41163dc192c032c622880d19e1ecc3759cf276ad";
    const because = "Taken before the base; the view it shows did not change before the base.";
    const older = (applicability?: string): ChangePresentationDraft => ({
      ...at.draft,
      base,
      views: at.draft.views.map((view) => ({
        ...view,
        before: view.before.map((media) => ({
          ...media,
          captureHead: taken,
          ...(applicability ? { applicability } : {}),
        })),
      })),
    });
    await expect(stageChangePresentation(older(), root)).rejects.toThrow(
      "Before evidence for completion needs the original base or an applicability declaration.",
    );

    const staged = await stageChangePresentation(older(because), root);
    expect(await at.service.prepare(TASK, staged, at.forge)).toBe(1);
    const saved = at.tasks.delivery.changePresentation(TASK)?.revisions.at(-1);
    expect(saved?.base).toBe(base);
    expect(saved?.views[0]?.before[0]).toMatchObject({
      captureHead: taken,
      applicability: because,
    });
    const published = await at.publish();
    // Capture versions and applicability stay data; the description names neither.
    expect(published.body).not.toContain(taken);
    expect(published.body).not.toContain(because);

    // A push republishes the story with the picture's version and reason as they were.
    const pushed = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
    at.change = { ...published, headSha: pushed };
    at.setHead(pushed);
    expect(await at.service.atPushedVersion(TASK, 1, at.change, at.forge)).toBe(2);
    const republished = at.tasks.delivery.changePresentation(TASK)?.revisions.at(-1);
    expect(republished?.base).toBe(base);
    expect(republished?.views[0]?.before[0]).toMatchObject({
      captureHead: taken,
      applicability: because,
    });
  });

  it("keeps only the newest and published revisions and removes only their superseded copies", async () => {
    const at = await arrange();
    await at.prepare();
    await at.publish();
    const stage = () =>
      stageChangePresentation(at.draft, { taskId: TASK, worktree: at.worktree, dir: at.media });
    const second = await stage();
    await at.service.prepare(TASK, second, at.forge);
    const third = await stage();
    await at.service.prepare(TASK, third, at.forge);
    expect(
      at.tasks.delivery.changePresentation(TASK)?.revisions.map((story) => story.revision),
    ).toEqual([1, 3]);
    expect(second.assets.every((asset) => !existsSync(join(at.media, asset.file)))).toBe(true);
    expect(at.staged.assets.every((asset) => existsSync(join(at.media, asset.file)))).toBe(true);
    await at.publish(3);
    expect(
      at.tasks.delivery.changePresentation(TASK)?.revisions.map((story) => story.revision),
    ).toEqual([3]);
    expect(at.staged.assets.every((asset) => !existsSync(join(at.media, asset.file)))).toBe(true);
    expect(third.assets.every((asset) => existsSync(join(at.media, asset.file)))).toBe(true);
    expect(existsSync(join(at.worktree, "dark.webp"))).toBe(true);
    expect(at.upload).toHaveBeenCalledTimes(2);
  });
});

// INF-169 F2 also covers a lost opening followed by a human edit and a later push.
it("reconciles an edited uncertain opening before preparing the newer version", async () => {
  const at = await arrange();
  await at.prepare();
  const send = at.open.getMockImplementation();
  at.open.mockImplementationOnce(async (input) => {
    await send?.(input);
    throw new Error("Lost opening reply");
  });
  await expect(at.publish()).rejects.toThrow("Lost opening");
  const next = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
  at.setHead(next);
  if (!at.change) throw new Error("Opening did not reach the stand-in");
  at.change = {
    ...at.change,
    headSha: next,
    body: `Human introduction\n${at.change.body?.replace("## Why", "## A reviewed edit")}`,
  };
  const region = readPresentationRegion(at.change.body ?? "", TASK);
  await expect(at.publish(1, { replaceRegion: region })).rejects.toThrow("code changed");
  expect(at.tasks.delivery.changePresentation(TASK)?.publication).toBeUndefined();
  const revision = await at.service.prepare(
    TASK,
    {
      ...at.staged,
      head: next,
      views: at.staged.views.map((view) => ({
        ...view,
        after: view.after.map((media) => ({
          ...media,
          applicability: "The reply view is unchanged by the publication correction.",
        })),
      })),
    },
    at.forge,
  );
  const updated = await at.publish(revision);
  expect(updated.body).toMatch(/^Human introduction/);
  expect(at.open).toHaveBeenCalledTimes(1);
  expect(at.update).toHaveBeenCalledTimes(1);
  expect(at.tasks.delivery.changePresentation(TASK)?.reconciled).toBeUndefined();
});

it("discards fresh staging copies when preparation fails, not the source files (INF-169 F13)", async () => {
  const at = await arrange();
  at.setHead("c40687d8d4f738056e62db6ab98b90f7f7d17497");
  await expect(at.prepare()).rejects.toThrow("code changed");
  expect(at.staged.assets.every((asset) => !existsSync(join(at.media, asset.file)))).toBe(true);
  expect(existsSync(join(at.worktree, "dark.webp"))).toBe(true);
});

it("keeps the earlier opening identity through a deliberate retry and a newer prepared version (INF-169 F2)", async () => {
  const at = await arrange();
  await at.prepare();
  at.open.mockRejectedValueOnce(new Error("Lost opening response"));
  await expect(at.publish()).rejects.toThrow("Lost opening");
  const next = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
  at.setHead(next);
  await expect(at.publish(1, { retryOpening: true })).rejects.toThrow("code changed");
  const revision = await at.service.prepare(
    TASK,
    {
      ...at.staged,
      head: next,
      views: at.staged.views.map((view) => ({
        ...view,
        after: view.after.map((media) => ({
          ...media,
          applicability: "The reply view is unchanged by this publication correction.",
        })),
      })),
    },
    at.forge,
  );
  expect(
    at.tasks.delivery.changePresentation(TASK)?.revisions.map((story) => story.revision),
  ).toEqual([1, 2]);
  const earlier = at.tasks.delivery.changePresentation(TASK)?.publication;
  at.change = {
    number: 1,
    branch: BRANCH,
    headSha: next,
    title: "feat: share the change story",
    url: null,
    body: earlier?.region,
  };
  await at.publish(revision);
  expect(at.tasks.delivery.changePresentation(TASK)?.published).toMatchObject({
    revision: 2,
    head: next,
  });
  expect(at.open).toHaveBeenCalledTimes(1);
  expect(at.update).toHaveBeenCalledTimes(1);
});

it("reconciles a late opening after GitHub refuses the deliberate retry as a duplicate (INF-169 F2)", async () => {
  const at = await arrange();
  await at.prepare();
  const send = at.open.getMockImplementation();
  at.open.mockRejectedValueOnce(new Error("Lost response"));
  await expect(at.publish()).rejects.toThrow("Lost response");
  at.open.mockImplementationOnce(async (input) => {
    await send?.(input); // The earlier send becomes visible during the duplicate attempt.
    throw new ForgeWriteError("failed", "refused", "A pull request already exists");
  });
  await expect(at.publish(1, { retryOpening: true })).rejects.toThrow("already exists");
  at.restart();
  expect((await at.publish()).number).toBe(1);
  expect(at.open).toHaveBeenCalledTimes(2);
  expect(at.upload).toHaveBeenCalledTimes(2);
});

// INF-169 R1: a shown card owns media independently of the publication ledger.
it("keeps a closed card's pictures and recording after later publications prune their story copies", async () => {
  const at = await arrange();
  writeFileSync(join(at.worktree, "sample.mp4"), DEMO_RECORDING.bytes);
  const poster = DEMO_POSTER.bytes;
  if (!poster) throw new Error("The recording fixture needs its real poster bytes");
  writeFileSync(join(at.worktree, "poster.png"), poster);
  const stage = () =>
    stageChangePresentation(
      {
        ...at.draft,
        views: [
          ...at.draft.views,
          {
            id: "recording",
            caption: "The recorded interaction",
            kind: "new",
            before: [],
            after: [
              {
                path: "sample.mp4",
                poster: "poster.png",
                alt: DEMO_POSTER.alt,
                inspected: true,
                captureHead: HEAD,
              },
            ],
          },
        ],
      },
      {
        taskId: TASK,
        worktree: at.worktree,
        dir: at.media,
        probe: async () => ({
          ok: true,
          width: DEMO_RECORDING.width,
          height: DEMO_RECORDING.height,
          durationMs: DEMO_RECORDING.durationMs,
        }),
      },
    );
  const first = await stage();
  await at.service.prepare(TASK, first, at.forge);
  await at.publish();
  const completion = await at.service.completion(TASK, 1, HEAD);
  const files = [
    ...new Set(
      [...completion.body.matchAll(/app-frame:\/\/(?:images|media)\/([^" ]+)/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ];
  const bytes = files.map((file) => readFileSync(join(at.media, file)));
  expect(bytes.map((value) => createHash("sha256").update(value).digest("hex")).sort()).toEqual(
    first.assets.map((asset) => asset.uploadSha256).sort(),
  );
  expect(files.some((file) => first.assets.some((asset) => asset.file === file))).toBe(false);
  for (const picture of completion.pictures) {
    expect(files.some((file) => file.startsWith(`${picture.id}.`))).toBe(true);
    if (picture.demo) expect(files).toContain(`${picture.demo.id}.mp4`);
  }
  at.cards.upsert({
    id: "shown-story",
    taskId: TASK,
    author: "crewmate",
    meta: "Story",
    priority: 30,
    title: completion.title,
    body: completion.body,
    pictures: completion.pictures,
    actions: [{ id: "read", label: "Read", default: true }],
    status: "ready",
    createdAt: 1,
  });
  at.cards.resolve("shown-story", "read");
  for (const revision of [2, 3]) {
    await at.service.prepare(TASK, await stage(), at.forge);
    await at.publish(revision);
  }
  expect(first.assets.every((asset) => !existsSync(join(at.media, asset.file)))).toBe(true);
  at.restart();
  const saved = at.cards.get("shown-story");
  expect(saved?.body).toBe(completion.body);
  expect(saved?.pictures).toEqual(completion.pictures);
  expect(files.map((file) => readFileSync(join(at.media, file)))).toEqual(bytes);
  expect(readFileSync(join(at.worktree, "sample.mp4"))).toEqual(DEMO_RECORDING.bytes);
});

// INF-169 R3: missing or duplicated boundaries follow the deliberate human-edit path.
describe("edited story boundaries", () => {
  const { start, end } = presentationRegionMarkers(TASK);
  it.each([
    ["missing start", (body: string) => body.replace(start, "")],
    ["missing end", (body: string) => body.replace(end, "")],
    ["missing both", (body: string) => body.replace(start, "").replace(end, "")],
    [
      "duplicated start",
      (body: string) => body.replace(start, `${start}\nA person's words\n${start}`),
    ],
    ["duplicated end", (body: string) => body.replace(end, `${end}\nA person's words\n${end}`)],
    ["empty description", (_body: string) => ""],
  ])("restores %s only after reviewing the exact whole description", async (_name, edit) => {
    const at = await arrange();
    await at.prepare();
    const published = await at.publish();
    const edited = edit(`Human introduction\n${published.body}\nHuman closing words`).replaceAll(
      "\n",
      "\r\n",
    );
    at.change = { ...published, body: edited };
    expect(readPresentationRegion(edited, TASK)).toBe(edited.replaceAll("\r\n", "\n"));
    await expect(at.publish()).rejects.toThrow("whole description");
    expect(at.update).not.toHaveBeenCalled();
    // A later edit invalidates even the reviewed empty description.
    at.change = { ...at.change, body: `${edited}\r\nA later human addition` };
    await expect(at.publish(1, { replaceRegion: edited })).rejects.toThrow("whole description");
    at.change = { ...at.change, body: edited };
    const replaced = await at.publish(
      1,
      presentationRecoverySchema.parse({ replaceRegion: edited }),
    );
    const preserved = edited.replaceAll("\r\n", "\n").replaceAll(start, "").replaceAll(end, "");
    expect(replaced.body?.startsWith(preserved)).toBe(true);
    expect(replaced.body?.split(start)).toHaveLength(2);
    expect(replaced.body?.split(end)).toHaveLength(2);
    expect(readPresentationRegion(replaced.body ?? "", TASK)).toBe(
      at.tasks.delivery.changePresentation(TASK)?.published?.region,
    );
    await expect(at.service.assertPublished(TASK, replaced, at.forge)).resolves.toEqual({
      ...replaced,
      squashMessage: at.draft.whatChanged.join("\n\n"),
    });
    expect(at.update).toHaveBeenCalledTimes(1);
    expect(at.upload).toHaveBeenCalledTimes(2);
  });
});

it("cleans a busy preparation's fresh staging copies without deleting the active preparation's files (INF-169 R4)", async () => {
  const at = await arrange();
  let signal = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attachments = at.forge.attachments;
  if (!attachments) throw new Error("Missing attachment fixture");
  const destination = attachments.destination;
  attachments.destination = async () => {
    signal();
    await proceed;
    return destination();
  };
  const first = at.prepare();
  await entered;
  try {
    const second = await stageChangePresentation(at.draft, {
      taskId: TASK,
      worktree: at.worktree,
      dir: at.media,
    });
    await expect(at.service.prepare(TASK, second, at.forge)).rejects.toThrow("already in progress");
    expect(second.assets.every((asset) => !existsSync(join(at.media, asset.file)))).toBe(true);
    await expect(at.prepare()).rejects.toThrow("already in progress");
    expect(at.staged.assets.every((asset) => existsSync(join(at.media, asset.file)))).toBe(true);
  } finally {
    release();
    await first;
  }
  expect(at.staged.assets.every((asset) => existsSync(join(at.media, asset.file)))).toBe(true);
});

it("recovers an uncertain replacement with edited markers through the same deliberate path (INF-169 R3)", async () => {
  const at = await arrange();
  await at.prepare();
  const first = await at.publish();
  await at.service.prepare(
    TASK,
    { ...at.staged, after: ["A newly reviewed explanation."] },
    at.forge,
  );
  at.update.mockRejectedValueOnce(new Error("Lost PATCH reply"));
  await expect(at.publish(2)).rejects.toThrow("Lost PATCH");
  const edited = `A person's introduction\n${first.body?.replace(presentationRegionMarkers(TASK).end, "")}\nA person's conclusion`;
  at.change = { ...first, body: edited };
  at.restart();
  await expect(at.publish(2)).rejects.toThrow("whole description");
  const next = await at.publish(2, { replaceRegion: edited });
  expect(next.body).toContain("A person's introduction");
  expect(next.body).toContain("A person's conclusion");
  expect(at.tasks.delivery.changePresentation(TASK)?.published?.revision).toBe(2);
  await expect(at.service.assertPublished(TASK, next, at.forge)).resolves.toEqual({
    ...next,
    squashMessage: at.draft.whatChanged.join("\n\n"),
  });
});

// INF-1965: the saved story belongs to every destination, not only native-upload hosts.
// Existing inspected photographs and the publisher's host readings own the fixture.
describe("stories without native attachment publication", () => {
  it.each([
    ["github", "github.example.com"],
    ["gitlab", "gitlab.example.com"],
  ] as const)(
    "publishes and reads back %s text while retaining the complete card's pictures",
    async (kind, host) => {
      const at = await arrange();
      const destination = {
        host,
        format: kind,
        projectId: 1422452335,
        fullName: "octo/meterlab",
        visibility: "private" as const,
      };
      const forge: Forge = {
        ...at.forge,
        kind,
        host,
        attachments: undefined,
        storyDestination: async () => destination,
      };
      const revision = await at.service.prepare(TASK, at.staged, forge);
      const change = await at.service.publish(TASK, revision, forge, BRANCH, at.draft.title);
      expect(at.upload).not.toHaveBeenCalled();
      expect(at.order).toEqual(["open"]);
      expect(change.body).toContain(presentationMarkdownText(at.draft.why[0] ?? ""));
      expect(change.body).toContain("this host receives the story's text only");
      expect(change.body).toContain(at.draft.views[0]?.before[0]?.alt);
      expect(change.body).not.toMatch(/app-frame:|user-attachments|\/uploads\/|\.webp/);
      expect(at.tasks.delivery.changePresentation(TASK)?.receipts).toEqual([]);
      const card = await at.service.completion(TASK, revision, HEAD);
      expect(card.body).toContain("app-frame://images/");
      expect(card.pictures).toHaveLength(2);
      expect(card.riskDeclaration).toEqual(risk);
      expect((await at.service.assertPublished(TASK, change, forge)).squashMessage).toBe(
        at.draft.whatChanged.join("\n\n"),
      );
      // The same identity check protects text: visibility/project changes never silently republish.
      forge.storyDestination = async () => ({
        ...destination,
        projectId: destination.projectId + 1,
      });
      await expect(at.service.assertPublished(TASK, change, forge)).rejects.toThrow(
        "destination or audience changed",
      );
    },
  );

  it("binds a plain branch's retained story without inventing a description or pull request", async () => {
    const at = await arrange();
    at.change = { branch: BRANCH, headSha: HEAD, url: null };
    const forge: Forge = {
      ...at.forge,
      kind: "git",
      attachments: undefined,
      storyDestination: async () => ({
        kind: "branch",
        origin: "https://git.example.test/octo/meterlab.git",
      }),
    };
    const revision = await at.service.prepare(TASK, at.staged, forge);
    const change = await at.service.publish(TASK, revision, forge, BRANCH, at.draft.title);
    expect(at.upload).not.toHaveBeenCalled();
    expect(at.open).not.toHaveBeenCalled();
    expect(at.update).not.toHaveBeenCalled();
    expect(change).toEqual({ branch: BRANCH, headSha: HEAD, url: null });
    expect(at.tasks.delivery.changePresentation(TASK)?.published).toBeUndefined();
    expect(at.tasks.delivery.changePresentation(TASK)?.completion).toMatchObject({
      revision,
      head: HEAD,
    });
    expect((await at.service.completion(TASK, revision, HEAD)).pictures).toHaveLength(2);
    await expect(
      at.service.assertPublished(TASK, { ...change, headSha: "b".repeat(40) }, forge),
    ).rejects.toThrow("current committed version");
    forge.storyDestination = async () => ({
      kind: "branch",
      origin: "https://git.example.test/another/project.git",
    });
    await expect(at.service.assertPublished(TASK, change, forge)).rejects.toThrow(
      "destination or audience changed",
    );
  });

  it("prepares and completes local work without a forge, and refuses stale code or missing pictures", async () => {
    const at = await arrange();
    const local = { kind: "local", project: "repo-meterlab" } as const;
    const revision = await at.service.prepare(TASK, at.staged, local);
    expect(at.tasks.delivery.changePresentation(TASK)?.publication).toBeUndefined();
    expect(at.tasks.delivery.changePresentation(TASK)?.receipts).toEqual([]);
    expect(await at.service.assertLocal(TASK, local)).toBe(HEAD);
    const card = await at.service.completion(TASK, revision, HEAD);
    expect(card.pictures).toHaveLength(2);
    expect(card.riskDeclaration).toEqual(risk);
    expect(at.order).toEqual([]);
    await expect(
      at.service.assertLocal(TASK, { ...local, project: "another-project" }),
    ).rejects.toThrow("local project changed");
    at.setHead("b".repeat(40));
    await expect(at.service.assertLocal(TASK, local)).rejects.toThrow("current committed version");
    at.setHead(HEAD);
    const asset = at.tasks.delivery.changePresentation(TASK)?.revisions[0]?.assets[0];
    if (!asset) throw new Error("Missing retained fixture");
    rmSync(join(at.media, asset.file));
    await expect(at.service.assertLocal(TASK, local)).rejects.toThrow();
  });

  it("never downgrades a native host to text when its upload capability disappears", async () => {
    const at = await arrange();
    await at.prepare();
    const destination = await at.forge.attachments!.destination();
    const forge: Forge = {
      ...at.forge,
      attachments: undefined,
      storyDestination: async () => destination,
    };
    await expect(at.service.publish(TASK, 1, forge, BRANCH, at.draft.title)).rejects.toThrow(
      "Native evidence publication is not available",
    );
    expect(at.open).not.toHaveBeenCalled();
    expect(at.tasks.delivery.changePresentation(TASK)?.published).toBeUndefined();
  });
});

// Accepted live-validation view plan: saved stories bind proof before publication and completion.
it("fills no-surface stories from the record and refuses a stale proof snapshot", async () => {
  const at = await arrange();
  const proof = noSurfaceProof(HEAD);
  seedDelivery(at.tasks, TASK, { liveValidation: proof });
  const revision = await at.prepare();
  const saved = at.tasks.delivery.changePresentation(TASK)!.revisions.at(-1)!;
  expect(saved.liveValidation).toMatchObject({
    label: "No running surface",
    live: 0,
    total: 0,
    verdict: "no-surface",
  });
  await at.publish(revision);
  const completion = await at.service.completion(TASK, revision, HEAD);
  expect(completion.body).toContain("No running surface");
  proof.runs[0]!.revision += 1;
  seedDelivery(at.tasks, TASK, { liveValidation: proof });
  await expect(at.service.completion(TASK, revision, HEAD)).rejects.toThrow(
    "Prepare the story again",
  );
  await expect(at.publish(revision)).rejects.toThrow("Prepare the story again");
});
