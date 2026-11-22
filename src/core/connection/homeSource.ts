import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import {
  FETCH_APP_REFUSAL_STATUS,
  FETCH_APP_TYPES,
  type FetchAppRefusal,
  fetchSourceRequestSchema,
  PAIR_BODY_MAX_BYTES,
} from "@shared/connection";
import { COMPUTER } from "@shared/deviceNames";
import { deviceRunsWork } from "@shared/devices";
import type { PairedDevice } from "./connection";

/** What a home run from source sends of itself (`ConnectionOptions.source`). */
export type HomeSource = {
  commit: string;
  archive: () => { stream: Readable; ended: Promise<void>; stop: () => void };
};

/** What each refusal at `FETCH_SOURCE_PATH` says. */
// i18n-exempt: read by the computer that asked, which says its own catalogued words for a failed fetch
const FETCH_SOURCE_REASONS: Partial<Record<FetchAppRefusal, string>> = {
  malformed: "The request for this home's source is not one it reads.",
  unknown: `Only a ${COMPUTER.one} this home lists to run work gets its source.`,
  none: "This home does not run that commit from source.",
};

/** What answering `FETCH_SOURCE_PATH` reaches of the connection. */
export type SourceAnswerSeams = {
  /** The paired device the request's TLS socket proves to be, or null. */
  admit: (request: IncomingMessage) => PairedDevice | null | Promise<PairedDevice | null>;
  /** The request's body as text: null past the cap, undefined when it failed. */
  readBody: (request: IncomingMessage) => Promise<string | null | undefined>;
  answerJson: (response: ServerResponse, status: number, body: unknown) => void;
  source: (() => HomeSource | null) | undefined;
  /** Counts what this home sent a device. */
  tellSent: (deviceId: string, bytes: number) => void;
  onProblem: (problem: string) => void;
};

/**
 * Answers `/infinitary-source` (docs/devices.md, "Matching the home's
 * build"): the committed tree of the commit this home runs from source, as
 * one gzipped tar, to a computer that runs work already on the list, proven
 * by its key in TLS as `/firstmate` admits it.
 */
export async function answerSource(
  request: IncomingMessage,
  response: ServerResponse,
  seams: SourceAnswerSeams,
): Promise<void> {
  const refuseWith = (status: number) => {
    request.resume();
    response.writeHead(status, { Connection: "close" }).end();
  };
  const refused = (why: "malformed" | "unknown" | "none") =>
    seams.answerJson(response, FETCH_APP_REFUSAL_STATUS[why], {
      refused: why,
      reason: FETCH_SOURCE_REASONS[why] as string,
    });
  if (request.headers.origin !== undefined) return refuseWith(403);
  if (request.method !== "POST") {
    // i18n-exempt: an HTTP header name
    response.setHeader("Allow", "POST");
    return refuseWith(405);
  }
  if (!/^application\/json(;|$)/i.test(request.headers["content-type"] ?? ""))
    return refuseWith(415);
  if (Number(request.headers["content-length"] ?? 0) > PAIR_BODY_MAX_BYTES) return refuseWith(413);
  const text = await seams.readBody(request);
  if (text === undefined) return void response.destroy();
  if (text === null) return refuseWith(413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const want = fetchSourceRequestSchema.safeParse(body).data;
  if (!want) return refused("malformed");
  let device: PairedDevice | null = null;
  try {
    device = await seams.admit(request);
  } catch {
    device = null;
  }
  if (!device || !deviceRunsWork(device.kind)) return refused("unknown");
  const source = seams.source?.() ?? null;
  if (!source || source.commit !== want.commit) return refused("none");
  if (response.destroyed) return;
  const { stream, ended, stop } = source.archive();
  ended.catch((error: unknown) => {
    seams.onProblem(
      // i18n-exempt: a log line, never shown
      `could not send this home's source: ${error instanceof Error ? error.message : String(error)}`,
    );
    // An archive that fails part way cuts the answer short, so the computer never builds half a tree.
    response.destroy();
  });
  response.writeHead(200, {
    "Content-Type": FETCH_APP_TYPES.bundle,
    "Cache-Control": "no-store",
    Connection: "close",
  });
  const deviceId = device.id;
  stream.on("data", (piece: Buffer) => seams.tellSent(deviceId, piece.length));
  stream.pipe(response);
  response.once("close", stop);
}
