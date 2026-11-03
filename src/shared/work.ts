import { z } from "zod";
import { CARD_MEDIA_KINDS, CARD_MEDIA_PIECE_BYTES, CARD_TYPEFACE_KINDS } from "./cardPictures";
import { cardEffectSchema, cardPictureSchema, riskDeclarationSchema } from "./cards";
import { openChangeInputSchema, stagedChangePresentationSchema } from "./changePresentation";
import {
  CHECK_DECLARATION_VERDICTS,
  LEGACY_NO_IMPACT,
  MERGE_GUIDANCE_IMPACTS,
} from "./checkRepair";
import { crewResponseSchema } from "./crewResponses";
import { crewSpeedSchema, speedSelectionSchema } from "./crewSpeed";
import { cutOffSchema, fmEventSchema } from "./events";
import { keptValidationInputSchema } from "./liveValidation";
import {
  PLACEMENT_FACTS_ORDER,
  placementFactsAnswerSchema,
  placementFactsRequestSchema,
} from "./placement";
import { reasoningSchema } from "./reasoning";
import { keptRecoveryWaySchema, workWaitSchema } from "./recovery";
import { requiredActionsSchema } from "./requiredActions";
import { runbookSkillFilesSchema } from "./runbooks";
import { sourceIdentitySchema } from "./selfSource";
import {
  heldSignInSchema,
  taskBrowserCommandResultSchema,
  taskBrowserFactSchema,
  taskBrowserFrameSchema,
  taskBrowserHandleSchema,
  taskBrowserInputSchema,
  taskBrowserRequestSchema,
  taskBrowserSizeSchema,
} from "./taskBrowser";
import { firstReleaseReportSchema } from "./taskRelease";
import { toolObservationSchema } from "./toolCompletion";

/**
 * A crewmate's conversation held on a computer that runs work (piece 8,
 * docs/helper.md "Holding a conversation"), as the shapes both sides of the
 * connection parse. Nothing here is a new kind of message: both directions
 * ride the connection's own `invoke` and `result` (src/shared/connection.ts).
 *
 * - **Work requests**, asked by the computer of its home: one per tool
 *   callback a crewmate's tools hand the host (a card, a report, a
 *   follow-up, ...), a card picture's bytes, a background job's end, and the
 *   numbered events of what the conversation did. They are core channels in
 *   `src/shared/ipc.ts` whose `reach` is `work`. Each carries the task and a
 *   `callId` the computer chose once; after a drop it asks again under the
 *   same `callId`, and the home answers a repeat from what it kept.
 * - **Orders**, asked by the home of the computer: open a conversation,
 *   prompt it, steer it, abort, detach or close it, list what the computer
 *   holds, and copy a conversation's record; and make, read, keep and
 *   retire the task's working copy there (piece 10, docs/helper.md "Its
 *   working copies"). Each that acts carries an `orderId` taken from
 *   something the home saved, and the computer answers a repeat without
 *   acting again.
 *
 * The crewmate's tools run on the computer, where its files are; only what a
 * tool hands the host crosses. The computer asks nothing until a home has
 * opened a conversation on it, so a home that never does never sees a work
 * request.
 */

/** A task id as the home mints it; it names a folder on the computer, so nothing else passes. */
export const placedTaskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** The computer's own id for one callback, the same each time it asks again. */
export const workCallIdSchema = z.string().min(1).max(128);

/**
 * An order's id, taken from what the home saved before it asked: the inbox
 * rows a prompt or steer delivers, the task event that asked to stop.
 */
export const workOrderIdSchema = z.string().min(1).max(4096);

/** The most events one `inf:work:events` request carries. */
export const PLACED_EVENTS_MAX_PER_REQUEST = 512;

/**
 * The most bytes one answer or order carries of a file that crosses in
 * pieces: a conversation's record (`inf:session:copy`), a git bundle
 * (`inf:working-copy:read`), a downloaded artifact (`inf:working-copy:artifact`).
 */
export const PLACED_COPY_CHUNK_BYTES = 4 * 1024 * 1024;

/** A card picture's or project font's bytes, base64: room for the card tool's 8 MiB cap. */
const PICTURE_DATA_MAX_CHARS = 11_200_000;

/** One piece of a demo recording, base64: room for `CARD_MEDIA_PIECE_BYTES`. */
const RECORDING_PIECE_MAX_CHARS = Math.ceil(CARD_MEDIA_PIECE_BYTES / 3) * 4;
/** A demo recording's whole size: the card tool's 16 MiB cap. */
const RECORDING_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Where a computer keeps one task's conversation, under the folder its
 * roster names (`tasksDir`), and its working copy, under the folder the
 * roster names for those (`worktreesDir`). The home writes the crewmate's
 * instructions with these paths, so the crewmate reads the folders it
 * actually has. Both sides are Macs, so the separator is a slash.
 */
export function placedTaskFolders(tasksDir: string, task: string, worktreesDir?: string) {
  const root = `${tasksDir}/${task}`;
  return {
    root,
    /**
     * The working copy: the task's own git worktree there, or an empty
     * folder of the conversation's on a computer that keeps none.
     */
    work: worktreesDir ? `${worktreesDir}/${task}` : `${root}/work`,
    /** The conversation's record, which the home copies at each turn's end. */
    sessions: `${root}/sessions`,
    /** The verified copies of the pictures its cards name. */
    cards: `${root}/cards`,
    cardBodies: `${root}/card-bodies`,
    sourceCards: `${root}/source-cards`,
    evidence: `${root}/evidence`,
    /** Bulk working material. Removed when the task closes, not after a week. */
    temp: `${root}/temp`,
  };
}

const modelRefSchema = z.object({ provider: z.string().min(1), id: z.string().min(1) });

const sessionImageSchema = z.object({
  mimeType: z.string().min(1).max(64),
  data: z.string().min(1).max(PICTURE_DATA_MAX_CHARS),
});

const controlProfileSchema = z.object({
  steer: z.enum(["native", "followup-queue"]),
  interruptGranularity: z.enum(["turn", "process"]),
  quotaEvents: z.boolean(),
  backgroundWork: z.enum(["host", "client"]),
  failureSignals: z.enum(["typed", "text"]),
});

/**
 * What a held conversation is now, as the computer last saw it: what the
 * home's stand-in for the session answers from without asking.
 */
export const placedStateSchema = z.object({
  sessionId: z.string(),
  backend: z.enum(["pi", "claude"]),
  controlProfile: controlProfileSchema,
  streaming: z.boolean(),
  /** Where it resumes from on the computer: its record file, or its Claude session id. */
  resume: z.string().optional(),
  /**
   * Its record, by its path under the task's `sessions` folder: the name the
   * home's copy of it goes by (`inf:session:copy`).
   */
  record: z.string().min(1).max(1024).optional(),
  model: modelRefSchema.optional(),
  modelLabel: z.string().optional(),
  reasoning: reasoningSchema.optional(),
  /**
   * The session this one started over from, when an open renewed it, until
   * a turn of the new conversation finishes: a home that opens it before
   * then, here or again after a restart, has yet to tell the crewmate why.
   */
  renewal: z
    .object({ from: z.string(), changed: z.array(z.enum(["prompt", "instructions"])) })
    .optional(),
  /**
   * The computer's own account the conversation is bound to there, which its
   * usage and a cut-off it meets belong to; never one of the home's. Absent
   * when it is bound to none of the computer's accounts (Claude on that
   * user's login, with no account of Firstmate's there), or from a computer
   * older than this.
   */
  accountId: z.string().min(1).max(256).optional(),
});
export type PlacedState = z.infer<typeof placedStateSchema>;

/**
 * What the home opens a conversation with. The binding crosses as a
 * description, and the computer resolves it with its own sign-ins; the
 * instructions are the home's, written with the computer's folders; `tools`
 * names the crewmate tools to bind, each to callbacks that ask the home.
 */
