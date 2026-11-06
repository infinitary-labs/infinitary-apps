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
  readyPresentation,
  type StoryAround,
} from "@shared/changePresentation";
import {
  hostedPresentation,
  type LocalPresentationDestination,
  nativePresentationMedia,
  type PresentationDestination,
  presentationFormat,
  samePresentationDestination,
} from "@shared/presentationDestination";
import type { NamingRule } from "../../shared/runbooks";
import {
  AttachmentUploadError,
  changeTitle,
  type Forge,
  type ForgeChange,
  ForgeWriteError,
  neutralizePipelineAttestation,
  PresentationAroundError,
  pipelineAttestationSection,
  presentationAround,
  presentationBodyLimit,
  presentationCardBody,
  presentationCommitMessage,
  presentationContentHash,
  presentationLines,
  presentationMarkdown,
  presentationRegionMarkers,
  presentationSizingUrl,
  readPresentationRegion,
  replaceAroundPresentation,
  replacePresentationRegion,
  sameAroundPresentation,
  sameAttachmentDestination,
} from "../forge";
import type { StagedChangePresentation } from "../pi/changePresentation";
import { storyLedgers } from "../storage/changeProjection";
import type { TaskService } from "../tasks/taskService";
import { requireConventional } from "../workspace/conventional";

export type PresentationLedger = Pick<TaskService, "get"> & {
  delivery: Pick<
    TaskService["delivery"],
    "changePresentation" | "updateChangePresentation" | "afterMergeRefusal" | "afterMergeShown"
  >;
};
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

type PublicationOpening = {
  draft?: boolean;
  /** The branch the change targets when it opens (INF-1873); an open change keeps its own. */
  base?: string;
  /** Recheck and consume the caller's publication authority after preflight, before uploads. */
  beforePublish?: (head: string) => void;
  /** Whether Careful's records complete no-mistakes' review, test and document at this version. */
  attests?: (head: string) => boolean;
  /** The ref this Mac holds the branch at when not under its own name (INF-2490). */
  source?: string;
};

type PresentationTarget = Forge | LocalPresentationDestination;

async function storyDestination(target: PresentationTarget): Promise<PresentationDestination> {
  if (target.kind === "local") return target;
  if (target.storyDestination) return target.storyDestination();
  if (target.attachments) return target.attachments.destination();
  throw new Error("The story's destination cannot be read.");
}

/** Serialization, retained receipts and the all-files-first barrier; never merge authority. */
export class ChangePresentations {
  private readonly active = new Map<string, ReadonlySet<string>>();

  constructor(
    private readonly options: {
      namingRule?: () => NamingRule | null;
      tasks: PresentationLedger;
      mediaDir: (taskId: string) => string;
      /** Read actual committed code, including after asynchronous uploads. */
      head: (taskId: string) => Promise<string>;
      /**
       * The branch the working copy has checked out, whose change a story
       * is prepared for (INF-2490); undefined for the task's current change.
       */
      branch?: (taskId: string) => Promise<string | undefined>;
    },
  ) {}

