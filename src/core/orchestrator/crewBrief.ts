import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttachmentRef } from "@shared/attachments";
import { alreadyAllowedWords } from "@shared/captainAllowances";
import { TURN_IMAGES_MAX, type TurnImage } from "@shared/cards";
import { inheritedOverrideWords } from "@shared/holds";
import type { Rigor } from "@shared/rigor";
import type { RunbookFacts } from "@shared/runbooks";
import type { EffectiveTaskPolicies } from "@shared/taskPolicies";
import { attachmentPath, loadImages } from "../attachments";
import { CONTRIBUTION_DELIVERY_WORDS } from "../forge";
import { renderBriefKnowledge, renderReferenceImport, savedKnowledge } from "../knowledge/context";
import type { KnowledgeService } from "../knowledge/knowledgeService";
import type { MessageFile } from "../overflow";
import { crewmateSourceCardsDir } from "../paths";
import { LOCAL_MACHINE_ID } from "../session/session";
import { currentReceipt } from "../storage/changeProjection";
import type { TaskRecord } from "../storage/taskRecords";
import { alreadyAllowed, inheritedOverride } from "../tasks/alreadyAllowed";
import { sha256OfFile } from "../tasks/handoverFiles";
import type { TaskService } from "../tasks/taskService";
import { checkedOutRefFor } from "../workspace/workspaceService";
import { linkedIssuesSection } from "./buildRows";
import type { CardService } from "./cardService";
import { otherCheckedOutBranch } from "./checkedOutHead";
import { type CrewmateProcedureFacts, crewmateProcedureFor } from "./crewSession";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import {
  type BasisBriefFacts,
  type BriefPart,
  type BriefPictures,
  basisSectionParts,
  type CodeElsewhere,
  FLEET_STARTED_CHANGE_WORDS,
  joinParts,
  renderAnswerShapeSection,
  renderBranchFromCarriedLine,
  renderBranchFromLine,
  renderBuiltOnLine,
  renderOperationShapeSection,
  renderPicturesSection,
  renderProgramPartSection,
  renderResultShapeSection,
  renderReviewedPlanSection,
  renderRigorSection,
  UNSAFE_DATA_READER_WORDS,
  withoutOriginReadLine,
} from "./intentBrief";
import { lostComputer, SourceOutOfReach } from "./lostStarts";
import { renderSideEffectSection } from "./sideEffectBrief";
import {
  basisFacts,
  branchFromSource,
  deliverableOf,
  sourceFacts,
  taskContributesUpstream,
} from "./workShape";

/**
 * The tasks whose messages' pictures and files a fresh crewmate's brief
 * carries, in order: the task itself, then the work its brief carries
 * forward - its basis, the task it was discovered or escalated from, the
 * attempt it replaces. `basis` is the shape's, so work routed before its
 * record is written (a review) reads the same sources.
 */
function briefSources(tasks: TaskService, taskId: string, basis: string | undefined): string[] {
  const resolved = basis ? tasks.resolve(basis) : undefined;
  return [
    taskId,
    ...(resolved ? [resolved.id] : []),
    ...tasks.graph.discoveredOrigins(taskId).map((origin) => origin.id),
    ...tasks.graph.replacedPredecessors(taskId).map((predecessor) => predecessor.id),
  ];
}

function briefPictureRefs(
  tasks: TaskService,
  sources: readonly string[],
  extra: readonly AttachmentRef[],
): AttachmentRef[] {
  const seen = new Set<string>();
  return [...sources.flatMap((id) => tasks.capture.pictures(id)), ...extra].filter((ref) => {
    if (seen.has(ref.sha256)) return false;
    seen.add(ref.sha256);
    return true;
  });
}

/**
 * Whether a fresh crewmate's first turn would carry the captain's pictures
 * (`CrewBrief.briefPictures`), from the same sources. Routing reads it as
 * the turn's need, so a model whose def takes text only is skipped with its
 * reason instead of taking the task and refusing them at its first prompt
 * (docs/routing.md, "Pictures"). A copy that is gone rides no turn, so it
 * asks for nothing.
 */