export const placedSpecSchema = z.object({
  /** Home build identity only; each computer resolves its own source path. */
  homeSource: sourceIdentitySchema.optional(),
  /** Resolve the home’s saved speed before each request; eligibility stays on this computer. */
  speed: z.boolean().optional(),
  binding: z.object({
    backend: z.enum(["pi", "claude"]),
    accountId: z.string().min(1).max(256).optional(),
    provider: z.string().min(1).max(256).optional(),
  }),
  model: modelRefSchema.optional(),
  thinking: z.object({
    level: z.enum(["low", "medium", "high", "xhigh", "off"]),
    quick: z.boolean().optional(),
  }),
  instructions: z.string(),
  /** Only the opt-in travels; each computer reads its own user files. */
  personalResources: z.boolean().optional(),
  runbookSkills: z.array(runbookSkillFilesSchema).optional(),
  tools: z.array(z.string().min(1).max(64)).max(64),
  /** The conversation to reopen, as the computer named it in an earlier state. */
  resume: z.string().min(1).max(4096).optional(),
  /** The provider's retries before a turn fails. */
  retries: z.number().int().nonnegative().max(16).optional(),
  /**
   * The task has its own browser on that computer (docs/task-browser.md,
   * "On another computer"): its crewmate's shell is given `infinitary-browser-axi`
   * and its `emit_card` the browser's door and handoff. The home sends it
   * only to a computer whose roster says it keeps task browsers.
   */
  browser: z.boolean().optional(),
  /**
   * The task's crewmate reaches the home's integrations through
   * `infinitary-integrations-axi` in its shell there, each list, show and
   * call asked of the home (`inf:work:integrations`,
   * `inf:work:use-integration`; docs/integrations.md, "On a computer that
   * runs work"). The home sends it only to a computer that lists the
   * `integrations-there` change and keeps task browsers, whose task channel
   * the command rides.
   */
  integrations: z.boolean().optional(),
  /** The named heavy-run-line change grants this computer's load command. */
  load: z.boolean().optional(),
});
export type PlacedSpec = z.infer<typeof placedSpecSchema>;

/**
 * Everything a held conversation tells its home, in order: what a session
 * tells its owner (`SessionEvent`, src/core/session/session.ts), plus where
 * each prompt's turn starts and ends. `turn_ended` carries the steers no turn
 * took in and the state after it, and `interrupted` when the computer quit
 * mid-turn.
 */
export const placedEventSchema = z.union([
  toolObservationSchema,
  fmEventSchema,
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("background_work_changed"),
      count: z.number().int().nonnegative().optional(),
      /**
       * A Pi conversation's longest-running shell job there, by its id and
       * command, while the count is above zero (`background-job-named.md`).
       */
      job: z.object({ id: z.string().min(1), command: z.string() }).optional(),
    }),
    z.object({ type: z.literal("turn_closed"), text: z.string().optional() }),
    z.object({ type: z.literal("request_started") }),
    z.object({ type: z.literal("input_read"), textSha256: z.string() }),
    z.object({ type: z.literal("continuation_started") }),
    z.object({
      type: z.literal("continuation_ended"),
      /** The helper ended this work on shutdown/recovery; the home supplies its computer's name. */
      interrupted: z.literal(true).optional(),
      error: z.string().optional(),
      cutOff: cutOffSchema.optional(),
    }),
    z.object({
      type: z.literal("model_served"),
      model: z.object({ provider: z.string(), id: z.string() }),
      fallback: z
        .object({
          from: z.object({ provider: z.string(), id: z.string() }),
          category: z.string().optional(),
        })
        .optional(),
    }),
    z.object({
      type: z.literal("turn_started"),
      turn: z.number().int().positive(),
      orderId: workOrderIdSchema,
    }),
    z.object({
      type: z.literal("turn_ended"),
      turn: z.number().int().positive(),
      outcome: z.enum(["done", "failed", "interrupted"]),
      error: z.string().optional(),
      undelivered: z.array(z.string()),
      state: placedStateSchema.optional(),
    }),
  ]),
]);
export type PlacedEvent = z.infer<typeof placedEventSchema>;

/** One numbered event: counted per task from 1, with the computer's own time. */
export const placedEventRecordSchema = z.object({
  seq: z.number().int().positive(),
  at: z.number(),
  event: placedEventSchema,
});
export type PlacedEventRecord = z.infer<typeof placedEventRecordSchema>;

/** The answer to `inf:work:events`: what the home took in, and what it keeps for good. */
export const placedEventsAnswerSchema = z.object({
  /** The newest number the home has; the computer sends on from the next. */
  through: z.number().int().nonnegative(),
  /** The newest number the home will never ask for again; the computer may forget up to it. */
  kept: z.number().int().nonnegative(),
});
export type PlacedEventsAnswer = z.infer<typeof placedEventsAnswerSchema>;

const toolTextSchema = z.object({ text: z.string() });
const doneSchema = z.object({ ok: z.literal(true) });

/**
 * A file one task hands another, by its kept name (`handover-files.md`,
 * INF-992): its sha256's first sixteen digits, then its own name reduced
 * to letters, digits, `_` and `-`, with one extension.
 */
export const HANDOVER_FILE_NAME = /^[0-9a-f]{16}-[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9]{1,16}$/;

/** A handed file as a report declares it: never its content, only its kept name, size and sha256. */
export const handoverFileSchema = z.object({
  file: z.string().regex(HANDOVER_FILE_NAME),
  size: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type HandoverFile = z.infer<typeof handoverFileSchema>;

/** One callback's request: its task, its call, and what the tool handed over. */
function asked<T extends z.ZodRawShape>(shape: T) {
  return z.tuple([z.object({ task: placedTaskIdSchema, callId: workCallIdSchema, ...shape })]);
}

/**
 * A card a crewmate on that computer emitted, as declared: an action may come
 * without a label, which the home's host words or refuses (FI3-249).
 */
export const placedCardSchema = z.object({
  title: z.string(),
  body: z.string(),
  actions: z.array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      default: z.boolean().optional(),
      effect: cardEffectSchema.optional(),
      danger: z.boolean().optional(),
    }),
  ),
  id: z.string().optional(),
  pictures: z.array(cardPictureSchema).optional(),
  presentationRevision: z.number().int().positive().optional(),
  width: z.enum(["wide", "full"]).optional(),
  holdsPlace: z.boolean().optional(),
  reply: z.string().optional(),
  riskDeclaration: riskDeclarationSchema.optional(),
  requiredActions: requiredActionsSchema.optional(),
  asking: z.boolean().optional(),
  designOnly: z.boolean().optional(),
  /** The choice on it is not its task's answer (INF-1226, `Card.continues`). */
  continues: z.boolean().optional(),
  /** It answers the captain's message it is about (INF-1610, `Card.answering`). */
  answering: z.boolean().optional(),
  /** The label of the card's door to its task's browser, from a crewmate whose task has one there. */
  browserButton: z.string().optional(),
  /** Its request that the captain take its browser over (docs/task-browser.md, "Asking for help"). */
  browserHandoff: z
    .object({
      site: z.string(),
      reason: z.string(),
      after: z.string(),
      /** The saved sign-in its browser was given did not sign the page in (docs/task-browser.md, "Saved sign-ins"). */
      savedFailed: z.literal(true).optional(),
    })
    .optional(),
  /** Bind the shown ordinary action to a recorded validation request. */
  /** INF-1824: `gaps` names further gaps of the same version, drawn as one checklist. */
  validationDecision: z
    .object({ request: z.string(), action: z.string(), gaps: z.array(z.string()).optional() })
    .optional(),
  /** The page from its task's project that its browser button opens (docs/task-browser.md, "A page from the project"). */
  browserPage: z.string().optional(),
});

const cardRefusalReasonSchema = z.enum(["checks", "ci-cap", "review", "shape", "other"]);

/** A card answer: shown, or refused with the typed reason a completion card's refusal keeps. */
export const placedCardAnswerSchema = z.union([
  z.object({ shown: z.literal(true), cardId: z.string().optional() }),
  z.object({
    refused: z.object({ message: z.string(), reason: cardRefusalReasonSchema, why: z.string() }),
  }),
]);
export type PlacedCardAnswer = z.infer<typeof placedCardAnswerSchema>;

/** A commit as git names it in full. */
const commitSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

/** An exact commit of another task on this computer, never that task's uncommitted files. */
export const workingCopyBaseSchema = z.object({
  task: placedTaskIdSchema,
  headSha: commitSchema,
  /** The last base assigned to this copy; refuse to replace any other commits. */
  previousHead: commitSchema.optional(),
});
export type WorkingCopyBase = z.infer<typeof workingCopyBaseSchema>;

