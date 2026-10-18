import { createHash, randomBytes } from "node:crypto";
import { open, readFile, realpath, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type ChangePresentation,
  type ChangePresentationRecord,
  changePresentationSchema,
  type PresentationAsset,
  type PresentationPublication,
  type PresentationReceipt,
  type PresentationRecovery,
} from "@shared/changePresentation";
import {
  AttachmentUploadError,
  type Forge,
  type ForgeChange,
  ForgeWriteError,
  presentationBodyLimit,
  presentationCardBody,
  presentationCommitMessage,
  presentationContentHash,
  presentationLines,
  presentationMarkdown,
  presentationSizingUrl,
  readPresentationRegion,
  replacePresentationRegion,
  sameAttachmentDestination,
} from "../forge";
import type { StagedChangePresentation } from "../pi/changePresentation";
import type { TaskService } from "../tasks/taskService";

export type PresentationLedger = Pick<
  TaskService,
  "get" | "changePresentation" | "updateChangePresentation"
>;
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
/** GitHub's body limit covers the rendered region and all surrounding project/human text. */
export const GITHUB_STORY_BODY_LIMIT = presentationBodyLimit("github.com");

/** The host's own words in a crewmate's tool text: GitHub's pull request, GitLab's merge request. */
function hostWords(forge: Forge): { place: string; change: string; oneOpen: string } {
  const place = forge.place ?? "the project's host";
  return forge.kind === "gitlab"
    ? {
        place,
        change: "merge request",
        oneOpen: `${place} permits only one open merge request for this source and target branch`,
      }
    : {
        place,
        change: "pull request",
        oneOpen: `${place} permits only one open pull request for this head and base`,
      };
}

/** Serialization, retained receipts and the all-files-first barrier; never merge authority. */
export class ChangePresentations {
  private readonly active = new Map<string, ReadonlySet<string>>();

  constructor(
    private readonly options: {
      tasks: PresentationLedger;
      mediaDir: (taskId: string) => string;
      /** Read actual committed code, including after asynchronous uploads. */
      head: (taskId: string) => Promise<string>;
    },
  ) {}

  async prepare(taskId: string, staged: StagedChangePresentation, forge: Forge): Promise<number> {
    try {
      return await this.serial(
        taskId,
        async () => {
          if (!forge.attachments)
            throw new Error("Native evidence publication is not available on this host.");
          if ((await this.options.head(taskId)) !== staged.head)
            throw new Error("The code changed. Prepare a story for the current committed version.");
          const destination = await forge.attachments.destination();
          const current = this.options.tasks.changePresentation(taskId);
          if (
            current?.publication &&
            current.publication.state !== "confirmed" &&
            !current.publication.retryOpening
          )
            throw new Error("Reconcile the uncertain story write before preparing a replacement.");
          const prior = current?.revisions.at(-1);
          if (
            prior &&
            (!sameAttachmentDestination(prior.destination, destination) ||
              prior.base !== staged.base)
          )
            throw new Error(
              "Keep the original Before base and destination; reconcile changed project identity or visibility before publishing.",
            );
          const revision = (prior?.revision ?? 0) + 1;
          const story = changePresentationSchema.parse({
            ...staged,
            taskId,
            destination,
            revision,
          });
          await this.checkRetained(story);
          // Before media for a surviving view stays the original comparison, never silently refreshed.
          for (const view of prior?.views ?? []) {
            const next = story.views.find((candidate) => candidate.id === view.id);
            if (!next) continue;
            const identities = (owner: ChangePresentation, entries: typeof view.before) =>
              entries.map(
                (entry) => owner.assets.find((asset) => asset.id === entry.asset)?.uploadSha256,
              );
            if (
              JSON.stringify(identities(prior as ChangePresentation, view.before)) !==
              JSON.stringify(identities(story, next.before))
            )
              throw new Error(`Keep the original Before evidence for ${view.id}.`);
          }
          await this.save(taskId, (record) => {
            const receipts = [...(record?.receipts ?? [])];
            for (const asset of this.uploadAssets(story)) {
              if (receipts.some((receipt) => receiptMatches(story, asset, receipt))) continue;
              receipts.push({
                destination: story.destination,
                digest: asset.uploadSha256,
                mediaType: asset.mediaType,
                state: "prepared",
              });
            }
            return { ...record, revisions: [...(record?.revisions ?? []), story], receipts };
          });
          return revision;
        },
        staged.assets,
      );
    } finally {
      await this.discardStaged(taskId, staged);
    }
  }

