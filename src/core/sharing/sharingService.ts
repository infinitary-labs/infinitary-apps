import { randomUUID } from "node:crypto";
import {
  type DiagnosticEvent,
  diagnosticDataViolation,
  FTUE_MILESTONES,
  isPhoneDiagnosticEvent,
  PHONE_FTUE_MILESTONES,
  type PhoneDiagnosticEventName,
} from "@shared/diagnostics";
import type { FmEvent } from "@shared/events";
import {
  DATA_TERMS,
  type DiagnosticRecord,
  type DiagnosticsSwitch,
  type PendingDiagnostic,
  type PhoneDiagnostics,
  type Sharing,
  type SharingAskAnswer,
  type SharingChannel,
  type SharingPreview,
  type SharingView,
} from "@shared/sharing";
import type { CoreEventSink } from "../events";
import { redactDeep } from "../observe/redact";
import type { SettingsStore } from "../storage/settingsStore";
import type { TaskEvent } from "../storage/taskEventStore";
import { buildDiagnosticBody, type DiagnosticsConfig, type TelemetryClient } from "../telemetry";

/**
 * The two switches (roadmap 1.4; `src/shared/sharing.ts` is the shape,
 * `docs/sharing.md` the one home). This is the ONE writer of the `sharing`
 * settings row and the one gate on anything that leaves the machine for us:
 *
 * - Diagnostics. The events `src/shared/diagnostics.ts` declares, each with
 *   its allowlisted fields, the app version and the anonymous install ID,
 *   on by default. `record` is the one way in: off, it builds nothing and
 *   keeps nothing; on, the event joins the row's pending list and goes once
 *   the person has been SHOWN what Diagnostics sends (the first-launch
 *   notice or the viewer painted - `viewedAt`) and the build has a
 *   destination. The wire (decision D-12's Umami client,
 *   `src/core/telemetry.ts`) posts only bodies `buildDiagnosticBody` makes
 *   and re-checks each against the policy. The install ID is minted at boot
 *   while the switch is on, dropped when it is turned off, and minted anew
 *   when it is turned back on.
 * - Contribution. The R2 `decided` records newer than the last send,
 *   redacted the way the corpus export redacts. It has no sender today: the
 *   switch is absent until the terms are published (`DATA_TERMS.published`)
 *   and this service refuses to turn it on before then. `contributionSender`
 *   is the seam the beta's sender plugs into; until one exists the backlog
 *   is a preview and nothing else.
 * - The ask. `noteLocalModelEnabled` is the seam the local model's own
 *   enablement calls (F4c: once, at that moment). It fires only under
 *   published terms, once ever, and `answerAsk` settles it; "not now" is a
 *   full answer and the app never asks again on its own.
 *
 * Every write pushes the whole view as `inf:sharing`, the same way the
 * captain's preferences travel.
 */

/** How many sent events stay inspectable in the viewer. */
export const DIAGNOSTICS_SENT_KEEP = 20;
/**
 * How many recorded events wait at most (a person who never answers the
 * notice, a long time offline). Past it a new event is dropped, so the
 * oldest - the first-run funnel's beginning - are the ones that stay.
 */
export const DIAGNOSTICS_PENDING_CAP = 200;
/**
 * How often a running app retries events the endpoint did not accept
 * (offline, the endpoint down). A new event retries them too.
 */
export const DIAGNOSTICS_RETRY_MS = 60 * 60 * 1000;
/** How many of the contribution backlog's records the viewer shows in full. */
export const CONTRIBUTION_PREVIEW_LIMIT = 20;

export type SharingTerms = { published: boolean; version: string };

export type DecisionBacklog = {
  /** The newest decision events newer than `since`, capped. */
  list: (since: number, limit: number) => TaskEvent[];
  /** How many there are in all. */
  count: (since: number) => number;
};