/** check_change's declarations, as the crewmate's tool takes them (src/shared/checkRepair.ts). */
const checkChangeInputSchema = z.object({
  change: z.string().optional(),
  declaration: z
    .object({
      headSha: z.string(),
      verdict: z.enum(CHECK_DECLARATION_VERDICTS),
      evidence: z.string(),
      check: z.string().optional(),
      repairId: z.string().optional(),
      outcome: z.enum(["passed", "failed", "superseded", "void"]).optional(),
    })
    .optional(),
  pull: z.number().int().min(1).optional(),
  absentChecks: z
    .object({ headSha: z.string(), evidence: z.string(), localGate: z.string() })
    .optional(),
  skipRules: z.object({ headSha: z.string(), method: z.literal("squash") }).optional(),
  diagnosis: z
    .object({
      headSha: z.string(),
      check: z.string(),
      classification: z.enum(["own-regression", "baseline-blocked", "suspected-flake", "unknown"]),
      evidence: z.string(),
      dependencyTask: z.string().optional(),
      changedTest: z.boolean().optional(),
    })
    .optional(),
  repair: z
    .object({
      id: z.string(),
      sourceHead: z.string(),
      headSha: z.string(),
      check: z.string(),
      evidence: z.string(),
    })
    .optional(),
  rerun: z.object({ headSha: z.string(), check: z.string(), evidence: z.string() }).optional(),
  conflictRepair: z
    .object({
      fromHead: z.string(),
      toHead: z.string(),
      newBase: z.string(),
      // `none` travels by its older name, so this shape is the one every
      // build on this contract admits (`wireRepairImpact`, INF-493).
      impact: z.enum([LEGACY_NO_IMPACT, "changed-work", "unknown"]),
      changedPaths: z.array(z.string()),
      evidence: z.string(),
      validation: z.string(),
    })
    .optional(),
  captainGuidance: z
    .object({
      mark: z.number().int().min(1),
      impact: z.enum(MERGE_GUIDANCE_IMPACTS),
      evidence: z.string(),
    })
    .optional(),
});

/**
 * A read of the home's knowledge, as the `knowledge` tool hands it to the
 * host (`KnowledgeReadInput`, docs/knowledge.md "The tools"). The home's
 * `KnowledgeService` checks the rest, as it does for a crewmate of its own.
 */
const knowledgeReadInputSchema = z.object({
  action: z.enum(["search", "get", "neighbors", "history"]),
  query: z.string().optional(),
  ids: z.array(z.string()).optional(),
  id: z.string().optional(),
  revision: z.number().int().min(1).optional(),
  scope: z.string().optional(),
  cursor: z.string().optional(),
});

/**
 * One answer of the home's integrations, as a crewmate's
 * `infinitary-integrations-axi` prints it (docs/integrations.md, "On a
 * computer that runs work"): structured rows, a call's words, or a
 * refusal's. It is what the home's integrations said, never a sign-in.
 */
const integrationAnswerSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  text: z.string().optional(),
  refused: z.enum(["refused", "invalid"]).optional(),
});

/** One source a write cites, as the tool names it; the home keeps or refuses it. */
const knowledgeSourceInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
  z.object({ kind: z.literal("report"), task: z.string() }),
  z.object({ kind: z.literal("quote"), text: z.string(), citation: z.string() }),
  z.object({
    kind: z.literal("article"),
    url: z.string(),
    title: z.string(),
    excerpt: z.string(),
    author: z.string().optional(),
    published: z.string().optional(),
  }),
]);

/** A write to the home's knowledge, as the `record_knowledge` tool hands it to the host (`RecordInput`). */
const recordKnowledgeInputSchema = z.object({
  action: z.enum(["publish", "revise", "assess", "relate", "retire", "retire_many", "use"]),
  requestId: z.string(),
  kind: z.enum(["concept", "finding", "direction"]).optional(),
  lane: z.enum(["personal", "reference"]).optional(),
  id: z.string().optional(),
  expectedRevision: z.number().int().min(1).optional(),
  revision: z.number().int().min(1).optional(),
  scope: z.string().optional(),
  title: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  explanation: z.string().optional(),
  links: z.array(z.object({ to: z.string(), reason: z.string() })).optional(),
  statement: z.string().optional(),
  basis: z.enum(["observation", "inference"]).optional(),
  about: z.array(z.string()).optional(),
  relationship: z.object({ from: z.string(), predicate: z.string(), to: z.string() }).optional(),
  conditions: z.string().optional(),
  appliesTo: z.array(z.string()).optional(),
  sources: z.array(knowledgeSourceInputSchema).optional(),
  verdict: z.enum(["supports", "contradicts", "inconclusive"]).optional(),
  method: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  type: z.enum(["related", "contradicts", "supersedes", "duplicates"]).optional(),
  reason: z.string().optional(),
  purpose: z.string().optional(),
  task: z.string().optional(),
  ids: z.array(z.string()).optional(),
  except: z.array(z.string()).optional(),
});

/**
 * The work requests a computer that runs work asks its home, declared into
 * `invokeContract` (src/shared/ipc.ts) with `reach: "work"`.
 */