  /** Also used for refusals before preparation starts, including transferred staging copies. */
  async discardStaged(taskId: string, staged: StagedChangePresentation): Promise<void> {
    await this.cleanupMedia(taskId, staged.assets);
  }

  /** Does not replace an old PR or leave a new PR with only some of its planned evidence. */
  async publish(
    taskId: string,
    revision: number,
    forge: Forge,
    branch: string,
    title: string,
    checks: "pending" | "passed" = "pending",
    recovery?: PresentationRecovery,
  ): Promise<ForgeChange> {
    return this.serial(taskId, () =>
      this.publishLocked(taskId, revision, forge, branch, title, checks, recovery),
    );
  }

  private async publishLocked(
    taskId: string,
    revision: number,
    forge: Forge,
    branch: string,
    title: string,
    checks: "pending" | "passed",
    recovery?: PresentationRecovery,
    remoteOnly = false,
    inheritedContentHash?: string,
  ): Promise<ForgeChange> {
    const story = this.current(taskId, revision);
    if (!forge.attachments)
      throw new Error("Native evidence publication is not available on this host.");
    const words = hostWords(forge);
    let ledger = this.ledger(taskId);
    if (ledger.publication && ledger.publication.state !== "confirmed") {
      // Recover a prior write by reading, even if a later push moved the code.
      // Its original head stays on the receipt; completion still needs a current story.
      if (!sameAttachmentDestination(story.destination, await forge.attachments.destination()))
        throw new Error("The publication destination or audience changed.");
      const reconciled = await this.reconcile(story, ledger.publication, forge, branch, recovery);
      if (reconciled && ledger.publication.revision === revision) return reconciled;
      ledger = this.ledger(taskId);
    }
    const existing = await forge.changeFor(branch);
    if (existing && !ledger.published && ledger.publication?.retryOpening) {
      const reconciled = await this.reconcile(
        story,
        ledger.publication,
        forge,
        branch,
        recovery,
        existing,
      );
      if (reconciled && ledger.publication.revision === revision) return reconciled;
      ledger = this.ledger(taskId);
    }
    if (existing && !ledger.published && !ledger.reconciled)
      throw new Error(`This ${words.change} predates the saved story. It will not be rewritten.`);
    if (!existing && (ledger.published || ledger.reconciled))
      throw new Error(
        `The published ${words.change} is no longer open. Publication stops; close this task or deliberately reopen that same ${words.change} on ${words.place}.`,
      );
    const knownNumber = ledger.published?.number ?? ledger.reconciled?.number;
    if (existing && knownNumber !== undefined && existing.number !== knownNumber)
      throw new Error(
        `Another ${words.change} is open for this branch. Publication stops rather than replacing the named ${words.change}.`,
      );
    await this.validateCurrent(story, forge, branch, remoteOnly);
    const previousRegion =
      recovery?.replaceRegion ?? ledger.reconciled?.region ?? ledger.published?.region;
    const bodyFor = (region: string, current: ForgeChange | null): string => {
      const body =
        current && previousRegion !== undefined
          ? replacePresentationRegion(current.body ?? "", previousRegion, region, taskId)
          : [story.projectText, region].filter(Boolean).join("\n\n");
      const limit = presentationBodyLimit(story.destination.host);
      if (Array.from(body).length > limit)
        throw new Error(
          `The complete ${words.change} description exceeds ${words.place}'s ${limit.toLocaleString("en-US")}-character limit. Shorten the story or surrounding text before publishing.`,
        );
      return body;
    };
    // Render the actual layout, escaping, links and recovery-preserved words before sending files.
    bodyFor(
      presentationMarkdown(
        story,
        // Never saved as a receipt or sent: a real receipt's length, for sizing alone.
        new Map(
          this.uploadAssets(story).map((asset) => [
            asset.id,
            presentationSizingUrl(story.destination.host, asset.mediaType),
          ]),
        ),
        existing ? checks : "pending",
      ),
      existing,
    );
    const urls = new Map<string, string>();
    for (const asset of this.uploadAssets(story)) {
      let receipt = this.receipt(story, asset);
      if (receipt?.state === "sending" || receipt?.state === "uncertain") {
        this.keepReceipt(story, { ...receipt, state: "uncertain" });
        if (!recovery?.retryUploads?.includes(asset.uploadSha256))
          throw new Error(
            `An attachment may already exist on ${words.place}. Disclose this possible orphan on a card before asking for a deliberate new attempt; then pass recovery.retryUploads with digest ${asset.uploadSha256}. No upload was resent.`,
          );
        receipt = { ...receipt, possibleOrphan: true };
      }
      if (receipt?.state === "confirmed" && receipt.url) {
        urls.set(asset.id, receipt.url);
        continue;
      }
      const bytes = await this.readAsset(story, asset).catch((error: unknown) => {
        this.keepReceipt(story, {
          destination: story.destination,
          digest: asset.uploadSha256,
          mediaType: asset.mediaType,
          state: "unavailable",
          problem: "The retained evidence is unavailable or changed.",
        });
        throw error;
      });
      receipt = {
        ...(receipt?.possibleOrphan ? { possibleOrphan: true } : {}),
        destination: story.destination,
        digest: asset.uploadSha256,
        mediaType: asset.mediaType,
        state: "sending",
      };
      this.keepReceipt(story, receipt);
      try {
        const uploaded = await forge.attachments.upload(story.destination, {
          bytes,
          sha256: asset.uploadSha256,
          mediaType: asset.mediaType,
        });
        receipt = { ...receipt, state: "confirmed", url: uploaded.url };
        this.keepReceipt(story, receipt);
        urls.set(asset.id, uploaded.url);
      } catch (error) {
        this.keepReceipt(story, {
          ...receipt,
          state: error instanceof AttachmentUploadError ? error.outcome : "uncertain",
          problem:
            error instanceof AttachmentUploadError
              ? error.message
              : "The upload outcome was not confirmed. Do not resend automatically; disclose the possible orphan before asking for another attempt.",
        });
        throw error;
      }
    }
    // Uploading may have taken time. No write until code, destination and all retained files still match.
    await this.validateCurrent(story, forge, branch, remoteOnly);
    const region = presentationMarkdown(story, urls, existing ? checks : "pending");
    const fresh = await forge.changeFor(branch);
    if (existing?.number !== fresh?.number)
      throw new Error(`The ${words.change} changed during publication. Read it again.`);
    if (fresh && fresh.headSha !== story.head)
      throw new Error("The pushed code does not match this story.");
    // A person may have added words during upload. Recheck before any description write.
    const body = bodyFor(region, fresh);
    if (fresh && body === fresh.body && ledger.published?.revision === revision) return fresh;
    const publication: PresentationPublication = {
      revision,
      head: story.head,
      state: "sending",
      region,
      regionHash: hash(region),
      contentHash: inheritedContentHash ?? presentationContentHash(story),
      ...(fresh?.number ? { number: fresh.number } : {}),
    };
    this.options.tasks.updateChangePresentation(taskId, (record) => ({
      ...this.required(record),
      publication,
    }));
    try {
      if (fresh) {
        if (!forge.updateChangeBody) throw new Error("This host cannot replace a saved story.");
        await forge.updateChangeBody(fresh, body);
      } else {
        const opened = await forge.openChange({ branch, title, body });
        if (opened.number) publication.number = opened.number;
      }
      // Neither GitHub nor GitLab offers an atomic conditional body update. Reread both sides and disclose the race.
      // Only the generated region is the app's: GitLab runs and strips a project
      // template's own quick actions around it, and a person may add words (INF-290 F3).
      const read = await forge.changeFor(branch);
      if (
        !read ||
        read.headSha !== story.head ||
        readPresentationRegion(read.body ?? "", taskId) !== presentationLines(region)
      )
        throw new Error(
          "The story write did not read back exactly; a simultaneous edit or an uncertain write needs reconciliation.",
        );
      await this.confirm(taskId, { ...publication, number: read.number });
      return read;
    } catch (error) {
      this.options.tasks.updateChangePresentation(taskId, (record) => ({
        ...this.required(record),
        publication:
          error instanceof ForgeWriteError && error.outcome === "failed"
            ? ledger.publication
            : { ...publication, state: "uncertain" },
      }));
      throw error;
    }
  }