export type SharingServiceOptions = {
  settings: SettingsStore;
  emit: CoreEventSink;
  /** The wire; a no-op one where no ids are baked in. */
  raw: TelemetryClient;
  /** What every body is built from, for the wire and the viewer alike. */
  telemetryConfig: DiagnosticsConfig;
  /** Where the raw client sends; null = this build sends nowhere, so nothing flushes. */
  destination: string | null;
  decisions: DecisionBacklog;
  /** The beta's sender; absent today, so the backlog is a preview only. */
  contributionSender?: (records: Record<string, unknown>[]) => Promise<void>;
  terms?: SharingTerms;
  now?: () => number;
  /** Mints an install ID; a random UUID. Injectable for tests only. */
  newInstallId?: () => string;
};

/** A phone event as a phone hands it: a declared `ios_*` name and its fields. */
export type PhoneDiagnosticEvent = Extract<DiagnosticEvent, { name: PhoneDiagnosticEventName }>;

export class SharingService {
  private readonly settings: SettingsStore;
  private readonly emit: CoreEventSink;
  private readonly raw: TelemetryClient;
  private readonly telemetryConfig: DiagnosticsConfig;
  private readonly destination: string | null;
  private readonly decisions: DecisionBacklog;
  private readonly contributionSender: SharingServiceOptions["contributionSender"];
  private readonly terms: SharingTerms;
  private readonly now: () => number;
  private readonly newInstallId: () => string;
  private sentDiagnostics: DiagnosticRecord[] = [];
  /** An event on the wire right now: sends go one at a time, oldest first. */
  private sending = false;
  private retry: ReturnType<typeof setInterval> | null = null;

  constructor(options: SharingServiceOptions) {
    this.settings = options.settings;
    this.emit = options.emit;
    this.raw = options.raw;
    this.telemetryConfig = options.telemetryConfig;
    this.destination = options.destination;
    this.decisions = options.decisions;
    this.contributionSender = options.contributionSender;
    this.terms = options.terms ?? { published: DATA_TERMS.published, version: DATA_TERMS.version };
    this.now = options.now ?? (() => Date.now());
    this.newInstallId = options.newInstallId ?? randomUUID;
    // An unpublished build cannot hold the switch on, whatever a row says.
    if (!this.terms.published && this.state().contribution.enabled) {
      this.write({
        ...this.state(),
        contribution: { ...this.state().contribution, enabled: false },
      });
    }
  }

  get(): SharingView {
    const state = this.state();
    return {
      ...state,
      termsPublished: this.terms.published,
      termsVersion: this.terms.version,
      diagnosticsDestination: this.destination,
      askPending: state.ask.askedAt !== null && state.ask.answeredAt === null,
    };
  }

  /**
   * Turn a channel on or off. Contribution refuses to turn on while the
   * terms are unpublished: there is nothing to consent to and nowhere to
   * send. Turning a channel on sends nothing by itself until the person has
   * been shown what it sends (`markViewed`).
   */
  setSwitch(channel: SharingChannel, enabled: boolean): SharingView {
    if (channel === "contribution" && enabled && !this.terms.published) return this.get();
    const state = this.state();
    if (state[channel].enabled === enabled) return this.get();
    if (channel === "diagnostics") {
      // Off drops the install ID and everything waiting; back on is a new,
      // unrelated ID, so the two stretches cannot be joined.
      this.write({
        ...state,
        diagnostics: {
          ...state.diagnostics,
          enabled,
          installId: enabled ? this.newInstallId() : null,
          pending: [],
          // Every phone's ID goes with the computer's; back on, each phone
          // that hands an event again gets a new one.
          phones: {},
        },
      });
    } else {
      this.write({ ...state, [channel]: { ...state[channel], enabled } });
    }
    this.flush(channel);
    return this.get();
  }

  /**
   * The person was shown what this channel sends: the first-launch notice
   * or the viewer painted. Stamped once; from then on the channel sends
   * while it is on, starting with what was pending.
   */
  markViewed(channel: SharingChannel): SharingView {
    const state = this.state();
    if (state[channel].viewedAt === null) {
      this.write({ ...state, [channel]: { ...state[channel], viewedAt: this.now() } });
    }
    this.flush(channel);
    return this.get();
  }