export const workRequests = {
  "inf:work:card": {
    effect: "change",
    request: asked({ card: placedCardSchema }),
    response: placedCardAnswerSchema,
  },
  "inf:work:card-refused": {
    effect: "change",
    request: asked({
      refusal: z.object({ title: z.string(), reason: cardRefusalReasonSchema, why: z.string() }),
    }),
    response: doneSchema,
  },
  "inf:work:close-card": {
    effect: "change",
    request: asked({ cardId: z.string(), reason: z.string().optional() }),
    response: toolTextSchema,
  },
  "inf:work:followup": {
    effect: "change",
    request: asked({
      input: z.object({
        title: z.string(),
        goal: z.string(),
        why: z.string(),
        blocksMe: z.boolean().optional(),
        testFailure: z.boolean().optional(),
        testPath: z.string().optional(),
      }),
    }),
    response: toolTextSchema,
  },
  "inf:work:progress": {
    effect: "change",
    request: asked({
      text: z.string(),
      plan: z
        .array(
          z.object({
            label: z.string(),
            short: z.string(),
            state: z.enum(["done", "current", "next", "skipped"]),
          }),
        )
        .optional(),
    }),
    response: toolTextSchema,
  },
  "inf:work:report": {
    effect: "change",
    request: asked({
      text: z.string(),
      summary: z.string().optional(),
      declared: z
        .object({
          responses: z.array(crewResponseSchema).optional(),
          firstRelease: firstReleaseReportSchema.optional(),
          validation: keptValidationInputSchema.optional(),
          workWait: workWaitSchema.optional(),
          recoveryWays: z.array(keptRecoveryWaySchema).optional(),
          wait: z.object({ reason: z.string(), cardId: z.string().optional() }).optional(),
          finished: z.boolean().optional(),
          mergeCompletesTask: z
            .object({
              prNumber: z.number().int().positive(),
              headSha: z.string().regex(/^[a-f0-9]{40,64}$/),
            })
            .optional(),
          needsFirstmate: z.string().optional(),
          /** When it looks at its running job again (`report-check-back.md`); the home keeps it. */
          checkBack: z.object({ minutes: z.number(), waitingFor: z.string() }).optional(),
          /** The report's typed result (`report-result.md`); the home checks it. */
          result: z.record(z.string(), z.unknown()).optional(),
          /** Files it hands on (`handover-files.md`), sent home before the report. */
          files: z.array(handoverFileSchema).optional(),
        })
        .optional(),
    }),
    response: toolTextSchema,
  },
  "inf:work:reply": {
    effect: "change",
    /** `interim` marks a still-working line (`work-reply-interim.md`); an older home drops it. */
    request: asked({ cardId: z.string(), text: z.string(), interim: z.boolean().optional() }),
    response: toolTextSchema,
  },
  "inf:work:speed-note": {
    effect: "change",
    request: asked({ model: modelRefSchema, selection: speedSelectionSchema }),
    response: doneSchema,
  },
  "inf:work:speed": {
    effect: "read",
    request: asked({ model: modelRefSchema }),
    response: crewSpeedSchema,
  },
  "inf:work:tasks": {
    effect: "read",
    request: asked({
      input: z.object({
        project: z.string().optional(),
        status: z.enum(["open", "active", "done", "dropped", "live", "closed"]).optional(),
        key: z.string().optional(),
        field: z.string().optional(),
        text: z.string().optional(),
        parent: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        skip: z.number().int().nonnegative().optional(),
        // One cut of a list that stops short, and its later pages (`task-list-snapshot.md`).
        snapshot: z.boolean().optional(),
        ids: z.array(z.string()).max(100).optional(),
        // Every project and its folder instead of tasks (`project-folders.md`).
        projects: z.boolean().optional(),
      }),
    }),
    response: z.object({
      rows: z.array(z.record(z.string(), z.unknown())),
      total: z.number().int().nonnegative(),
      projects: z
        .array(z.object({ key: z.string(), name: z.string(), folder: z.string().optional() }))
        .optional(),
      order: z.array(z.string()).optional(),
    }),
  },
  "inf:work:read-workflow": {
    effect: "read",
    request: asked({
      input: z.object({
        runId: z.number().int().positive(),
        // Omitted for the run's short read, which saves the home's run watch (since 8.5).
        jobId: z.number().int().positive().optional(),
        offset: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    }),
    response: toolTextSchema,
  },
  "inf:work:github-read": {
    effect: "read",
    request: asked({
      input: z.object({ path: z.string(), method: z.enum(["GET", "HEAD"]).optional() }),
    }),
    response: toolTextSchema,
  },
  "inf:work:github-write": {
    effect: "change",
    request: asked({
      input: z.object({
        method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
        path: z.string(),
        body: z.string().optional(),
        validationEffect: z.string().optional(),
      }),
    }),
    response: toolTextSchema,
  },
  /**
   * open_change: the home offers the task's branch where the project lives,
   * with its own sign-in, once it has brought the branch home.
   */
  "inf:work:prepare-change": {
    effect: "change",
    request: asked({ input: stagedChangePresentationSchema }),
    response: toolTextSchema,
  },
  "inf:work:open-change": {
    effect: "change",
    request: asked({ input: openChangeInputSchema }),
    response: toolTextSchema,
  },
  /** check_change: the home reads the change's checks, and records what the crewmate declared. */
  "inf:work:check-change": {
    effect: "change",
    request: asked({ input: checkChangeInputSchema }),
    response: toolTextSchema,
  },
  /**
   * download_artifact: the home downloads it with its own sign-in and
   * writes it into the task's working copy here (`inf:working-copy:artifact`)
   * before it answers.
   */
  "inf:work:download-artifact": {
    effect: "change",
    request: asked({
      input: z.object({
        runId: z.number().int().positive(),
        artifactId: z.number().int().positive(),
        /** One exact member streamed into task evidence (workflow-evidence-file). */
        file: z.string().min(1).max(4096).optional(),
        /** The archive's files instead of saving anything (`artifact-parts`). */
        list: z.boolean().optional(),
        /** Paths inside the archive to save, or to narrow a listing to (`artifact-parts`). */
        files: z.array(z.string().min(1).max(4096)).optional(),
        /** The listing's first file, 1-based (`artifact-parts`). */
        offset: z.number().int().positive().optional(),
      }),
    }),
    response: toolTextSchema,
  },
  /**
   * knowledge: the home reads its own knowledge for the crewmate, as the
   * reader it binds for a crewmate of its own (docs/knowledge.md, "Who has
   * it"), from `KNOWLEDGE_THERE_SINCE` on.
   */
  "inf:work:knowledge": {
    effect: "read",
    request: asked({ input: knowledgeReadInputSchema }),
    response: toolTextSchema,
  },
  /**
   * record_knowledge: the home writes its own knowledge for the crewmate, under the same rules.
   * It repeats safely: knowledge keeps its own request id, so a cut-off is asked again.
   */
  "inf:work:record-knowledge": {
    effect: "change",
    repeats: "safe",
    request: asked({ input: recordKnowledgeInputSchema }),
    response: toolTextSchema,
  },
  /**
   * The integrations command's list, with no name, and its show: the home
   * reads its own integrations for the crewmate, as for a crewmate of its
   * own (docs/integrations.md, "On a computer that runs work"), from the
   * `integrations-there` change on.
   */
  "inf:work:integrations": {
    effect: "read",
    request: asked({ input: z.object({ name: z.string().optional() }) }),
    response: integrationAnswerSchema,
  },
  /**
   * The integrations command's call: the home runs one action with its own
   * sign-in under the task's rules - a read runs, a change is kept as an ask
   * the captain's click sends - and answers with its words.
   */
  "inf:work:use-integration": {
    effect: "change",
    request: asked({
      input: z.object({
        name: z.string(),
        action: z.string(),
        input: z.unknown(),
        reason: z.string().optional(),
      }),
    }),
    response: integrationAnswerSchema,
  },
  /** One card picture's verified copy, asked before the card that names it. */
  "inf:work:picture": {
    effect: "change",
    repeats: "safe",
    request: asked({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}-[0-9a-f]{32}$/),
      extension: z.enum(["png", "jpg", "webp"]),
      data: z.string().min(1).max(PICTURE_DATA_MAX_CHARS),
    }),
    response: doneSchema,
  },
  /**
   * One piece of a card's demo recording, asked in order after its poster
   * and before the card that names it (docs/helper.md): the home keeps the
   * recording once its last piece arrives.
   */
  "inf:work:media": {
    effect: "change",
    repeats: "safe",
    request: asked({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}-[0-9a-f]{32,64}$/),
      extension: z.enum([...CARD_MEDIA_KINDS, "png", "jpg", "webp", "txt", "json", "log"]),
      offset: z.number().int().nonnegative(),
      size: z.number().int().positive().max(RECORDING_MAX_BYTES),
      data: z.string().min(1).max(RECORDING_PIECE_MAX_CHARS),
    }),
    response: doneSchema,
  },
  /**
   * One piece of a file a crewmate's report hands on (`handover-files.md`,
   * INF-992), asked in order before that report: the home keeps the file
   * once its last piece arrives whole, checked against its sha256. Its
   * content is never logged or printed on either side.
   */
  "inf:work:handover-file": {
    effect: "change",
    repeats: "safe",
    request: asked({
      file: z.string().regex(HANDOVER_FILE_NAME),
      size: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024 * 1024),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      offset: z.number().int().nonnegative(),
      data: z
        .string()
        .min(1)
        .max(Math.ceil(PLACED_COPY_CHUNK_BYTES / 3) * 4),
    }),
    response: doneSchema,
  },
  /**
   * One project font's verified copy, asked before the card whose preview
   * names it (docs/helper.md), from `CARD_TYPEFACES_SINCE` on.
   */
  "inf:work:typeface": {
    effect: "change",
    repeats: "safe",
    request: asked({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}-[0-9a-f]{32}$/),
      extension: z.enum(CARD_TYPEFACE_KINDS),
      data: z.string().min(1).max(PICTURE_DATA_MAX_CHARS),
    }),
    response: doneSchema,
  },
  /**
   * A background job the crewmate's shell started there ended; its `callId`
   * is `job:<id>`. With `interrupted`, from protocol 8.15, it never exited:
   * that computer's run ended first, and its next start says so once -
   * `quit` when the run's own stop killed it, `crash` when the run ended
   * without one, so the command may have run on. A background task its
   * Claude client ran there comes only so, by the id its model was given,
   * with its description as the command; from protocol 9.2
   * (`CLIENT_JOB_ENDS_SINCE`), `client` when the client ended with it while
   * that computer ran on.
   */
  "inf:work:job-exit": {
    effect: "change",
    request: asked({
      exit: z.object({
        jobId: z.string().min(1).max(64),
        command: z.string(),
        exitCode: z.number().int().nullable(),
        durationMs: z.number().nonnegative(),
        tail: z.string(),
        interrupted: z.enum(["quit", "crash", "client"]).optional(),
      }),
    }),
    response: doneSchema,
  },
  /**
   * A task's browser there, as the captain reads it, each time it changes
   * (docs/task-browser.md, "On another computer"): asked once, while the
   * home is in reach and never again, since the next one says it whole;
   * null once that computer keeps no fact of it.
   */
  "inf:work:browser": {
    effect: "change",
    request: z.tuple([
      z.object({ task: placedTaskIdSchema, fact: taskBrowserFactSchema.nullable() }),
    ]),
    response: doneSchema,
  },
  /** A live read only: credentials never enter the durable conversation ledger. */
  "inf:work:browser-sign-in": {
    effect: "read",
    request: z.tuple([z.object({ task: placedTaskIdSchema, site: z.string().min(1) })]),
    response: z.object({
      signIn: heldSignInSchema
        .extend({
          site: z.string(),
          id: z.string(),
          savedAt: z.number(),
          automatic: z.literal(true),
        })
        .optional(),
    }),
  },
  /** One picture of a task's page while the captain watches it there; asked once, like the fact. */
  "inf:work:browser-frame": {
    effect: "change",
    request: z.tuple([
      z.object({
        task: placedTaskIdSchema,
        frame: taskBrowserFrameSchema.omit({ taskId: true }),
      }),
    ]),
    response: doneSchema,
  },
  /**
   * What a task's browser there has the home do, each once under its
   * `callId`: one line on its timeline, its crewmate's wake once the
   * captain handed it back, or its saved sign-in copied back into the save
   * the home lent it or made from it as it stops.
   */
  "inf:work:browser-event": {
    effect: "change",
    request: asked({
      event: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("note"), text: z.string().min(1).max(2_000) }),
        z.object({
          kind: z.literal("returned"),
          site: z.string(),
          after: z.string().optional(),
          saved: z.literal(true).optional(),
          once: z.string().min(1).max(512),
        }),
        z.object({
          kind: z.literal("sign-in"),
          site: z.string().min(1),
          id: z.string().min(1).max(128),
          held: heldSignInSchema,
        }),
      ]),
    }),
    response: doneSchema,
  },
  /**
   * What the conversation did, numbered: one request at a time per task, in
   * order, from the number after the last answer's `through`.
   */
  "inf:work:events": {
    effect: "change",
    request: z.tuple([
      z.object({
        task: placedTaskIdSchema,
        events: z.array(placedEventRecordSchema).min(1).max(PLACED_EVENTS_MAX_PER_REQUEST),
      }),
    ]),
    response: placedEventsAnswerSchema,
  },
} as const satisfies Record<
  `inf:work:${string}`,
  {
    effect: "read" | "change";
    /** A change that may be asked again: a cut-off is safe, and the home marks none begun. */
    repeats?: "safe";
    request: z.ZodType;
    response: z.ZodType;
  }