export function briefCarriesPictures(
  tasks: TaskService,
  taskId: string,
  shape: { basis?: string } | undefined,
  extra: readonly AttachmentRef[] = [],
): boolean {
  const sources = briefSources(tasks, taskId, shape?.basis);
  return briefPictureRefs(tasks, sources, extra).some((ref) => {
    try {
      return existsSync(attachmentPath(ref));
    } catch {
      return false;
    }
  });
}

/** What a brief reads of the supervisor beyond its options. */
export type CrewBriefHost = {
  /** The card stack, for a source's answer card and its thread. */
  readonly cards: CardService;
  /** Where a task's crewmate runs: the computer its record names, or this Mac. */
  machineOf(taskId: string): string;
  /** Delivers one file into a task's hand-over folder where it runs. */
  deliverHandover(
    taskId: string,
    path: string,
    name: string,
    sha256: string,
  ): Promise<{ file: string; path: string }>;
  /** This Mac's knowledge for a task, when the computer it runs on reads it. */
  knowledgeFor(taskId: string): KnowledgeService | undefined;
  backendOf(taskId: string): string | undefined;
  /** The notes section of a crewmate an automation's run started (docs/automation.md, "A rule's notes"). */
  ruleNotesSection?(taskId: string): Promise<string | undefined>;
};

/**
 * A crewmate's brief at dispatch: the captain's pictures, the rigor and
 * autonomy the host stamps, the answer, operation and hand-off sections, the
 * work it is built on, and the project's knowledge; and the runbook facts
 * its instructions are selected by.
 */