  preview(): SharingPreview {
    const since = this.state().contribution.sentAt ?? 0;
    return {
      diagnostics: {
        pending: this.pendingRecords(),
        sent: [...this.sentDiagnostics],
      },
      contribution: {
        pending: this.decisions
          .list(since, CONTRIBUTION_PREVIEW_LIMIT)
          .map((event) => redactDeep(contributionRecord(event))),
        pendingCount: this.decisions.count(since),
      },
    };
  }

  /**
   * The local model was just enabled (F4c's moment). Under published terms
   * this opens the ask once ever; unpublished, there is nothing to ask.
   */
  noteLocalModelEnabled(): SharingView {
    const state = this.state();
    if (!this.terms.published || state.ask.askedAt !== null) return this.get();
    this.write({ ...state, ask: { ...state.ask, askedAt: this.now() } });
    return this.get();
  }

  answerAsk(answer: SharingAskAnswer): SharingView {
    const state = this.state();
    if (state.ask.askedAt === null || state.ask.answeredAt !== null) return this.get();
    this.write({ ...state, ask: { ...state.ask, answeredAt: this.now(), answer } });
    if (answer === "contribute") return this.setSwitch("contribution", true);
    return this.get();
  }

  /**
   * The launch: mint the install ID if the switch is on and there is none
   * yet (the first launch), record `app_launch` (and the first launch's
   * funnel step), send whatever an earlier run left waiting, and retry
   * every `intervalMs` while the app runs. Called once at boot.
   */
  start(intervalMs: number = DIAGNOSTICS_RETRY_MS): void {
    const state = this.state();
    if (state.diagnostics.enabled && state.diagnostics.installId === null) {
      this.write({
        ...state,
        diagnostics: { ...state.diagnostics, installId: this.newInstallId() },
      });
    }
    this.record({ name: "ftue_first_launch", data: {} });
    this.record({ name: "app_launch", data: {} });
    this.flushDiagnostics();
    if (this.retry) return;
    this.retry = setInterval(() => this.flushDiagnostics(), intervalMs);
    this.retry.unref?.();
  }

  /**
   * Record one declared event (`src/shared/diagnostics.ts`). A first-run
   * milestone is kept once per install whatever the switch says - it is a
   * local fact, so turning Diagnostics on later never reports an old step
   * as new - and is dropped if it was reached before. Off, nothing is built
   * or kept; with no destination nothing ever could go, so nothing is kept
   * either. Otherwise the event waits on the row until the endpoint
   * accepts it, which needs the person to have been told.
   */
  record(event: DiagnosticEvent): void {
    // A phone's event goes only through `recordPhone`, under the phone's own ID.
    if (isPhoneDiagnosticEvent(event.name)) return;
    let state = this.state();
    if (FTUE_MILESTONES.includes(event.name)) {
      if (state.diagnostics.milestones.includes(event.name)) return;
      state = this.withDiagnostics(state, {
        milestones: [...state.diagnostics.milestones, event.name],
      });
      this.write(state);
    }
    const diagnostics = state.diagnostics;
    if (!diagnostics.enabled || !diagnostics.installId || this.destination === null) return;
    if (diagnostics.pending.length >= DIAGNOSTICS_PENDING_CAP) return;
    if (
      diagnosticDataViolation(event.name, { ...event.data, version: this.telemetryConfig.version })
    ) {
      return;
    }
    const entry: PendingDiagnostic = { at: this.now(), name: event.name, data: { ...event.data } };
    this.write(this.withDiagnostics(state, { pending: [...diagnostics.pending, entry] }));
    this.flushDiagnostics();
  }