>;

/** The declaration as the invoke contract publishes it: the repeat rule stays off the wire. */
export function workRequestWire<C extends keyof typeof workRequests>(channel: C) {
  const declared = workRequests[channel];
  if (!("repeats" in declared)) return declared;
  const { repeats: _repeats, ...wire } = declared;
  return wire;
}

/** Whether a cut-off of this request is safe to ask again, from its own declaration. */
export function requestRepeatsSafely(channel: string): boolean {
  const declared = workRequests[channel as keyof typeof workRequests];
  return declared !== undefined && "repeats" in declared && declared.repeats === "safe";
}

/** One order's task and id: every order that acts carries both. */
function ordered<T extends z.ZodRawShape>(shape: T) {
  return z.tuple([z.object({ orderId: workOrderIdSchema, task: placedTaskIdSchema, ...shape })]);
}

/** One conversation as the computer's roster lists it. */
export const placedRosterTaskSchema = z.object({
  task: placedTaskIdSchema,
  /** A conversation is open there now. */
  open: z.boolean(),
  /** The home closed it; it opens no more. */
  closed: z.boolean(),
  /** The turn running now, and the order that started it. */
  running: z.object({ turn: z.number().int().positive(), orderId: workOrderIdSchema }).optional(),
  /** The newest event number it has written. */
  seq: z.number().int().nonnegative(),
  state: placedStateSchema.optional(),
  /** Its working copy is there, not yet retired (`inf:working-copy:retire`). */
  workingCopy: z.boolean().optional(),
});
export type PlacedRosterTask = z.infer<typeof placedRosterTaskSchema>;

/** The commit a task's working copy started from, and whether it was fetched first. */
const dispatchBaseSchema = z.object({
  sha: z.string(),
  ref: z.string(),
  fetch: z.enum(["fetched", "failed", "none"]),
  fetchError: z.string().optional(),
});

/** What a task's work saved as one commit on its kept ref before its working copy goes. */
export const keptWorkSchema = z.object({
  ref: z.string().min(1).max(256),
  sha: commitSchema,
  dirty: z.boolean(),
  unlandedCommits: z.number().int().nonnegative(),
});

/** A git bundle waiting there to be read home (`inf:working-copy:read`). */
const bundleSchema = z.object({
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Which of a task's refs a bundle carries: its branch, or the commit its work was kept in. */
export const bundledRefSchema = z.enum(["branch", "kept"]);
export type BundledRef = z.infer<typeof bundledRefSchema>;

/** What `read` reads: a bundle, or the pack of a task that moves (`task-move`). */
export const readableRefSchema = z.enum(["branch", "kept", "move"]);
export type ReadableRef = z.infer<typeof readableRefSchema>;

/** A file the home sent as a source file (`inf:session:source-file`), by its name there. */
const sourceFileSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/)
    .max(200),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const sourceFileFields = {
  task: placedTaskIdSchema,
  name: z
    .string()
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/)
    .max(200),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  offset: z.number().int().nonnegative(),
  data: z.string().max(Math.ceil(PLACED_COPY_CHUNK_BYTES / 3) * 4),
  /** A file another task handed this one, kept in temporary storage. */
  into: z.enum(["handover"]).optional(),
};

/**
 * The orders a home asks a computer that runs work. The computer answers
 * them; the home sends them only to a computer whose welcome says it takes
 * work (`takesWork`, src/shared/ipc.ts).
 */
