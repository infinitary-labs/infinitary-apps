/**
 * The human-supervision view of the corpus export (docs/card-evidence.md,
 * "The export"): `pnpm export:corpus --human-supervision` adds this to the
 * C4 pack. It reads the card evidence the app already keeps - the
 * append-only `card_observations`, and the cards, revisions and threads
 * beside them - and writes one EPISODE per card lifecycle: every offer the
 * card showed, what the stage did with each, every interaction with the
 * offer it named, the thread lines about it, how the lifecycle ended, and,
 * in a separate namespace, what the task was when the evidence was read.
 *
 * It reads one database snapshot, up to one observation cutoff, so the same
 * source and cutoff always produce the same records. It never infers: an
 * outcome no observation recorded is `unknown`, a card written before the
 * capture is `legacy-reconstructed` from its final row with nothing shown or
 * clicked invented, and every missing fact is named where it is missing.
 *
 * Nothing here decides who may use the pack: every episode says the rights
 * are the owner's local use and that external use is not authorized.
 * Credential scrubbing is best effort, never anonymization.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { redactDeep } from "../src/core/observe/redact.ts";
import {
  CARD_CAPTURE_VERSION,
  CARD_OBSERVATION_KINDS,
  type CardObservation,
  type CardObservationKind,
  type CardObservationPayload,
  cardAnswersSchema,
  cardObservationPayloadSchemas,
} from "../src/shared/cards.ts";

/** The episode record's schema: a reader treats another version by its own rules. */
export const HUMAN_SUPERVISION_SCHEMA = "fm3000.human-supervision.episode/1";
/** The normalizer that turned observations into episodes. */
export const HUMAN_SUPERVISION_NORMALIZER = 1;

export const HUMAN_SUPERVISION_FILE = "human-supervision.jsonl";
export const HUMAN_SUPERVISION_LABELS_FILE = "human-supervision-labels.jsonl";
/** Where the pictures an offer shows are copied inside the pack. */
export const HUMAN_SUPERVISION_ASSETS_DIR = "assets/pictures";

/** What the pack's rights are, whatever a reader would like them to be. */
const RIGHTS = { scope: "owner-local", external_use: "not-authorized" } as const;

type Observation = CardObservation;
type Payload<K extends CardObservationKind> = CardObservationPayload<K>;

export type EpisodeOffer = {
  offer_id: string;
  seq: number | null;
  recorded_at: number | null;
  actor: string | null;
  source: string | null;
  /** How the offer was taken: an observation's basis, or a legacy row's. */
  basis: Payload<"offer">["basis"] | "legacy-revision" | "legacy-final-row";
  fingerprint: string | null;
  author: string;
  title: string;
  meta: string | null;
  model: string | null;
  body: string;
  actions: unknown[];
  pictures: EpisodePicture[];
  width: string | null;
};

export type EpisodePicture = {
  id: string;
  alt: string;
  width: number;
  height: number;
  group: number;
  /** Pack-relative path of the copied bytes; null when they could not be resolved. */
  asset: string | null;
  sha256: string | null;
  missing?: "not-found" | "invalid-id";
  /** The demo recording this picture is the poster of (docs/card-authoring.md "Demo recordings"). */
  demo?: EpisodeDemo;
};

/** A demo recording an offer plays, copied beside its poster. */
export type EpisodeDemo = {
  id: string;
  kind: string;
  width: number;
  height: number;
  duration_ms: number;
  bytes: number;
  /** Pack-relative path of the copied recording; null when it could not be resolved. */
  asset: string | null;
  sha256: string | null;
  missing?: "not-found" | "invalid-id";
};

export type EpisodeStage = {
  seq: number;
  at: number;
  offer_id: string | null;
  actor: string;
  source: string;
} & Payload<"availability">;