  /** A completion offer must use the newest fully published story at the current committed version. */
  async completion(taskId: string, revision: number, head: string) {
    return this.serial(taskId, async () => {
      const story = this.publishedStory(taskId, head, revision);
      if ((await this.options.head(taskId)) !== head)
        throw new Error("The current code changed before the completion card.");
      await this.checkRetained(story);
      // A displayed card owns independent copies. Story pruning never sees
      // these minted names, even after the card closes or the app restarts.
      const copies: PresentationAsset[] = [];
      try {
        for (const asset of story.assets) {
          const bytes = await this.readAsset(story, asset);
          const id = `${taskId}-${randomBytes(16).toString("hex")}`;
          const copy = { ...asset, id, file: asset.file.replace(asset.id, id) };
          const file = await open(join(this.options.mediaDir(taskId), copy.file), "wx");
          copies.push(copy);
          try {
            await file.writeFile(bytes);
          } finally {
            await file.close();
          }
        }
        const ids = new Map(story.assets.map((asset, index) => [asset.id, copies[index]?.id]));
        const copiedId = (id: string): string => {
          const copy = ids.get(id);
          if (!copy) throw new Error("The story has missing retained media.");
          return copy;
        };
        const cardStory: ChangePresentation = {
          ...story,
          assets: copies,
          views: story.views.map((view) => {
            const media = (entries: typeof view.before) =>
              entries.map((entry) => ({
                ...entry,
                asset: copiedId(entry.asset),
                ...(entry.poster ? { poster: copiedId(entry.poster) } : {}),
              }));
            return { ...view, before: media(view.before), after: media(view.after) };
          }),
          pictures: story.pictures.map((picture) => ({
            ...picture,
            id: copiedId(picture.id),
            ...(picture.demo ? { demo: { ...picture.demo, id: copiedId(picture.demo.id) } } : {}),
          })),
        };
        return {
          title: story.title,
          body: presentationCardBody(cardStory),
          pictures: cardStory.pictures,
          riskDeclaration: story.risk,
          requiredActions: story.requiredActions,
        };
      } catch (error) {
        await this.cleanupMedia(taskId, copies);
        throw error;
      }
    });
  }