  /**
   * One event a paired phone handed over (docs/sharing.md, "A phone's
   * events"). It is kept only when this computer's own events would go:
   * Diagnostics on, the person told, and a build with a destination.
   * Otherwise nothing is built or kept, not even the phone's ID. The phone
   * gets an install ID of its own here the first time, and its first-run
   * steps are kept once per that ID. A message sent from the phone is also
   * the phone's first message, the first time.
   */
  recordPhone(deviceId: string, event: PhoneDiagnosticEvent, version: string, atMs: number): void {
    const state = this.state();
    const diagnostics = state.diagnostics;
    if (!diagnostics.enabled || !diagnostics.installId || diagnostics.viewedAt === null) return;
    if (this.destination === null) return;
    if (diagnosticDataViolation(event.name, { ...event.data, version })) return;
    let phone: PhoneDiagnostics = diagnostics.phones[deviceId] ?? {
      installId: this.newInstallId(),
      milestones: [],
    };
    const at = Math.min(atMs, this.now());
    const names: PhoneDiagnosticEventName[] =
      event.name === "ios_message_sent" ? ["ios_ftue_first_message", event.name] : [event.name];
    const pending = [...diagnostics.pending];
    for (const name of names) {
      if (PHONE_FTUE_MILESTONES.includes(name)) {
        if (phone.milestones.includes(name)) continue;
        phone = { ...phone, milestones: [...phone.milestones, name] };
      }
      if (pending.length >= DIAGNOSTICS_PENDING_CAP) break;
      pending.push({ at, name, data: { ...event.data }, phone: deviceId, version });
    }
    this.write(
      this.withDiagnostics(state, {
        pending,
        phones: { ...diagnostics.phones, [deviceId]: phone },
      }),
    );
    this.flushDiagnostics();
  }

  /**
   * The paired devices changed: a phone no longer on the list drops its
   * install ID and whatever of it still waits, so a phone that joins again
   * is a new install.
   */
  keepPhones(held: (deviceId: string) => boolean): void {
    const state = this.state();
    const { phones, pending } = state.diagnostics;
    const gone = Object.keys(phones).filter((deviceId) => !held(deviceId));
    const waiting = pending.filter((entry) => entry.phone === undefined || held(entry.phone));
    if (gone.length === 0 && waiting.length === pending.length) return;
    const kept = Object.fromEntries(
      Object.entries(phones).filter(([deviceId]) => !gone.includes(deviceId)),
    );
    this.write(this.withDiagnostics(state, { phones: kept, pending: waiting }));
  }

  /** Stop retrying and drain the wire on quit. */
  close(timeoutMs?: number): Promise<void> {
    if (this.retry) clearInterval(this.retry);
    this.retry = null;
    return this.raw.close(timeoutMs);
  }

  /** On, viewed once, and somewhere to go: the three facts a send needs. */
  private open(channel: SharingChannel): boolean {
    const row = this.state()[channel];
    if (!row.enabled || row.viewedAt === null) return false;
    return channel === "diagnostics" ? this.destination !== null : this.terms.published;
  }

  private flush(channel: SharingChannel): void {
    if (!this.open(channel)) return;
    if (channel === "diagnostics") this.flushDiagnostics();
    else this.flushContribution();
  }

  /**
   * Send the oldest waiting event, then the next, one at a time so they
   * arrive in order. An event leaves the row only once the endpoint
   * accepted it; a refusal stops the run until the next event or retry. An
   * entry the policy no longer allows is dropped unsent.
   */
  private flushDiagnostics(): void {
    if (this.sending || !this.open("diagnostics")) return;
    const state = this.state();
    const entry = state.diagnostics.pending[0];
    if (!entry) return;
    const record = this.recordFor(entry, state.diagnostics);
    if (!record) {
      this.write(this.withDiagnostics(state, { pending: state.diagnostics.pending.slice(1) }));
      this.flushDiagnostics();
      return;
    }
    this.sending = true;
    void this.raw.send(record.body).then((accepted) => {
      this.sending = false;
      if (!accepted) return;
      this.sentDiagnostics = [...this.sentDiagnostics, record].slice(-DIAGNOSTICS_SENT_KEEP);
      const latest = this.state();
      // Off (or off and on) while it flew: the row's list is already empty.
      const pending = [...latest.diagnostics.pending];
      const index = pending.findIndex(
        (waiting) =>
          waiting.at === entry.at && waiting.name === entry.name && waiting.phone === entry.phone,
      );
      if (index >= 0) pending.splice(index, 1);
      this.write(this.withDiagnostics(latest, { pending, sentAt: entry.at }));
      this.flushDiagnostics();
    });
  }