export type EpisodeInteraction = {
  interaction_id: string | null;
  seq: number | null;
  at: number | null;
  actor: string;
  source: string;
  /** The offer the core dispatched; `display` says whether the shell showed it. */
  offer_id: string | null;
  basis: "captured" | "legacy-final-row";
  /** Nothing recorded what became of it: never a success or a failure. */
  outcome: "unknown";
  /** Named facts a reader selects on for a given use; never a quality score. */
  eligibility: {
    human_source: boolean;
    display_matched: boolean;
    questions: "complete" | "partial" | "none-asked" | "not-recorded";
    context_present: boolean;
    outcome_known: false;
    labelled: false;
  };
} & Partial<Payload<"action">>;

export type EpisodeMessage = {
  message_id: number;
  seq: number | null;
  at: number;
  who: string;
  offer_id: string | null;
  text: string | null;
  display?: Payload<"message_ref">["display"];
};

export type EpisodeEnd =
  | { kind: "open" }
  | { kind: "action"; seq: number | null; at: number | null; interaction_id: string | null }
  | ({
      kind: "exit";
      seq: number;
      at: number;
      actor: string;
      source: string;
      offer_id: string | null;
    } & Payload<"exit">)
  | { kind: "legacy-resolution"; at: number | null; resolution: string | null };

export type Episode = {
  schema: typeof HUMAN_SUPERVISION_SCHEMA;
  episode_id: string;
  basis: "captured" | "legacy-initial-snapshot" | "legacy-reconstructed";
  card_id: string;
  task_id: string | null;
  author: string | null;
  lifecycle: {
    started: "started" | "reopened" | "legacy-initial-snapshot" | "unknown";
    predecessor: string | null;
    first_seq: number | null;
    last_seq: number | null;
    capture_versions: number[];
    builds: string[];
  };
  offers: EpisodeOffer[];
  stage: EpisodeStage[];
  interactions: EpisodeInteraction[];
  thread: EpisodeMessage[];
  end: EpisodeEnd;
  /**
   * Evidence read after the fact, kept apart from anything a choice was made
   * on: the task as it stood at the cutoff (a temporal join, never a causal
   * one) and the effect receipts, of which capture v1 writes none.
   */
  later: {
    join: "same-task-at-cutoff";
    task: { status: string; closed_reason: string | null; closed_at: number | null } | null;
    effect_receipts: [];
  };
  /** What the episode could not carry, and why. */
  missing: string[];
  /** A credential-shaped string was scrubbed somewhere in the record. */
  redacted: boolean;
  rights: typeof RIGHTS;
};

export type HumanSupervisionExclusion = { reason: string; seqs: number[] };

export type HumanSupervisionManifest = {
  schema: typeof HUMAN_SUPERVISION_SCHEMA;
  normalizer_version: number;
  /** This installation's random namespace; absent when no capture ever ran. */
  source_namespace: string | null;
  /** The last observation read: the same cutoff always produces the same records. */
  cutoff: { seq: number; recorded_at: number | null };
  capture: {
    supported_version: number;
    epochs: { capture_version: number; activated_at: number; build: string | null }[];
    observed_versions: number[];
    /** Cards with activity after the capture started and no evidence of it. */
    uncovered_cards: number;
  };
  counts: {
    episodes: number;
    by_basis: Record<string, number>;
    interactions: number;
    by_actor: Record<string, number>;
    by_source: Record<string, number>;
    by_display: Record<string, number>;
    questions: Record<string, number>;
    missing: Record<string, number>;
    open_episodes: number;
    redacted_episodes: number;
    pictures: { copied: number; missing: number };
  };
  /**
   * The first-inventory funnel (docs/card-evidence.md): offers the stage
   * showed, interactions on host controls, those on the offer the shell
   * showed, those with their questions and task context whole. Purpose
   * eligibility, reviewed labels and independent evaluation episodes are a
   * use's own decisions; none is declared here.
   */
  funnel: {
    offers_available: number;
    host_control_interactions: number;
    matched_offers: number;
    question_and_context_complete: number;
    labels: number;
  };
  exclusions: HumanSupervisionExclusion[];
  rights: typeof RIGHTS & { redaction: string };
  session_references: "none-in-capture-v1";
};

