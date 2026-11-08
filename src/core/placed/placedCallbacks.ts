import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { HERE } from "@shared/deviceNames";
import type { InvokeRequest, WorkInvokeChannel } from "@shared/ipc";
import { isIntegrationAnswer } from "../integrations";
import { cardMutationText } from "../orchestrator/cardMutationText";
import { type AppPaths, crewmateCardPicturesDir, crewmateHandoverDir } from "../paths";
import { keepContentFile } from "../pi/cardImages";
import { CardRefusedError, type DeclaredCardInput } from "../session/tools";
import { sha256OfFile } from "../tasks/handoverFiles";
import type { PlacedBrowserSink, PlacedHost } from "./crewMachines";
import type { CallLine, PlacedLedger } from "./placedLedger";
import type { PlacedSession } from "./placedSession";

/**
 * The callbacks a crewmate's conversation on a computer that runs work asks
 * of the home (docs/helper.md, "Work requests"): each done here exactly as
 * for a crewmate of this Mac, by the callbacks its session was opened with,
 * once its non-repeatable change is marked begun (`PlacedLedger.begin`).
 * What a card shows or a report hands on arrives as files, kept under the
 * task's own folders here.
 */

/** A conversation not open on this Mac, or a computer not caught up: asked again, never kept. */
export class NotHeldHere extends Error {}

/** What answering a callback reads of the home's side (`PlacedSessions`). */
export type CallbackReach = {
  readonly paths: AppPaths;
  /** The supervisor, once it exists. */
  host(): PlacedHost | undefined;
  /** Where a task's browser there is heard, once it exists. */
  browsers(): PlacedBrowserSink | undefined;
  takesSharedCards(deviceId: string): boolean;
  takesCheckDeclarations(deviceId: string): boolean;
};

/** The task a callback is asked for. */
export type CallingTask = {
  readonly task: string;
  readonly deviceId: string;
  readonly ledger: PlacedLedger;
  /** Its conversation, open on this Mac: opened by the supervisor when nothing holds it. */
  live(): Promise<PlacedSession>;
};

