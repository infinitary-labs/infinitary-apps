import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  CARD_MEDIA_PIECE_BYTES,
  cardSoundNames,
  cardTypefaceNames,
  parseCardMediaFileName,
  parseCardTypefaceFileName,
} from "@shared/cardPictures";
import { wireRepairImpact } from "@shared/checkRepair";
import { changesStoryAround, keepsCardTypefaces } from "@shared/contractFeatures";
import { HOME } from "@shared/deviceNames";
import type { WorkInvokeChannel } from "@shared/ipc";
import {
  PLACED_COPY_CHUNK_BYTES,
  placedCardAnswerSchema,
  placedSecretsSchema,
  workRequests,
} from "@shared/work";
import { contractChange, listsChange } from "../connection/contractChanges";
import { filesAskedOfHome, type TaskFiles } from "../files/taskFiles";
import { PLACED_RELEASE_FILE_REFUSAL } from "../forge";
import type { TaskIntegrations } from "../integrations";
import type { MediaProbe, TypefaceProbe } from "../pi/cardImages";
import { verifyKeptValidationEvidenceSync } from "../pi/validationEvidence";
import type { SecretsCatalog } from "../secrets/requests";
import { CardRefusedError, type CrewmateToolDelegate } from "../session/tools";
import { HANDOVER_OUT_DIR_NAME } from "../tasks/handoverFiles";
import type { TaskQueryRow } from "../tasks/taskQuery";
import { integrationsAskedOfHome } from "./integrationsThere";
import {
  carryStory,
  type PlacedMedia,
  sendCardData,
  sendCardSounds,
  sendPictures,
} from "./placedStoryMedia";
import type { PlacedTasks } from "./placedTasks";

/**
 * What a crewmate's tools and commands ask of its home from a computer that
 * runs work (docs/helper.md, "Holding a conversation"): the callbacks its
 * tools run on, and the files, integrations and secrets its commands reach.
 * `SessionHost` gives each task's conversation these, asking through its own
 * requests for that task, so each still waits for every event written before
 * it and keeps its callback's one deadline.
 */

/** A task's requests of its home, which `SessionHost` makes for it. */
export type TaskAsks = {
  readonly task: string;
  /** One work request, after prior events reach the home, within its callback's deadline. */
  call: (channel: WorkInvokeChannel, fields: object, signal?: AbortSignal) => Promise<unknown>;
  /** One deadline spanning every request of a callback; the tool's own cancellation ends them too. */
  withDeadline: <T>(
    channel: WorkInvokeChannel,
    run: (signal: AbortSignal) => Promise<T>,
    toolSignal?: AbortSignal,
  ) => Promise<T>;
  log: (line: string) => void;
};

/** What this computer lends a task's tools here (`SessionHostOptions`, where each is described). */
export type ToolCallbackOptions = {
  tasks: PlacedTasks;
  protectedPlaces?: readonly string[];
  probeMedia?: MediaProbe;
  probeTypeface?: TypefaceProbe;
  homeVersion?: () => string | null;
  homeChanges?: () => readonly string[] | null;
};

const toolTextSchema = workRequests["inf:work:close-card"].response;
const tasksAnswerSchema = workRequests["inf:work:tasks"].response;

/**
 * The callbacks a crewmate's tools run on here: each asks the home, after
 * every event the conversation wrote before it, so the home hears them in
 * the order they happened.
 */