export type HumanSupervisionPack = {
  episodes: Episode[];
  labels: never[];
  manifest: HumanSupervisionManifest;
  /** Pictures to copy into the pack: absolute source, pack-relative destination. */
  assets: { from: string; to: string }[];
};

type ObservationRow = {
  seq: number;
  id: string;
  card_id: string;
  lifecycle_id: string;
  task_id: string | null;
  kind: string;
  schema_version: number;
  capture_version: number;
  recorded_at: number;
  actor: string;
  source: string;
  offer_id: string | null;
  interaction_id: string | null;
  message_id: number | null;
  build: string | null;
  payload_json: string;
};

type CardRow = {
  id: string;
  task_id: string | null;
  author: string | null;
  title: string;
  meta: string;
  model?: string | null;
  body: string;
  actions_json: string;
  created_at: number;
  resolved_at: number | null;
  chosen_action: string | null;
  answers_json?: string | null;
  pictures_json?: string | null;
  width?: string | null;
};

type RevisionRow = {
  card_id: string;
  revision: number;
  title: string;
  body: string;
  actions_json: string;
  created_at: number;
  replaced_at: number;
};

type MessageRow = { id: number; card_id: string; who: string; text: string; at: number };
type TaskRow = {
  id: string;
  status: string;
  closed_reason: string | null;
  closed_at: number | null;
};
type EpochRow = {
  capture_version: number;
  activated_at: number;
  build: string | null;
  namespace: string;
};

type Snapshot = {
  observations: ObservationRow[];
  epochs: EpochRow[];
  cards: CardRow[];
  revisions: RevisionRow[];
  messages: MessageRow[];
  tasks: Map<string, TaskRow>;
};

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * One consistent read of everything the view needs, in one read
 * transaction, so no write the app makes meanwhile can split it. The
 * cutoff is the last observation this read saw.
 */
function readSnapshot(dbPath: string): Snapshot {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const captured = hasTable(db, "card_observations");
      return {
        observations: captured
          ? (db.prepare("SELECT * FROM card_observations ORDER BY seq").all() as ObservationRow[])
          : [],
        epochs: hasTable(db, "card_capture_epochs")
          ? (db
              .prepare("SELECT * FROM card_capture_epochs ORDER BY capture_version")
              .all() as EpochRow[])
          : [],
        cards: hasTable(db, "cards")
          ? (db.prepare("SELECT * FROM cards ORDER BY created_at, id").all() as CardRow[])
          : [],
        revisions: hasTable(db, "card_revisions")
          ? (db
              .prepare("SELECT * FROM card_revisions ORDER BY card_id, revision")
              .all() as RevisionRow[])
          : [],
        messages: hasTable(db, "card_messages")
          ? (db
              .prepare("SELECT id, card_id, who, text, at FROM card_messages ORDER BY id")
              .all() as MessageRow[])
          : [],
        tasks: new Map(
          (hasTable(db, "tasks")
            ? (db
                .prepare("SELECT id, status, closed_reason, closed_at FROM tasks")
                .all() as TaskRow[])
            : []
          ).map((row) => [row.id, row]),
        ),
      };
    })();
  } finally {
    db.close();
  }
}