export const workOrders = {
  [PLACEMENT_FACTS_ORDER]: {
    effect: "read",
    request: z.tuple([placementFactsRequestSchema]),
    response: placementFactsAnswerSchema,
  },
  /** Verified source-card files, media and git bundles kept outside the working copy. */
  "inf:session:source-file": {
    effect: "change",
    request: z.tuple([
      z.union([
        // Streaming evidence has no whole-file memory allocation or legacy size bound.
        z.object({
          ...sourceFileFields,
          size: z.number().int().nonnegative(),
          evidence: z.literal(true),
        }),
        z.object({
          ...sourceFileFields,
          size: z
            .number()
            .int()
            .nonnegative()
            .max(1024 * 1024 * 1024),
          evidence: z.never().optional(),
        }),
      ]),
    ]),
    response: z.object({ file: z.string(), complete: z.boolean() }),
  },
  /** Imports a verified source bundle into this task's repository, never its checked-out branch. */
  "inf:working-copy:source-ref": {
    effect: "change",
    request: z.tuple([
      z.object({
        task: placedTaskIdSchema,
        name: z
          .string()
          .regex(/^[A-Za-z0-9_-]+\.bundle$/)
          .max(200),
        // Infinitary's refs from INFINITARY_REFS_SINCE on, Firstmate 3000's always.
        from: z.string().regex(/^refs\/(heads|infinitary\/kept|fm3000\/kept)\/[A-Za-z0-9_/-]+$/),
        to: z.string().regex(/^refs\/(infinitary|fm3000)\/sources\/[A-Za-z0-9_-]+$/),
        sha: z.string().regex(/^[0-9a-f]{40,64}$/),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    ]),
    response: z.object({ ref: z.string() }),
  },
  /** What the computer holds, the folder its tasks live under, and the one its working copies do. */
  "inf:session:roster": {
    effect: "read",
    request: z.tuple([]),
    response: z.object({
      tasksDir: z.string(),
      worktreesDir: z.string().optional(),
      tasks: z.array(placedRosterTaskSchema),
      /**
       * It keeps task browsers: a browser engine and a command process
       * (docs/task-browser.md, "On another computer"). Absent from one that
       * keeps none, or speaks a contract older than `TASK_BROWSERS_THERE_SINCE`.
       */
      browsers: z.boolean().optional(),
    }),
  },
  /** Opens the task's conversation; one already open answers its state. */
  "inf:session:open": {
    effect: "change",
    request: ordered({ spec: placedSpecSchema }),
    response: z.object({ state: placedStateSchema }),
  },
  /** Starts a turn; answers once it has started, and its end is an event. */
  "inf:session:prompt": {
    effect: "change",
    request: ordered({
      text: z.string(),
      images: z.array(sessionImageSchema).max(16).optional(),
    }),
    response: z.object({ turn: z.number().int().positive() }),
  },
  /** Words into the running turn; `delivered: false` when no turn runs, so nothing took them. */
  "inf:session:steer": {
    effect: "change",
    request: ordered({
      text: z.string(),
      images: z.array(sessionImageSchema).max(16).optional(),
    }),
    response: z.object({ delivered: z.boolean() }),
  },
  "inf:session:abort": {
    effect: "change",
    request: ordered({ failure: z.string().optional() }),
    response: doneSchema,
  },
  /** Lets go of the live client at an idle boundary; the next prompt reattaches. */
  "inf:session:detach": {
    effect: "change",
    request: ordered({}),
    response: doneSchema,
  },
  /** Ends the conversation for good: the task's record closed at home. */
  "inf:session:close": {
    effect: "change",
    request: ordered({}),
    response: doneSchema,
  },
  /** Removes leftovers only, after the home checks age and live dependencies. */
  "inf:session:clean-files": {
    effect: "change",
    request: ordered({}),
    response: z.object({
      removedFiles: z.array(z.string()),
      bytes: z.number().nonnegative(),
    }),
  },
  /**
   * Removes only the task's provisioned temporary folder, after the
   * conversation is closed. Separate from the week-long leftover pass.
   * A pending answer is not final: the home asks again.
   */
  "inf:session:clean-temp": {
    effect: "change",
    request: ordered({}),
    response: z.object({
      status: z.enum(["removed", "absent", "pending"]),
      bytes: z.number().nonnegative(),
      reason: z.string().min(1).max(300).optional(),
    }),
  },
  /**
   * Replaces the words from outside its conversation holds, once due, with
   * their kind's note (`outside-data-there.md`; docs/task-retention.md,
   * "Words from outside"): each kind's words read by its `until`, and the
   * results of the calls that fetched a kind's words before they were
   * fenced (`legacy`). `waiting` while it works; a conversation open there
   * is let go of and opened again from its files, and `state` is its own
   * after. `files` names what changed under its record's folder, by the
   * names `inf:session:copy` uses, for the home to copy whole.
   */
  "inf:session:delete-outside": {
    effect: "change",
    request: ordered({
      kinds: z
        .array(
          z.object({
            label: z.string().min(1).max(48),
            until: z.number(),
            note: z.string().min(1).max(200),
          }),
        )
        .min(1)
        .max(64),
      legacy: z
        .array(
          z.object({
            label: z.string().min(1).max(48),
            names: z.array(z.string().min(1).max(200)).max(1024),
          }),
        )
        .max(64),
      /**
       * Files from outside due in the task's hand-over folder, by kept name,
       * removed first (`outside-data-files.md`).
       */
      files: z.array(z.string().regex(HANDOVER_FILE_NAME)).max(1024).optional(),
    }),
    response: z.object({
      status: z.enum(["changed", "unchanged", "waiting"]),
      files: z.array(z.string().min(1).max(1024)).max(1024),
      state: placedStateSchema.optional(),
    }),
  },
  /**
   * Removes the task's folder there - its conversation's record, orders and
   * outbox - for a task the home no longer records there: only once the
   * conversation is closed for good and its working copy is gone. One
   * already removed answers the same.
   */
  "inf:session:remove": {
    effect: "change",
    request: ordered({}),
    response: doneSchema,
  },
  /**
   * The conversation's record, from where the home's copy of each file ends:
   * at most `PLACED_COPY_CHUNK_BYTES` per answer, `more` while there is more.
   */
  "inf:session:copy": {
    effect: "read",
    request: z.tuple([
      z.object({
        task: placedTaskIdSchema,
        /** Refresh the app-owned record from a live client before reading (8.15 or later). */
        refresh: z.boolean().optional(),
        from: z
          .array(
            z.object({
              name: z.string().min(1).max(1024),
              offset: z.number().int().nonnegative(),
            }),
          )
          .max(1024),
      }),
    ]),
    response: z.object({
      files: z.array(
        z.object({
          name: z.string().min(1).max(1024),
          size: z.number().int().nonnegative(),
          offset: z.number().int().nonnegative(),
          /** The bytes from `offset`, base64. */
          data: z.string(),
        }),
      ),
      more: z.boolean(),
    }),
  },
  /**
   * Makes the task's working copy there: the project cloned there once,
   * then a working copy on the task's branch from where the project lives,
   * or one of a warm working copy that came back. One already there
   * answers where it is. With no project, it is one of the computer's own
   * local workspace, as a task with no project is here.
   */
  "inf:working-copy:prepare": {
    effect: "change",
    request: ordered({
      project: z.object({ origin: z.string().min(1).max(4096) }).optional(),
      /** Use another task's local repository at this commit, without cloning or fetching. */
      base: workingCopyBaseSchema.optional(),
      /**
       * With no project: the commit of the home's default workspace the
       * working copy starts from, sent first (`inf:working-copy:seed`).
       */
      seed: commitSchema.optional(),
    }),
    response: z.union([
      z.object({ refused: z.literal("preparation-unknown") }),
      z.object({ refused: z.literal("preparation-failed"), message: z.string().max(2000) }),
      z.object({
        dir: z.string(),
        branch: z.string(),
        /** Acknowledges an exact base; the home refuses an older computer that ignores it. */
        headSha: commitSchema.optional(),
        /** It cloned the project for this one. */
        cloned: z.boolean(),
        /** It cloned it with this computer's own sign-in where the project lives. */
        signedIn: z.boolean().optional(),
        /** How it got the working copy, absent when it was already there. */
        acquired: z
          .object({
            source: z.enum(["pool", "new"]),
            base: dispatchBaseSchema,
            ms: z.number().nonnegative(),
          })
          .optional(),
      }),
      /**
       * The host where the project lives refused the clone for want of this
       * computer's own sign-in (`forgeAuthRequired`): a typed refusal, so
       * the home holds the task for that sign-in and starts it by itself
       * once this computer reports one (docs/forge.md, "A computer's own
       * sign-in"). Nothing was made here for the task.
       */
      z.object({
        refused: z.literal("forge-sign-in"),
        host: z.string().min(1).max(253),
        /** The person's word for the host ("GitHub"). */
        name: z.string().min(1).max(64),
      }),
    ]),
  },
  /**
   * Sends the home's default workspace to a task with no project, so its
   * working copy there starts from the commit the home has and its work
   * merges back into it. The first ask names the commit alone: `have` when
   * this computer holds it, else `need` with the commits it holds that the
   * bundle may leave out. The bundle then crosses in pieces the way an
   * artifact does; `ready` once every byte is there and the commit is.
   */
  "inf:working-copy:seed": {
    effect: "change",
    request: z.tuple([
      z.object({
        task: placedTaskIdSchema,
        sha: commitSchema,
        piece: z
          .object({
            size: z.number().int().positive(),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            offset: z.number().int().nonnegative(),
            data: z.string(),
          })
          .optional(),
      }),
    ]),
    response: z.object({
      outcome: z.enum(["have", "need", "partial", "ready"]),
      /** With `need`: commits this computer already holds. */
      have: z.array(commitSchema).max(64).optional(),
    }),
  },
  /** Installs the working copy's dependencies there, as a new one's are here. */
  "inf:working-copy:install": {
    effect: "change",
    request: ordered({}),
    response: z.union([
      z.object({ outcome: z.literal("skipped") }),
      z.object({ outcome: z.enum(["offline", "online"]), ms: z.number().nonnegative() }),
      z.object({ outcome: z.literal("failed"), ms: z.number().nonnegative(), error: z.string() }),
    ]),
  },
  /** Reads a task's committed revision and complete changed-file list on this computer. */
  "inf:working-copy:revision": {
    effect: "read",
    request: z.tuple([z.object({ task: placedTaskIdSchema, headSha: commitSchema.optional() })]),
    response: z.object({
      headSha: commitSchema,
      changedFiles: z.array(z.string()),
      /** Host-measured text lines at headSha; absent when unavailable or on an older computer. */
      changeLines: z
        .object({
          base: commitSchema,
          added: z.number().int().nonnegative(),
          deleted: z.number().int().nonnegative(),
        })
        .optional(),
      /**
       * The change reading at that commit (INF-148). Absent from a computer
       * on an older contract, which then cannot carry a passed review.
       */
      changeReading: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
  },
  /** Whether the working copy holds edits or commits that never merged. */
  "inf:working-copy:status": {
    effect: "read",
    request: z.tuple([z.object({ task: placedTaskIdSchema })]),
    response: z.object({
      present: z.boolean(),
      dirty: z.boolean(),
      unlandedCommits: z.number().int().nonnegative(),
      /**
       * Where the project it was cloned from lives, as its clone there names
       * it; null for one of the computer's own local workspace. Absent from
       * a computer on an older contract, and when no working copy is there.
       */
      origin: z.string().max(4096).nullable().optional(),
    }),
  },
  /**
   * Bundles one of the task's refs for the home, leaving out the commits it
   * says it has. `sha` is where the ref points, null when there is none;
   * with no `bundle` the home has that commit already.
   */
  "inf:working-copy:bundle": {
    effect: "change",
    request: z.tuple([
      z.object({
        task: placedTaskIdSchema,
        ref: bundledRefSchema,
        have: z.array(commitSchema).max(64),
      }),
    ]),
    response: z.object({ sha: commitSchema.nullable(), bundle: bundleSchema.optional() }),
  },
  /** The bundle (or move pack) made last for that ref, from `offset`: at most `PLACED_COPY_CHUNK_BYTES`. */
  "inf:working-copy:read": {
    effect: "read",
    request: z.tuple([
      z.object({
        task: placedTaskIdSchema,
        ref: readableRefSchema,
        offset: z.number().int().nonnegative(),
      }),
    ]),
    response: z.object({
      size: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      /** The bytes from `offset`, base64. */
      data: z.string(),
    }),
  },
  /**
   * The task closed at home: what its working copy holds that never merged
   * is saved there as one commit on its kept ref, once, and answered the
   * same when asked again. Null when nothing is unmerged.
   */
  "inf:working-copy:keep": {
    effect: "change",
    request: ordered({}),
    response: z.object({ kept: keptWorkSchema.nullable() }),
  },
  /**
   * Deletes the task's working copy there, once its kept work is at home:
   * `kept` names the commit the home holds, and must be the one the keep
   * answered; with null, nothing may be unmerged.
   */
  "inf:working-copy:retire": {
    effect: "change",
    request: ordered({ kept: commitSchema.nullable() }),
    response: doneSchema,
  },
  /**
   * One piece of an artifact the home downloaded for the task's crewmate,
   * written at `offset` into the working copy's
   * `.infinitary-artifacts/run-<runId>/artifact-<artifactId>.zip` (a computer
   * before 8.4: `.firstmate-artifacts/`) once every
   * piece is there and its digest matches; never over a file already there.
   */
  "inf:working-copy:artifact": {
    effect: "change",
    request: z.tuple([
      z.object({
        task: placedTaskIdSchema,
        runId: z.number().int().positive(),
        artifactId: z.number().int().positive(),
        /** A selection of the artifact's files, named by its SHA-256's start (`artifact-parts`). */
        part: z
          .string()
          .regex(/^[0-9a-f]{12}$/)
          .optional(),
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        offset: z.number().int().nonnegative(),
        data: z.string(),
      }),
    ]),
    /** `exists` when a file was there already, which it never writes over. */
    response: z.object({ outcome: z.enum(["partial", "written", "exists"]) }),
  },
  /**
   * Packs the task's work to move it to another computer (`task-move`,
   * docs/helper.md, "Moving a started task"): its conversation must be idle
   * and is let go first, never closed, so the task can run here again if the
   * move does not finish. The pack - what is staged and not, untracked
   * files and the task's own folders - waits in `bundles/` for `read` with
   * `move`, and its branch's commits for `bundle` with `branch`.
   */
  "inf:working-copy:move-out": {
    effect: "change",
    request: ordered({
      /** Ignored files in the working copy that move too (`ComputerMove.keep`). */
      keep: z.array(z.string().min(1).max(4096)).max(256).optional(),
    }),
    response: z.object({ head: commitSchema, branch: z.string().min(1), pack: bundleSchema }),
  },
  /**
   * Makes the working copy of a task that moves here (`task-move`): asked
   * first with neither file, it answers the commits it holds that a bundle
   * may leave out (`need`); then, with the task's branch as a source file
   * (none when every commit is here) and its pack, it fetches the branch,
   * makes the working copy at `head` and unpacks the work, checked against
   * what left (`ready`). Asked again once ready, it answers the same.
   */
  "inf:working-copy:move-in": {
    effect: "change",
    request: ordered({
      /**
       * Where the project lives, to clone it from; or, for a project the
       * home keeps on itself or clones from a folder, its id, whose commits
       * come in the bundle alone, with the home's own branch and the commit
       * the task's branch left it at, which the repository there starts on.
       */
      project: z
        .union([
          z.object({ origin: z.string().min(1).max(4096) }),
          z.object({
            local: z.string().min(1).max(64),
            base: z.object({ branch: z.string().min(1).max(255), sha: commitSchema }),
          }),
        ])
        .optional(),
      /** A task with no project: the home's workspace commit it sent first. */
      seed: commitSchema.optional(),
      head: commitSchema,
      bundle: sourceFileSchema.optional(),
      pack: sourceFileSchema.optional(),
    }),
    response: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("need"), have: z.array(commitSchema).max(64) }),
      z.object({ outcome: z.literal("ready"), dir: z.string(), branch: z.string() }),
    ]),
  },
} as const satisfies Record<
  `inf:session:${string}` | `inf:working-copy:${string}` | typeof PLACEMENT_FACTS_ORDER,
  { effect: "read" | "change"; request: z.ZodType; response: z.ZodType }