/** Does one callback the task's computer asked, answering what goes back to it. */
export async function answerCall(
  reach: CallbackReach,
  placed: CallingTask,
  channel: WorkInvokeChannel,
  request: Record<string, unknown>,
): Promise<unknown> {
  switch (channel) {
    case "inf:work:picture":
      return picture(reach.paths, placed.task, request as InvokeRequest<"inf:work:picture">[0]);
    case "inf:work:media":
      return recordingPiece(
        reach.paths,
        placed.task,
        request as InvokeRequest<"inf:work:media">[0],
      );
    case "inf:work:handover-file":
      return handoverPiece(
        reach.paths,
        placed.task,
        request as InvokeRequest<"inf:work:handover-file">[0],
      );
    case "inf:work:typeface":
      return typeface(reach.paths, placed.task, request as InvokeRequest<"inf:work:typeface">[0]);
    case "inf:work:job-exit": {
      const { exit } = request as InvokeRequest<"inf:work:job-exit">[0];
      const host = reach.host();
      if (!host) throw new NotHeldHere(`${HERE.This} is still starting.`);
      placed.ledger.begin(channel, request);
      host.jobExit(placed.task, { ...exit, ownerId: placed.task });
      return { ok: true };
    }
    case "inf:work:browser-event": {
      const { event } = request as InvokeRequest<"inf:work:browser-event">[0];
      const browsers = reach.browsers();
      if (!browsers) throw new NotHeldHere(`${HERE.This} is still starting.`);
      placed.ledger.begin(channel, request);
      browsers.heardEvent(placed.deviceId, placed.task, event);
      return { ok: true };
    }
    default:
      break;
  }
  const session = await placed.live();
  placed.ledger.begin(channel, request);
  const callbacks = session.callbacks;
  const missing = (): never => {
    throw new Error("That tool is not this task's.");
  };
  switch (channel) {
    case "inf:work:card": {
      const { card } = request as InvokeRequest<"inf:work:card">[0];
      const onCard = callbacks?.onCard ?? missing();
      try {
        const shown = await onCard(card as DeclaredCardInput);
        if (shown && typeof shown === "object") {
          // The supervisor refuses a computer from before shared cards a
          // write on someone else's card before writing anything
          // (`takesSharedCards`); should one still come back, that
          // computer hears what the host saved in words, never "shown".
          if (!reach.takesSharedCards(placed.deviceId)) {
            const why = cardMutationText(shown);
            return { refused: { message: why, reason: "other", why } };
          }
          return { shown: true, cardId: shown.cardId, mutation: shown };
        }
        return { shown: true, ...(shown ? { cardId: shown } : {}) };
      } catch (caught) {
        if (!(caught instanceof CardRefusedError)) throw caught;
        return { refused: { message: caught.message, reason: caught.reason, why: caught.why } };
      }
    }
    case "inf:work:card-refused": {
      const { refusal } = request as InvokeRequest<"inf:work:card-refused">[0];
      callbacks?.onCardRefused?.(refusal);
      return { ok: true };
    }
    case "inf:work:close-card": {
      const { cardId, reason } = request as InvokeRequest<"inf:work:close-card">[0];
      const onCloseCard = callbacks?.onCloseCard ?? missing();
      return { text: await onCloseCard({ cardId, ...(reason ? { reason } : {}) }) };
    }
    case "inf:work:followup": {
      const { input } = request as InvokeRequest<"inf:work:followup">[0];
      return { text: await (callbacks?.onFollowup ?? missing())(input) };
    }
    case "inf:work:start-program": {
      const { input } = request as InvokeRequest<"inf:work:start-program">[0];
      return { text: await (callbacks?.onStartProgram ?? missing())(input) };
    }
    case "inf:work:progress": {
      const { text, plan } = request as InvokeRequest<"inf:work:progress">[0];
      return { text: await (callbacks?.onProgress ?? missing())(text, plan) };
    }
    case "inf:work:report": {
      const { text, summary, declared } = request as InvokeRequest<"inf:work:report">[0];
      return { text: await (callbacks?.onReport ?? missing())(text, summary, declared) };
    }
    case "inf:work:reply": {
      const { cardId, text, interim, answersMessage, signsOff, operationId, response } =
        request as InvokeRequest<"inf:work:reply">[0];
      return {
        text: await (callbacks?.onReply ?? missing())({
          cardId,
          text,
          ...(interim !== undefined ? { interim } : {}),
          ...(answersMessage !== undefined ? { answersMessage } : {}),
          ...(signsOff === true ? { signsOff } : {}),
          ...(operationId ? { operationId } : {}),
          ...(response ? { response } : {}),
        }),
      };
    }
    case "inf:work:revise-required-action": {
      const { input } = request as InvokeRequest<"inf:work:revise-required-action">[0];
      return { text: await (callbacks?.onReviseRequiredAction ?? missing())(input) };
    }
    case "inf:work:read-card": {
      const { cardId } = request as InvokeRequest<"inf:work:read-card">[0];
      return { text: await (callbacks?.onReadCard ?? missing())(cardId) };
    }
    case "inf:work:speed-note": {
      const { model, selection } = request as InvokeRequest<"inf:work:speed-note">[0];
      callbacks?.onSpeed?.(model, selection);
      return { ok: true };
    }
    case "inf:work:speed": {
      const { model } = request as InvokeRequest<"inf:work:speed">[0];
      return (await callbacks?.requestedSpeed?.(model)) ?? "standard";
    }
    case "inf:work:tasks": {
      const { input } = request as InvokeRequest<"inf:work:tasks">[0];
      return await (callbacks?.onQueryTasks ?? missing())(input);
    }
    case "inf:work:read-workflow": {
      const { input } = request as InvokeRequest<"inf:work:read-workflow">[0];
      return { text: await (callbacks?.onReadWorkflow ?? missing())(input) };
    }
    case "inf:work:github-read": {
      const { input } = request as InvokeRequest<"inf:work:github-read">[0];
      return { text: await (callbacks?.onGithubRead ?? missing())(input) };
    }
    case "inf:work:github-write": {
      const { input } = request as InvokeRequest<"inf:work:github-write">[0];
      return { text: await (callbacks?.onGithubWrite ?? missing())(input) };
    }
    case "inf:work:prepare-change": {
      const { input } = request as InvokeRequest<"inf:work:prepare-change">[0];
      return { text: await (callbacks?.onPrepareChange ?? missing())(input) };
    }
    case "inf:work:open-change": {
      const { input } = request as InvokeRequest<"inf:work:open-change">[0];
      return { text: await (callbacks?.onOpenChange ?? missing())(input) };
    }
    case "inf:work:check-change": {
      if (!reach.takesCheckDeclarations(placed.deviceId))
        return {
          text: "Update Infinitary on the work computer before it reads check facts and records check or repair declarations. No declaration was recorded.",
        };
      const { input } = request as InvokeRequest<"inf:work:check-change">[0];
      return { text: await (callbacks?.onCheckChange ?? missing())(input) };
    }
    case "inf:work:download-artifact": {
      const { input } = request as InvokeRequest<"inf:work:download-artifact">[0];
      return { text: await (callbacks?.onDownloadArtifact ?? missing())(input) };
    }
    case "inf:work:knowledge": {
      const { input } = request as InvokeRequest<"inf:work:knowledge">[0];
      return { text: await (callbacks?.knowledge ?? missing()).read(input) };
    }
    case "inf:work:record-knowledge": {
      const { input } = request as InvokeRequest<"inf:work:record-knowledge">[0];
      return { text: await (callbacks?.knowledge ?? missing()).record(input) };
    }
    // The integrations command there, answered by this Mac's own integrations under the task's rules.
    case "inf:work:integrations": {
      const { input } = request as InvokeRequest<"inf:work:integrations">[0];
      const integrations = callbacks?.integrations ?? missing();
      if (input.name === undefined) return { data: { integrations: await integrations.list() } };
      const shown = await integrations.show(input.name);
      return isIntegrationAnswer(shown) ? shown : { data: shown };
    }
    case "inf:work:use-integration": {
      const { input } = request as InvokeRequest<"inf:work:use-integration">[0];
      const integrations = callbacks?.integrations ?? missing();
      return await integrations.call(
        input.name,
        input.action,
        input.input,
        undefined,
        input.reason,
      );
    }
    // The files command there, answered by this Mac as for a crewmate of its own (docs/files.md).
    case "inf:work:files": {
      const { input } = request as InvokeRequest<"inf:work:files">[0];
      const files = callbacks?.files ?? missing();
      return input.op === "computers" ? await files.computers() : await files.list(input.target);
    }
    case "inf:work:copy-file": {
      const { input } = request as InvokeRequest<"inf:work:copy-file">[0];
      return await (callbacks?.files ?? missing()).copy(input.target);
    }
    default:
      throw new Error(`${channel} is not a request ${HERE.this} answers.`);
  }
}