export function toolCallbacks(
  asks: TaskAsks,
  folders: ReturnType<PlacedTasks["folders"]>,
  options: ToolCallbackOptions,
): CrewmateToolDelegate {
  const text = async (channel: WorkInvokeChannel, fields: object, signal?: AbortSignal) =>
    toolTextSchema.parse(await asks.call(channel, { callId: randomUUID(), ...fields }, signal))
      .text;
  const ask = (channel: WorkInvokeChannel, fields: object, toolSignal?: AbortSignal) =>
    asks.withDeadline(channel, (deadline) => text(channel, fields, deadline), toolSignal);
  const media: PlacedMedia = {
    task: asks.task,
    tasks: options.tasks,
    call: (channel, fields, signal) =>
      asks.call(channel, { callId: randomUUID(), ...fields }, signal),
  };
  return {
    taskId: asks.task,
    cwd: folders.work,
    picturesDir: folders.cards,
    ...(options.protectedPlaces ? { protectedPlaces: options.protectedPlaces } : {}),
    cardBodiesDir: folders.cardBodies,
    evidenceDir: folders.evidence,
    // Reported files are kept in the temporary folder, which goes when the task closes.
    handoverDir: join(folders.temp, HANDOVER_OUT_DIR_NAME),
    ...(options.probeMedia ? { probeMedia: options.probeMedia } : {}),
    ...(options.probeTypeface ? { probeTypeface: options.probeTypeface } : {}),
    contributionNotes: true,
    onCard: (card, toolSignal) =>
      asks.withDeadline(
        "inf:work:card",
        async (signal) => {
          // A card whose preview names a project font of this task's own goes
          // only to a home that keeps one: an older home is told nothing, not
          // even the card's pictures.
          const typefaces = cardTypefaceNames(card.body).flatMap((name) => {
            const typeface = parseCardTypefaceFileName(name);
            return typeface?.taskId === asks.task ? [typeface] : [];
          });
          // Work admission requires this major, whose home compares copied
          // story facts with the saved revision before answering the tool.
          const home = options.homeVersion?.() ?? null;
          if (typefaces.length > 0 && home !== null && !keepsCardTypefaces(home)) {
            throw new Error(
              `Card font refused: ${HOME.the} runs an older Infinitary that cannot show a project's fonts; draw the preview in the app's own typefaces until it is updated.`,
            );
          }
          // A card with a sound clip of this task's own goes only to a home that
          // keeps one (`card-sound-clips.md`): an older home is told nothing.
          const sounds = cardSoundNames(card.body).filter(
            (name) => parseCardMediaFileName(name)?.taskId === asks.task,
          );
          if (
            sounds.length > 0 &&
            !listsChange(options.homeChanges?.() ?? null, contractChange("card-sound-clips"))
          ) {
            throw new Error(
              `Card sound refused: ${HOME.the} runs an older Infinitary that cannot play a card's sound clips; say it in words until it is updated.`,
            );
          }
          await sendCardSounds(media, card.body, signal);
          // Work admission requires this major, whose home shows a merge
          // card's summary, keeps a card's files and put-off choices, loads
          // the app's own parts by reference and hands a card its data files.
          // Each data file its script reads goes first.
          await sendCardData(media, card.body, signal);
          // Each picture's bytes first, so the home holds them when it shows the card.
          await sendPictures(media, card.pictures ?? [], signal);
          // Each project font its preview names, before the card too.
          for (const typeface of typefaces) {
            await asks.call(
              "inf:work:typeface",
              {
                callId: randomUUID(),
                id: typeface.id,
                extension: typeface.kind,
                data: options.tasks.typeface(asks.task, typeface.fileName).toString("base64"),
              },
              signal,
            );
          }
          const answer = placedCardAnswerSchema.parse(
            await asks.call("inf:work:card", { callId: randomUUID(), card }, signal),
          );
          if ("refused" in answer)
            throw new CardRefusedError(
              answer.refused.message,
              answer.refused.reason,
              answer.refused.why,
            );
          return answer.mutation ?? answer.cardId;
        },
        toolSignal,
      ),
    onCardRefused: (refusal) => {
      // A refusal record is not the card's request, so the card's cancellation does not reach it.
      void asks
        .call("inf:work:card-refused", { callId: randomUUID(), refusal })
        .catch((error: unknown) =>
          asks.log(`a refused card was not recorded: ${messageOf(error)}`),
        );
    },
    onCloseCard: (input, signal) => ask("inf:work:close-card", input, signal),
    onFollowup: (input, signal) => ask("inf:work:followup", { input }, signal),
    onStartProgram: (input, signal) => ask("inf:work:start-program", { input }, signal),
    onProgress: (note, plan, signal) =>
      ask("inf:work:progress", { text: note, ...(plan !== undefined ? { plan } : {}) }, signal),
    onReport: (report, summary, declared, toolSignal) =>
      asks.withDeadline(
        "inf:work:report",
        async (signal) => {
          if (declared?.validation?.kind === "run") {
            verifyKeptValidationEvidenceSync(
              declared.validation.evidence,
              folders.cards,
              asks.task,
            );
            for (const proof of declared.validation.evidence) {
              for (const file of [proof.file, ...(proof.posterFile ? [proof.posterFile] : [])]) {
                if (file.includes("/") || !file.startsWith(`${asks.task}-`))
                  throw new Error("That proof is not this task's.");
                const dot = file.lastIndexOf(".");
                const data = readFileSync(join(folders.cards, file));
                for (let offset = 0; offset < data.length; offset += CARD_MEDIA_PIECE_BYTES) {
                  await asks.call(
                    "inf:work:media",
                    {
                      callId: randomUUID(),
                      id: file.slice(0, dot),
                      extension: file.slice(dot + 1),
                      offset,
                      size: data.length,
                      data: data
                        .subarray(offset, offset + CARD_MEDIA_PIECE_BYTES)
                        .toString("base64"),
                    },
                    signal,
                  );
                }
              }
            }
          }
          // Each handed file goes home whole, a piece at a time, before the
          // report that names it; its content is never logged here.
          if (declared?.files && declared.files.length > 0) {
            const piece = Buffer.alloc(PLACED_COPY_CHUNK_BYTES);
            for (const handed of declared.files) {
              const fd = openSync(join(folders.temp, HANDOVER_OUT_DIR_NAME, handed.file), "r");
              try {
                for (let offset = 0; offset < handed.size; ) {
                  const read = readSync(fd, piece, 0, piece.length, offset);
                  if (!read) throw new Error("A handed file changed before it was sent.");
                  await asks.call(
                    "inf:work:handover-file",
                    {
                      callId: randomUUID(),
                      file: handed.file,
                      size: handed.size,
                      sha256: handed.sha256,
                      offset,
                      data: piece.subarray(0, read).toString("base64"),
                    },
                    signal,
                  );
                  offset += read;
                }
              } finally {
                closeSync(fd);
              }
            }
          }
          return text(
            "inf:work:report",
            {
              text: report,
              ...(summary !== undefined ? { summary } : {}),
              ...(declared !== undefined ? { declared } : {}),
            },
            signal,
          );
        },
        toolSignal,
      ),
    // The connection admits work only on this home's major. Every callback
    // below is part of that contract, not a second per-feature permission.
    onReply: (input, signal) => ask("inf:work:reply", input, signal),
    onReviseRequiredAction: (input, signal) =>
      ask("inf:work:revise-required-action", { input }, signal),
    onReadCard: (cardId, signal) => ask("inf:work:read-card", { cardId }, signal),
    onQueryTasks: (input, toolSignal) =>
      asks.withDeadline(
        "inf:work:tasks",
        async (signal) => {
          const answer = tasksAnswerSchema.parse(
            await asks.call("inf:work:tasks", { callId: randomUUID(), input }, signal),
          );
          return {
            rows: answer.rows as TaskQueryRow[],
            total: answer.total,
            ...(answer.projects ? { projects: answer.projects } : {}),
            ...(answer.order ? { order: answer.order } : {}),
          };
        },
        toolSignal,
      ),
    onReadWorkflow: (input, signal) => ask("inf:work:read-workflow", { input }, signal),
    onGithubRead: (input, signal) => ask("inf:work:github-read", { input }, signal),
    onGithubWrite: (input, signal) => {
      if (input.file !== undefined) return Promise.resolve(PLACED_RELEASE_FILE_REFUSAL);
      return ask("inf:work:github-write", { input }, signal);
    },
    // The home opens, checks and merges with its own sign-in, once it has
    // brought the branch home; an artifact is written here before it answers.
    onPrepareChange: (story, toolSignal) =>
      asks.withDeadline(
        "inf:work:prepare-change",
        (signal) =>
          carryStory(media, story, signal, () =>
            text("inf:work:prepare-change", { input: story }, signal),
          ),
        toolSignal,
      ),
    // show_merge_card walks the steps at the home, which work admission
    // puts on this major; the story's pictures travel first.
    onShowMergeCard: (input, toolSignal) =>
      asks.withDeadline(
        "inf:work:show-merge-card",
        (signal) =>
          carryStory(media, input.story, signal, () =>
            text("inf:work:show-merge-card", { input }, signal),
          ),
        toolSignal,
      ),
    onOpenChange: async (input, signal) => {
      // An older home would drop around and answer as if nothing was asked.
      const home = options.homeVersion?.() ?? null;
      if (input.around && home !== null && !changesStoryAround(home))
        throw new Error(
          `around refused: ${HOME.the} runs an older Infinitary that cannot change the words around a story; nothing was sent. Report it until ${HOME.the} is updated.`,
        );
      return ask("inf:work:open-change", { input }, signal);
    },
    onCheckChange: (input, signal) => {
      const repair = input?.conflictRepair;
      const wire = repair
        ? { ...input, conflictRepair: { ...repair, impact: wireRepairImpact(repair.impact) } }
        : input;
      return ask("inf:work:check-change", { input: wire ?? {} }, signal);
    },
    onDownloadArtifact: (input, signal) => ask("inf:work:download-artifact", { input }, signal),
    // The home's knowledge, read and written there as for a crewmate of its own.
    knowledge: {
      read: (input, signal) => ask("inf:work:knowledge", { input }, signal),
      record: (input, signal) => ask("inf:work:record-knowledge", { input }, signal),
    },
  };
}