>;

export type WorkOrderChannel = keyof typeof workOrders;
export type WorkOrderRequest<C extends WorkOrderChannel> = z.infer<
  (typeof workOrders)[C]["request"]
>;
export type WorkOrderResponse<C extends WorkOrderChannel> = z.infer<
  (typeof workOrders)[C]["response"]
>;
export const WORK_ORDER_CHANNELS = Object.keys(workOrders) as WorkOrderChannel[];

export function isWorkOrderChannel(channel: string): channel is WorkOrderChannel {
  return Object.hasOwn(workOrders, channel);
}

/** One order about a task's browser on that computer: the task it names. */
function aboutBrowser<T extends z.ZodRawShape>(shape: T) {
  return z.tuple([z.object({ task: placedTaskIdSchema, ...shape })]);
}

/**
 * The orders a home asks a computer that runs work about its tasks'
 * browsers (docs/task-browser.md, "On another computer"), from
 * `TASK_BROWSERS_THERE_SINCE` on: the captain's side of a browser that runs
 * there - his view's pictures and room, his Take control, input and Return
 * control, Stop browser and Open again, a crewmate's request card, a saved
 * sign-in he lets it use or removes, and the task's close. Each answers
 * live and none is kept: a browser is gone once that computer quits, and an
 * answer may hold a sign-in, which nothing writes down there.
 */
