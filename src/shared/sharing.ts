import { z } from "zod";

/**
 * The two switches (roadmap 1.4; captain locks F2b and F4c, written out in
 * `DATA-TERMS.md`; Diagnostics on by default since the EONA alpha decision
 * of 2026-09-22, and widened to the event set by the captain the same day):
 * what may leave this machine FOR US. No feature is gated on either.
 *
 * - `diagnostics`: the events `src/shared/diagnostics.ts` declares - the
 *   app launching, a Firstmate turn ending or failing, and the first-run
 *   funnel - each with enum/boolean/number fields, the app version and an
 *   anonymous random install ID, and never a transcript, a prompt, code, a
 *   card body or anything else a person wrote. It is ON by default (the
 *   switch is the opt-out), and nothing goes until the person has been
 *   told: the first-launch notice or the Settings viewer painted.
 * - `contribution`: redacted records of the Firstmate's own decisions (the
 *   R2 `decided` events, the shapes the corpus export packages). Off by
 *   default; it has no destination until the terms are published, and the
 *   switch is absent from every build until then (`DATA_TERMS.published`).
 *
 * Each switch remembers when the person was first SHOWN what it sends (the
 * first-launch notice or the viewer painted) and when it last SENT
 * anything; nothing is sent before the first showing.
 *
 * `ask` is the one-time ask at local-model enablement (F4c): asked once,
 * answered once, never repeated by the app on its own.
 */

export const DATA_TERMS = {
  /**
   * Flipping this is the publication commit at the public beta: it puts
   * the contribution switch on the General tab and lets the ask fire.
   */
  published: false,
  /** The file, beside the code that sends the payload. */
  file: "DATA-TERMS.md",
  /** The version of the terms this build ships; a widening bumps it. */
  version: "draft-1",
} as const;

export const sharingChannelSchema = z.enum(["diagnostics", "contribution"]);
export type SharingChannel = z.infer<typeof sharingChannelSchema>;

export const sharingSwitchSchema = z.strictObject({
  enabled: z.boolean(),
  /** When the person was first shown what this channel sends; null = never, so nothing sent. */
  viewedAt: z.number().nullable(),
  /** When this channel last sent anything; null = never. */
  sentAt: z.number().nullable(),
});
export type SharingSwitch = z.infer<typeof sharingSwitchSchema>;

/**
 * One event recorded and not yet accepted by the endpoint: its declared
 * name and data (`src/shared/diagnostics.ts`). Kept on the row so a send
 * that failed, or one waiting for the person to be told, survives a
 * relaunch; the body is built from it at send time. Loose on purpose - an
 * entry the policy no longer allows is dropped unsent, never a row that
 * fails to parse.
 */
export const pendingDiagnosticSchema = z.strictObject({
  at: z.number(),
  name: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type PendingDiagnostic = z.infer<typeof pendingDiagnosticSchema>;

/**
 * Diagnostics' row: the switch, plus the anonymous install ID (a random
 * UUID; null while the switch is off - turning it back on mints a new one)
 * and what the install has recorded. The new keys default, so a row
 * written before them still parses.
 */
export const diagnosticsSwitchSchema = sharingSwitchSchema.extend({
  installId: z.string().nullable().default(null),
  /** The first-run milestones this install has reached, each sent once at most. */
  milestones: z.array(z.string()).default([]),
  /** Recorded events not yet accepted by the endpoint, oldest first. */
  pending: z.array(pendingDiagnosticSchema).default([]),
});
export type DiagnosticsSwitch = z.infer<typeof diagnosticsSwitchSchema>;

export const sharingAskAnswerSchema = z.enum(["contribute", "not-now"]);
export type SharingAskAnswer = z.infer<typeof sharingAskAnswerSchema>;

export const sharingAskSchema = z.strictObject({
  askedAt: z.number().nullable(),
  answeredAt: z.number().nullable(),
  answer: sharingAskAnswerSchema.nullable(),
});
export type SharingAsk = z.infer<typeof sharingAskSchema>;

export const sharingSchema = z.strictObject({
  diagnostics: diagnosticsSwitchSchema,
  contribution: sharingSwitchSchema,
  ask: sharingAskSchema,
});
export type Sharing = z.infer<typeof sharingSchema>;

const OFF: SharingSwitch = { enabled: false, viewedAt: null, sentAt: null };

/**
 * A fresh install: Diagnostics on (sending once the person has been told;
 * the install ID is minted at boot), contribution off. A row already
 * written keeps whatever it says, so a switch someone turned off stays off.
 */
export const DEFAULT_SHARING: Sharing = {
  diagnostics: {
    enabled: true,
    viewedAt: null,
    sentAt: null,
    installId: null,
    milestones: [],
    pending: [],
  },
  contribution: OFF,
  ask: { askedAt: null, answeredAt: null, answer: null },
};

/** The row plus what the window needs to render it honestly. */
export const sharingViewSchema = sharingSchema.extend({
  /** False hides the contribution switch and refuses to turn it on. */
  termsPublished: z.boolean(),
  termsVersion: z.string(),
  /**
   * The host diagnostics go to, for the person to read; null when this
   * build has no destination at all (a source or dev build), in which case
   * the switch is a preference for a build that has one and nothing sends.
   */
  diagnosticsDestination: z.string().nullable(),
  /** The local model was enabled and the ask has not been answered yet. */
  askPending: z.boolean(),
});
export type SharingView = z.infer<typeof sharingViewSchema>;

/** One event exactly as its request body reads on the wire. */
export const diagnosticRecordSchema = z.strictObject({
  at: z.number(),
  name: z.string(),
  body: z.record(z.string(), z.unknown()),
});
export type DiagnosticRecord = z.infer<typeof diagnosticRecordSchema>;

/**
 * What would leave, and what did: the payload viewer's value. Pending is
 * every recorded event the endpoint has not accepted yet, as the body it
 * will go as (empty while the switch is off: nothing is recorded then);
 * sent is the most recent history, so a record is inspectable after the
 * fact as the terms promise.
 */
export const sharingPreviewSchema = z.strictObject({
  diagnostics: z.strictObject({
    pending: z.array(diagnosticRecordSchema),
    sent: z.array(diagnosticRecordSchema),
  }),
  contribution: z.strictObject({
    /** The newest pending decision records, redacted; `pendingCount` is the whole backlog. */
    pending: z.array(z.record(z.string(), z.unknown())),
    pendingCount: z.number(),
  }),
});
export type SharingPreview = z.infer<typeof sharingPreviewSchema>;

/**
 * What Diagnostics sends, in one sentence: the same words the first-launch
 * notice and the alpha notice use (`docs/sharing.md`).
 */
export const DIAGNOSTICS_SUMMARY =
  "Anonymous events - the app opening, your first mate finishing or failing a turn, and how far first-time setup has come - with the app version and a random install ID that resets when Diagnostics is turned off and back on.";

/** The first-launch notice's words, under the input. */
export const DIAGNOSTICS_NOTICE_TEXT =
  "Infinitary sends anonymous usage events with a random install ID, reset when you turn them off and on - never what you type. Turn off here or in Settings.";

/** The viewer's empty waiting list, by whether Diagnostics is on. */
export const DIAGNOSTICS_NOTHING_WAITING = {
  on: "Nothing waiting: everything recorded has been sent.",
  off: "Nothing is recorded while Diagnostics is off.",
} as const;