export class CrewBrief {
  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: CrewBriefHost,
  ) {}

  /**
   * The captain's pictures a fresh crewmate is briefed with
   * (`docs/task-capture.md`, "Pictures stay with the task"): those the
   * messages attached to this task keep copies of, then those of the work
   * its brief carries forward - its basis, the task it was discovered or
   * escalated from, the attempt it replaces - then `extra`, each picture
   * once. As many as one message may carry ride the first turn; every
   * copy is delivered to the task’s hand-over folder and named by its path there; a
   * copy that is gone is counted, never sent as words alone.
   */
  async briefPictures(
    taskId: string,
    extra: readonly AttachmentRef[],
    extraFiles: readonly MessageFile[],
  ): Promise<{ section: string; riding: AttachmentRef[]; images?: TurnImage[] }> {
    const tasks = this.options.tasks;
    const basis = tasks.get(taskId)?.shape?.basis;
    const sources = briefSources(tasks, taskId, basis);
    const refs = briefPictureRefs(tasks, sources, extra);
    const files = [...sources.flatMap((id) => tasks.capture.messageFiles(id)), ...extraFiles];
    const here = this.host.machineOf(taskId) === LOCAL_MACHINE_ID;
    const machines = this.options.machines;
    if (
      !here &&
      (refs.length || files.length) &&
      (!machines?.sourceFile || !machines.takesHandover?.(this.host.machineOf(taskId)))
    )
      throw new Error(
        "Update Infinitary on the work computer before it can receive this message’s attachments.",
      );
    const deliver = async (path: string, name: string, sha256: string) =>
      (await this.host.deliverHandover(taskId, path, name, sha256)).path;
    const facts: BriefPictures = { riding: [], more: [], missing: 0 };
    const riding: AttachmentRef[] = [];
    const images: TurnImage[] = [];
    for (const ref of refs) {
      let image: TurnImage | undefined;
      try {
        [image] = loadImages([ref]);
      } catch {
        facts.missing += 1;
        continue;
      }
      const named = {
        name: ref.name,
        path: await deliver(attachmentPath(ref), ref.name, ref.sha256),
      };
      if (image && riding.length < TURN_IMAGES_MAX) {
        riding.push(ref);
        images.push(image);
        facts.riding.push(named);
      } else {
        facts.more.push(named);
      }
    }
    return {
      section: [
        renderPicturesSection(facts),
        ...(await Promise.all(
          [...new Map(files.map((file) => [file.sha256, file])).values()].map(async (file) => {
            if ((await sha256OfFile(file.path)) !== file.sha256)
              throw new Error(`The attached file ${file.name} changed.`);
            return `Attached file ${file.name}: ${await deliver(file.path, file.name, file.sha256)} (the full copy in your hand-over folder).`;
          }),
        )),
      ]
        .filter(Boolean)
        .join("\n"),
      riding,
      ...(images.length > 0 ? { images } : {}),
    };
  }

  /**
   * The single brief mint: the captain's pictures section (`briefPictures`),
   * the rigor section the host derived for this
   * dispatch (delivery rigor phase 2), the answer-shape section for a task
   * whose deliverable is an answer (captain lock 2 of 2026-09-19, the
   * visual-density audit; the deliverable is a stamped fact since Task B),
   * the basis section for a change grounded in a verified answer (Task B,
   * F3 A), then the project's knowledge lines. Runs at
   * dispatch, after the classifier - the kind is never sorted on any of
   * these lines - so a queued row is told the shape and rigor of the moment
   * it starts. It answers in pieces, each report it copied marked as its
   * event, for the receipt (`TaskService.recordBrief`).
   */
  async mintBrief(
    taskId: string,
    brief: string,
    repoId: string | null,
    pictures = "",
    // Whether this start's working copy begins at its branch_from source,
    // the base the start chose: an approved base or a review's version wins.
    fromSource = false,
  ): Promise<BriefPart[]> {
    const sections: BriefPart[][] = [];
    // The captain's pictures sit right under the captain's words.
    if (pictures) sections.push([pictures]);
    const rigor = this.deriveRigor(taskId);
    if (rigor) sections.push([renderRigorSection(rigor)]);
    this.stampAutonomy(taskId, repoId);
    const record = this.options.tasks.get(taskId);
    const policies = this.options.tasks.policiesOf(record);
    if (policies)
      sections.push([
        `Current task policies: ${JSON.stringify(policies)}. Read current policies before pushing or merging; later policy notices supersede this brief, not the scope.`,
      ]);
    // What the captain already allowed when work (re)starts: the override
    // standing on the task (INF-1216) and each yes the app recorded on it or
    // on the work it does again (INF-3170 piece 2). A reviewer reads the
    // builder's list in its own brief.
    const allowed =
      record && record.shape?.kind !== "review"
        ? alreadyAllowedWords(alreadyAllowed(this.options.tasks, record), "crewmate")
        : "";
    if (allowed) sections.push([allowed]);
    // An override on a task this one is part of shows as a labeled fact,
    // never as this task's ask (INF-1939 friction 5).
    const inherited =
      record && record.shape?.kind !== "review"
        ? inheritedOverride(this.options.tasks, record)
        : undefined;
    if (inherited) sections.push([inheritedOverrideWords(inherited.override, inherited.from)]);
    const deliverable = deliverableOf(record);
    let base = brief;
    // Whatever the brief was rendered from: a crewmate's follow-up has no
    // intent, and its tools follow the deliverable all the same (FI3-598).
    if (deliverable === "answer") {
      sections.push([
        renderAnswerShapeSection(record?.shape?.internal_step === true, record?.shape?.kind),
      ]);
    }
    if (record?.shape?.unsafe_data_reader) {
      sections.push([UNSAFE_DATA_READER_WORDS]);
      const linked = linkedIssuesSection(this.options.tasks, record);
      if (linked) sections.push([linked]);
    }
    if (deliverable === "operation") sections.push([renderOperationShapeSection()]);
    // The waits' closes are read now, at the start they cleared for.
    if (record?.shape?.side_effect)
      sections.push([renderSideEffectSection(this.options.tasks.graph.blockers(taskId))]);
    // A typed hand-off (INF-799): the result shape the report must fit, and
    // the task whose last commit the working copy began at.
    if (record?.shape?.result_schema)
      sections.push([renderResultShapeSection(record.shape.result_schema)]);
    const program =
      record?.shape?.program_part && record.parentId
        ? this.options.tasks.get(record.parentId)
        : undefined;
    if (program)
      sections.push([
        renderProgramPartSection({ key: program.key || program.id, title: program.title }),
      ]);
    const branchFrom =
      fromSource && record?.shape?.branch_from
        ? branchFromSource(this.options.tasks, record.shape.branch_from, record.repoId, record.id)
        : undefined;
    if (branchFrom && !("refused" in branchFrom)) {
      const source = {
        key: branchFrom.task.key || branchFrom.task.id,
        title: branchFrom.task.title,
        ref: branchFrom.ref,
      };
      // On a computer that runs work, the work kept here crosses first,
      // as a replacement's saved work does (INF-5142 part 5).
      const machine = this.host.machineOf(taskId);
      const machines = this.options.machines;
      if (machine === LOCAL_MACHINE_ID) sections.push([renderBranchFromLine(source)]);
      else {
        if (!machines?.sourceRef)
          throw new Error("Update Infinitary on the work computer to carry starting work.");
        const carried = await machines.sourceRef(
          machine,
          taskId,
          record?.repoId ?? null,
          branchFrom.task.id,
          branchFrom.ref,
        );
        sections.push([renderBranchFromCarriedLine({ ...source, carried })]);
      }
    }
    const builtOn = record?.shape?.built_on;
    if (builtOn) {
      const base = this.options.tasks.resolve(builtOn.task);
      sections.push([
        renderBuiltOnLine({
          key: builtOn.task,
          title: base?.title ?? builtOn.task,
          branch: builtOn.branch,
          head: builtOn.head,
        }),
      ]);
    }
    if (deliverable === "change" && record?.shape?.internal_step)
      sections.push([FLEET_STARTED_CHANGE_WORDS]);
    if (deliverable === "change") {
      if (record?.delivery?.publicationOrigin && record.branch)
        sections.push([
          "This task's branch has its own saved Git remote. Use git fetch and git push without a remote argument. Its branch.<branch>.remote setting names the saved remote; use that remote's default-branch tracking ref when bringing this branch up to date. Origin belongs to the project folder and may change.",
        ]);
      if (
        taskContributesUpstream(
          record,
          record?.repoId ? this.options.repos.get(record.repoId) : undefined,
        )
      ) {
        sections.push([CONTRIBUTION_DELIVERY_WORDS]);
      }
      const basis = basisFacts(this.options, this.host.cards, record);
      if (basis)
        sections.push(
          basisSectionParts(
            await this.withCardFile(taskId, basis),
            "basis",
            record?.shape?.kind !== "review",
          ),
        );
      // A review's basis is the builder it reads; the task that builder is
      // built on, such as its plan, may settle a finding (INF-6608).
      const reviewed =
        basis && record?.shape?.kind === "review"
          ? this.options.tasks.get(basis.taskId ?? "")
          : undefined;
      const plan = basisFacts(this.options, this.host.cards, reviewed);
      if (reviewed && plan)
        sections.push([
          renderReviewedPlanSection(
            reviewed.key || reviewed.id,
            await this.withCardFile(taskId, plan, "context"),
          ),
        ]);
      // A filing's discovered-from links are truthful provenance, not an
      // inferred accepted basis or a routing discount. Preserve same-session
      // direct builds/prototypes that legitimately have no external source.
      for (const origin of this.options.tasks.graph.discoveredOrigins(taskId)) {
        if (origin.id === taskId) continue;
        if (origin.id === this.options.tasks.resolve(record?.shape?.basis ?? "")?.id) {
          if (basis) base = withoutOriginReadLine(base, origin.key);
          continue;
        }
        const facts = await this.withCardFile(
          taskId,
          sourceFacts(this.options, this.host.cards, origin),
          "context",
        );
        sections.push(basisSectionParts(facts, "origin"));
        // Its findings are in the brief now, so its filing's line telling
        // it to go and read them goes: the origin reaches it once.
        base = withoutOriginReadLine(base, origin.key);
      }
    }
    // Dropped work can have saved edits without ever reporting. Its replacement
    // carries that work independently of basisHolds and of the deliverable.
    for (const predecessor of this.options.tasks.graph.replacedPredecessors(taskId)) {
      if (predecessor.id === taskId) continue;
      sections.push(
        basisSectionParts(
          await this.withCardFile(taskId, sourceFacts(this.options, this.host.cards, predecessor)),
          "replacement",
        ),
      );
    }
    // A rule's notes, handed as a file to the crewmate its run started.
    const notes = await this.host.ruleNotesSection?.(taskId);
    if (notes) sections.push([notes]);
    const knowledge = this.host.knowledgeFor(taskId);
    if (knowledge) {
      // Only how much is saved, never a saved word (docs/knowledge.md,
      // "Knowledge as needed"): the crewmate searches when its work needs it.
      const line = renderBriefKnowledge(savedKnowledge(knowledge));
      if (line) sections.push([line]);
      sections.push([renderReferenceImport()]);
    }
    return joinParts([[base], ...sections], "\n\n");
  }

  /**
   * The source tasks whose live work on another computer this task's brief
   * reads (`withCardFile`): a change's basis and each task it replaces. A
   * start that lost such a source's computer waits for it only while it is
   * still one of these (INF-5142 part 4).
   */
  liveSources(taskId: string): TaskRecord[] {
    const record = this.options.tasks.get(taskId);
    if (!record) return [];
    const ref = deliverableOf(record) === "change" ? record.shape?.basis : undefined;
    const basis =
      ref && this.options.tasks.graph.basisHolds(ref) ? this.options.tasks.resolve(ref) : undefined;
    return [
      ...(basis ? [basis] : []),
      ...this.options.tasks.graph.replacedPredecessors(taskId),
    ].filter((source) => source.id !== taskId && this.readsLiveWork(record, source));
  }

  private readsLiveWork(record: TaskRecord | undefined, source: TaskRecord): boolean {
    return Boolean(
      source.deviceId &&
        source.workspaceState === "present" &&
        source.branch &&
        deliverableOf(source) === "change" &&
        (source.repoId ?? null) === (record?.repoId ?? null),
    );
  }

  /**
   * Hand a source's card over as a file (FI3-700): the body is saved whole
   * - script, style and every picture path included, never cut (97c93aa4) -
   * under the new task's own folder, and the brief names that file instead
   * of pasting the HTML. The choice, answers and thread stay in the brief as
   * words. A card that cannot be saved rides in the brief whole, as before.
   */
  private async withCardFile(
    taskId: string,
    facts: BasisBriefFacts,
    handoff: "work" | "context" = "work",
  ): Promise<BasisBriefFacts> {
    // A finding carries its reports and card, not the origin's implementation.
    // Strip local refs too: provenance must never invite recovery of unrelated code.
    if (handoff === "context") {
      const { branch: _branch, keptRef: _keptRef, startingRef: _startingRef, ...context } = facts;
      facts = context;
    }
    const machine = this.host.machineOf(taskId);
    const machines = this.options.machines;
    const source = facts.taskId ? this.options.tasks.get(facts.taskId) : undefined;
    // A change in another repository starts this task from its own code
    // (INF-5003): no code crosses repositories, so its branch, saved work
    // and starting point go as a finding's do, and one line names where
    // that code lives instead.
    const elsewhere =
      handoff === "work" &&
      source !== undefined &&
      deliverableOf(source) === "change" &&
      (source.repoId ?? null) !== (this.options.tasks.get(taskId)?.repoId ?? null);
    if (elsewhere) {
      const { branch: _branch, keptRef: _keptRef, startingRef: _startingRef, ...context } = facts;
      facts = { ...context, elsewhere: this.codeElsewhere(source) };
    }
    // A live remote source is authoritative there, never the home's stale copy.
    if (
      handoff === "work" &&
      source?.deviceId &&
      this.readsLiveWork(this.options.tasks.get(taskId), source)
    ) {
      if (!machines) throw new Error("The source computer cannot be reached.");
      // A loss there names that computer, so the start waits for it (INF-5142).
      const outOfReach = (caught: unknown): never => {
        if (!lostComputer(caught)) throw caught;
        throw new SourceOutOfReach(
          `${machines.nameOf(source.deviceId as string)} went before ${source.key || source.id}'s work arrived.`,
          { deviceId: source.deviceId as string, sourceId: source.id, cause: caught },
        );
      };
      // Another branch its crewmate committed on there comes home to the
      // source's own ref for it (INF-2490), never the task's branch it left.
      const other = await otherCheckedOutBranch({ machines }, source).catch(outOfReach);
      await machines.bringBranchHome(source.id, true, other).catch(outOfReach);
      facts = other
        ? { ...facts, startingRef: checkedOutRefFor(source.id) }
        : { ...facts, branch: source.branch };
    } else if (handoff === "work" && facts.branch && source && !source.deviceId) {
      // Worktrees share refs: another branch its crewmate committed on here is named as it is.
      const other = await otherCheckedOutBranch({ machines }, source);
      if (other) facts = { ...facts, branch: other };
    }
    if (machine !== LOCAL_MACHINE_ID) {
      if (!machines?.sourceFile || !machines.sourceRef)
        throw new Error(
          "Update Infinitary on the work computer to carry source files and starting work.",
        );
      const { branch, keptRef, startingRef: home, ...rest } = facts;
      facts = rest;
      const startingRef = home ?? branch ?? keptRef;
      if (startingRef) {
        facts.startingRef = await machines.sourceRef(
          machine,
          taskId,
          source?.repoId ?? null,
          source?.id ?? facts.key,
          startingRef,
        );
      }
      const replacements = new Map<string, string>();
      for (const [index, file] of [
        ...(facts.pictures ?? []),
        ...(facts.recordings ?? []),
      ].entries()) {
        const extension = file.split(".").at(-1) ?? "bin";
        replacements.set(
          file,
          await machines.sourceFile(
            machine,
            taskId,
            `${facts.taskId ?? facts.key}-media-${index}.${extension}`,
            file,
          ),
        );
      }
      let body = facts.card;
      for (const [before, after] of replacements) body = body?.replaceAll(before, after);
      facts = {
        ...facts,
        ...(body ? { card: body } : {}),
        pictures: facts.pictures?.map((file) => replacements.get(file) ?? file),
        recordings: facts.recordings?.map((file) => replacements.get(file) ?? file),
      };
    }
    const { card, ...rest } = facts;
    if (!card) return facts;
    const dir = crewmateSourceCardsDir(this.options.paths, taskId);
    const file = join(dir, `${facts.key.replace(/[^A-Za-z0-9_-]/g, "-")}.html`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, card, "utf8");
    } catch {
      return facts;
    }
    if (machine === LOCAL_MACHINE_ID) return { ...rest, cardFile: file };
    if (!machines?.sourceFile)
      throw new Error("The source card cannot be copied to that computer.");
    const remoteFile = await machines.sourceFile(
      machine,
      taskId,
      `${facts.key.replace(/[^A-Za-z0-9_-]/g, "-")}.html`,
      file,
    );
    return { ...rest, cardFile: remoteFile };
  }

  private codeElsewhere(source: TaskRecord): CodeElsewhere {
    const delivery = source.delivery;
    const label = delivery?.changeLabel;
    return {
      repository: (source.repoId ? this.options.repos.get(source.repoId)?.name : undefined) ?? null,
      ...(label
        ? {
            change: {
              kind: delivery?.prNumber !== undefined ? "pull request" : "branch",
              label,
              ...(delivery?.prUrl ? { url: delivery.prUrl } : {}),
            },
          }
        : {}),
      // A merge that closed its task leaves `ci` alone; the receipt reads every merge fact.
      ...(currentReceipt(source)?.outcome === "merged" ? { merged: true } : {}),
    };
  }

  /**
   * The rigor a dispatch ships at (delivery rigor phase 2; derivation
   * revised by the captain 2026-09-19), derived by the host from facts it
   * holds - the posture, the captain's words on care, and the repository's
   * own standing rigor (`repos.rigor`, the column set by talking since
   * phase 3; null = derive) - and stamped on the shape so the record and a
   * re-dispatch carry it. Neither the intelligence tier nor an escalation
   * moves it: rejecting a result routes a stronger model, never more
   * ceremony. A shape that already names one keeps it: a pre-phase-2 row
   * reads as the quick work it was.
   *
   * Rigor exists only where a CHANGE lands through a gate. A task whose
   * deliverable is an answer ships nothing at all (Task B), a review task
   * reads a change rather than shipping one, and a task on the personal
   * workspace builds in place - there is no branch to review and no pull
   * request to hold - so none of those is gated and none takes a tier.
   */
  deriveRigor(taskId: string): Rigor | undefined {
    const record = this.options.tasks.get(taskId);
    if (record?.kind !== "work") return undefined;
    const shape = record.shape;
    const decision = { rigor: this.options.tasks.policiesOf(record)?.rigor.value };
    if (!decision.rigor) return undefined;
    if (shape?.rigor) return decision.rigor;
    // A quiet write, like the kind stamp (S3): the rigor explains what the
    // crewmate was told, it is not a state change, and the facts it was
    // derived from - posture, ask, repo rigor - are all on the record.
    this.options.tasks.placement.recordShape(taskId, { rigor: decision.rigor }, record.difficulty);
    return decision.rigor;
  }

  /**
   * The autonomy a dispatch was commissioned under, stamped on the shape
   * beside the rigor (captain ruling 2026-09-20: autonomy is a repository
   * default with a per-task ask). A quiet write like the rigor stamp - it
   * records what the task started under and changes nothing. It is NOT
   * what a merge attempt reads: `taskAutonomy` derives the effective value
   * live, so the captain turning a repository autonomous reaches the work
   * already in flight.
   */
  private stampAutonomy(taskId: string, repoId: string | null): void {
    const record = this.options.tasks.get(taskId);
    if (record?.kind !== "work") return;
    const shape = record.shape;
    const repo = repoId ? this.options.repos.get(repoId) : undefined;
    // A review ships nothing, the personal workspace builds in place, and
    // an answer task commits nothing (Task B) - none of the three has a
    // merge for anyone to be autonomous about. The same exemptions rigor
    // takes, for the same reason, and the reason the deliverable speaks
    // before this hold does.
    if (
      shape?.kind === "review" ||
      repo?.kind === "personal" ||
      shape?.in_place !== undefined ||
      deliverableOf(record) !== "change"
    ) {
      return;
    }
    if (shape?.autonomy !== undefined) return;
    const autonomy = this.options.tasks.policiesOf(record)?.autonomy.value ?? false;
    this.options.tasks.placement.recordShape(taskId, { autonomy }, record.difficulty);
  }

  /**
   * The closed facts the runbook selectors read for a task (docs/runbooks.md,
   * "Typed crew reach"): its kind, place, delivery, care, backend and project.
   */
  runbookFacts(taskId: string, procedure: CrewmateProcedureFacts, backend: string): RunbookFacts {
    const record = this.options.tasks.get(taskId);
    const repo = record?.repoId ? this.options.repos.get(record.repoId) : undefined;
    return {
      kind: record?.shape?.kind ?? "unclear",
      place: repo?.kind === "personal" ? "personal" : "project",
      delivery: procedure.delivery,
      care: procedure.rigor,
      backend,
      ...(record?.repoId ? { project: record.repoId } : {}),
    };
  }

  /**
   * The runbook sections the changed policies select that the earlier ones
   * did not (INF-1868, piece 5): a crewmate's instructions were served at
   * its dispatch, so the policy notice carries what the change adds, such
   * as what Careful asks when care rises to it. An unknown backend reads
   * the sections no backend selector restricts.
   */
  addedGuidance(
    taskId: string,
    before: EffectiveTaskPolicies | null | undefined,
    policies: EffectiveTaskPolicies,
  ): string[] {
    if (!this.options.runbooks) return [];
    const backend = this.host.backendOf(taskId) ?? "";
    const now = this.options.runbooks.crewSections(
      this.runbookFacts(taskId, crewmateProcedureFor(policies), backend),
    );
    const earlier = new Set(
      before
        ? this.options.runbooks.crewSections(
            this.runbookFacts(taskId, crewmateProcedureFor(before), backend),
          )
        : now,
    );
    return now.filter((section) => !earlier.has(section));
  }

  /**
   * Adds the host wakes the guidance a policy notice carries asks for to what
   * the conversation was told (`servedWakes`, docs/forge.md, "Comments on a
   * pull request"): only those the new policies select and the earlier ones
   * did not, as `addedGuidance` works out its sections; its earlier guidance
   * stays with it, so none is taken away.
   */
  noteAddedWakes(
    taskId: string,
    before: EffectiveTaskPolicies | null | undefined,
    policies: EffectiveTaskPolicies,
  ): void {
    if (!this.options.runbooks || !before) return;
    const backend = this.host.backendOf(taskId) ?? "";
    const wakesFor = (chosen: EffectiveTaskPolicies) =>
      this.options.runbooks?.crew(this.runbookFacts(taskId, crewmateProcedureFor(chosen), backend))
        .wakes ?? [];
    const earlier = new Set(wakesFor(before));
    const added = wakesFor(policies).filter((wake) => !earlier.has(wake));
    const told = this.options.tasks.get(taskId)?.delivery?.servedWakes ?? [];
    const servedWakes = [...new Set([...told, ...added])];
    if (servedWakes.length > told.length)
      this.options.tasks.delivery.recordChangeEvidence(taskId, { servedWakes });
  }
}