export const browserOrders = {
  /** Every browser fact it keeps, by task: asked each time it comes into reach. */
  "inf:task-browser:facts": {
    effect: "read",
    request: z.tuple([]),
    response: z.object({
      facts: z.array(z.object({ task: placedTaskIdSchema, fact: taskBrowserFactSchema })),
    }),
  },
  /** Whether the captain watches the task's browser now: pictures come while he does. */
  "inf:task-browser:watch": {
    effect: "change",
    request: aboutBrowser({ watching: z.boolean() }),
    response: doneSchema,
  },
  /** The room his maximized view gives the page, or null for its own size. */
  "inf:task-browser:size": {
    effect: "change",
    request: aboutBrowser({ size: taskBrowserSizeSchema.nullable() }),
    response: doneSchema,
  },
  "inf:task-browser:input": {
    effect: "change",
    request: aboutBrowser({ input: taskBrowserInputSchema }),
    response: taskBrowserCommandResultSchema,
  },
  "inf:task-browser:take": {
    effect: "change",
    request: aboutBrowser({ handle: taskBrowserHandleSchema.optional() }),
    response: taskBrowserCommandResultSchema,
  },
  /**
   * His Return control. With `remember`, the tick that saves the site's
   * sign-in on the home: the answer carries what the browser holds of it,
   * which the home saves under that id.
   */
  "inf:task-browser:return": {
    effect: "change",
    request: aboutBrowser({
      handle: taskBrowserHandleSchema,
      remember: z
        .object({
          id: z.string().min(1).max(128),
          site: z.string().optional(),
          refresh: z.boolean().optional(),
        })
        .optional(),
    }),
    response: z.union([
      z.object({
        ok: z.literal(true),
        remembered: z.object({ site: z.string(), held: heldSignInSchema }).optional(),
        warning: z.string().optional(),
      }),
      z.object({ ok: z.literal(false), text: z.string() }),
    ]),
  },
  "inf:task-browser:stop": {
    effect: "change",
    request: aboutBrowser({}),
    response: taskBrowserCommandResultSchema,
  },
  "inf:task-browser:reopen": {
    effect: "change",
    request: aboutBrowser({}),
    response: taskBrowserCommandResultSchema,
  },
  /** A crewmate's card asks the captain to take over: the browser pauses before the card goes up. */
  "inf:task-browser:request": {
    effect: "change",
    request: aboutBrowser({ request: taskBrowserRequestSchema.extend({ site: z.string() }) }),
    response: z.union([
      z.object({ ok: z.literal(true), handle: taskBrowserHandleSchema }),
      z.object({ ok: z.literal(false), text: z.string() }),
    ]),
  },
  /**
   * The captain's click on a request card's saved sign-in: the save the home
   * lends that browser, which holds it in memory only and copies back into
   * it, by its id, as it stops.
   */
  "inf:task-browser:grant": {
    effect: "change",
    request: aboutBrowser({
      handle: taskBrowserHandleSchema,
      signIn: heldSignInSchema.extend({
        site: z.string().min(1),
        id: z.string().min(1).max(128),
        savedAt: z.number(),
      }),
    }),
    response: taskBrowserCommandResultSchema,
  },
  /** The captain removed a site's saved sign-in: every browser there using it signs out of it. */
  "inf:task-browser:sign-out": {
    effect: "change",
    request: z.tuple([z.object({ site: z.string().min(1) })]),
    response: doneSchema,
  },
  /** The task closed: its browser there goes, and its command answers nothing more. */
  "inf:task-browser:close": {
    effect: "change",
    request: aboutBrowser({}),
    response: doneSchema,
  },
} as const satisfies Record<
  `inf:task-browser:${string}`,
  { effect: "read" | "change"; request: z.ZodType; response: z.ZodType }
>;

export type BrowserOrderChannel = keyof typeof browserOrders;
export type BrowserOrderRequest<C extends BrowserOrderChannel> = z.infer<
  (typeof browserOrders)[C]["request"]
>;
export type BrowserOrderResponse<C extends BrowserOrderChannel> = z.infer<
  (typeof browserOrders)[C]["response"]
>;
export const BROWSER_ORDER_CHANNELS = Object.keys(browserOrders) as BrowserOrderChannel[];

export function isBrowserOrderChannel(channel: string): channel is BrowserOrderChannel {
  return Object.hasOwn(browserOrders, channel);
}

/**
 * The update order a home asks a computer that runs work whatever version it
 * runs (docs/helper.md, "Updated by its home"): bring Firstmate there to the
 * home's own version. A computer that keeps a copy of Firstmate gets the
 * home's at `FETCH_APP_PATH` with its own key and keeps it in place of its
 * own; one that runs its Mac's own app has nothing to get. Either answers,
 * then lets its run end, and its background starts it again from what is
 * kept there; `restarts` says whether a background is set up there to do so.
 *
 * It is asked of a computer on any major from `WORK_UPDATE_SINCE` on, so its
 * name and shape never change: a later major adds an order beside it, never
 * in its place.
 */
export const updateOrders = {
  "fm:firstmate:update": {
    effect: "change",
    request: z.tuple([]),
    response: z.object({ restarts: z.boolean() }),
  },
} as const satisfies Record<
  `fm:firstmate:${string}`,
  { effect: "read" | "change"; request: z.ZodType; response: z.ZodType }
>;

export type UpdateOrderChannel = keyof typeof updateOrders;
export const UPDATE_ORDER_CHANNELS = Object.keys(updateOrders) as UpdateOrderChannel[];
/** The update order's channel. */
export const WORK_UPDATE_ORDER: UpdateOrderChannel = "fm:firstmate:update";
export type WorkUpdateAnswer = z.infer<(typeof updateOrders)[typeof WORK_UPDATE_ORDER]["response"]>;

/** Where the home's version is published for a Mac, and the SHA-256 it is checked against. */
export const updateDownloadSchema = z.object({
  url: z
    .string()
    .max(2048)
    .regex(/^https:\/\/\S+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type UpdateDownload = z.infer<typeof updateDownloadSchema>;

const downloadCountShape = {
  received: z.number().int().nonnegative(),
  total: z.number().int().positive().optional(),
};
/**
 * What is under way where a home asked a download: `idle`, nothing in this
 * run; `downloading`; `updating`, what arrived is checked and being kept, or
 * the update order runs, so it starts again from the new copy; `failed` or
 * `mismatch`, the last download ended with nothing there changed. The
 * progress order's shape never changes across majors, so a state a later
 * version adds is still read: a home reads one it does not know as under way.
 */
export const UPDATE_PROGRESS_STATES = [
  "idle",
  "downloading",
  "updating",
  "failed",
  "mismatch",
] as const;
export type UpdateProgressState = (typeof UPDATE_PROGRESS_STATES)[number];

/**
 * How far a download the home asked for has got: the bytes received, the
 * size its release stated (only when it stated one, and never a redirect's),
 * and what is under way there (`UPDATE_PROGRESS_STATES`). A home whose
 * connection dropped while it asked reads it to follow that download
 * (docs/devices.md, "Downloading over the connection").
 */
export const updateProgressSchema = z.object({
  ...downloadCountShape,
  state: z.string().min(1).max(64),
});
/** How far a download has got, as a computer of this version says it: one of the states it knows. */
export type UpdateProgress = Omit<z.infer<typeof updateProgressSchema>, "state"> & {
  state: UpdateProgressState;
};

/**
 * The orders a home asks a Mac that runs work to download its update itself
 * (docs/devices.md, "Downloading over the connection"), of a computer on
 * any major from `WORK_DOWNLOAD_SINCE` on, so their names and shapes never
 * change either. `fm:firstmate:update-download` gets the home's published
 * version over HTTPS, checks its SHA-256 and its publisher, keeps it in
 * place of the copy there and answers as the update order does; or answers
 * `fallback` with nothing there changed - the download failed, stopped with
 * nothing moving, or did not match (`mismatch`) - and the home sends its own
 * copy with the update order. Either answer carries the download's last
 * count. One asked while a download or an update already runs there answers
 * `updating`, and the home follows that one. `fm:firstmate:update-progress`
 * answers how far that download has got, which the home asks while it runs.
 */
export const downloadOrders = {
  "fm:firstmate:update-download": {
    effect: "change",
    request: z.tuple([updateDownloadSchema]),
    response: z.union([
      z.object({ restarts: z.boolean(), ...downloadCountShape }),
      z.object({ fallback: z.enum(["failed", "mismatch"]), ...downloadCountShape }),
      z.object({ updating: z.literal(true) }),
    ]),
  },
  "fm:firstmate:update-progress": {
    effect: "read",
    request: z.tuple([]),
    response: updateProgressSchema,
  },
} as const satisfies Record<
  `fm:firstmate:${string}`,
  { effect: "read" | "change"; request: z.ZodType; response: z.ZodType }
>;

export type DownloadOrderChannel = keyof typeof downloadOrders;
export const DOWNLOAD_ORDER_CHANNELS = Object.keys(downloadOrders) as DownloadOrderChannel[];
/** The download order's channel. */
export const WORK_DOWNLOAD_ORDER = "fm:firstmate:update-download" satisfies DownloadOrderChannel;
/** The order that reads how far the download has got. */
export const WORK_PROGRESS_ORDER = "fm:firstmate:update-progress" satisfies DownloadOrderChannel;
export type WorkDownloadAnswer = z.infer<
  (typeof downloadOrders)[typeof WORK_DOWNLOAD_ORDER]["response"]
>;