  async prepare(
    taskId: string,
    staged: StagedChangePresentation,
    target: PresentationTarget,
  ): Promise<number> {
    try {
      return await this.serial(
        taskId,
        async () => {
          if ((await this.options.head(taskId)) !== staged.head)
            throw new Error("The code changed. Prepare a story for the current committed version.");
          const branch = await this.options.branch?.(taskId);
          const destination = await storyDestination(target);
          const current = this.options.tasks.delivery.changePresentation(taskId, branch);
          if (
            current?.publication &&
            current.publication.state !== "confirmed" &&
            !current.publication.retryOpening
          )
            throw new Error("Reconcile the uncertain story write before preparing a replacement.");
          const prior = current?.revisions.at(-1);
          if (
            prior &&
            (!samePresentationDestination(prior.destination, destination) ||
              prior.base !== staged.base)
          )
            throw new Error(
              "Keep the original Before base and destination; reconcile changed project identity or visibility before publishing.",
            );
          const revision = (prior?.revision ?? 0) + 1;
          if (staged.version === 2)
            requireConventional(staged.title, "story title", this.options.namingRule?.());
          const story = changePresentationSchema.parse({
            ...staged,
            taskId,
            destination,
            revision,
          });
          const steps =
            story.afterMerge &&
            this.options.tasks.delivery.afterMergeRefusal(taskId, story.afterMerge);
          if (steps) throw new Error(steps);
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
          await this.save(taskId, branch, (record) => {
            const receipts = [...(record?.receipts ?? [])];
            for (const asset of this.nativeAssets(story)) {
              if (!hostedPresentation(story.destination))
                throw new Error("An upload needs a host.");
              if (receipts.some((receipt) => receiptMatches(story, asset, receipt))) continue;
              receipts.push({
                destination: story.destination,
                digest: asset.uploadSha256,
                mediaType: asset.mediaType,
                state: "prepared",
              });
            }
            return {
              ...record,
              revisions: [...(record?.revisions ?? []), story],
              receipts,
              ...(!hostedPresentation(destination) && destination.kind === "local"
                ? {
                    completion: {
                      revision,
                      head: story.head,
                      contentHash: presentationContentHash(story),
                    },
                  }
                : {}),
            };
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
    around?: StoryAround,
    opening?: PublicationOpening,
  ): Promise<ForgeChange> {
    // INF-2509: the revision the author named stands for the host's republication of it.
    const record = this.options.tasks.delivery.changePresentation(taskId, branch);
    const named = (record && shownRevision(record, revision)) ?? revision;
    return this.serial(taskId, () =>
      this.publishLocked(
        taskId,
        named,
        forge,
        branch,
        title,
        checks,
        recovery,
        false,
        undefined,
        around,
        opening,
      ),
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
    inherited?: { contentHash: string; refreshOf: number },
    around?: StoryAround,
    opening?: PublicationOpening,
  ): Promise<ForgeChange> {
    const story = this.current(taskId, branch, revision);
    if (story.version === 2 && title !== story.title)
      throw new Error("Use the saved title for the pull request and completion card.");
    if (!hostedPresentation(story.destination)) {
      if (story.destination.kind !== "branch")
        throw new Error("A local story has no remote publication.");
      if (around || recovery)
        throw new Error("A pushed branch has no description to replace or reconcile.");
      await this.validatePrepared(story, forge, remoteOnly);
      const existing = await forge.changeFor(branch);
      if (existing && existing.headSha !== story.head)
        throw new Error("The pushed branch does not match this story.");
      opening?.beforePublish?.(story.head);
      // A placed branch is brought home before publication. Preserve the plain
      // forge's first push from there; an already-pushed branch needs no write.
      const change =
        existing ??
        (await forge.openChange({
          branch,
          title,
          body: "",
          ...(opening?.source ? { source: opening.source } : {}),
        }));
      await this.validateCurrent(story, forge, branch, remoteOnly);
      if (change.headSha !== story.head)
        throw new Error("The pushed branch does not match this story.");
      await this.save(taskId, branch, (record) => ({
        ...this.required(record),
        completion: { revision, head: story.head, contentHash: presentationContentHash(story) },
      }));
      return change;
    }
    const destination = story.destination;
    if (nativePresentationMedia(destination) && !forge.attachments)
      throw new Error("Native evidence publication is not available on this host.");
    const words = hostWords(forge);
    let ledger = this.ledger(taskId, branch);
    if (ledger.publication && ledger.publication.state !== "confirmed") {
      // Recover a prior write by reading, even if a later push moved the code.
      // Its original head stays on the receipt; completion still needs a current story.
      if (!samePresentationDestination(destination, await storyDestination(forge)))
        throw new Error("The publication destination or audience changed.");
      const reconciled = await this.reconcile(story, ledger.publication, forge, branch, recovery);
      // A reconciled write is this revision's; words around it still need their own change.
      if (reconciled && ledger.publication.revision === revision && !around) return reconciled;
      ledger = this.ledger(taskId, branch);
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
      if (reconciled && ledger.publication.revision === revision && !around) return reconciled;
      ledger = this.ledger(taskId, branch);
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
    // INF-497: changing only the words around the published story keeps its region byte for byte.
    const kept = around && ledger.published?.revision === revision ? ledger.published : undefined;
    await this.validateCurrent(story, forge, branch, remoteOnly);
    // A person's rename stops the story before any file is sent, not only before the write.
    this.renameFor(story, ledger, existing, forge, title);
    const previousRegion =
      recovery?.replaceRegion ?? ledger.reconciled?.region ?? ledger.published?.region;
    // INF-1793: Careful counts as no-mistakes on github.com; the attestation sits at
    // the end of the app's own region, read from the records when the region is written.
    const { end: regionEnd } = presentationRegionMarkers(taskId);
    const attested = (rendered: string): string =>
      destination.host === "github.com" &&
      rendered.endsWith(regionEnd) &&
      opening?.attests?.(story.head)
        ? `${rendered.slice(0, -regionEnd.length)}${pipelineAttestationSection(story.head)}\n\n${regionEnd}`
        : rendered;
    const bodyFor = (region: string, current: ForgeChange | null): string => {
      if (around && !current)
        throw new PresentationAroundError(
          `Nothing was sent: around changes the words around the story on an open ${words.change}. On its first publication, put them in the story's projectText.`,
        );
      const replaced =
        current && previousRegion !== undefined
          ? replacePresentationRegion(current.body ?? "", previousRegion, region, taskId)
          : [story.projectText, region].filter(Boolean).join("\n\n");
      const changed = around
        ? replaceAroundPresentation(replaced, around, taskId, forge.kind === "gitlab")
        : replaced;
      // The check reads the first attestation it finds; words around the region carry none live.
      const outside = region.includes(pipelineAttestationSection(story.head))
        ? presentationAround(changed, taskId)
        : undefined;
      const body = outside
        ? `${neutralizePipelineAttestation(outside.above)}${region}${neutralizePipelineAttestation(outside.below)}`
        : changed;
      const limit = presentationBodyLimit(presentationFormat(destination));
      if (Array.from(body).length > limit)
        throw new Error(
          `The complete ${words.change} description exceeds ${words.place}'s ${limit.toLocaleString("en-US")}-character limit. Shorten the story or surrounding text before publishing.`,
        );
      return body;
    };
    // Render the actual layout, escaping, links and recovery-preserved words before sending files.
    bodyFor(
      kept?.region ??
        attested(
          presentationMarkdown(
            story,
            // Never saved as a receipt or sent: a real receipt's length, for sizing alone.
            new Map(
              this.nativeAssets(story).map((asset) => [
                asset.id,
                presentationSizingUrl(destination.host, asset.mediaType),
              ]),
            ),
            existing ? checks : "pending",
          ),
        ),
      existing,
    );
    opening?.beforePublish?.(story.head);
    const urls = new Map<string, string>();
    for (const asset of this.nativeAssets(story)) {
      if (!forge.attachments)
        throw new Error("Native evidence publication is not available on this host.");
      let receipt = this.receipt(story, branch, asset);
      if (receipt?.state === "sending" || receipt?.state === "uncertain") {
        this.keepReceipt(story, branch, { ...receipt, state: "uncertain" });
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
        this.keepReceipt(story, branch, {
          destination: destination,
          digest: asset.uploadSha256,
          mediaType: asset.mediaType,
          state: "unavailable",
          problem: "The retained evidence is unavailable or changed.",
        });
        throw error;
      });
      receipt = {
        ...(receipt?.possibleOrphan ? { possibleOrphan: true } : {}),
        destination: destination,
        digest: asset.uploadSha256,
        mediaType: asset.mediaType,
        state: "sending",
      };
      this.keepReceipt(story, branch, receipt);
      try {
        const uploaded = await forge.attachments.upload(destination, {
          bytes,
          sha256: asset.uploadSha256,
          mediaType: asset.mediaType,
        });
        receipt = { ...receipt, state: "confirmed", url: uploaded.url };
        this.keepReceipt(story, branch, receipt);
        urls.set(asset.id, uploaded.url);
      } catch (error) {
        this.keepReceipt(story, branch, {
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
    const region =
      kept?.region ?? attested(presentationMarkdown(story, urls, existing ? checks : "pending"));
    const fresh = await forge.changeFor(branch);
    if (existing?.number !== fresh?.number)
      throw new Error(`The ${words.change} changed during publication. Read it again.`);
    if (fresh && fresh.headSha !== story.head)
      throw new Error("The pushed code does not match this story.");
    // A person may have added words during upload. Recheck before any description write.
    const body = bodyFor(region, fresh);
    const rename = this.renameFor(story, ledger, fresh, forge, title);
    if (
      fresh &&
      body === fresh.body &&
      rename === undefined &&
      ledger.published?.revision === revision
    )
      return fresh;
    const publication: PresentationPublication = {
      revision,
      head: story.head,
      state: "sending",
      region,
      regionHash: hash(region),
      contentHash: inherited?.contentHash ?? kept?.contentHash ?? presentationContentHash(story),
      ...(inherited
        ? { refreshOf: inherited.refreshOf }
        : kept?.refreshOf !== undefined
          ? { refreshOf: kept.refreshOf }
          : {}),
      ...(story.version === 2 || !fresh ? { title } : {}),
      ...(fresh?.number ? { number: fresh.number } : {}),
    };
    this.options.tasks.delivery.updateChangePresentation(
      taskId,
      (record) => ({
        ...this.required(record),
        publication,
      }),
      branch,
    );
    let read: ForgeChange | null;
    try {
      if (fresh) {
        if (!forge.updateChangeBody) throw new Error("This host cannot replace a saved story.");
        await forge.updateChangeBody(fresh, body, rename);
      } else {
        const opened = await forge.openChange({
          branch,
          title,
          body,
          ...(opening?.draft !== undefined ? { draft: opening.draft } : {}),
          ...(opening?.base ? { base: opening.base } : {}),
        });
        if (opened.number) publication.number = opened.number;
      }
      // Neither GitHub nor GitLab offers an atomic conditional body update. Reread both sides and disclose the race.
      // Only the generated region is the app's: GitLab runs and strips a project
      // template's own quick actions around it, and a person may add words (INF-290 F3).
      read = await forge.changeFor(branch);
      if (
        !read ||
        read.headSha !== story.head ||
        readPresentationRegion(read.body ?? "", taskId) !== presentationLines(region)
      )
        throw new Error(
          "The story write did not read back exactly; a simultaneous edit or an uncertain write needs reconciliation.",
        );
      await this.confirm(taskId, branch, { ...publication, number: read.number });
    } catch (error) {
      this.options.tasks.delivery.updateChangePresentation(
        taskId,
        (record) => ({
          ...this.required(record),
          publication:
            error instanceof ForgeWriteError && error.outcome === "failed"
              ? ledger.publication
              : { ...publication, state: "uncertain" },
        }),
        branch,
      );
      throw error;
    }
    // The story is the app's and is confirmed; the words around it are a person's too.
    if (around && !sameAroundPresentation(read.body ?? "", body, taskId))
      throw new PresentationAroundError(
        `The story is published, but ${words.place} shows different words around it than you sent; someone may have edited them at the same time. Read the description with github_read before changing them again.`,
      );
    // INF-717: the title went in the same write; a person may have renamed the change meanwhile.
    const shown = changeTitle(forge.kind, read);
    if (fresh && story.version === 2 && shown !== undefined && shown !== title)
      throw new PresentationAroundError(
        `The story is published, but ${words.place} shows the title "${shown}" rather than "${title}"; someone may have renamed the ${words.change} at the same time. Read it with github_read before calling open_change again.`,
      );
    return read;
  }

  /**
   * INF-717: a version-2 story's conventional title is its change's title too. Answers the title
   * to send with the story when the change still carries the one the app left there, or none when
   * it already reads the story's; a person's rename sends nothing and is said.
   */
  private renameFor(
    story: ChangePresentation,
    record: ChangePresentationRecord,
    current: ForgeChange | null,
    forge: Forge,
    title: string,
  ): string | undefined {
    if (story.version !== 2 || !current) return undefined;
    const hosted = changeTitle(forge.kind, current);
    if (hosted === undefined || hosted === title) return undefined;
    const published = record.published;
    const left = published?.title;
    if (hosted === left) return title;
    // A publication before INF-717 kept no title, and the app set one only on opening. Its own
    // version-2 story's title is the app's; the record no longer keeps any older one.
    if (
      published &&
      left === undefined &&
      record.revisions.find((saved) => saved.revision === published.revision && saved.version === 2)
        ?.title === hosted
    )
      return title;
    const words = hostWords(forge);
    throw new PresentationAroundError(
      `Nothing was sent: the ${words.change}'s title on ${words.place} reads "${hosted}", not the story's "${title}". ${left === undefined ? "The app has no record of setting that title." : `The app last left "${left}" there, so someone renamed it.`} To keep that title, prepare the story with it and call open_change again. To use the story's title instead, ask the captain on a card first, then set the title alone with github_write and call open_change again.`,
    );
  }

  /** A completion offer must use the newest fully published story at the current committed version. */
  async completion(taskId: string, revision: number, head: string, branch?: string) {
    return this.serial(taskId, async () => {
      const story = this.publishedStory(taskId, branch, head, revision);
      const committed = await this.options.head(taskId);
      if (committed !== head)
        throw new Error(
          `${pushFirst(committed, head)} Then show the completion card again with presentation ${revision}.`,
        );
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
          ...(story.afterMerge?.length
            ? { afterMerge: this.options.tasks.delivery.afterMergeShown(story.afterMerge) }
            : {}),
        };
      } catch (error) {
        await this.cleanupMedia(taskId, copies);
        throw error;
      }
    });
  }

  /** Local completion validates the committed code and retained files without reaching a forge. */
  async assertLocal(taskId: string, destination: LocalPresentationDestination): Promise<string> {
    const head = await this.options.head(taskId);
    const story = this.publishedStory(taskId, undefined, head);
    if (!samePresentationDestination(story.destination, destination))
      throw new Error("The story's local project changed.");
    await this.checkRetained(story);
    return head;
  }

  /**
   * Publication completeness is independent of checks and of permission to
   * merge. A completion offer passes its revision, so a refusal names the way
   * to a current story.
   */
  async assertPublished(
    taskId: string,
    change: ForgeChange,
    forge: Forge,
    revision?: number,
  ): Promise<ForgeChange> {
    // The story of the change being checked, on its own branch (INF-2490).
    const branch = change.branch;
    const record = this.ledger(taskId, branch);
    const story = this.publishedStory(taskId, branch, change.headSha, revision);
    if (!samePresentationDestination(story.destination, await storyDestination(forge)))
      throw new Error("The story's destination or audience changed.");
    if (!hostedPresentation(story.destination)) return change;
    if (!record.published) throw new Error("The current story has not been published.");
    for (const asset of this.nativeAssets(story)) {
      const receipt = this.receipt(story, branch, asset);
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
    const ledger = this.ledger(story.taskId, branch);
    const words = hostWords(forge);
    if (found && (publication.number === undefined || publication.number === found.number)) {
      const region = readPresentationRegion(found.body ?? "", story.taskId);
      if (region === presentationLines(publication.region)) {
        await this.confirm(story.taskId, branch, { ...publication, number: found.number });
        return found;
      }
      if (
        (ledger.published && region === presentationLines(ledger.published.region)) ||
        (ledger.reconciled && region === presentationLines(ledger.reconciled.region))
      ) {
        this.options.tasks.delivery.updateChangePresentation(
          story.taskId,
          (record) => ({
            ...this.required(record),
            publication: ledger.published,
          }),
          branch,
        );
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
        this.options.tasks.delivery.updateChangePresentation(
          story.taskId,
          (record) => ({
            ...this.required(record),
            publication: ledger.published,
            reconciled: { number: found.number as number, region },
          }),
          branch,
        );
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
      this.options.tasks.delivery.updateChangePresentation(
        story.taskId,
        (record) => ({
          ...this.required(record),
          publication: { ...publication, retryOpening: true },
        }),
        branch,
      );
      return undefined;
    }
    throw new Error(
      `The earlier ${words.change} write remains uncertain; absence is not proof that it failed. No request was resent. A deliberate open_change with recovery.retryOpening may try opening again; ${words.oneOpen}.`,
    );
  }

  /** A completion offer names its revision; the merge path names none and keeps its own words. */
  private publishedStory(
    taskId: string,
    branch: string | undefined,
    head: string,
    revision?: number,
  ): ChangePresentation {
    const record = this.ledger(taskId, branch);
    const story = record.revisions.at(-1);
    if (story && !hostedPresentation(story.destination)) {
      const ready = readyPresentation(record);
      if (!ready || ready.head !== head || (revision !== undefined && ready.revision !== revision))
        throw new Error(
          "The current committed version needs its newest story. Prepare it with prepare_change, and on a pushed branch confirm it with open_change, before showing its completion card or merging.",
        );
      return story;
    }
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
        `The current story and all evidence must be published and read back before the completion card or merge.${revision === undefined ? "" : ` ${completionWayOut(record, story, head)}`}`,
      );
    return story;
  }

  private async confirm(
    taskId: string,
    branch: string | undefined,
    publication: PresentationPublication,
  ): Promise<void> {
    const confirmed = { ...publication, state: "confirmed" as const };
    await this.save(taskId, branch, (record) => ({
      ...this.required(record),
      publication: confirmed,
      published: confirmed,
      reconciled: undefined,
    }));
  }

  /** Keep the latest draft and the last complete publication, never an unbounded revision history. */
  private async save(
    taskId: string,
    branch: string | undefined,
    update: (record: ChangePresentationRecord | undefined) => ChangePresentationRecord,
  ): Promise<void> {
    const previous = this.options.tasks.delivery.changePresentation(taskId, branch);
    this.options.tasks.delivery.updateChangePresentation(
      taskId,
      (record) => {
        const next = update(record);
        const newest = next.revisions.at(-1)?.revision;
        return {
          ...next,
          revisions: next.revisions.filter(
            (story) =>
              story.revision === newest ||
              story.revision ===
                (next.completion?.revision ??
                  next.published?.revision ??
                  next.publication?.revision),
          ),
        };
      },
      branch,
    );
    await this.cleanupMedia(taskId, previous?.revisions.flatMap((story) => story.assets) ?? []);
  }

  private async cleanupMedia(taskId: string, assets: PresentationAsset[]): Promise<void> {
    // Every change's story keeps its own files (INF-2490).
    const kept = new Set(
      storyLedgers(this.options.tasks.get(taskId)?.delivery).flatMap((ledger) =>
        ledger.revisions.flatMap((story) => story.assets.map((asset) => asset.file)),
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

  /** Called only on a host-accepted repair lineage, not an author's arbitrary new story. */
  async refreshConflictOnly(
    taskId: string,
    fromHead: string,
    toHead: string,
    forge: Forge,
    branch: string,
    title: string,
    attests?: (head: string) => boolean,
  ): Promise<void> {
    await this.serial(taskId, () =>
      this.republishLocked(taskId, toHead, forge, branch, title, {
        fromHead,
        remoteOnly: true,
        checks: "passed",
        ...(attests ? { attests } : {}),
      }),
    );
  }

  /**
   * A pull request that moved past its published story, read at the merge
   * (INF-2509): the story is republished at the pull request's version, its
   * words unchanged. The pushed branch is the version merged, wherever its
   * commits were made.
   */
  async republishMoved(
    taskId: string,
    change: ForgeChange,
    forge: Forge,
    attests?: (head: string) => boolean,
  ): Promise<void> {
    await this.serial(taskId, () =>
      this.republishLocked(taskId, change.headSha, forge, change.branch, change.title ?? "", {
        remoteOnly: true,
        checks: "passed",
        ...(attests ? { attests } : {}),
      }),
    );
  }

  /**
   * The revision a completion card shows (INF-2509, INF-1868's answer 5):
   * the one the author named, or, once the pull request moved past it, the
   * host's republication of it at the pushed version. The author vouches for
   * the story at the code they committed, so that code must be the pushed
   * version. Any other mismatch is left for the completion's own refusal.
   */
  async atPushedVersion(
    taskId: string,
    revision: number,
    change: ForgeChange,
    forge: Forge,
    attests?: (head: string) => boolean,
  ): Promise<number> {
    return this.serial(taskId, async () => {
      const record = this.ledger(taskId, change.branch);
      const published = record.published;
      const newest = record.revisions.at(-1);
      if (
        !published ||
        !newest ||
        !hostedPresentation(newest.destination) ||
        published.revision !== newest.revision ||
        (published.revision !== revision && published.refreshOf !== revision)
      )
        return revision;
      if (published.head === change.headSha) return published.revision;
      const committed = await this.options.head(taskId);
      if (committed !== change.headSha)
        throw new Error(
          `${pushFirst(committed, change.headSha)} Then show the completion card again with presentation ${revision}.`,
        );
      return (
        (await this.republishLocked(
          taskId,
          change.headSha,
          forge,
          change.branch,
          change.title ?? "",
          { remoteOnly: false, checks: "pending", ...(attests ? { attests } : {}) },
        )) ?? revision
      );
    });
  }

  /**
   * The published story again at `toHead`, its words and the content its
   * completion offer approved unchanged, as a new revision that names the
   * one its author published. Only the newest story is republished: a newer
   * revision the author prepared is theirs to publish, and nothing happens.
   * An accepted repair names where it starts, and refuses that newer
   * revision instead. Answers the revision now published, if any.
   */
  private async republishLocked(
    taskId: string,
    toHead: string,
    forge: Forge,
    branch: string,
    title: string,
    how: {
      fromHead?: string;
      remoteOnly: boolean;
      /** What an older story's description says of the checks: a merge runs after they passed. */
      checks: "pending" | "passed";
      attests?: (head: string) => boolean;
    },
  ): Promise<number | undefined> {
    const record = this.ledger(taskId, branch);
    const published = record.revisions.find(
      (story) => story.revision === record.published?.revision,
    );
    if (!published || !hostedPresentation(published.destination)) return undefined;
    if (published.head === toHead) return published.revision;
    if (how.fromHead !== undefined && published.head !== how.fromHead)
      throw new Error("The repair does not start from the published story.");
    const latest = record.revisions.at(-1) as ChangePresentation;
    const applicability =
      how.fromHead !== undefined
        ? `The accepted repair from ${how.fromHead} to ${toHead} leaves this view unchanged.`
        : "Captured on an earlier version of this pull request; the story's words did not change.";
    const refreshed = changePresentationSchema.parse({
      ...published,
      revision: published.revision + 1,
      head: toHead,
      views: published.views.map((view) => ({
        ...view,
        after: view.after.map((media) => ({
          ...media,
          applicability: media.applicability ?? applicability,
        })),
      })),
    });
    if (
      latest.revision !== published.revision &&
      JSON.stringify(latest) !== JSON.stringify(refreshed)
    ) {
      if (how.fromHead === undefined) return undefined;
      throw new Error(
        "A newer edited story needs its own completion offer; it is not a repair's refresh.",
      );
    }
    if (latest.revision === published.revision)
      await this.save(taskId, branch, (old) => ({
        ...this.required(old),
        revisions: [...this.required(old).revisions, refreshed],
      }));
    await this.publishLocked(
      taskId,
      refreshed.revision,
      forge,
      branch,
      published.version === 2 ? published.title : title,
      how.checks,
      undefined,
      how.remoteOnly,
      {
        contentHash: record.published?.contentHash ?? presentationContentHash(published),
        refreshOf: record.published?.refreshOf ?? published.revision,
      },
      undefined,
      how.attests ? { attests: how.attests } : undefined,
    );
    return refreshed.revision;
  }

  private current(taskId: string, branch: string, revision: number): ChangePresentation {
    const story = this.ledger(taskId, branch).revisions.at(-1);
    if (!story || story.revision !== revision)
      throw new Error("Use the newest prepared story revision.");
    return changePresentationSchema.parse(story);
  }
  /** The story ledger of the change on `branch`; undefined names the task's current change. */
  private ledger(taskId: string, branch: string | undefined): ChangePresentationRecord {
    return this.required(this.options.tasks.delivery.changePresentation(taskId, branch));
  }
  private required(record: ChangePresentationRecord | undefined): ChangePresentationRecord {
    if (!record) throw new Error("Prepare the change story before opening its pull request.");
    return record;
  }
  private nativeAssets(story: ChangePresentation): PresentationAsset[] {
    if (!nativePresentationMedia(story.destination)) return [];
    const ids = new Set(
      story.views.flatMap((view) => [...view.before, ...view.after].map((entry) => entry.asset)),
    );
    return story.assets.filter((asset) => ids.has(asset.id));
  }
  private receipt(
    story: ChangePresentation,
    branch: string,
    asset: PresentationAsset,
  ): PresentationReceipt | undefined {
    return this.ledger(story.taskId, branch).receipts.find((receipt) =>
      receiptMatches(story, asset, receipt),
    );
  }
  private keepReceipt(story: ChangePresentation, branch: string, next: PresentationReceipt): void {
    this.options.tasks.delivery.updateChangePresentation(
      story.taskId,
      (record) => ({
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
      }),
      branch,
    );
  }
  private async validateCurrent(
    story: ChangePresentation,
    forge: Forge,
    branch: string,
    remoteOnly = false,
  ): Promise<void> {
    await this.validatePrepared(story, forge, remoteOnly);
    if (!forge.branchHead || (await forge.branchHead(branch)) !== story.head)
      throw new Error(
        "The pushed code does not match this story. Push the reviewed version first.",
      );
  }
  private async validatePrepared(
    story: ChangePresentation,
    forge: Forge,
    remoteOnly: boolean,
  ): Promise<void> {
    if (!remoteOnly && (await this.options.head(story.taskId)) !== story.head)
      throw new Error("The code changed after this story was prepared.");
    if (!samePresentationDestination(story.destination, await storyDestination(forge)))
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

/**
 * The way to a refused completion card, said from the ledger's typed facts
 * (INF-961): a crewmate refused without these words took its story as lost
 * (INF-899). A published story follows a later push on its own (INF-2509);
 * a story its author prepared and never published does not.
 */
function completionWayOut(
  record: ChangePresentationRecord,
  newest: ChangePresentation,
  head: string,
): string {
  const published = record.published?.revision === newest.revision;
  // INF-2509: a published story follows its pull request's later versions on its own.
  if (published && record.published?.head !== head)
    return `Story revision ${newest.revision} was published at ${record.published?.head}, and the pushed branch is now at ${head}: show the completion card with presentation ${newest.revision}, and the app republishes it at the pushed version.`;
  if (newest.head !== head)
    return `Story revision ${newest.revision} was prepared at ${newest.head} and never published, and the pushed branch is now at ${head}. Prepare a new story revision at the pushed version with prepare_change, keeping its base and title, publish it with open_change, then show the completion card with the revision prepare_change returns as presentation.`;
  if (!published || record.publication?.state !== "confirmed")
    return `Story revision ${newest.revision} is prepared at the pushed version but not yet published and read back: publish it with open_change, then show the completion card with presentation ${newest.revision}.`;
  return `The newest story is revision ${newest.revision}: show the completion card with presentation ${newest.revision}.`;
}

/** The refusal when the committed code is ahead of the pushed branch. */
function pushFirst(committed: string, pushed: string): string {
  return `The current code changed before the completion card: the branch is at ${committed}, and the pushed branch at ${pushed}. Push it; the app republishes the published story at the pushed version.`;
}

/**
 * The revision a named one stands for now (INF-2509): itself while it is the
 * newest, or the host's republication of it at a later version.
 */
function shownRevision(record: ChangePresentationRecord, revision: number): number | undefined {
  const newest = record.revisions.at(-1);
  if (!newest) return undefined;
  if (newest.revision === revision) return revision;
  const published = record.published;
  return published?.revision === newest.revision && published.refreshOf === revision
    ? newest.revision
    : undefined;
}

function receiptMatches(
  story: ChangePresentation,
  asset: PresentationAsset,
  receipt: PresentationReceipt,
): boolean {
  return (
    hostedPresentation(story.destination) &&
    receipt.digest === asset.uploadSha256 &&
    receipt.mediaType === asset.mediaType &&
    sameAttachmentDestination(receipt.destination, story.destination)
  );
}
