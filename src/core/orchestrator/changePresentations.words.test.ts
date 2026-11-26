import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { arrange, BRANCH, TASK } from "../../../tests/helpers/changePresentationsHarness";
import { readPresentationRegion } from "../forge";
import { stageChangePresentation } from "../pi/changePresentation";

// INF-497 (the captain on INF-100's PR #138): correct only the words around the
// published story, leave the story unchanged, and refuse a concurrent edit.
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