  /** Publication completeness is independent of checks and of permission to merge. */
  async assertPublished(taskId: string, change: ForgeChange, forge: Forge): Promise<ForgeChange> {
    const record = this.ledger(taskId);
    const story = this.publishedStory(taskId, change.headSha);
    if (!record.published) throw new Error("The current story has not been published.");
    if (
      !forge.attachments ||
      !sameAttachmentDestination(story.destination, await forge.attachments.destination())
    )
      throw new Error("The story's destination or audience changed.");
    for (const asset of this.uploadAssets(story)) {
      const receipt = this.receipt(story, asset);
      if (receipt?.state !== "confirmed" || !receipt.url)
        throw new Error("The current story is missing a confirmed attachment.");
    }
    if (record.published.regionHash !== hash(record.published.region))
      throw new Error("The saved publication record changed.");
    const projectText = replacePresentationRegion(
      change.body ?? "",
      record.published.region,
      "",
      taskId,
    );
    return { ...change, squashMessage: presentationCommitMessage({ ...story, projectText }) };
  }

  private async reconcile(
    story: ChangePresentation,
    publication: PresentationPublication,
    forge: Forge,
    branch: string,
    recovery?: PresentationRecovery,
    observed?: ForgeChange,
  ): Promise<ForgeChange | undefined> {
    const found = observed ?? (await forge.changeFor(branch));
    const ledger = this.ledger(story.taskId);
    const words = hostWords(forge);
    if (found && (publication.number === undefined || publication.number === found.number)) {
      const region = readPresentationRegion(found.body ?? "", story.taskId);
      if (region === presentationLines(publication.region)) {
        await this.confirm(story.taskId, { ...publication, number: found.number });
        return found;
      }
      if (
        (ledger.published && region === presentationLines(ledger.published.region)) ||
        (ledger.reconciled && region === presentationLines(ledger.reconciled.region))
      ) {
        this.options.tasks.updateChangePresentation(story.taskId, (record) => ({
          ...this.required(record),
          publication: ledger.published,
        }));
        const restored =
          ledger.published && region === presentationLines(ledger.published.region)
            ? "The last confirmed story"
            : "The reviewed edit";
        throw new Error(
          `${restored} is still on ${words.place}. Its state is restored; call open_change deliberately to retry the replacement.`,
        );
      }
      // A deliberate replacement is bound to the exact edit shown on the crewmate’s card.
      if (
        recovery?.replaceRegion !== undefined &&
        region === presentationLines(recovery.replaceRegion) &&
        found.number !== undefined
      ) {
        this.options.tasks.updateChangePresentation(story.taskId, (record) => ({
          ...this.required(record),
          publication: ledger.published,
          reconciled: { number: found.number as number, region },
        }));
        return undefined;
      }
      replacePresentationRegion(
        found.body ?? "",
        publication.region,
        publication.region,
        story.taskId,
      );
    }
    if (publication.number !== undefined || ledger.published) {
      throw new Error(
        `The published ${words.change} is no longer open. Publication stops; it will not be reopened or replaced. Close this task or reopen that ${words.change} deliberately on ${words.place} before continuing.`,
      );
    }
    if (recovery?.retryOpening || publication.retryOpening) {
      // The host permits only one open change for the branch and its target; the fresh read above found none.
      this.options.tasks.updateChangePresentation(story.taskId, (record) => ({
        ...this.required(record),
        publication: { ...publication, retryOpening: true },
      }));
      return undefined;
    }
    throw new Error(
      `The earlier ${words.change} write remains uncertain; absence is not proof that it failed. No request was resent. A deliberate open_change with recovery.retryOpening may try opening again; ${words.oneOpen}.`,
    );
  }