/** A report a turn gave before this Mac restarted, given to the turn this Mac follows now. */
export async function replayReport(session: PlacedSession, line: CallLine): Promise<void> {
  if (!line.report) return;
  const { text, summary, declared } = line.report;
  try {
    await session.callbacks?.onReport?.(
      text,
      summary,
      declared as Parameters<NonNullable<typeof session.callbacks.onReport>>[2],
    );
  } catch {
    // Refused again now: it was refused or answered then, and the crewmate read that.
  }
}

/**
 * Where this Mac's cards show a task's file from - a picture, a project font,
 * a demo recording - refused when its id is not the task's own.
 */
function cardFile(
  paths: AppPaths,
  task: string,
  request: { id: string; extension: string },
  what: string,
): { dir: string; file: string } {
  if (!request.id.startsWith(`${task}-`)) throw new Error(`That ${what} is not this task's.`);
  const dir = crewmateCardPicturesDir(paths, task);
  return { dir, file: join(dir, `${request.id}.${request.extension}`) };
}

/** A card picture's bytes, kept where this Mac's cards show their pictures from. */
function picture(
  paths: AppPaths,
  task: string,
  request: InvokeRequest<"inf:work:picture">[0],
): { ok: true } {
  const { dir, file } = cardFile(paths, task, request, "picture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, Buffer.from(request.data, "base64"));
  return { ok: true };
}

/**
 * A project font's bytes, kept beside the pictures where this Mac's frames
 * load it from - left alone when that name already holds them, and
 * otherwise replaced whole (`keepContentFile`), since a frame may be
 * reading the name while the same font arrives again.
 */
function typeface(
  paths: AppPaths,
  task: string,
  request: InvokeRequest<"inf:work:typeface">[0],
): { ok: true } {
  const { dir, file } = cardFile(paths, task, request, "font");
  mkdirSync(dir, { recursive: true });
  keepContentFile(file, Buffer.from(request.data, "base64"));
  return { ok: true };
}

/**
 * A piece of a card's demo recording, written at its place in a partial
 * file; the last piece makes it the recording its poster names, so a card
 * never names one this Mac holds only part of.
 */
function recordingPiece(
  paths: AppPaths,
  task: string,
  request: InvokeRequest<"inf:work:media">[0],
): { ok: true } {
  const { dir, file } = cardFile(paths, task, request, "recording");
  const piece = writePiece(dir, file, request, "recording");
  if (piece.last) renameSync(piece.partial, file);
  return { ok: true };
}

/**
 * A piece of a file the task's report hands on (`handover-files.md`),
 * written at its place in a 0600 partial file; the last piece, checked
 * against its sha256, makes it the kept file the report names. Its
 * content is never logged or put in an answer.
 */
async function handoverPiece(
  paths: AppPaths,
  task: string,
  request: InvokeRequest<"inf:work:handover-file">[0],
): Promise<{ ok: true }> {
  const dir = crewmateHandoverDir(paths, task);
  const file = join(dir, request.file);
  const piece = writePiece(dir, file, request, "handed file", { dir: 0o700, file: 0o600 });
  if (!piece.last) return { ok: true };
  if (
    statSync(piece.partial).size !== request.size ||
    (await sha256OfFile(piece.partial)) !== request.sha256
  ) {
    rmSync(piece.partial, { force: true });
    throw new Error("The handed file did not arrive unchanged.");
  }
  renameSync(piece.partial, file);
  return { ok: true };
}

/**
 * One piece of a file sent in pieces, written at its offset in the file's
 * `.partial` beside it in `dir` (made new by the first piece, with `modes`
 * when given); answers whether it was the last, which the caller turns into
 * the file. A piece that runs past the file's size is refused before
 * anything is written.
 */
function writePiece(
  dir: string,
  file: string,
  request: { data: string; offset: number; size: number },
  what: string,
  modes?: { dir: number; file: number },
): { partial: string; last: boolean } {
  const piece = Buffer.from(request.data, "base64");
  if (request.offset + piece.length > request.size)
    throw new Error(`That piece runs past the ${what}'s end.`);
  mkdirSync(dir, { recursive: true, ...(modes ? { mode: modes.dir } : {}) });
  const partial = `${file}.partial`;
  const flags = request.offset === 0 ? "w" : "r+";
  const handle = modes ? openSync(partial, flags, modes.file) : openSync(partial, flags);
  try {
    writeSync(handle, piece, 0, piece.length, request.offset);
  } finally {
    closeSync(handle);
  }
  return { partial, last: request.offset + piece.length === request.size };
}