/** An observation row read through its kind's schema, or the reason it cannot be. */
function parseObservation(row: ObservationRow): Observation | { excluded: string } {
  if (row.capture_version > CARD_CAPTURE_VERSION) return { excluded: "newer-capture-version" };
  if (!(CARD_OBSERVATION_KINDS as readonly string[]).includes(row.kind)) {
    return { excluded: "unknown-kind" };
  }
  const kind = row.kind as CardObservationKind;
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload_json);
  } catch {
    return { excluded: "unreadable-payload" };
  }
  const payload = cardObservationPayloadSchemas[kind].safeParse(raw);
  if (!payload.success) return { excluded: "invalid-payload" };
  return {
    seq: row.seq,
    id: row.id,
    kind,
    cardId: row.card_id,
    lifecycleId: row.lifecycle_id,
    taskId: row.task_id,
    schemaVersion: row.schema_version,
    captureVersion: row.capture_version,
    recordedAt: row.recorded_at,
    actor: row.actor,
    source: row.source,
    offerId: row.offer_id,
    interactionId: row.interaction_id,
    messageId: row.message_id,
    build: row.build,
    payload: payload.data,
  } as Observation;
}

/** A verified picture id as the app mints it (`src/shared/cardPictures.ts`): `<taskId>-<32 hex>`. */
const PICTURE_ID = /^([A-Za-z0-9_-]{1,64})-([0-9a-f]{32})$/;
const PICTURE_EXTENSIONS = ["png", "jpg", "webp"] as const;
const RECORDING_EXTENSIONS = ["mp4", "gif"] as const;

/**
 * Where a picture's or a demo recording's verified copy lives, contained in
 * the userData it was read from: `crewmates/<taskId>/cards/<id>.<ext>`. A
 * name that is not a minted id, or a file that resolves outside, is never read.
 */