  private publishedStory(taskId: string, head: string, revision?: number): ChangePresentation {
    const record = this.ledger(taskId);
    const story = record.revisions.at(-1);
    if (!story || (!record.published && revision === undefined))
      throw new Error("The current story has not been published.");
    if (
      !record.published ||
      (revision !== undefined && story.revision !== revision) ||
      record.publication?.state !== "confirmed" ||
      record.published?.revision !== story.revision ||
      record.published.head !== head ||
      story.head !== head
    )
      throw new Error(
        "The current story and all evidence must be published and read back before the completion card or merge.",
      );
    return story;
  }

  private async confirm(taskId: string, publication: PresentationPublication): Promise<void> {
    const confirmed = { ...publication, state: "confirmed" as const };
    await this.save(taskId, (record) => ({
      ...this.required(record),
      publication: confirmed,
      published: confirmed,
      reconciled: undefined,
    }));
  }

  /** Keep the latest draft and the last complete publication, never an unbounded revision history. */
  private async save(
    taskId: string,
    update: (record: ChangePresentationRecord | undefined) => ChangePresentationRecord,
  ): Promise<void> {
    const previous = this.options.tasks.changePresentation(taskId);
    this.options.tasks.updateChangePresentation(taskId, (record) => {
      const next = update(record);
      const newest = next.revisions.at(-1)?.revision;
      return {
        ...next,
        revisions: next.revisions.filter(
          (story) =>
            story.revision === newest ||
            story.revision === (next.published?.revision ?? next.publication?.revision),
        ),
      };
    });
    await this.cleanupMedia(taskId, previous?.revisions.flatMap((story) => story.assets) ?? []);
  }

  private async cleanupMedia(taskId: string, assets: PresentationAsset[]): Promise<void> {
    const kept = new Set(
      (this.options.tasks.get(taskId)?.delivery?.presentation?.revisions ?? []).flatMap((story) =>
        story.assets.map((asset) => asset.file),
      ),
    );
    for (const asset of assets) {
      if (
        kept.has(asset.file) ||
        this.active.get(taskId)?.has(asset.file) ||
        !asset.file.startsWith(`${taskId}-`) ||
        !/^[A-Za-z0-9_-]+\.(png|jpg|webp|mp4)$/.test(asset.file)
      )
        continue;
      // A failed unlink must not turn a confirmed external write into an uncertain one.
      await rm(join(this.options.mediaDir(taskId), asset.file), { force: true }).catch(() => {
        console.warn("Could not remove superseded story media", taskId, asset.id);
      });
    }
  }

  /** Called only on a host-accepted conflict-only lineage, not an author's arbitrary new story. */
  async refreshConflictOnly(
    taskId: string,
    fromHead: string,
    toHead: string,
    forge: Forge,
    branch: string,
    title: string,
  ): Promise<void> {
    await this.serial(taskId, async () => {
      const record = this.ledger(taskId);
      const published = record.revisions.find(
        (story) => story.revision === record.published?.revision,
      );
      if (!published || published.head === toHead) return;
      if (published.head !== fromHead)
        throw new Error("The repair does not start from the published story.");
      const latest = record.revisions.at(-1) as ChangePresentation;
      const refreshed = changePresentationSchema.parse({
        ...published,
        revision: published.revision + 1,
        head: toHead,
        views: published.views.map((view) => ({
          ...view,
          after: view.after.map((media) => ({
            ...media,
            applicability:
              media.applicability ??
              `The accepted conflict-only repair from ${fromHead} to ${toHead} leaves this view unchanged.`,
          })),
        })),
      });
      if (
        latest.revision !== published.revision &&
        JSON.stringify(latest) !== JSON.stringify(refreshed)
      )
        throw new Error(
          "A newer edited story needs its own completion offer; it is not a conflict-only refresh.",
        );
      if (latest.revision === published.revision)
        await this.save(taskId, (old) => ({
          ...this.required(old),
          revisions: [...this.required(old).revisions, refreshed],
        }));
      await this.publishLocked(
        taskId,
        refreshed.revision,
        forge,
        branch,
        title,
        "passed",
        undefined,
        true,
        record.published?.contentHash ?? presentationContentHash(published),
      );
    });
  }