  /** The body a waiting event goes as, with this install's ID; null when the policy refuses it. */
  private recordFor(
    entry: PendingDiagnostic,
    diagnostics: DiagnosticsSwitch,
  ): DiagnosticRecord | null {
    // A phone's event goes under that phone's own ID and version; one whose
    // phone left is never sent.
    const installId =
      entry.phone === undefined
        ? diagnostics.installId
        : (diagnostics.phones[entry.phone]?.installId ?? null);
    if (!installId) return null;
    if (entry.phone !== undefined && entry.version === undefined) return null;
    const config =
      entry.phone === undefined
        ? this.telemetryConfig
        : { ...this.telemetryConfig, version: entry.version as string };
    const event = { name: entry.name, data: entry.data } as DiagnosticEvent;
    try {
      // The builder throws for anything outside the policy.
      const body = buildDiagnosticBody(config, event, installId, entry.at);
      return { at: entry.at, name: entry.name, body };
    } catch {
      return null;
    }
  }

  /** Every waiting event as the body it will go as: the viewer's "what would leave". */
  private pendingRecords(): DiagnosticRecord[] {
    const diagnostics = this.state().diagnostics;
    if (!diagnostics.enabled) return [];
    return diagnostics.pending
      .map((entry) => this.recordFor(entry, diagnostics))
      .filter((record): record is DiagnosticRecord => record !== null);
  }

  private withDiagnostics(state: Sharing, patch: Partial<DiagnosticsSwitch>): Sharing {
    return { ...state, diagnostics: { ...state.diagnostics, ...patch } };
  }

  private flushContribution(): void {
    const sender = this.contributionSender;
    if (!sender) return;
    const state = this.state();
    const since = state.contribution.sentAt ?? 0;
    const records = this.decisions
      .list(since, Number.MAX_SAFE_INTEGER)
      .map((event) => redactDeep(contributionRecord(event)));
    if (records.length === 0) return;
    const sentAt = this.now();
    void sender(records).then(() => {
      const latest = this.state();
      this.write({ ...latest, contribution: { ...latest.contribution, sentAt } });
    });
  }

  private state(): Sharing {
    return this.settings.getSharing();
  }

  private write(next: Sharing): void {
    this.settings.setSharing(next);
    this.emit("inf:sharing", this.get());
  }
}

/**
 * The crew half of the first-run funnel, read off the events every task
 * change already broadcasts (the `broadcastEvent` seam in
 * `src/core/eventSeam.ts`): a crewmate starting, its first report, and its
 * task closing. `record` keeps each once per install, so this names the
 * step every time and the first one is what goes.
 */
export function crewMilestoneFor(event: FmEvent): DiagnosticEvent | null {
  switch (event.type) {
    case "task_started":
      return { name: "ftue_first_spawn_started", data: {} };
    case "task_report":
      return { name: "ftue_first_spawn_succeeded", data: {} };
    case "task_changed":
      if (event.kind !== "work" || event.from === event.status) return null;
      if (event.status !== "done" && event.status !== "dropped") return null;
      if (!event.closedReason) return null;
      return { name: "ftue_first_disposal", data: { outcome: event.closedReason } };
    default:
      return null;
  }
}

/** A contribution record: the decision event as the corpus export packages it. */
function contributionRecord(event: TaskEvent): Record<string, unknown> {
  return {
    taskId: event.taskId,
    at: event.at,
    actor: event.actor,
    kind: event.kind,
    ref: event.ref,
    data: event.data,
  };
}