/**
 * The files command here (docs/files.md): each list and copy asked of the
 * home, which reads the file on the computer it is on and delivers the
 * copy into this task's hand-over folder here.
 */
export function filesCommand(asks: TaskAsks): TaskFiles {
  const ask = (
    channel: "inf:work:files" | "inf:work:copy-file",
    input: object,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    asks.withDeadline(
      channel,
      (deadline) => asks.call(channel, { callId: randomUUID(), input }, deadline),
      signal,
    );
  return filesAskedOfHome({
    read: (input, signal) => ask("inf:work:files", input, signal),
    copy: (target, signal) => ask("inf:work:copy-file", { target }, signal),
  });
}

/** The integrations command here: each list, show and call asked of the home within its deadline. */
export function integrationsCommand(asks: TaskAsks): TaskIntegrations {
  return integrationsAskedOfHome((channel, input, signal) =>
    asks.withDeadline(
      channel,
      (deadline) => asks.call(channel, { callId: randomUUID(), input }, deadline),
      signal,
    ),
  );
}

/**
 * The secrets a task's command lists here (docs/secrets.md, "Current
 * command seam"): each list is asked of the home, which answers the same
 * catalog its own crewmates list, as metadata only. There is no use,
 * receipt or approval here, so no value or custody reaches this computer.
 */
export function secretsCommand(asks: TaskAsks): SecretsCatalog {
  return {
    list: async () =>
      placedSecretsSchema.parse(
        await asks.withDeadline("inf:work:secrets", (deadline) =>
          asks.call("inf:work:secrets", { callId: randomUUID(), input: {} }, deadline),
        ),
      ).secrets,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