function pictureSource(
  userDataDir: string,
  id: string,
  extensions: readonly string[] = PICTURE_EXTENSIONS,
): { path: string; extension: string } | { missing: "not-found" | "invalid-id" } {
  const match = PICTURE_ID.exec(id);
  const taskId = match?.[1];
  if (!taskId) return { missing: "invalid-id" };
  const root = resolve(userDataDir);
  for (const extension of extensions) {
    const candidate = join(root, "crewmates", taskId, "cards", `${id}.${extension}`);
    if (!existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    const within = relative(realpathSync(root), real);
    if (within.startsWith("..") || within.startsWith(sep)) return { missing: "invalid-id" };
    return { path: real, extension };
  }
  return { missing: "not-found" };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** What a reader can select an interaction on, from the facts it carries. */
function eligibilityOf(
  interaction: Omit<EpisodeInteraction, "eligibility">,
): EpisodeInteraction["eligibility"] {
  const questions = interaction.questions;
  return {
    human_source: interaction.actor === "captain" && interaction.source === "chrome",
    display_matched: interaction.display?.fidelity === "matched",
    questions: questions
      ? questions.length === 0
        ? "none-asked"
        : questions.every((question) => question.complete)
          ? "complete"
          : "partial"
      : interaction.answers?.length
        ? "not-recorded"
        : "none-asked",
    context_present: interaction.context !== undefined,
    outcome_known: false,
    labelled: false,
  };
}

/**
 * The view itself: episodes, the (empty) label file, the manifest section
 * and the pictures to copy. Pure over one snapshot, so the same cutoff
 * always yields the same records.
 */
export function buildHumanSupervision(input: {
  dbPath: string | null;
  userDataDir: string;
}): HumanSupervisionPack {
  const snapshot: Snapshot = input.dbPath
    ? readSnapshot(input.dbPath)
    : { observations: [], epochs: [], cards: [], revisions: [], messages: [], tasks: new Map() };
  const exclusions = new Map<string, number[]>();
  const exclude = (reason: string, seq: number) =>
    exclusions.set(reason, [...(exclusions.get(reason) ?? []), seq]);

  // Group the readable observations by lifecycle, in log order.
  const lifecycles = new Map<string, Observation[]>();
  for (const row of snapshot.observations) {
    const parsed = parseObservation(row);
    if ("excluded" in parsed) {
      exclude(parsed.excluded, row.seq);
      continue;
    }
    const key = `${parsed.cardId}\u0000${parsed.lifecycleId}`;
    lifecycles.set(key, [...(lifecycles.get(key) ?? []), parsed]);
  }
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
  const cardsById = new Map(snapshot.cards.map((card) => [card.id, card]));
  const assets = new Map<string, { from: string; to: string }>();
  let picturesMissing = 0;

  const picturesOf = (value: unknown): EpisodePicture[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): EpisodePicture[] => {
      if (!entry || typeof entry !== "object") return [];
      const picture = entry as { id?: unknown; alt?: unknown; width?: unknown; height?: unknown; group?: unknown };
      if (typeof picture.id !== "string") return [];
      const base = {
        id: picture.id,
        alt: typeof picture.alt === "string" ? picture.alt : "",
        width: typeof picture.width === "number" ? picture.width : 0,
        height: typeof picture.height === "number" ? picture.height : 0,
        group: typeof picture.group === "number" ? picture.group : 0,
      };
      const recording = demoOf((entry as { demo?: unknown }).demo);
      const withDemo = recording ? { demo: recording } : {};
      const source = pictureSource(input.userDataDir, picture.id);
      if ("missing" in source) {
        picturesMissing += 1;
        return [{ ...base, asset: null, sha256: null, missing: source.missing, ...withDemo }];
      }
      const to = `${HUMAN_SUPERVISION_ASSETS_DIR}/${picture.id}.${source.extension}`;
      assets.set(to, { from: source.path, to });
      return [{ ...base, asset: to, sha256: sha256(readFileSync(source.path)), ...withDemo }];
    });
  };
  // A poster's recording, copied beside it by the same rules; a missing one counts as a missing picture.
  const demoOf = (value: unknown): EpisodeDemo | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const demo = value as Record<string, unknown>;
    if (typeof demo.id !== "string") return undefined;
    const number = (key: string) => (typeof demo[key] === "number" ? (demo[key] as number) : 0);
    const base = {
      id: demo.id,
      kind: typeof demo.kind === "string" ? demo.kind : "",
      width: number("width"),
      height: number("height"),
      duration_ms: number("durationMs"),
      bytes: number("bytes"),
    };
    const source = pictureSource(input.userDataDir, demo.id, RECORDING_EXTENSIONS);
    if ("missing" in source) {
      picturesMissing += 1;
      return { ...base, asset: null, sha256: null, missing: source.missing };
    }
    const to = `${HUMAN_SUPERVISION_ASSETS_DIR}/${demo.id}.${source.extension}`;
    assets.set(to, { from: source.path, to });
    return { ...base, asset: to, sha256: sha256(readFileSync(source.path)) };
  };

  const episodes: Episode[] = [];
  const later = (taskId: string | null): Episode["later"] => {
    const task = taskId ? snapshot.tasks.get(taskId) : undefined;
    return {
      join: "same-task-at-cutoff",
      task: task
        ? { status: task.status, closed_reason: task.closed_reason, closed_at: task.closed_at }
        : null,
      effect_receipts: [],
    };
  };
  const finish = (episode: Omit<Episode, "redacted">): Episode => {
    const scrubbed = redactDeep(episode);
    return {
      ...scrubbed,
      redacted: JSON.stringify(scrubbed) !== JSON.stringify(episode),
    };
  };

  // Captured lifecycles.
  const capturedCards = new Set<string>();
  for (const observations of lifecycles.values()) {
    const first = observations[0] as Observation;
    capturedCards.add(first.cardId);
    const missing = new Set<string>();
    const offers: EpisodeOffer[] = [];
    const stage: EpisodeStage[] = [];
    const interactions: EpisodeInteraction[] = [];
    const thread: EpisodeMessage[] = [];
    let end: EpisodeEnd = { kind: "open" };
    let started: Episode["lifecycle"]["started"] = "unknown";
    let predecessor: string | null = null;
    for (const observation of observations) {
      switch (observation.kind) {
        case "offer": {
          const offer = observation.payload;
          offers.push({
            offer_id: observation.id,
            seq: observation.seq,
            recorded_at: observation.recordedAt,
            actor: observation.actor,
            source: observation.source,
            basis: offer.basis,
            fingerprint: offer.fingerprint,
            author: offer.author,
            title: offer.title,
            meta: offer.meta,
            model: offer.model ?? null,
            body: offer.body,
            actions: offer.actions,
            pictures: picturesOf(offer.pictures),
            width: offer.width ?? null,
          });
          break;
        }
        case "availability": {
          if (observation.payload.lifecycle && started === "unknown") {
            started = observation.payload.lifecycle;
            predecessor = observation.payload.predecessor ?? null;
          }
          stage.push({
            seq: observation.seq,
            at: observation.recordedAt,
            offer_id: observation.offerId,
            actor: observation.actor,
            source: observation.source,
            ...observation.payload,
          });
          break;
        }
        case "action": {
          const base = {
            interaction_id: observation.interactionId,
            seq: observation.seq,
            at: observation.recordedAt,
            actor: observation.actor,
            source: observation.source,
            offer_id: observation.offerId,
            basis: "captured" as const,
            outcome: "unknown" as const,
            ...observation.payload,
          };
          interactions.push({ ...base, eligibility: eligibilityOf(base) });
          if (observation.payload.closes && end.kind === "open") {
            end = {
              kind: "action",
              seq: observation.seq,
              at: observation.recordedAt,
              interaction_id: observation.interactionId,
            };
          }
          if (observation.payload.contextGap) missing.add(`context:${observation.payload.contextGap}`);
          if (observation.payload.questionsGap) {
            missing.add(`questions:${observation.payload.questionsGap}`);
          }
          break;
        }
        case "message_ref": {
          const message = messagesById.get(observation.payload.messageId);
          if (!message) missing.add("thread:message-deleted");
          thread.push({
            message_id: observation.payload.messageId,
            seq: observation.seq,
            at: message?.at ?? observation.recordedAt,
            who: observation.payload.who,
            offer_id: observation.offerId,
            text: message?.text ?? null,
            ...(observation.payload.display ? { display: observation.payload.display } : {}),
          });
          break;
        }
        case "exit": {
          if (end.kind === "open") {
            end = {
              kind: "exit",
              seq: observation.seq,
              at: observation.recordedAt,
              actor: observation.actor,
              source: observation.source,
              offer_id: observation.offerId,
              ...observation.payload,
            };
          }
          break;
        }
        case "effect_receipt":
          // Capture v1 writes none; a later version's receipt is read by its rules.
          break;
        case "seen":
          // What the window showed, read by the stage's change marks
          // (docs/card-authoring.md "What changed since you looked"); the
          // episode schema does not carry it.
          break;
      }
    }
    const offerIds = new Set(offers.map((offer) => offer.offer_id));
    for (const interaction of interactions) {
      if (interaction.offer_id && !offerIds.has(interaction.offer_id)) missing.add("offer:not-captured");
    }
    if (offers.some((offer) => offer.pictures.some((picture) => picture.missing))) {
      missing.add("pictures:missing");
    }
    if (interactions.length > 0) missing.add("outcome:unknown");
    const legacySeed = started === "legacy-initial-snapshot";
    if (legacySeed) missing.add("lifecycle:start-unknown");
    episodes.push(
      finish({
        schema: HUMAN_SUPERVISION_SCHEMA,
        episode_id: first.lifecycleId,
        basis: legacySeed ? "legacy-initial-snapshot" : "captured",
        card_id: first.cardId,
        task_id: first.taskId,
        author: offers[0]?.author ?? cardsById.get(first.cardId)?.author ?? null,
        lifecycle: {
          started,
          predecessor,
          first_seq: first.seq,
          last_seq: (observations.at(-1) as Observation).seq,
          capture_versions: [...new Set(observations.map((entry) => entry.captureVersion))].sort(),
          builds: [...new Set(observations.flatMap((entry) => (entry.build ? [entry.build] : [])))].sort(),
        },
        offers,
        stage,
        interactions,
        thread,
        end,
        later: later(first.taskId),
        missing: [...missing].sort(),
        rights: RIGHTS,
      }),
    );
  }

  // Cards the capture never saw: reconstructed from their final row, with
  // nothing shown or clicked invented. What the row cannot say is missing.
  const firstEpoch = snapshot.epochs[0]?.activated_at;
  let uncovered = 0;
  const revisionsOf = new Map<string, RevisionRow[]>();
  for (const revision of snapshot.revisions) {
    revisionsOf.set(revision.card_id, [...(revisionsOf.get(revision.card_id) ?? []), revision]);
  }
  for (const card of snapshot.cards) {
    if (capturedCards.has(card.id)) continue;
    const touched = Math.max(card.created_at, card.resolved_at ?? 0);
    if (firstEpoch !== undefined && touched >= firstEpoch) uncovered += 1;
    const finalActions = parseJson(card.actions_json);
    const offers: EpisodeOffer[] = [
      ...(revisionsOf.get(card.id) ?? []).map((revision) => ({
        offer_id: `legacy:${card.id}:r${revision.revision}`,
        seq: null,
        recorded_at: revision.created_at,
        actor: null,
        source: null,
        basis: "legacy-revision" as const,
        fingerprint: null,
        author: card.author ?? "unknown",
        title: revision.title,
        meta: null,
        model: null,
        body: revision.body,
        actions: Array.isArray(parseJson(revision.actions_json))
          ? (parseJson(revision.actions_json) as unknown[])
          : [],
        pictures: [],
        width: null,
      })),
      {
        offer_id: `legacy:${card.id}:final`,
        seq: null,
        recorded_at: null,
        actor: null,
        source: null,
        basis: "legacy-final-row",
        fingerprint: null,
        author: card.author ?? "unknown",
        title: card.title,
        meta: card.meta,
        model: card.model ?? null,
        body: card.body,
        actions: Array.isArray(finalActions) ? finalActions : [],
        pictures: picturesOf(parseJson(card.pictures_json)),
        width: card.width ?? null,
      },
    ];
    const answers = cardAnswersSchema.safeParse(parseJson(card.answers_json));
    const declared =
      Array.isArray(finalActions) &&
      finalActions.some(
        (action) =>
          action && typeof action === "object" && (action as { id?: unknown }).id === card.chosen_action,
      );
    const interactions: EpisodeInteraction[] = [];
    if (card.chosen_action && declared) {
      const base = {
        interaction_id: null,
        seq: null,
        at: card.resolved_at,
        // The final row cannot say who clicked, through what, or which
        // version was on the stage: those are unknown, never assumed.
        actor: "unknown",
        source: "unknown",
        offer_id: null,
        basis: "legacy-final-row" as const,
        outcome: "unknown" as const,
        actionId: card.chosen_action,
        ...(answers.success && answers.data.length > 0 ? { answers: answers.data } : {}),
        display: { fidelity: "legacy-missing" as const },
      };
      interactions.push({ ...base, eligibility: eligibilityOf(base) });
    }
    const missing = [
      "display:shown-offer-unknown",
      "lifecycle:start-unknown",
      "stage:not-recorded",
      ...(interactions.length > 0 ? ["context:not-recorded", "outcome:unknown"] : []),
      ...(offers.some((offer) => offer.pictures.some((picture) => picture.missing))
        ? ["pictures:missing"]
        : []),
    ];
    episodes.push(
      finish({
        schema: HUMAN_SUPERVISION_SCHEMA,
        episode_id: `legacy:${card.id}`,
        basis: "legacy-reconstructed",
        card_id: card.id,
        task_id: card.task_id,
        author: card.author,
        lifecycle: {
          started: "unknown",
          predecessor: null,
          first_seq: null,
          last_seq: null,
          capture_versions: [],
          builds: [],
        },
        offers,
        stage: [],
        interactions,
        thread: snapshot.messages
          .filter((message) => message.card_id === card.id)
          .map((message) => ({
            message_id: message.id,
            seq: null,
            at: message.at,
            who: message.who,
            offer_id: null,
            text: message.text,
          })),
        end:
          card.resolved_at === null
            ? { kind: "open" }
            : { kind: "legacy-resolution", at: card.resolved_at, resolution: card.chosen_action },
        later: later(card.task_id),
        missing: missing.sort(),
        rights: RIGHTS,
      }),
    );
  }

  const interactions = episodes.flatMap((episode) => episode.interactions);
  const captured = interactions.filter((interaction) => interaction.basis === "captured");
  const lastRow = snapshot.observations.at(-1);
  const manifest: HumanSupervisionManifest = {
    schema: HUMAN_SUPERVISION_SCHEMA,
    normalizer_version: HUMAN_SUPERVISION_NORMALIZER,
    source_namespace: snapshot.epochs[0]?.namespace ?? null,
    cutoff: { seq: lastRow?.seq ?? 0, recorded_at: lastRow?.recorded_at ?? null },
    capture: {
      supported_version: CARD_CAPTURE_VERSION,
      epochs: snapshot.epochs.map(({ capture_version, activated_at, build }) => ({
        capture_version,
        activated_at,
        build,
      })),
      observed_versions: [
        ...new Set(snapshot.observations.map((row) => row.capture_version)),
      ].sort(),
      uncovered_cards: uncovered,
    },
    counts: {
      episodes: episodes.length,
      by_basis: tally(episodes.map((episode) => episode.basis)),
      interactions: interactions.length,
      by_actor: tally(interactions.map((interaction) => interaction.actor)),
      by_source: tally(interactions.map((interaction) => interaction.source)),
      by_display: tally(interactions.map((interaction) => interaction.display?.fidelity ?? "none")),
      questions: tally(interactions.map((interaction) => interaction.eligibility.questions)),
      missing: tally(episodes.flatMap((episode) => episode.missing)),
      open_episodes: episodes.filter((episode) => episode.end.kind === "open").length,
      redacted_episodes: episodes.filter((episode) => episode.redacted).length,
      pictures: { copied: assets.size, missing: picturesMissing },
    },
    funnel: {
      offers_available: new Set(
        episodes.flatMap((episode) =>
          episode.stage.flatMap((entry) =>
            entry.state === "available" && entry.offer_id ? [entry.offer_id] : [],
          ),
        ),
      ).size,
      host_control_interactions: captured.filter((entry) => entry.source === "chrome").length,
      matched_offers: captured.filter((entry) => entry.eligibility.display_matched).length,
      question_and_context_complete: captured.filter(
        (entry) =>
          entry.eligibility.display_matched &&
          entry.eligibility.context_present &&
          (entry.eligibility.questions === "complete" ||
            entry.eligibility.questions === "none-asked"),
      ).length,
      labels: 0,
    },
    exclusions: [...exclusions]
      .map(([reason, seqs]) => ({ reason, seqs }))
      .sort((a, b) => a.reason.localeCompare(b.reason)),
    rights: {
      ...RIGHTS,
      redaction:
        "known credential shapes scrubbed, best effort; not anonymization or confidentiality clearance",
    },
    session_references: "none-in-capture-v1",
  };
  return {
    episodes,
    labels: [],
    manifest,
    assets: [...assets.values()].sort((a, b) => a.to.localeCompare(b.to)),
  };
}

/** Whether a record references only pack assets that exist in the list it ships with. */
export function danglingAssets(pack: HumanSupervisionPack): string[] {
  const shipped = new Set(pack.assets.map((asset) => asset.to));
  return pack.episodes.flatMap((episode) =>
    episode.offers.flatMap((offer) =>
      offer.pictures.flatMap((picture) =>
        picture.asset && !shipped.has(picture.asset) ? [picture.asset] : [],
      ),
    ),
  );
}