  private current(taskId: string, revision: number): ChangePresentation {
    const story = this.ledger(taskId).revisions.at(-1);
    if (!story || story.revision !== revision)
      throw new Error("Use the newest prepared story revision.");
    return changePresentationSchema.parse(story);
  }
  private ledger(taskId: string): ChangePresentationRecord {
    return this.required(this.options.tasks.changePresentation(taskId));
  }
  private required(record: ChangePresentationRecord | undefined): ChangePresentationRecord {
    if (!record) throw new Error("Prepare the change story before opening its pull request.");
    return record;
  }
  private uploadAssets(story: ChangePresentation): PresentationAsset[] {
    const ids = new Set(
      story.views.flatMap((view) => [...view.before, ...view.after].map((entry) => entry.asset)),
    );
    return story.assets.filter((asset) => ids.has(asset.id));
  }
  private receipt(
    story: ChangePresentation,
    asset: PresentationAsset,
  ): PresentationReceipt | undefined {
    return this.ledger(story.taskId).receipts.find((receipt) =>
      receiptMatches(story, asset, receipt),
    );
  }
  private keepReceipt(story: ChangePresentation, next: PresentationReceipt): void {
    this.options.tasks.updateChangePresentation(story.taskId, (record) => ({
      ...this.required(record),
      receipts: [
        ...this.required(record).receipts.filter(
          (receipt) =>
            !(
              receipt.digest === next.digest &&
              receipt.mediaType === next.mediaType &&
              sameAttachmentDestination(receipt.destination, next.destination)
            ),
        ),
        next,
      ],
    }));
  }
  private async validateCurrent(
    story: ChangePresentation,
    forge: Forge,
    branch: string,
    remoteOnly = false,
  ): Promise<void> {
    if (!remoteOnly && (await this.options.head(story.taskId)) !== story.head)
      throw new Error("The code changed after this story was prepared.");
    if (!forge.branchHead || (await forge.branchHead(branch)) !== story.head)
      throw new Error(
        "The pushed code does not match this story. Push the reviewed version first.",
      );
    if (
      !forge.attachments ||
      !sameAttachmentDestination(story.destination, await forge.attachments.destination())
    )
      throw new Error("The publication destination or audience changed.");
    await this.checkRetained(story);
  }
  private async checkRetained(story: ChangePresentation): Promise<void> {
    for (const asset of story.assets) await this.readAsset(story, asset);
    const ids = new Set(story.assets.map((asset) => asset.id));
    if (ids.size !== story.assets.length)
      throw new Error("Duplicate retained attachment identities.");
    for (const view of story.views)
      for (const media of [...view.before, ...view.after]) {
        if (!ids.has(media.asset) || (media.poster && !ids.has(media.poster)))
          throw new Error("Missing retained attachment identity.");
      }
  }
  private async readAsset(
    story: ChangePresentation,
    asset: PresentationAsset,
  ): Promise<Uint8Array> {
    const root = await realpath(this.options.mediaDir(story.taskId));
    if (!asset.id.startsWith(`${story.taskId}-`))
      throw new Error("The retained media belongs to another task.");
    const file = await realpath(join(root, asset.file));
    if (relative(root, file) !== asset.file)
      throw new Error("The retained media escaped its task folder.");
    const bytes = await readFile(file);
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.uploadSha256)
      throw new Error("The retained media changed after inspection.");
    return bytes;
  }
  private async serial<T>(
    taskId: string,
    run: () => Promise<T>,
    staged: PresentationAsset[] = [],
  ): Promise<T> {
    if (this.active.has(taskId))
      throw new Error("A story operation is already in progress for this task.");
    this.active.set(taskId, new Set(staged.map((asset) => asset.file)));
    try {
      return await run();
    } finally {
      this.active.delete(taskId);
    }
  }
}

function receiptMatches(
  story: ChangePresentation,
  asset: PresentationAsset,
  receipt: PresentationReceipt,
): boolean {
  return (
    receipt.digest === asset.uploadSha256 &&
    receipt.mediaType === asset.mediaType &&
    sameAttachmentDestination(receipt.destination, story.destination)
  );
}
